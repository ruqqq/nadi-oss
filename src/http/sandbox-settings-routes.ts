import { asc, eq } from "drizzle-orm";
import { validateRequestSession } from "../auth/session";
import { registryDb } from "../db/client";
import { agents, workspaceSandboxSettings } from "../db/schema";
import { WorkspaceRepository } from "../db/repositories/workspaces";
import { platformCapabilities } from "../edition";
import type { Env } from "../env";
import { log } from "../log";
import {
  DEFAULT_COMPUTE_LIMITS,
  clampPositiveInt,
  defaultProviderConfig,
  mockSandboxEnabled,
  parseDomainList,
  providerConfigSchema,
  validateSandboxDomain,
} from "../compute/config";
import { ComputeEnvSecretsStore } from "../compute/env-secrets";
import { parseEnvVarMap, serializeEnvVarsJson, validateEnvVarName } from "../compute/env-vars";
import type {
  BackendReference,
  ComputeBackend,
  ComputeSpec,
  ProcessStatus,
  StartProcessResult,
} from "../compute/backend";
import { DaytonaComputeBackend } from "../compute/backends/daytona";
import { resolveDaytonaConfiguration } from "../compute/daytona-config";
import { createSpritesClient } from "../compute/backends/sprites-client";
import { resolveSpritesConfiguration } from "../compute/sprites-config";
import { buildComputeBackend } from "../compute/registry";
import { ComputeError } from "../compute/errors";
import {
  computeProviderReadiness,
  getAgentComputeSettings,
  getComputeSettingsView,
  getWorkspaceComputeSettings,
  saveDaytonaApiKey,
} from "../compute/settings";
import type {
  EffectiveComputeConfig,
  ProviderConfig,
  WorkspaceComputeSettings,
} from "../compute/types";
import { createWorkspaceSecretsServices } from "../secrets";

export async function routeSandboxSettings(req: Request, env: Env): Promise<Response | null> {
  const url = new URL(req.url);
  if (!url.pathname.startsWith("/api/settings/sandbox")) return null;

  const target = await resolveDefaultAgentTarget(req, env);
  if (!target.ok) return target.response;

  if (url.pathname === "/api/settings/sandbox") {
    if (req.method === "GET")
      return Response.json(await getComputeSettingsView({ env, ...target }));
    if (req.method === "PUT")
      return updateWorkspaceSandboxSettings(req, env, target.workspaceId, target.agentId);
    return new Response("Method not allowed", { status: 405 });
  }

  if (url.pathname === "/api/settings/sandbox/agent") {
    if (req.method === "PUT")
      return updateAgentSandboxSettings(req, env, target.workspaceId, target.agentId);
    return new Response("Method not allowed", { status: 405 });
  }

  if (url.pathname === "/api/settings/sandbox/daytona-secret") {
    if (req.method === "PUT")
      return updateDaytonaSecret(req, env, target.workspaceId, target.agentId);
    if (req.method === "DELETE")
      return clearDaytonaOverride(env, target.workspaceId, target.agentId);
    return new Response("Method not allowed", { status: 405 });
  }

  if (url.pathname === "/api/settings/sandbox/sprites-secret") {
    if (req.method === "PUT")
      return updateSpritesSecret(req, env, target.workspaceId, target.agentId);
    if (req.method === "DELETE")
      return clearSpritesOverride(env, target.workspaceId, target.agentId);
    return new Response("Method not allowed", { status: 405 });
  }

  if (url.pathname === "/api/settings/sandbox/test") {
    if (req.method === "POST") return testComputeConnection(env, target.workspaceId);
    return new Response("Method not allowed", { status: 405 });
  }

  if (url.pathname === "/api/settings/sandbox/env") {
    if (req.method === "PUT")
      return updateEnvVars(req, env, target.workspaceId, target.agentId, "workspace");
    return new Response("Method not allowed", { status: 405 });
  }
  if (url.pathname === "/api/settings/sandbox/agent/env") {
    if (req.method === "PUT")
      return updateEnvVars(req, env, target.workspaceId, target.agentId, "agent");
    return new Response("Method not allowed", { status: 405 });
  }
  if (url.pathname === "/api/settings/sandbox/secret-env") {
    if (req.method === "PUT")
      return upsertSecretEnv(req, env, target.workspaceId, target.agentId, "workspace");
    if (req.method === "DELETE")
      return deleteSecretEnv(req, env, target.workspaceId, target.agentId, "workspace");
    return new Response("Method not allowed", { status: 405 });
  }
  if (url.pathname === "/api/settings/sandbox/agent/secret-env") {
    if (req.method === "PUT")
      return upsertSecretEnv(req, env, target.workspaceId, target.agentId, "agent");
    if (req.method === "DELETE")
      return deleteSecretEnv(req, env, target.workspaceId, target.agentId, "agent");
    return new Response("Method not allowed", { status: 405 });
  }

  return new Response("Not found", { status: 404 });
}

async function resolveDefaultAgentTarget(
  req: Request,
  env: Env,
): Promise<{ ok: true; workspaceId: string; agentId: string } | { ok: false; response: Response }> {
  const session = await validateRequestSession(env, req);
  if (!session) return { ok: false, response: new Response("Unauthorized", { status: 401 }) };
  const db = registryDb(env);
  const workspace = await new WorkspaceRepository(db).getCurrentWorkspaceForOwner(session.user.id);
  if (!workspace) return { ok: false, response: new Response("Not found", { status: 404 }) };
  const agent = await db
    .select({ id: agents.id })
    .from(agents)
    .where(eq(agents.workspaceId, workspace.id))
    .orderBy(asc(agents.createdAt))
    .get();
  if (!agent) return { ok: false, response: new Response("Not found", { status: 404 }) };
  return { ok: true, workspaceId: workspace.id, agentId: agent.id };
}

async function updateWorkspaceSandboxSettings(
  req: Request,
  env: Env,
  workspaceId: string,
  agentId: string,
): Promise<Response> {
  const body = (await req.json().catch(() => null)) as Record<string, unknown> | null;
  if (!body) return new Response("Malformed JSON", { status: 400 });

  // MERGE, don't clobber: a partial PUT (e.g. just toggling `enabled`) must not
  // reset unrelated fields (limits, secret name, runtime ceiling) to defaults.
  // Only overwrite a field when the request actually supplies it; otherwise keep
  // the existing stored value, falling back to a default when there is no row.
  const existing = await getWorkspaceComputeSettings(env, workspaceId);

  const enabled = typeof body.enabled === "boolean" ? body.enabled : (existing?.enabled ?? false);
  const provider =
    typeof body.provider === "string" ? body.provider : (existing?.provider ?? "daytona");
  let providerConfig;
  try {
    if (body.providerConfig !== undefined) {
      providerConfig = providerConfigSchema.parse(body.providerConfig);
    } else if (existing?.provider === provider) {
      providerConfig = existing.providerConfig;
    } else {
      providerConfig = defaultProviderConfig(provider);
    }
  } catch {
    return new Response("invalid provider config", { status: 400 });
  }
  if (provider !== providerConfig.kind)
    return new Response("provider config does not match provider", { status: 400 });
  // Mock is a test double, selectable only where the deployment opted into it.
  // Enforced here and not just hidden in the UI, because hiding an option does
  // not stop a hand-rolled PUT from setting it. Switching AWAY from mock stays
  // allowed, so a workspace left on mock is never stuck.
  if (provider === "mock" && !mockSandboxEnabled(env))
    return new Response("provider unavailable", { status: 400 });
  // Same shape as the mock gate, for the same reason: hiding an option in the
  // UI does not stop a hand-rolled PUT. celld has no container bindings, so
  // `cloudflare` there is a workspace whose every sandbox tool fails at
  // acquire. Switching AWAY stays allowed, so a workspace that arrived on
  // `cloudflare` (a celld deploy that never set DEFAULT_SANDBOX_PROVIDER seeds
  // it) is never stuck on it.
  if (provider === "cloudflare" && !platformCapabilities(env).containerSandbox)
    return new Response("provider unavailable", { status: 400 });
  const networkRestrictionEnabled =
    typeof body.networkRestrictionEnabled === "boolean"
      ? body.networkRestrictionEnabled
      : (existing?.networkRestrictionEnabled ?? false);
  // MERGE-preserve like `snapshot`: a present string is validated (each
  // domain must parse via `validateSandboxDomain`) and stored trimmed; an
  // empty string is an explicit clear; omitting the key preserves whatever
  // was previously saved.
  let networkDomainAllowlist: string;
  try {
    if (typeof body.networkDomainAllowlist === "string") {
      const trimmed = body.networkDomainAllowlist.trim();
      if (trimmed) parseDomainList(trimmed).forEach(validateSandboxDomain);
      networkDomainAllowlist = trimmed;
    } else {
      networkDomainAllowlist = existing?.networkDomainAllowlist ?? "";
    }
  } catch {
    return new Response("invalid domain", { status: 400 });
  }
  // Preserve any customized limits (nothing in this endpoint edits them yet).
  const limitsJson = JSON.stringify(existing?.limits ?? DEFAULT_COMPUTE_LIMITS);
  const row = {
    workspaceId,
    enabled,
    provider,
    providerConfigJson: JSON.stringify(providerConfig),
    networkRestrictionEnabled,
    networkDomainAllowlist,
    idleTimeoutMs:
      body.idleTimeoutMs === undefined
        ? (existing?.idleTimeoutMs ?? 900000)
        : clampPositiveInt(body.idleTimeoutMs, 900000, 86_400_000),
    recoveryTtlMs:
      body.recoveryTtlMs === undefined
        ? (existing?.recoveryTtlMs ?? 86_400_000)
        : clampPositiveInt(body.recoveryTtlMs, 86_400_000, 604_800_000),
    maxProcessRuntimeMs:
      body.maxProcessRuntimeMs === undefined
        ? (existing?.maxProcessRuntimeMs ?? 600000)
        : clampPositiveInt(body.maxProcessRuntimeMs, 600000, 86_400_000),
    limitsJson,
    updatedAt: Date.now(),
  };
  await registryDb(env)
    .insert(workspaceSandboxSettings)
    .values({ ...row, createdAt: Date.now() })
    .onConflictDoUpdate({ target: workspaceSandboxSettings.workspaceId, set: row });
  return Response.json(await getComputeSettingsView({ env, workspaceId, agentId }));
}

async function updateAgentSandboxSettings(
  req: Request,
  env: Env,
  workspaceId: string,
  agentId: string,
): Promise<Response> {
  const body = (await req.json().catch(() => null)) as Record<string, unknown> | null;
  if (!body) return new Response("Malformed JSON", { status: 400 });
  const existing = await getAgentComputeSettings(env, workspaceId, agentId);
  // MERGE-preserve like `snapshot` above: a present string is validated and
  // stored trimmed (empty string clears it to null), omitting the key
  // preserves the previously saved value.
  let sandboxNetworkDomainAllowlist: string | null;
  try {
    if (typeof body.networkDomainAllowlist === "string") {
      const trimmed = body.networkDomainAllowlist.trim();
      if (trimmed) parseDomainList(trimmed).forEach(validateSandboxDomain);
      sandboxNetworkDomainAllowlist = trimmed || null;
    } else {
      const existing = await getAgentComputeSettings(env, workspaceId, agentId);
      sandboxNetworkDomainAllowlist = existing?.networkDomainAllowlist ?? null;
    }
  } catch {
    return new Response("invalid domain", { status: 400 });
  }
  await registryDb(env)
    .update(agents)
    .set({
      // Same null-clears-the-override rule as `resourceProfile` above.
      sandboxEnabled:
        body.enabled === null
          ? null
          : typeof body.enabled === "boolean"
            ? body.enabled
            : (existing?.enabled ?? null),
      sandboxNetworkDomainAllowlist,
      sandboxIdleTimeoutMs:
        typeof body.idleTimeoutMs === "number"
          ? clampPositiveInt(body.idleTimeoutMs, 900000, 86_400_000)
          : (existing?.idleTimeoutMs ?? null),
      sandboxMaxProcessRuntimeMs:
        typeof body.maxProcessRuntimeMs === "number"
          ? clampPositiveInt(body.maxProcessRuntimeMs, 600000, 86_400_000)
          : (existing?.maxProcessRuntimeMs ?? null),
    })
    .where(eq(agents.id, agentId));
  return Response.json(await getComputeSettingsView({ env, workspaceId, agentId }));
}

type SandboxConnectionTestErrorPhase = "connection" | "cleanup";

/** Marker echoed by the probe command; the probe must read it back verbatim. */
const CONNECTION_PROBE_MARKER = "nadi-compute-ready";

/**
 * The connection test has no real thread, but `CloudflareComputeBackend` derives
 * its Durable Object identity from (workspaceId, threadId) and refuses a missing
 * one. Use a stable synthetic id so the probe reuses (and discards) a single
 * throwaway DO per workspace rather than leaking one each run.
 */
const CONNECTION_TEST_THREAD_ID = "__nadi_connection_test__";

/**
 * Provider-neutral connection test. Resolves the workspace's provider, builds a
 * backend, then acquires a `small` runtime, runs `printf nadi-compute-ready` and
 * verifies the marker echoes back, and releases with `disposition: "discard"` in
 * a `finally`. A cleanup failure AFTER a working acquire+probe is reported as a
 * distinct `"cleanup"` phase (a sandbox may have leaked) rather than
 * `"connection"`. Responses carry `provider`, `ok`, and `phase`, and never raw
 * SDK text or secrets (errors are reduced to the compute taxonomy code).
 *
 * Daytona keeps its source/secret validation and the `COMPUTE_TEST_BACKEND_FACTORY`
 * test seam; Cloudflare is resolved through the registry, which validates the
 * deployment bindings and picks the backup path.
 */
async function testComputeConnection(env: Env, workspaceId: string): Promise<Response> {
  const workspace = await getWorkspaceComputeSettings(env, workspaceId);
  if (!workspace) {
    return Response.json(
      { ok: false, phase: "connection", error: "missing_workspace_settings" },
      { status: 400 },
    );
  }

  const provider = workspace.providerConfig.kind;
  const resolved = await resolveTestBackend(env, workspaceId, workspace);
  if ("response" in resolved) return resolved.response;

  const spec: ComputeSpec = {
    environmentId: resolved.environmentId,
    profile: "small",
    workspaceRoot: "/workspace",
    env: {},
    maxProcessRuntimeMs: workspace.maxProcessRuntimeMs,
    // A restricted workspace never reaches Cloudflare (readiness/UI block it) and
    // Daytona applies its own restrictions elsewhere; the probe itself is
    // unrestricted so it only measures reachability.
    allowedHosts: null,
  };

  return runConnectionProbe(resolved.backend, provider, spec);
}

/**
 * Resolve the backend to probe for `workspace`'s provider, or an early 400
 * response describing why the config is not testable. Daytona uses the
 * `COMPUTE_TEST_BACKEND_FACTORY` seam; Cloudflare is gated on readiness then
 * built through the registry with a synthetic thread id.
 */
async function resolveTestBackend(
  env: Env,
  workspaceId: string,
  workspace: WorkspaceComputeSettings,
): Promise<{ backend: ComputeBackend; environmentId: string } | { response: Response }> {
  const providerConfig = workspace.providerConfig;
  if (providerConfig.kind === "daytona") {
    const resolved = await resolveDaytonaConfiguration({ env, workspaceId, providerConfig });
    const source = resolved.profiles.small;
    if (!source) {
      return {
        response: Response.json(
          { ok: false, provider: "daytona", phase: "connection", error: "missing_source" },
          { status: 400 },
        ),
      };
    }
    if (!resolved.apiKey) {
      return {
        response: Response.json(
          { ok: false, provider: "daytona", phase: "connection", error: "missing_secret" },
          { status: 400 },
        ),
      };
    }
    const createBackend =
      env.COMPUTE_TEST_BACKEND_FACTORY ??
      ((config: {
        apiKey: string;
        apiUrl: string | null;
        target: string | null;
        source: { image?: string; snapshot?: string };
      }): ComputeBackend => new DaytonaComputeBackend(config));
    const backend = createBackend({
      apiKey: resolved.apiKey,
      apiUrl: resolved.apiUrl,
      target: resolved.target,
      source: { [source.kind]: source.value },
    });
    return { backend, environmentId: source.value };
  }

  // Mock: the local-dev in-memory provider is always testable — it needs no
  // deployment config, so it skips the Cloudflare readiness gate below (which
  // only speaks to the Cloudflare provider) and builds directly.
  if (providerConfig.kind === "mock") {
    const backend = await buildComputeBackend(
      env,
      workspaceId,
      CONNECTION_TEST_THREAD_ID,
      testEffectiveConfig(workspace, providerConfig),
    );
    return { backend, environmentId: "mock:small" };
  }

  // Sprites: no acquire/probe backend exists yet, so the connection test is a
  // list-based probe run inline here and returned directly. Returning a
  // `response` short-circuits `runConnectionProbe` below — the sprites test
  // never creates a sprite.
  if (providerConfig.kind === "sprites") {
    const resolved = await resolveSpritesConfiguration({ env, workspaceId, providerConfig });
    if (!resolved.apiKey) {
      return {
        response: Response.json(
          { ok: false, provider: "sprites", phase: "connection", error: "missing_secret" },
          { status: 400 },
        ),
      };
    }
    // List-based probe (per the approved spec): no sandbox is created. An
    // authenticated GET /v1/sprites proves the key + reachability.
    try {
      await createSpritesClient({ apiKey: resolved.apiKey }).listSprites(1);
      return { response: Response.json({ ok: true, provider: "sprites" }) };
    } catch (error) {
      return {
        response: Response.json(
          {
            ok: false,
            provider: "sprites",
            phase: "connection",
            error: error instanceof Error ? error.message : String(error),
          },
          { status: 502 },
        ),
      };
    }
  }

  // Cloudflare: fail closed early when the deployment is not ready (the same
  // signal the settings UI keys off), so we never build a backend that can't run.
  const readiness = computeProviderReadiness({
    env,
    provider: "cloudflare",
    networkRestricted: false,
  });
  if (!readiness.ready) {
    return {
      response: Response.json(
        {
          ok: false,
          provider: "cloudflare",
          phase: "connection",
          error: "provider_not_deployable",
          missingConfig: readiness.missingConfig,
          unsupported: readiness.unsupported,
        },
        { status: 400 },
      ),
    };
  }
  const backend = await buildComputeBackend(
    env,
    workspaceId,
    CONNECTION_TEST_THREAD_ID,
    testEffectiveConfig(workspace, providerConfig),
  );
  return { backend, environmentId: "cloudflare:small" };
}

/**
 * Minimal effective config for the registry's Cloudflare branch, which reads
 * only `providerConfig.kind`. The other fields are populated from the workspace
 * for type-correctness; the Cloudflare builder ignores them.
 */
function testEffectiveConfig(
  workspace: WorkspaceComputeSettings,
  providerConfig: ProviderConfig,
): EffectiveComputeConfig {
  return {
    provider: workspace.provider,
    providerConfig,
    resourceProfile: "small",
    idleTimeoutMs: workspace.idleTimeoutMs,
    recoveryTtlMs: workspace.recoveryTtlMs,
    maxProcessRuntimeMs: workspace.maxProcessRuntimeMs,
    monitorPollIntervalMs: 0,
    limits: workspace.limits,
    allowedHosts: null,
    editableEnv: {},
    agentEditableEnv: {},
    secretEnvNames: [],
    environmentEditableEnv: {},
    environmentSecretEnvNames: [],
  };
}

async function runConnectionProbe(
  backend: ComputeBackend,
  provider: string,
  spec: ComputeSpec,
): Promise<Response> {
  let runtime: BackendReference | undefined;
  let connectionError: unknown;
  try {
    runtime = await backend.acquire(spec);
    const started = await backend.startProcess(runtime, {
      command: `printf ${CONNECTION_PROBE_MARKER}`,
      timeoutMs: 30_000,
    });
    await waitForProcessExit(backend, runtime, started);
    const output = await backend.readProcessOutput(runtime, started.process);
    if ((output.stdout ?? "").trim() !== CONNECTION_PROBE_MARKER) {
      throw new ComputeError("provider_transient", "compute_probe_output_mismatch");
    }
  } catch (err) {
    connectionError = err;
  }

  // Always attempt teardown, even on a connection failure, so a probe never
  // leaks a sandbox. A teardown failure is its own phase.
  let cleanupError: unknown;
  if (runtime) {
    try {
      await backend.release(runtime, { disposition: "discard" });
    } catch (err) {
      cleanupError = err;
    }
  }

  if (connectionError) {
    return failure(provider, "connection", connectionError);
  }
  if (cleanupError) {
    return failure(provider, "cleanup", cleanupError);
  }
  return Response.json({ ok: true, provider });
}

/** Poll until the probe process exits (printf is near-instant); bounded so a
 * stuck process can't hang the request. */
async function waitForProcessExit(
  backend: ComputeBackend,
  runtime: BackendReference,
  started: StartProcessResult,
): Promise<ProcessStatus> {
  if (started.status !== "running") return started;
  for (let attempt = 0; attempt < 40; attempt += 1) {
    const status = await backend.getProcessStatus(runtime, started.process);
    if (status.status !== "running") return status;
    await delay(250);
  }
  return { status: "running" };
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function failure(provider: string, phase: SandboxConnectionTestErrorPhase, err: unknown): Response {
  return Response.json({ ok: false, provider, phase, error: safeErrorCode(err) });
}

/**
 * Reduce a thrown value to a safe, stable string. A `ComputeError` yields its
 * taxonomy `code` (never the message, which can embed raw SDK text); other
 * errors surface their message. Both backends normalize SDK failures to
 * `ComputeError`, so raw provider text does not reach the browser.
 */
function safeErrorCode(err: unknown): string {
  if (err instanceof ComputeError) return err.code;
  return err instanceof Error ? err.message : "unknown_error";
}

async function updateDaytonaSecret(
  req: Request,
  env: Env,
  workspaceId: string,
  agentId: string,
): Promise<Response> {
  const body = (await req.json().catch(() => null)) as {
    value?: unknown;
    secretName?: unknown;
  } | null;
  if (typeof body?.value !== "string" || !body.value.trim()) {
    return new Response("value must be a non-empty string", { status: 400 });
  }
  const workspace = await getWorkspaceComputeSettings(env, workspaceId);
  if (workspace?.providerConfig.kind === "cloudflare") {
    return new Response("Daytona credentials require the Daytona provider", { status: 400 });
  }
  const defaultDaytonaConfig = defaultProviderConfig("daytona");
  if (defaultDaytonaConfig.kind !== "daytona") throw new Error("invalid_daytona_default");
  const configuredSecretName =
    workspace?.providerConfig.kind === "daytona"
      ? workspace.providerConfig.apiKeySecretName
      : defaultDaytonaConfig.apiKeySecretName;
  const suppliedSecretName =
    typeof body.secretName === "string" && body.secretName.trim()
      ? body.secretName.trim()
      : configuredSecretName;
  if (suppliedSecretName !== configuredSecretName) {
    return new Response("secretName must match the configured Daytona secret", { status: 400 });
  }
  try {
    await saveDaytonaApiKey({
      env,
      workspaceId,
      secretName: configuredSecretName,
      value: body.value,
    });
  } catch (err) {
    if (err instanceof Error && err.message === "invalid_secret_name") {
      return new Response("invalid secretName", { status: 400 });
    }
    throw err;
  }
  return Response.json(await getComputeSettingsView({ env, workspaceId, agentId }));
}

async function clearDaytonaOverride(
  env: Env,
  workspaceId: string,
  agentId: string,
): Promise<Response> {
  const workspace = await getWorkspaceComputeSettings(env, workspaceId);
  const defaultDaytonaConfig = defaultProviderConfig("daytona");
  if (defaultDaytonaConfig.kind !== "daytona") throw new Error("invalid_daytona_default");
  const secretName =
    workspace?.providerConfig.kind === "daytona"
      ? workspace.providerConfig.apiKeySecretName
      : defaultDaytonaConfig.apiKeySecretName;
  const { store, writer } = createWorkspaceSecretsServices(env);
  const existingKey = await store.get(workspaceId, secretName);
  await writer.delete(workspaceId, secretName);

  if (workspace?.providerConfig.kind === "daytona") {
    try {
      if (env.COMPUTE_TEST_RESET_DAYTONA_SETTINGS) {
        await env.COMPUTE_TEST_RESET_DAYTONA_SETTINGS(workspaceId);
      } else {
        await registryDb(env)
          .update(workspaceSandboxSettings)
          .set({
            providerConfigJson: JSON.stringify(defaultDaytonaConfig),
            idleTimeoutMs: 900_000,
            updatedAt: Date.now(),
          })
          .where(eq(workspaceSandboxSettings.workspaceId, workspaceId));
      }
    } catch (resetError) {
      if (existingKey !== null) {
        try {
          await writer.set(workspaceId, secretName, existingKey);
        } catch {
          log.error("sandbox_settings.daytona_reset_compensation_failed", {
            workspaceId,
            secretName,
          });
          return new Response("Unable to reset Daytona override", { status: 500 });
        }
      }
      throw resetError;
    }
  }

  return Response.json(await getComputeSettingsView({ env, workspaceId, agentId }));
}

async function updateSpritesSecret(
  req: Request,
  env: Env,
  workspaceId: string,
  agentId: string,
): Promise<Response> {
  const body = (await req.json().catch(() => null)) as {
    value?: unknown;
    secretName?: unknown;
  } | null;
  if (typeof body?.value !== "string" || !body.value.trim()) {
    return new Response("value must be a non-empty string", { status: 400 });
  }
  const workspace = await getWorkspaceComputeSettings(env, workspaceId);
  if (workspace?.providerConfig.kind === "cloudflare") {
    return new Response("Sprites credentials require the Sprites provider", { status: 400 });
  }
  const defaultSpritesConfig = defaultProviderConfig("sprites");
  if (defaultSpritesConfig.kind !== "sprites") throw new Error("invalid_sprites_default");
  const configuredSecretName =
    workspace?.providerConfig.kind === "sprites"
      ? workspace.providerConfig.apiKeySecretName
      : defaultSpritesConfig.apiKeySecretName;
  const suppliedSecretName =
    typeof body.secretName === "string" && body.secretName.trim()
      ? body.secretName.trim()
      : configuredSecretName;
  if (suppliedSecretName !== configuredSecretName) {
    return new Response("secretName must match the configured Sprites secret", { status: 400 });
  }
  try {
    await saveDaytonaApiKey({
      env,
      workspaceId,
      secretName: configuredSecretName,
      value: body.value,
    });
  } catch (err) {
    if (err instanceof Error && err.message === "invalid_secret_name") {
      return new Response("invalid secretName", { status: 400 });
    }
    throw err;
  }
  return Response.json(await getComputeSettingsView({ env, workspaceId, agentId }));
}

async function clearSpritesOverride(
  env: Env,
  workspaceId: string,
  agentId: string,
): Promise<Response> {
  const workspace = await getWorkspaceComputeSettings(env, workspaceId);
  const defaultSpritesConfig = defaultProviderConfig("sprites");
  if (defaultSpritesConfig.kind !== "sprites") throw new Error("invalid_sprites_default");
  const secretName =
    workspace?.providerConfig.kind === "sprites"
      ? workspace.providerConfig.apiKeySecretName
      : defaultSpritesConfig.apiKeySecretName;
  const { store, writer } = createWorkspaceSecretsServices(env);
  const existingKey = await store.get(workspaceId, secretName);
  await writer.delete(workspaceId, secretName);

  if (workspace?.providerConfig.kind === "sprites") {
    try {
      await registryDb(env)
        .update(workspaceSandboxSettings)
        .set({
          providerConfigJson: JSON.stringify(defaultSpritesConfig),
          idleTimeoutMs: 900_000,
          updatedAt: Date.now(),
        })
        .where(eq(workspaceSandboxSettings.workspaceId, workspaceId));
    } catch (resetError) {
      if (existingKey !== null) {
        try {
          await writer.set(workspaceId, secretName, existingKey);
        } catch {
          log.error("sandbox_settings.sprites_reset_compensation_failed", {
            workspaceId,
            secretName,
          });
          return new Response("Unable to reset Sprites override", { status: 500 });
        }
      }
      throw resetError;
    }
  }

  return Response.json(await getComputeSettingsView({ env, workspaceId, agentId }));
}

type EnvScope = "workspace" | "agent";

/** Names currently in the OTHER set at this scope, for collision checks. */
async function otherSetNames(
  env: Env,
  workspaceId: string,
  agentId: string,
  scope: EnvScope,
  which: "editable" | "secret",
): Promise<Set<string>> {
  if (which === "editable") {
    const settings =
      scope === "workspace"
        ? await getWorkspaceComputeSettings(env, workspaceId)
        : await getAgentComputeSettings(env, workspaceId, agentId);
    return new Set(Object.keys(settings?.envVars ?? {}));
  }
  const { store, writer } = createWorkspaceSecretsServices(env);
  const secretStore = new ComputeEnvSecretsStore({ store, writer });
  const names =
    scope === "workspace"
      ? await secretStore.listWorkspaceNames(workspaceId)
      : await secretStore.listAgentNames(workspaceId, agentId);
  return new Set(names.map((n) => n.name));
}

async function updateEnvVars(
  req: Request,
  env: Env,
  workspaceId: string,
  agentId: string,
  scope: EnvScope,
): Promise<Response> {
  const body = (await req.json().catch(() => null)) as { envVars?: unknown } | null;
  if (!body) return new Response("Malformed JSON", { status: 400 });
  let map: Record<string, string>;
  let json: string;
  try {
    map = parseEnvVarMap(body.envVars ?? {});
    json = serializeEnvVarsJson(map);
  } catch {
    return new Response("invalid env vars", { status: 400 });
  }
  const secretNames = await otherSetNames(env, workspaceId, agentId, scope, "secret");
  if (Object.keys(map).some((name) => secretNames.has(name))) {
    return new Response("env var name conflicts with the other set", { status: 400 });
  }
  if (scope === "workspace") {
    // Merge-preserve the rest of the row: reuse the existing PUT path's insert/update.
    const existing = await getWorkspaceComputeSettings(env, workspaceId);
    await registryDb(env)
      .insert(workspaceSandboxSettings)
      .values({
        workspaceId,
        enabled: existing?.enabled ?? false,
        provider: existing?.provider ?? "daytona",
        providerConfigJson: JSON.stringify(
          existing?.providerConfig ?? defaultProviderConfig(existing?.provider ?? "daytona"),
        ),
        idleTimeoutMs: existing?.idleTimeoutMs ?? 900000,
        recoveryTtlMs: existing?.recoveryTtlMs ?? 86_400_000,
        maxProcessRuntimeMs: existing?.maxProcessRuntimeMs ?? 600000,
        limitsJson: JSON.stringify(existing?.limits ?? DEFAULT_COMPUTE_LIMITS),
        networkRestrictionEnabled: existing?.networkRestrictionEnabled ?? false,
        networkDomainAllowlist: existing?.networkDomainAllowlist ?? "",
        envVarsJson: json,
        createdAt: Date.now(),
        updatedAt: Date.now(),
      })
      .onConflictDoUpdate({
        target: workspaceSandboxSettings.workspaceId,
        set: { envVarsJson: json, updatedAt: Date.now() },
      });
  } else {
    await registryDb(env)
      .update(agents)
      .set({ sandboxEnvVarsJson: json })
      .where(eq(agents.id, agentId));
  }
  return Response.json(await getComputeSettingsView({ env, workspaceId, agentId }));
}

async function upsertSecretEnv(
  req: Request,
  env: Env,
  workspaceId: string,
  agentId: string,
  scope: EnvScope,
): Promise<Response> {
  const body = (await req.json().catch(() => null)) as { envVars?: unknown } | null;
  if (!body) return new Response("Malformed JSON", { status: 400 });
  let map: Record<string, string>;
  try {
    map = parseEnvVarMap(body.envVars ?? {});
  } catch {
    return new Response("invalid env vars", { status: 400 });
  }
  const editableNames = await otherSetNames(env, workspaceId, agentId, scope, "editable");
  if (Object.keys(map).some((name) => editableNames.has(name))) {
    return new Response("env var name conflicts with the other set", { status: 400 });
  }
  const { store, writer } = createWorkspaceSecretsServices(env);
  const secretStore = new ComputeEnvSecretsStore({ store, writer });
  for (const [name, value] of Object.entries(map)) {
    if (scope === "workspace") await secretStore.setWorkspace(workspaceId, name, value);
    else await secretStore.setAgent(workspaceId, agentId, name, value);
  }
  return Response.json(await getComputeSettingsView({ env, workspaceId, agentId }));
}

async function deleteSecretEnv(
  req: Request,
  env: Env,
  workspaceId: string,
  agentId: string,
  scope: EnvScope,
): Promise<Response> {
  const body = (await req.json().catch(() => null)) as { name?: unknown } | null;
  if (typeof body?.name !== "string") return new Response("name required", { status: 400 });
  let name: string;
  try {
    name = validateEnvVarName(body.name);
  } catch {
    return new Response("invalid env var name", { status: 400 });
  }
  const { store, writer } = createWorkspaceSecretsServices(env);
  const secretStore = new ComputeEnvSecretsStore({ store, writer });
  if (scope === "workspace") await secretStore.deleteWorkspace(workspaceId, name);
  else await secretStore.deleteAgent(workspaceId, agentId, name);
  return Response.json(await getComputeSettingsView({ env, workspaceId, agentId }));
}
