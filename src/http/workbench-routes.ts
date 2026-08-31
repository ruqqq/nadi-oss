import type { Env } from "../env";
import { validateRequestSession, type ValidatedSession } from "../auth/session";
import { registryDb } from "../db/client";
import { WorkbenchRepository, type WorkbenchRepositoryEntry } from "../db/repositories/workbenches";
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
import type { AgentConfig, AgentRepositoryRow } from "../db/schema";
import { resolveAgentScope } from "./agent-scope";
import {
  COMPUTE_RESOURCE_PROFILE_IDS,
  parseDomainList,
  validateSandboxDomain,
} from "../compute/config";
import type { ComputeResourceProfile } from "../compute/backend";

type WorkbenchBody = {
  name?: unknown;
  description?: unknown;
  setupScript?: unknown;
  resourceProfile?: unknown;
  networkDomainAllowlist?: unknown;
};

type WorkbenchSummary = AgentConfig & {
  repositories: AgentRepositoryRow[];
  envVars: Record<string, string>;
  secretEnvNames: string[];
  /** Additional host-allowlist domains, additive on top of the workspace list. */
  networkDomainAllowlist: string;
};

export async function routeWorkbenches(req: Request, env: Env): Promise<Response | null> {
  const url = new URL(req.url);

  if (url.pathname === "/api/workbenches") {
    if (req.method === "GET") return listWorkbenches(req, env, url);
    if (req.method === "POST") return createWorkbench(req, env);
    return new Response("Method not allowed", { status: 405 });
  }

  const archiveId = matchId(url.pathname, /^\/api\/workbenches\/([^/]+)\/archive$/);
  if (archiveId !== null) {
    if (req.method === "POST") return archiveWorkbench(req, env, archiveId);
    return new Response("Method not allowed", { status: 405 });
  }

  const reposId = matchId(url.pathname, /^\/api\/workbenches\/([^/]+)\/repositories$/);
  if (reposId !== null) {
    if (req.method === "PUT") return replaceRepositories(req, env, reposId);
    return new Response("Method not allowed", { status: 405 });
  }

  const envVarsId = matchId(url.pathname, /^\/api\/workbenches\/([^/]+)\/env-vars$/);
  if (envVarsId !== null) {
    if (req.method === "PUT") return setEnvVars(req, env, envVarsId);
    return new Response("Method not allowed", { status: 405 });
  }

  const secretMatch = url.pathname.match(/^\/api\/workbenches\/([^/]+)\/secrets\/([^/]+)$/);
  if (secretMatch?.[1] && secretMatch[2]) {
    const workbenchId = decodeURIComponent(secretMatch[1]);
    const name = decodeURIComponent(secretMatch[2]);
    if (req.method === "PUT") return setSecret(req, env, workbenchId, name);
    if (req.method === "DELETE") return deleteSecret(req, env, workbenchId, name);
    return new Response("Method not allowed", { status: 405 });
  }

  const workbenchId = matchId(url.pathname, /^\/api\/workbenches\/([^/]+)$/);
  if (workbenchId !== null) {
    if (req.method === "GET") return getWorkbench(req, env, workbenchId);
    if (req.method === "PATCH") return updateWorkbench(req, env, workbenchId);
    return new Response("Method not allowed", { status: 405 });
  }

  if (url.pathname.startsWith("/api/workbenches/")) {
    return new Response("Not found", { status: 404 });
  }

  return null;
}

async function listWorkbenches(req: Request, env: Env, url: URL): Promise<Response> {
  const session = await validateRequestSession(env, req);
  if (!session) return new Response("Unauthorized", { status: 401 });

  const status = parseStatus(url.searchParams.get("status"));
  if (!status.ok) return status.response;

  const workspaceId = await resolveWorkspaceId(env, session);
  if (!workspaceId) return Response.json({ workbenches: [] });

  const db = registryDb(env);
  const repo = new WorkbenchRepository(db);
  const rows = await repo.listForWorkspace(workspaceId, status.value);
  const workbenches = await Promise.all(
    rows.map((row) => buildSummary(env, repo, workspaceId, row)),
  );
  return Response.json({ workbenches });
}

async function createWorkbench(req: Request, env: Env): Promise<Response> {
  const session = await validateRequestSession(env, req);
  if (!session) return new Response("Unauthorized", { status: 401 });

  const workspaceId = await resolveWorkspaceId(env, session);
  if (!workspaceId) return new Response("Workspace not found", { status: 404 });

  const body = (await req.json().catch(() => null)) as WorkbenchBody | null;
  const parsed = parseCreatePayload(body);
  if (!parsed.ok) return parsed.response;

  const db = registryDb(env);
  const repo = new WorkbenchRepository(db);
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
    const workbench = await repo.create({
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
      // A brand-new workbench has no pre-existing KV secrets, so its D1 name
      // index is already authoritative — skip the one-time KV backfill probe.
      secretNamesBackfilled: true,
      createdAt,
      updatedAt: createdAt,
    });
    const summary = await buildSummary(env, repo, workspaceId, workbench);
    return Response.json({ workbench: summary }, { status: 201 });
  } catch (error) {
    return mapWorkbenchError(error);
  }
}

async function getWorkbench(req: Request, env: Env, workbenchId: string): Promise<Response> {
  const session = await validateRequestSession(env, req);
  if (!session) return new Response("Unauthorized", { status: 401 });

  const db = registryDb(env);
  const repo = new WorkbenchRepository(db);
  const workbench = await repo.getById(workbenchId);
  if (!workbench) return new Response("Not found", { status: 404 });

  const membership = await assertMember(db, workbench.workspaceId, session.user.id);
  if (!membership) return new Response("Not found", { status: 404 });

  const summary = await buildSummary(env, repo, workbench.workspaceId, workbench);
  return Response.json({ workbench: summary });
}

async function updateWorkbench(req: Request, env: Env, workbenchId: string): Promise<Response> {
  const session = await validateRequestSession(env, req);
  if (!session) return new Response("Unauthorized", { status: 401 });

  const db = registryDb(env);
  const repo = new WorkbenchRepository(db);
  const workbench = await repo.getById(workbenchId);
  if (!workbench) return new Response("Not found", { status: 404 });

  const membership = await assertMember(db, workbench.workspaceId, session.user.id);
  if (!membership) return new Response("Not found", { status: 404 });

  const body = (await req.json().catch(() => null)) as WorkbenchBody | null;
  const parsed = parsePatchPayload(body);
  if (!parsed.ok) return parsed.response;

  if (Object.keys(parsed.value).length === 0) {
    return new Response("No valid fields to update", { status: 400 });
  }

  try {
    await repo.update(workbenchId, { ...parsed.value, updatedAt: Date.now() });
  } catch (error) {
    return mapWorkbenchError(error);
  }

  const updated = await repo.getById(workbenchId);
  if (!updated) return new Response("Not found", { status: 404 });
  const summary = await buildSummary(env, repo, updated.workspaceId, updated);
  return Response.json({ workbench: summary });
}

async function archiveWorkbench(req: Request, env: Env, workbenchId: string): Promise<Response> {
  const session = await validateRequestSession(env, req);
  if (!session) return new Response("Unauthorized", { status: 401 });

  const db = registryDb(env);
  const repo = new WorkbenchRepository(db);
  const workbench = await repo.getById(workbenchId);
  if (!workbench) return new Response("Not found", { status: 404 });

  const membership = await assertMember(db, workbench.workspaceId, session.user.id);
  if (!membership) return new Response("Not found", { status: 404 });

  await repo.archive(workbenchId, Date.now());
  const archived = await repo.getById(workbenchId);
  if (!archived) return new Response("Not found", { status: 404 });
  const summary = await buildSummary(env, repo, archived.workspaceId, archived);
  return Response.json({ workbench: summary });
}

async function replaceRepositories(req: Request, env: Env, workbenchId: string): Promise<Response> {
  const session = await validateRequestSession(env, req);
  if (!session) return new Response("Unauthorized", { status: 401 });

  const db = registryDb(env);
  const repo = new WorkbenchRepository(db);
  const workbench = await repo.getById(workbenchId);
  if (!workbench) return new Response("Not found", { status: 404 });

  const membership = await assertMember(db, workbench.workspaceId, session.user.id);
  if (!membership) return new Response("Not found", { status: 404 });

  const body = (await req.json().catch(() => null)) as unknown;
  const parsed = parseRepositoryEntries(body);
  if (!parsed.ok) return parsed.response;

  try {
    await repo.replaceRepositories(workbenchId, workbench.workspaceId, parsed.value, Date.now());
  } catch (error) {
    return mapWorkbenchError(error);
  }

  const updated = await repo.getById(workbenchId);
  if (!updated) return new Response("Not found", { status: 404 });
  const summary = await buildSummary(env, repo, updated.workspaceId, updated);
  return Response.json({ workbench: summary });
}

async function setEnvVars(req: Request, env: Env, workbenchId: string): Promise<Response> {
  const session = await validateRequestSession(env, req);
  if (!session) return new Response("Unauthorized", { status: 401 });

  const db = registryDb(env);
  const repo = new WorkbenchRepository(db);
  const workbench = await repo.getById(workbenchId);
  if (!workbench) return new Response("Not found", { status: 404 });

  const membership = await assertMember(db, workbench.workspaceId, session.user.id);
  if (!membership) return new Response("Not found", { status: 404 });

  const body = (await req.json().catch(() => null)) as { envVars?: unknown } | null;
  let sandboxEnvVarsJson: string;
  try {
    const map = parseEnvVarMap(body?.envVars ?? {});
    sandboxEnvVarsJson = serializeEnvVarsJson(map);
  } catch (error) {
    return mapWorkbenchError(error);
  }

  await repo.update(workbenchId, { sandboxEnvVarsJson, updatedAt: Date.now() });

  const updated = await repo.getById(workbenchId);
  if (!updated) return new Response("Not found", { status: 404 });
  const summary = await buildSummary(env, repo, updated.workspaceId, updated);
  return Response.json({ workbench: summary });
}

async function setSecret(
  req: Request,
  env: Env,
  workbenchId: string,
  name: string,
): Promise<Response> {
  const session = await validateRequestSession(env, req);
  if (!session) return new Response("Unauthorized", { status: 401 });

  const db = registryDb(env);
  const repo = new WorkbenchRepository(db);
  const workbench = await repo.getById(workbenchId);
  if (!workbench) return new Response("Not found", { status: 404 });

  const membership = await assertMember(db, workbench.workspaceId, session.user.id);
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
  await secretStore.setAgent(workbench.workspaceId, workbenchId, validName, body.value);
  // Backfill legacy names before adding this one, so the D1 index is complete
  // and the returned summary lists every secret, not just the new one.
  await ensureWorkbenchSecretNamesBackfilled(env, repo, workbench);
  await repo.putSecretName(workbenchId, validName, Date.now());

  const updated = await repo.getById(workbenchId);
  if (!updated) return new Response("Not found", { status: 404 });
  const summary = await buildSummary(env, repo, updated.workspaceId, updated);
  return Response.json({ workbench: summary });
}

async function deleteSecret(
  req: Request,
  env: Env,
  workbenchId: string,
  name: string,
): Promise<Response> {
  const session = await validateRequestSession(env, req);
  if (!session) return new Response("Unauthorized", { status: 401 });

  const db = registryDb(env);
  const repo = new WorkbenchRepository(db);
  const workbench = await repo.getById(workbenchId);
  if (!workbench) return new Response("Not found", { status: 404 });

  const membership = await assertMember(db, workbench.workspaceId, session.user.id);
  if (!membership) return new Response("Not found", { status: 404 });

  const secretStore = new ComputeEnvSecretsStore(createWorkspaceSecretsServices(env));
  await secretStore.deleteAgent(workbench.workspaceId, workbenchId, name);
  // Backfill from the KV list BEFORE removing this name: that list still
  // includes the just-deleted key while KV propagates, so seeding first then
  // deleting lets the D1 removal win — otherwise the stale list would re-add it.
  await ensureWorkbenchSecretNamesBackfilled(env, repo, workbench);
  await repo.deleteSecretName(workbenchId, name);

  const updated = await repo.getById(workbenchId);
  if (!updated) return new Response("Not found", { status: 404 });
  const summary = await buildSummary(env, repo, updated.workspaceId, updated);
  return Response.json({ workbench: summary });
}

async function buildSummary(
  env: Env,
  repo: WorkbenchRepository,
  _workspaceId: string,
  row: AgentConfig,
): Promise<WorkbenchSummary> {
  const [repositories, secretEnvNames] = await Promise.all([
    repo.listRepositories(row.id),
    loadWorkbenchSecretNames(env, repo, row),
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
 * The workbench's secret names, read from the strongly-consistent D1 index.
 * A workbench predating that index gets its names seeded from the KV list once
 * (see {@link ensureWorkbenchSecretNamesBackfilled}); every read after that is
 * pure D1, so a just-added secret shows immediately and a deleted one is gone
 * immediately — neither waits on KV `list` propagation.
 */
async function loadWorkbenchSecretNames(
  env: Env,
  repo: WorkbenchRepository,
  workbench: AgentConfig,
): Promise<string[]> {
  await ensureWorkbenchSecretNamesBackfilled(env, repo, workbench);
  return repo.listSecretNames(workbench.id);
}

async function ensureWorkbenchSecretNamesBackfilled(
  env: Env,
  repo: WorkbenchRepository,
  workbench: AgentConfig,
): Promise<void> {
  if (workbench.secretNamesBackfilled) return;
  const secretStore = new ComputeEnvSecretsStore(createWorkspaceSecretsServices(env));
  const kvNames = await secretStore.listAgentNames(workbench.workspaceId, workbench.id);
  await repo.backfillSecretNames(
    workbench.id,
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
  body: WorkbenchBody | null,
): { ok: true; value: CreateWorkbenchInput } | { ok: false; response: Response } {
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
  body: WorkbenchBody | null,
): { ok: true; value: PatchWorkbenchInput } | { ok: false; response: Response } {
  const patch: PatchWorkbenchInput = {};

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

type CreateWorkbenchInput = {
  name: string;
  description: string;
  setupScript: string;
  resourceProfile?: ComputeResourceProfile;
  networkDomainAllowlist?: string;
};

type PatchWorkbenchInput = Partial<CreateWorkbenchInput> & {
  sandboxNetworkDomainAllowlist?: string;
};

/** Parses the `PUT /api/workbenches/:id/repositories` body: an array of full repo entries. */
export function parseRepositoryEntries(
  body: unknown,
): { ok: true; value: WorkbenchRepositoryEntry[] } | { ok: false; response: Response } {
  if (!Array.isArray(body)) {
    return { ok: false, response: new Response("body must be an array", { status: 400 }) };
  }

  const entries: WorkbenchRepositoryEntry[] = [];
  for (const item of body) {
    const parsed = parseRepositoryEntry(item);
    if (!parsed.ok) return parsed;
    entries.push(parsed.value);
  }
  return { ok: true, value: entries };
}

function parseRepositoryEntry(
  item: unknown,
): { ok: true; value: WorkbenchRepositoryEntry } | { ok: false; response: Response } {
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

function mapWorkbenchError(error: unknown): Response {
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
  if (error.message === "workbench_not_found" || error.message === "repository_not_found") {
    return new Response("Not found", { status: 404 });
  }
  throw error;
}
