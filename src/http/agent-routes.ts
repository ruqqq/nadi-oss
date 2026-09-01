import type { Env } from "../env";
import { validateRequestSession, type ValidatedSession } from "../auth/session";
import { registryBinding, registryDb } from "../db/client";
import { AgentRepository, type AgentRepositoryEntry } from "../db/repositories/agents";
import type { ProjectStatus } from "../db/repositories/projects";
import { WorkspaceRepository } from "../db/repositories/workspaces";
import {
  parseEnvVarMap,
  parseEnvVarsJson,
  serializeEnvVarsJson,
  validateEnvVarName,
} from "../compute/env-vars";
import { ComputeEnvSecretsStore } from "../compute/env-secrets";
import { createWorkspaceSecretsServices } from "../secrets";
import { type AgentConfig, type AgentRepositoryRow } from "../db/schema";
import { log } from "../log";
import { resolveAgentScope } from "./agent-scope";
import { listAgentSkills, setSkillExclusion } from "./skill-routes";
import { AgentSettingsRepository } from "../db/repositories/agent-settings";
import { parseAgentBehaviourPatch } from "./settings-routes";
import {
  COMPUTE_RESOURCE_PROFILE_IDS,
  parseDomainList,
  validateSandboxDomain,
} from "../compute/config";
import type { ComputeResourceProfile } from "../compute/backend";
import { AgentSandboxLedger } from "../compute/agent-sandbox-ledger";

interface AgentSandboxDeletionStub {
  destroyForAgentDeletion(input: {
    workspaceId: string;
    agentId: string;
  }): Promise<{ destroyed: boolean; reason?: string }>;
}

type AgentBody = {
  name?: unknown;
  description?: unknown;
  setupScript?: unknown;
  resourceProfile?: unknown;
  networkDomainAllowlist?: unknown;
  /** Disable is an ordinary toggle: the agent stops taking new work, its
   *  machine and files survive. Distinct from archiving, which is the delete. */
  enabled?: unknown;
  systemPrompt?: unknown;
  provider?: unknown;
  model?: unknown;
  modelInputModalities?: unknown;
  reasoningEffort?: unknown;
  modelSupportsReasoning?: unknown;
};

export type AgentSummary = AgentConfig & {
  repositories: AgentRepositoryRow[];
  envVars: Record<string, string>;
  secretEnvNames: string[];
  /** Additional host-allowlist domains, additive on top of the workspace list. */
  networkDomainAllowlist: string;
};

/**
 * The lean shape a picker needs at first paint — `id`/`name`/`description`/
 * `enabled` and nothing else. Deliberately NOT `AgentSummary`: that type
 * costs `listRepositories` + `listSecretNames` (+ a KV `listAgentNames` on a
 * pre-backfill agent) per row, and carries `systemPrompt`/`sandboxEnvVarsJson`
 * — fine for the one-agent `GET /api/agents/:id` drill-down, wrong for a
 * bootstrap response built on every page load from rows already in hand.
 * Add a field here only when you can name the first-paint consumer that
 * needs it; `GET /api/agents` is where the rest lives.
 */
export type AgentListItem = {
  id: string;
  name: string;
  description: string;
  enabled: boolean;
};

/** Builds {@link AgentListItem} from an already-fetched row — no I/O, so
 *  callers with N rows in hand (e.g. bootstrap) pay zero extra queries. */
export function toAgentListItem(row: AgentConfig): AgentListItem {
  return { id: row.id, name: row.name, description: row.description, enabled: row.enabled };
}

export async function routeAgents(req: Request, env: Env): Promise<Response | null> {
  const url = new URL(req.url);

  if (url.pathname === "/api/agents") {
    if (req.method === "GET") return listAgents(req, env, url);
    if (req.method === "POST") return createAgent(req, env);
    return new Response("Method not allowed", { status: 405 });
  }

  const archiveId = matchId(url.pathname, /^\/api\/agents\/([^/]+)\/archive$/);
  if (archiveId !== null) {
    if (req.method === "POST") return archiveAgent(req, env, archiveId);
    return new Response("Method not allowed", { status: 405 });
  }

  const reposId = matchId(url.pathname, /^\/api\/agents\/([^/]+)\/repositories$/);
  if (reposId !== null) {
    if (req.method === "PUT") return replaceRepositories(req, env, reposId);
    return new Response("Method not allowed", { status: 405 });
  }

  const envVarsId = matchId(url.pathname, /^\/api\/agents\/([^/]+)\/env-vars$/);
  if (envVarsId !== null) {
    if (req.method === "PUT") return setEnvVars(req, env, envVarsId);
    return new Response("Method not allowed", { status: 405 });
  }

  const secretMatch = url.pathname.match(/^\/api\/agents\/([^/]+)\/secrets\/([^/]+)$/);
  if (secretMatch?.[1] && secretMatch[2]) {
    const agentId = decodeURIComponent(secretMatch[1]);
    const name = decodeURIComponent(secretMatch[2]);
    if (req.method === "PUT") return setSecret(req, env, agentId, name);
    if (req.method === "DELETE") return deleteSecret(req, env, agentId, name);
    return new Response("Method not allowed", { status: 405 });
  }

  // The two skill surfaces live under /api/agents/ because they are addressed
  // by AGENT, like /api/agents/:id/repositories. They must be matched HERE:
  // `routeAgents` runs before `routeSkills` (router.ts) and ends with a
  // catch-all 404 for /api/agents/, so registering them in skill-routes.ts
  // alone would 404 before `routeSkills` ever saw them. The handlers themselves
  // stay in skill-routes.ts, beside the rest of the skill surface.
  const agentSkillsId = matchId(url.pathname, /^\/api\/agents\/([^/]+)\/skills$/);
  if (agentSkillsId !== null) {
    if (req.method === "GET") return listAgentSkills(req, env, agentSkillsId);
    return new Response("Method not allowed", { status: 405 });
  }

  const exclusionMatch = url.pathname.match(/^\/api\/agents\/([^/]+)\/skills\/([^/]+)\/exclusion$/);
  if (exclusionMatch?.[1] && exclusionMatch[2]) {
    if (req.method === "POST")
      return setSkillExclusion(
        req,
        env,
        decodeURIComponent(exclusionMatch[1]),
        decodeURIComponent(exclusionMatch[2]),
      );
    return new Response("Method not allowed", { status: 405 });
  }

  const agentId = matchId(url.pathname, /^\/api\/agents\/([^/]+)$/);
  if (agentId !== null) {
    if (req.method === "GET") return getAgent(req, env, agentId);
    if (req.method === "PATCH") return updateAgent(req, env, agentId);
    return new Response("Method not allowed", { status: 405 });
  }

  if (url.pathname.startsWith("/api/agents/")) {
    return new Response("Not found", { status: 404 });
  }

  return null;
}

async function listAgents(req: Request, env: Env, url: URL): Promise<Response> {
  const session = await validateRequestSession(env, req);
  if (!session) return new Response("Unauthorized", { status: 401 });

  const status = parseStatus(url.searchParams.get("status"));
  if (!status.ok) return status.response;

  const workspaceId = await resolveWorkspaceId(env, session);
  if (!workspaceId) return Response.json({ agents: [] });

  const db = registryDb(env);
  const repo = new AgentRepository(db);
  const rows = await repo.listForWorkspace(workspaceId, status.value);
  const agents = await Promise.all(rows.map((row) => buildSummary(env, repo, workspaceId, row)));
  return Response.json({ agents });
}

async function createAgent(req: Request, env: Env): Promise<Response> {
  const session = await validateRequestSession(env, req);
  if (!session) return new Response("Unauthorized", { status: 401 });

  const workspaceId = await resolveWorkspaceId(env, session);
  if (!workspaceId) return new Response("Workspace not found", { status: 404 });

  const body = (await req.json().catch(() => null)) as AgentBody | null;
  const parsed = parseCreatePayload(body);
  if (!parsed.ok) return parsed.response;

  const db = registryDb(env);
  const repo = new AgentRepository(db);
  // What this route creates is an AGENT, and `system_prompt`, `provider` and
  // `model` are NOT NULL with no default — there is nothing sensible to invent
  // for them here. The workspace's existing agent supplies them, which is the
  // same rule the workbench migration used when it turned each workbench into
  // an agent. A workspace with no agent at all cannot have one made from this
  // surface; that is the agent-creation UI's job.
  const template = (await repo.listForWorkspace(workspaceId, "all")).sort(
    (left, right) => left.createdAt - right.createdAt || left.id.localeCompare(right.id),
  )[0];
  if (!template) return new Response("Workspace agent not found", { status: 404 });
  try {
    const createdAt = Date.now();
    const { resourceProfile, networkDomainAllowlist, ...rest } = parsed.value;
    const agent = await repo.create({
      id: `env_${crypto.randomUUID()}`,
      workspaceId,
      systemPrompt: template.systemPrompt,
      provider: template.provider,
      model: template.model,
      modelInputModalities: template.modelInputModalities,
      reasoningEffort: template.reasoningEffort,
      modelSupportsReasoning: template.modelSupportsReasoning,
      ...rest,
      ...(resourceProfile !== undefined ? { resourceProfile } : {}),
      ...(networkDomainAllowlist !== undefined
        ? { sandboxNetworkDomainAllowlist: networkDomainAllowlist }
        : {}),
      sandboxEnvVarsJson: "{}",
      // A brand-new agent has no pre-existing KV secrets, so its D1 name
      // index is already authoritative — skip the one-time KV backfill probe.
      secretNamesBackfilled: true,
      createdAt,
      updatedAt: createdAt,
    });
    const summary = await buildSummary(env, repo, workspaceId, agent);
    return Response.json({ agent: summary }, { status: 201 });
  } catch (error) {
    return mapAgentError(error);
  }
}

async function getAgent(req: Request, env: Env, agentId: string): Promise<Response> {
  const session = await validateRequestSession(env, req);
  if (!session) return new Response("Unauthorized", { status: 401 });

  const db = registryDb(env);
  const repo = new AgentRepository(db);
  const agent = await repo.getById(agentId);
  if (!agent) return new Response("Not found", { status: 404 });

  const membership = await assertMember(db, agent.workspaceId, session.user.id);
  if (!membership) return new Response("Not found", { status: 404 });

  const summary = await buildSummary(env, repo, agent.workspaceId, agent);
  return Response.json({ agent: summary });
}

async function updateAgent(req: Request, env: Env, agentId: string): Promise<Response> {
  const session = await validateRequestSession(env, req);
  if (!session) return new Response("Unauthorized", { status: 401 });

  const db = registryDb(env);
  const repo = new AgentRepository(db);
  const agent = await repo.getById(agentId);
  if (!agent) return new Response("Not found", { status: 404 });

  const membership = await assertMember(db, agent.workspaceId, session.user.id);
  if (!membership) return new Response("Not found", { status: 404 });

  const body = (await req.json().catch(() => null)) as AgentBody | null;
  const parsed = parsePatchPayload(body);
  if (!parsed.ok) return parsed.response;
  const behaviour = parseAgentBehaviourPatch(env, session.user.email, body ?? undefined);
  if (!behaviour.ok) return behaviour.response;

  if (Object.keys(parsed.value).length === 0 && Object.keys(behaviour.patch).length === 0) {
    return new Response("No valid fields to update", { status: 400 });
  }

  // The last usable agent may not be switched off: a workspace with no active,
  // enabled agent cannot start a thread at all.
  if (parsed.value.enabled === false && agent.enabled) {
    const remaining = await repo.countUsableExcluding(agent.workspaceId, agentId);
    if (remaining === 0) return lastAgentRefusal("disabled");
  }

  try {
    // `updatedAt` is written even for a behaviour-only patch: the agent list
    // orders by it, so a saved prompt that left the stamp alone would leave the
    // agent sitting where it was, looking untouched.
    await repo.update(agentId, { ...parsed.value, updatedAt: Date.now() });
    if (Object.keys(behaviour.patch).length > 0) {
      await new AgentSettingsRepository(db).updateAgentSettings(
        agent.workspaceId,
        { kind: "id", agentId },
        behaviour.patch,
      );
    }
  } catch (error) {
    return mapAgentError(error);
  }

  const updated = await repo.getById(agentId);
  if (!updated) return new Response("Not found", { status: 404 });
  const summary = await buildSummary(env, repo, updated.workspaceId, updated);
  return Response.json({ agent: summary });
}

/**
 * "Delete this agent and its machine. Its files are destroyed."
 *
 * ONE call to ONE Durable Object, addressed by AGENT id. It used to walk the
 * agent's non-archived threads and shut each one's sandbox down, which was
 * right only while the box was keyed by thread. Since P3 it is wrong in both
 * directions: every thread pointed at the SAME machine, so the walk was N
 * attempts at one box; and an agent whose threads had all been archived walked
 * zero threads and returned early, leaving a live sprite with nothing left that
 * could ever reach it — a machine billing forever, for an agent the user
 * believes they deleted.
 *
 * The ledger row is dropped here too, unconditionally and even when the DO
 * refused. `execShutdown` throws `compute_children_active` while a subagent
 * holds a lease, and it is the archive — not the teardown — that stops new
 * work, so the delete must not be blocked on it. Dropping the row makes the box
 * an ORPHAN by definition, which is exactly what the reconciler is for: it is
 * the only thing left that can collect a sprite whose agent is gone. Keeping
 * the row instead would leave the sprite accounted-for, and therefore never
 * reaped, forever.
 *
 * Best-effort by construction. Every failure is logged and none is raised.
 */
async function destroyAgentSandbox(env: Env, workspaceId: string, agentId: string): Promise<void> {
  try {
    const stub = env.AGENT_SANDBOX.get(
      env.AGENT_SANDBOX.idFromName(agentId),
    ) as unknown as AgentSandboxDeletionStub;
    const result = await stub.destroyForAgentDeletion({ workspaceId, agentId });
    // EVERY non-destroy is logged, `compute_disabled` included. That reason was
    // once filtered out as uninteresting, and filtering it is precisely what
    // would make "delete an agent you disabled first destroys nothing" ship in
    // silence. A teardown that decides to do nothing must say so.
    if (!result.destroyed) {
      log.warn("agent_routes.delete_sandbox_not_destroyed", {
        agentId,
        reason: result.reason,
      });
    }
  } catch (error) {
    log.warn("agent_routes.delete_sandbox_failed", { agentId, error: String(error) });
  }
  try {
    await new AgentSandboxLedger(registryBinding(env)).remove(agentId);
  } catch (error) {
    log.warn("agent_routes.delete_sandbox_ledger_failed", { agentId, error: String(error) });
  }
}

async function archiveAgent(req: Request, env: Env, agentId: string): Promise<Response> {
  const session = await validateRequestSession(env, req);
  if (!session) return new Response("Unauthorized", { status: 401 });

  const db = registryDb(env);
  const repo = new AgentRepository(db);
  const agent = await repo.getById(agentId);
  if (!agent) return new Response("Not found", { status: 404 });

  const membership = await assertMember(db, agent.workspaceId, session.user.id);
  if (!membership) return new Response("Not found", { status: 404 });

  if (agent.archivedAt === null) {
    const remaining = await repo.countUsableExcluding(agent.workspaceId, agentId);
    if (remaining === 0) return lastAgentRefusal("deleted");
    // BEFORE the archive write, not after: once the row carries `archived_at`
    // the effective compute config bails with `disabled`, `openSandbox()`
    // returns null, and there is no longer any route to the machine at all.
    // The window this leaves — a turn acquiring a box between the teardown and
    // the write — is milliseconds wide and closes permanently the moment the
    // row lands, since nothing can acquire compute for an archived agent.
    await destroyAgentSandbox(env, agent.workspaceId, agentId);
  }

  await repo.archive(agentId, Date.now());
  const archived = await repo.getById(agentId);
  if (!archived) return new Response("Not found", { status: 404 });
  const summary = await buildSummary(env, repo, archived.workspaceId, archived);
  return Response.json({ agent: summary });
}

async function replaceRepositories(req: Request, env: Env, agentId: string): Promise<Response> {
  const session = await validateRequestSession(env, req);
  if (!session) return new Response("Unauthorized", { status: 401 });

  const db = registryDb(env);
  const repo = new AgentRepository(db);
  const agent = await repo.getById(agentId);
  if (!agent) return new Response("Not found", { status: 404 });

  const membership = await assertMember(db, agent.workspaceId, session.user.id);
  if (!membership) return new Response("Not found", { status: 404 });

  const body = (await req.json().catch(() => null)) as unknown;
  const parsed = parseRepositoryEntries(body);
  if (!parsed.ok) return parsed.response;

  try {
    await repo.replaceRepositories(agentId, agent.workspaceId, parsed.value, Date.now());
  } catch (error) {
    return mapAgentError(error);
  }

  const updated = await repo.getById(agentId);
  if (!updated) return new Response("Not found", { status: 404 });
  const summary = await buildSummary(env, repo, updated.workspaceId, updated);
  return Response.json({ agent: summary });
}

async function setEnvVars(req: Request, env: Env, agentId: string): Promise<Response> {
  const session = await validateRequestSession(env, req);
  if (!session) return new Response("Unauthorized", { status: 401 });

  const db = registryDb(env);
  const repo = new AgentRepository(db);
  const agent = await repo.getById(agentId);
  if (!agent) return new Response("Not found", { status: 404 });

  const membership = await assertMember(db, agent.workspaceId, session.user.id);
  if (!membership) return new Response("Not found", { status: 404 });

  const body = (await req.json().catch(() => null)) as { envVars?: unknown } | null;
  let sandboxEnvVarsJson: string;
  try {
    const map = parseEnvVarMap(body?.envVars ?? {});
    sandboxEnvVarsJson = serializeEnvVarsJson(map);
  } catch (error) {
    return mapAgentError(error);
  }

  await repo.update(agentId, { sandboxEnvVarsJson, updatedAt: Date.now() });

  const updated = await repo.getById(agentId);
  if (!updated) return new Response("Not found", { status: 404 });
  const summary = await buildSummary(env, repo, updated.workspaceId, updated);
  return Response.json({ agent: summary });
}

async function setSecret(req: Request, env: Env, agentId: string, name: string): Promise<Response> {
  const session = await validateRequestSession(env, req);
  if (!session) return new Response("Unauthorized", { status: 401 });

  const db = registryDb(env);
  const repo = new AgentRepository(db);
  const agent = await repo.getById(agentId);
  if (!agent) return new Response("Not found", { status: 404 });

  const membership = await assertMember(db, agent.workspaceId, session.user.id);
  if (!membership) return new Response("Not found", { status: 404 });

  const body = (await req.json().catch(() => null)) as { value?: unknown } | null;
  if (typeof body?.value !== "string") {
    return new Response("value must be a string", { status: 400 });
  }

  let validName: string;
  try {
    validName = validateEnvVarName(name);
  } catch {
    return new Response("invalid env var name", { status: 400 });
  }

  const secretStore = new ComputeEnvSecretsStore(createWorkspaceSecretsServices(env));
  await secretStore.setAgent(agent.workspaceId, agentId, validName, body.value);
  // Backfill legacy names before adding this one, so the D1 index is complete
  // and the returned summary lists every secret, not just the new one.
  await ensureAgentSecretNamesBackfilled(env, repo, agent);
  await repo.putSecretName(agentId, validName, Date.now());

  const updated = await repo.getById(agentId);
  if (!updated) return new Response("Not found", { status: 404 });
  const summary = await buildSummary(env, repo, updated.workspaceId, updated);
  return Response.json({ agent: summary });
}

async function deleteSecret(
  req: Request,
  env: Env,
  agentId: string,
  name: string,
): Promise<Response> {
  const session = await validateRequestSession(env, req);
  if (!session) return new Response("Unauthorized", { status: 401 });

  const db = registryDb(env);
  const repo = new AgentRepository(db);
  const agent = await repo.getById(agentId);
  if (!agent) return new Response("Not found", { status: 404 });

  const membership = await assertMember(db, agent.workspaceId, session.user.id);
  if (!membership) return new Response("Not found", { status: 404 });

  const secretStore = new ComputeEnvSecretsStore(createWorkspaceSecretsServices(env));
  await secretStore.deleteAgent(agent.workspaceId, agentId, name);
  // Backfill from the KV list BEFORE removing this name: that list still
  // includes the just-deleted key while KV propagates, so seeding first then
  // deleting lets the D1 removal win — otherwise the stale list would re-add it.
  await ensureAgentSecretNamesBackfilled(env, repo, agent);
  await repo.deleteSecretName(agentId, name);

  const updated = await repo.getById(agentId);
  if (!updated) return new Response("Not found", { status: 404 });
  const summary = await buildSummary(env, repo, updated.workspaceId, updated);
  return Response.json({ agent: summary });
}

export async function buildSummary(
  env: Env,
  repo: AgentRepository,
  _workspaceId: string,
  row: AgentConfig,
): Promise<AgentSummary> {
  const [repositories, secretEnvNames] = await Promise.all([
    repo.listRepositories(row.id),
    loadAgentSecretNames(env, repo, row),
  ]);
  return {
    ...row,
    repositories,
    envVars: parseEnvVarsJson(row.sandboxEnvVarsJson),
    secretEnvNames,
    // NULL on `agents` means what "" meant on `workbenches`: no additions.
    networkDomainAllowlist: row.sandboxNetworkDomainAllowlist ?? "",
  };
}

/**
 * The agent's secret names, read from the strongly-consistent D1 index.
 * An agent predating that index gets its names seeded from the KV list once
 * (see {@link ensureAgentSecretNamesBackfilled}); every read after that is
 * pure D1, so a just-added secret shows immediately and a deleted one is gone
 * immediately — neither waits on KV `list` propagation.
 */
async function loadAgentSecretNames(
  env: Env,
  repo: AgentRepository,
  agent: AgentConfig,
): Promise<string[]> {
  await ensureAgentSecretNamesBackfilled(env, repo, agent);
  return repo.listSecretNames(agent.id);
}

async function ensureAgentSecretNamesBackfilled(
  env: Env,
  repo: AgentRepository,
  agent: AgentConfig,
): Promise<void> {
  if (agent.secretNamesBackfilled) return;
  const secretStore = new ComputeEnvSecretsStore(createWorkspaceSecretsServices(env));
  const kvNames = await secretStore.listAgentNames(agent.workspaceId, agent.id);
  await repo.backfillSecretNames(
    agent.id,
    kvNames.map((entry) => ({ name: entry.name, updatedAt: parseKvTimestamp(entry.updatedAt) })),
  );
}

function parseKvTimestamp(iso: string): number {
  const parsed = Date.parse(iso);
  return Number.isNaN(parsed) ? Date.now() : parsed;
}

async function assertMember(
  db: ReturnType<typeof registryDb>,
  workspaceId: string,
  userId: string,
): Promise<boolean> {
  try {
    await new WorkspaceRepository(db).assertMember({ workspaceId, userId });
    return true;
  } catch {
    return false;
  }
}

async function resolveWorkspaceId(env: Env, session: ValidatedSession): Promise<string | null> {
  return (await resolveAgentScope(env, session))?.workspaceId ?? null;
}

function parseStatus(
  value: string | null,
): { ok: true; value: ProjectStatus } | { ok: false; response: Response } {
  if (value === null || value === "active" || value === "archived" || value === "all") {
    return { ok: true, value: value ?? "active" };
  }
  return {
    ok: false,
    response: new Response("status must be active, archived, or all", { status: 400 }),
  };
}

function parseCreatePayload(
  body: AgentBody | null,
): { ok: true; value: CreateAgentInput } | { ok: false; response: Response } {
  const name = parseRequiredString(body?.name, "name");
  if (!name.ok) return name;
  const description = parseStringWithDefault(body?.description, "description", "");
  if (!description.ok) return description;
  const setupScript = parseStringWithDefault(body?.setupScript, "setupScript", "");
  if (!setupScript.ok) return setupScript;
  const resourceProfile = parseResourceProfile(body?.resourceProfile);
  if (!resourceProfile.ok) {
    return { ok: false, response: new Response("Invalid resourceProfile", { status: 400 }) };
  }
  const allowlist = parseNetworkDomainAllowlist(body?.networkDomainAllowlist);
  if (!allowlist.ok) return allowlist;

  return {
    ok: true,
    value: {
      name: name.value,
      description: description.value,
      setupScript: setupScript.value,
      ...(resourceProfile.hasValue ? { resourceProfile: resourceProfile.value } : {}),
      ...(allowlist.value !== undefined ? { networkDomainAllowlist: allowlist.value } : {}),
    },
  };
}

/**
 * Parses and validates the optional `networkDomainAllowlist` (each domain must
 * pass {@link validateSandboxDomain}). Returns `undefined` when the key is
 * absent so callers can omit it; an empty string is an explicit clear.
 */
function parseNetworkDomainAllowlist(
  value: unknown,
): { ok: true; value: string | undefined } | { ok: false; response: Response } {
  if (value === undefined) return { ok: true, value: undefined };
  if (typeof value !== "string") {
    return {
      ok: false,
      response: new Response("networkDomainAllowlist must be a string", { status: 400 }),
    };
  }
  const trimmed = value.trim();
  try {
    if (trimmed) parseDomainList(trimmed).forEach(validateSandboxDomain);
  } catch {
    return { ok: false, response: new Response("invalid domain", { status: 400 }) };
  }
  return { ok: true, value: trimmed };
}

function parsePatchPayload(
  body: AgentBody | null,
): { ok: true; value: PatchAgentInput } | { ok: false; response: Response } {
  const patch: PatchAgentInput = {};

  if (body?.name !== undefined) {
    const name = parseRequiredString(body.name, "name");
    if (!name.ok) return name;
    patch.name = name.value;
  }
  if (body?.description !== undefined) {
    const description = parseStringWithDefault(body.description, "description", "");
    if (!description.ok) return description;
    patch.description = description.value;
  }
  if (body?.setupScript !== undefined) {
    const setupScript = parseStringWithDefault(body.setupScript, "setupScript", "");
    if (!setupScript.ok) return setupScript;
    patch.setupScript = setupScript.value;
  }
  if (body?.resourceProfile !== undefined) {
    const resourceProfile = parseResourceProfile(body.resourceProfile);
    if (!resourceProfile.ok) {
      return { ok: false, response: new Response("Invalid resourceProfile", { status: 400 }) };
    }
    patch.resourceProfile = resourceProfile.value;
  }
  if (body?.networkDomainAllowlist !== undefined) {
    const allowlist = parseNetworkDomainAllowlist(body.networkDomainAllowlist);
    if (!allowlist.ok) return allowlist;
    // `value` is defined here because the key is present (not undefined).
    patch.sandboxNetworkDomainAllowlist = allowlist.value ?? "";
  }
  if (body?.enabled !== undefined) {
    if (typeof body.enabled !== "boolean") {
      return { ok: false, response: new Response("enabled must be a boolean", { status: 400 }) };
    }
    patch.enabled = body.enabled;
  }

  return { ok: true, value: patch };
}

function parseResourceProfile(
  value: unknown,
): { ok: true; hasValue: boolean; value: ComputeResourceProfile } | { ok: false } {
  if (value === undefined) return { ok: true, hasValue: false, value: "small" };
  if (
    typeof value !== "string" ||
    !(COMPUTE_RESOURCE_PROFILE_IDS as readonly string[]).includes(value)
  ) {
    return { ok: false };
  }
  return { ok: true, hasValue: true, value: value as ComputeResourceProfile };
}

type CreateAgentInput = {
  name: string;
  description: string;
  setupScript: string;
  resourceProfile?: ComputeResourceProfile;
  networkDomainAllowlist?: string;
};

type PatchAgentInput = Partial<CreateAgentInput> & {
  sandboxNetworkDomainAllowlist?: string;
  enabled?: boolean;
};

/** Parses the `PUT /api/agents/:id/repositories` body: an array of full repo entries. */
export function parseRepositoryEntries(
  body: unknown,
): { ok: true; value: AgentRepositoryEntry[] } | { ok: false; response: Response } {
  if (!Array.isArray(body)) {
    return { ok: false, response: new Response("body must be an array", { status: 400 }) };
  }

  const entries: AgentRepositoryEntry[] = [];
  for (const item of body) {
    const parsed = parseRepositoryEntry(item);
    if (!parsed.ok) return parsed;
    entries.push(parsed.value);
  }
  return { ok: true, value: entries };
}

function parseRepositoryEntry(
  item: unknown,
): { ok: true; value: AgentRepositoryEntry } | { ok: false; response: Response } {
  if (typeof item !== "object" || item === null) {
    return {
      ok: false,
      response: new Response("each repository must be an object", { status: 400 }),
    };
  }
  const entry = item as Record<string, unknown>;

  const source = entry.source;
  if (source !== "github" && source !== "url") {
    return {
      ok: false,
      response: new Response('source must be "github" or "url"', { status: 400 }),
    };
  }
  const name = parseRequiredString(entry.name, "name");
  if (!name.ok) return name;
  const url = parseRequiredString(entry.url, "url");
  if (!url.ok) return url;
  const checkoutPathName = parseRequiredString(entry.checkoutPathName, "checkoutPathName");
  if (!checkoutPathName.ok) return checkoutPathName;
  const defaultBranch = parseDefaultBranch(entry.defaultBranch);
  if (!defaultBranch.ok) return defaultBranch;
  const rootDirectory = parseStringWithDefault(entry.rootDirectory, "rootDirectory", "");
  if (!rootDirectory.ok) return rootDirectory;
  const setupCommand = parseStringWithDefault(entry.setupCommand, "setupCommand", "");
  if (!setupCommand.ok) return setupCommand;
  const packageManager = parseStringWithDefault(entry.packageManager, "packageManager", "");
  if (!packageManager.ok) return packageManager;
  const sourceInstallationId = parseOptionalString(
    entry.sourceInstallationId,
    "sourceInstallationId",
  );
  if (!sourceInstallationId.ok) return sourceInstallationId;
  const githubRepoId = parseOptionalNumber(entry.githubRepoId, "githubRepoId");
  if (!githubRepoId.ok) return githubRepoId;

  return {
    ok: true,
    value: {
      source,
      name: name.value,
      url: url.value,
      checkoutPathName: checkoutPathName.value,
      defaultBranch: defaultBranch.value,
      rootDirectory: rootDirectory.value,
      setupCommand: setupCommand.value,
      packageManager: packageManager.value,
      sourceInstallationId: sourceInstallationId.value,
      githubRepoId: githubRepoId.value,
    },
  };
}

function parseRequiredString(
  value: unknown,
  field: string,
): { ok: true; value: string } | { ok: false; response: Response } {
  if (typeof value !== "string" || !value.trim()) {
    return {
      ok: false,
      response: new Response(`${field} must be a non-empty string`, { status: 400 }),
    };
  }
  return { ok: true, value: value.trim() };
}

function parseStringWithDefault(
  value: unknown,
  field: string,
  defaultValue: string,
): { ok: true; value: string } | { ok: false; response: Response } {
  if (value === undefined) return { ok: true, value: defaultValue };
  if (typeof value !== "string") {
    return { ok: false, response: new Response(`${field} must be a string`, { status: 400 }) };
  }
  return { ok: true, value: value.trim() };
}

function parseDefaultBranch(
  value: unknown,
): { ok: true; value: string } | { ok: false; response: Response } {
  if (value === undefined) return { ok: true, value: "main" };
  if (typeof value !== "string") {
    return { ok: false, response: new Response("defaultBranch must be a string", { status: 400 }) };
  }
  return { ok: true, value: value.trim() || "main" };
}

function parseOptionalString(
  value: unknown,
  field: string,
): { ok: true; value: string | null } | { ok: false; response: Response } {
  if (value === undefined || value === null) return { ok: true, value: null };
  if (typeof value !== "string" || !value.trim()) {
    return {
      ok: false,
      response: new Response(`${field} must be a non-empty string`, { status: 400 }),
    };
  }
  return { ok: true, value: value.trim() };
}

function parseOptionalNumber(
  value: unknown,
  field: string,
): { ok: true; value: number | null } | { ok: false; response: Response } {
  if (value === undefined || value === null) return { ok: true, value: null };
  if (typeof value !== "number" || !Number.isFinite(value)) {
    return { ok: false, response: new Response(`${field} must be a number`, { status: 400 }) };
  }
  return { ok: true, value };
}

function matchId(pathname: string, re: RegExp): string | null {
  const match = pathname.match(re);
  return match?.[1] ? decodeURIComponent(match[1]) : null;
}

function mapAgentError(error: unknown): Response {
  if (!(error instanceof Error)) {
    throw error;
  }
  if (error.message === "sandbox_env_var_name_invalid") {
    return new Response("invalid env var name", { status: 400 });
  }
  if (error.message === "sandbox_env_var_value_too_large") {
    return new Response("env var value too large", { status: 400 });
  }
  if (
    error.message === "sandbox_env_vars_invalid" ||
    error.message === "sandbox_env_vars_too_many"
  ) {
    return new Response("invalid env vars", { status: 400 });
  }
  if (error.message === "agent_not_found" || error.message === "repository_not_found") {
    return new Response("Not found", { status: 404 });
  }
  throw error;
}

/**
 * The refusal a workspace's last usable agent gets. 409 rather than 400: the
 * request is well-formed, the workspace's state is what forbids it. The message
 * is the one the UI shows verbatim, so it says what to do next.
 */
function lastAgentRefusal(verb: "disabled" | "deleted"): Response {
  return new Response(
    `This is the workspace's only agent, so it can't be ${verb}. Create another agent first.`,
    { status: 409 },
  );
}
