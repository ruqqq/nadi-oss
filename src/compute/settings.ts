import { eq } from "drizzle-orm";
import type { Env } from "../env";
import { editionCapabilities, platformCapabilities } from "../edition";
import { registryDb } from "../db/client";
import { agents, mcpServers, workspaceSandboxSettings } from "../db/schema";
import { createWorkspaceSecretsServices } from "../secrets";
import {
  DEFAULT_COMPUTE_LIMITS,
  clampPositiveInt,
  defaultProviderConfig,
  mockSandboxEnabled,
  parseProviderConfigJson,
  resolveEffectiveComputeConfig,
} from "./config";
import { ComputeEnvSecretsStore } from "./env-secrets";
import { parseEnvVarsJson } from "./env-vars";
import {
  resolveDaytonaConfiguration,
  type DaytonaConfigurationMode,
  type ResolvedDaytonaConfiguration,
} from "./daytona-config";
import {
  resolveSpritesConfiguration,
  type SpritesConfigurationMode,
  type ResolvedSpritesConfiguration,
} from "./sprites-config";
import type {
  AgentComputeSettings,
  ComputeOutputLimits,
  ComputeProviderId,
  ComputeResourceProfile,
  ProviderConfig,
  WorkspaceComputeSettings,
} from "./types";

/** A capability a provider structurally cannot honor for a given workspace. */
export type ComputeUnsupportedCapability = "network_restrictions";

/**
 * Whether a compute provider is deployable for a workspace, and why not. This
 * report is surfaced to the browser (Task 5 keys provider selection off it), so
 * it carries only NAMES of absent configuration — never a value, a secret, or a
 * fragment of one.
 */
export interface ComputeProviderReadiness {
  provider: ComputeProviderId;
  ready: boolean;
  /** Names of deployment bindings/secrets absent at runtime. Never their values. */
  missingConfig: string[];
  /** Machine-readable capabilities the provider cannot honor for this workspace. */
  unsupported: ComputeUnsupportedCapability[];
}

/**
 * Deployment config Cloudflare compute needs, by binding/secret NAME. These are
 * declared optional in `src/env.ts` only because `worker-configuration.d.ts`
 * cannot be regenerated from this checkout; presence is therefore verified at
 * runtime here (never via a non-null assertion), and this check keeps working
 * once the `?` is dropped. `R2_ACCESS_KEY_ID`/`R2_SECRET_ACCESS_KEY` are the
 * SigV4 credentials the SDK presigns backup URLs with in production.
 */
export const CLOUDFLARE_REQUIRED_CONFIG = [
  "NADI_SANDBOX_SMALL",
  "NADI_SANDBOX_MEDIUM",
  "BACKUP_BUCKET",
  "BACKUP_BUCKET_NAME",
  "CLOUDFLARE_ACCOUNT_ID",
  "R2_ACCESS_KEY_ID",
  "R2_SECRET_ACCESS_KEY",
] as const;

/**
 * Runtime presence check for a binding/secret by name. Reads the value only to
 * test presence and returns a boolean — the value itself never escapes. An
 * empty/whitespace string counts as absent (an unset wrangler var). Object
 * bindings (Durable Object namespaces, R2 buckets) count as present when bound.
 */
export function isComputeConfigPresent(env: Env, name: string): boolean {
  const value = (env as unknown as Record<string, unknown>)[name];
  if (value === undefined || value === null) return false;
  if (typeof value === "string") return value.trim().length > 0;
  return true;
}

export function computeProviderReadiness(input: {
  env: Env;
  provider: ComputeProviderId;
  /** True when a non-empty effective host allowlist is in force for the workspace. */
  networkRestricted: boolean;
}): ComputeProviderReadiness {
  const { env, provider, networkRestricted } = input;
  // Non-Cloudflare providers (Daytona, Sprites) validate their own credentials
  // elsewhere and DO support network restrictions, so nothing here blocks
  // deployability.
  if (provider !== "cloudflare") {
    return { provider, ready: true, missingConfig: [], unsupported: [] };
  }
  const missingConfig = CLOUDFLARE_REQUIRED_CONFIG.filter(
    (name) => !isComputeConfigPresent(env, name),
  );
  // `@cloudflare/sandbox@0.12.3` has NO network-policy API, so a workspace with a
  // non-empty host allowlist cannot use Cloudflare. This is a distinct,
  // machine-readable capability gap — NOT missing configuration — because the UI
  // disables provider selection on it. `CloudflareComputeBackend.acquire` still
  // fails closed with `policy_rejected`; this is the early signal, not a
  // replacement for that backstop.
  const unsupported: ComputeUnsupportedCapability[] = networkRestricted
    ? ["network_restrictions"]
    : [];
  return {
    provider,
    ready: missingConfig.length === 0 && unsupported.length === 0,
    missingConfig,
    unsupported,
  };
}

export function extractMcpHosts(servers: { url: string; enabled: boolean }[]): string[] {
  const hosts = new Set<string>();
  for (const server of servers) {
    if (!server.enabled) continue;
    try {
      const host = new URL(server.url).hostname.toLowerCase();
      if (host) hosts.add(host);
    } catch {
      // Skip malformed server URLs.
    }
  }
  return [...hosts];
}

async function loadMcpHosts(env: Env, workspaceId: string): Promise<string[]> {
  const servers = await registryDb(env)
    .select({ url: mcpServers.url, enabled: mcpServers.enabled })
    .from(mcpServers)
    .where(eq(mcpServers.workspaceId, workspaceId))
    .all();
  return extractMcpHosts(servers);
}

export function parseComputeLimits(raw: string | null | undefined): ComputeOutputLimits {
  if (!raw) return DEFAULT_COMPUTE_LIMITS;
  try {
    const parsed = JSON.parse(raw) as Partial<ComputeOutputLimits>;
    return {
      tailMaxLines: clampPositiveInt(
        parsed.tailMaxLines,
        DEFAULT_COMPUTE_LIMITS.tailMaxLines,
        1000,
      ),
      tailMaxBytes: clampPositiveInt(
        parsed.tailMaxBytes,
        DEFAULT_COMPUTE_LIMITS.tailMaxBytes,
        256000,
      ),
      grepMaxMatches: clampPositiveInt(
        parsed.grepMaxMatches,
        DEFAULT_COMPUTE_LIMITS.grepMaxMatches,
        200,
      ),
      grepMaxContextLines: clampPositiveInt(
        parsed.grepMaxContextLines,
        DEFAULT_COMPUTE_LIMITS.grepMaxContextLines,
        20,
      ),
      grepMaxReturnedLines: clampPositiveInt(
        parsed.grepMaxReturnedLines,
        DEFAULT_COMPUTE_LIMITS.grepMaxReturnedLines,
        1000,
      ),
      grepMaxBytes: clampPositiveInt(
        parsed.grepMaxBytes,
        DEFAULT_COMPUTE_LIMITS.grepMaxBytes,
        256000,
      ),
      readMaxLines: clampPositiveInt(
        parsed.readMaxLines,
        DEFAULT_COMPUTE_LIMITS.readMaxLines,
        2000,
      ),
      readMaxBytes: clampPositiveInt(
        parsed.readMaxBytes,
        DEFAULT_COMPUTE_LIMITS.readMaxBytes,
        256000,
      ),
      maxProcessOutputBytes: clampPositiveInt(
        parsed.maxProcessOutputBytes,
        DEFAULT_COMPUTE_LIMITS.maxProcessOutputBytes,
        200_000_000,
      ),
      maxThreadOutputBytes: clampPositiveInt(
        parsed.maxThreadOutputBytes,
        DEFAULT_COMPUTE_LIMITS.maxThreadOutputBytes,
        1_000_000_000,
      ),
      maxUploadBytes: clampPositiveInt(
        parsed.maxUploadBytes,
        DEFAULT_COMPUTE_LIMITS.maxUploadBytes,
        200_000_000,
      ),
      maxDownloadBytes: clampPositiveInt(
        parsed.maxDownloadBytes,
        DEFAULT_COMPUTE_LIMITS.maxDownloadBytes,
        200_000_000,
      ),
    };
  } catch {
    return DEFAULT_COMPUTE_LIMITS;
  }
}

export async function getWorkspaceComputeSettings(
  env: Env,
  workspaceId: string,
): Promise<WorkspaceComputeSettings | null> {
  const row = await registryDb(env)
    .select()
    .from(workspaceSandboxSettings)
    .where(eq(workspaceSandboxSettings.workspaceId, workspaceId))
    .get();
  if (!row) return null;
  if (row.providerConfigJson === null) throw new Error("missing_provider_config_json");
  return {
    enabled: row.enabled,
    provider: row.provider,
    providerConfig: parseProviderConfigJson(row.providerConfigJson),
    idleTimeoutMs: row.idleTimeoutMs,
    recoveryTtlMs: row.recoveryTtlMs,
    maxProcessRuntimeMs: row.maxProcessRuntimeMs,
    limits: parseComputeLimits(row.limitsJson),
    networkRestrictionEnabled: row.networkRestrictionEnabled,
    networkDomainAllowlist: row.networkDomainAllowlist,
    envVars: parseEnvVarsJson(row.envVarsJson),
  };
}

export async function getAgentComputeSettings(
  env: Env,
  workspaceId: string,
  agentId: string,
): Promise<AgentComputeSettings | null> {
  void workspaceId;
  const row = await registryDb(env)
    .select({
      enabled: agents.sandboxEnabled,
      idleTimeoutMs: agents.sandboxIdleTimeoutMs,
      maxProcessRuntimeMs: agents.sandboxMaxProcessRuntimeMs,
      networkDomainAllowlist: agents.sandboxNetworkDomainAllowlist,
      envVarsJson: agents.sandboxEnvVarsJson,
    })
    .from(agents)
    .where(eq(agents.id, agentId))
    .get();
  if (!row) return null;
  return {
    enabled: row.enabled,
    idleTimeoutMs: row.idleTimeoutMs,
    maxProcessRuntimeMs: row.maxProcessRuntimeMs,
    networkDomainAllowlist: row.networkDomainAllowlist,
    envVars: row.envVarsJson === null ? null : parseEnvVarsJson(row.envVarsJson),
  };
}

async function loadSecretEnvNames(env: Env, workspaceId: string, agentId: string) {
  const { store, writer } = createWorkspaceSecretsServices(env);
  const secretStore = new ComputeEnvSecretsStore({ store, writer });
  const [workspace, agent] = await Promise.all([
    secretStore.listWorkspaceNames(workspaceId),
    secretStore.listAgentNames(workspaceId, agentId),
  ]);
  return { workspace, agent };
}

async function resolveWorkspaceDaytonaConfiguration(
  env: Env,
  workspaceId: string,
  workspace: WorkspaceComputeSettings | null,
): Promise<ResolvedDaytonaConfiguration | null> {
  if (!workspace || workspace.providerConfig.kind !== "daytona") return null;
  return resolveDaytonaConfiguration({
    env,
    workspaceId,
    providerConfig: workspace.providerConfig,
  });
}

async function resolveWorkspaceSpritesConfiguration(
  env: Env,
  workspaceId: string,
  workspace: WorkspaceComputeSettings | null,
): Promise<ResolvedSpritesConfiguration | null> {
  if (!workspace || workspace.providerConfig.kind !== "sprites") return null;
  return resolveSpritesConfiguration({
    env,
    workspaceId,
    providerConfig: workspace.providerConfig,
  });
}

/** The D1-backed inputs {@link resolveEffectiveComputeConfig} needs, independent of the workbench profile. */
export interface ComputeConfigInputs {
  workspace: WorkspaceComputeSettings | null;
  agent: AgentComputeSettings | null;
  daytonaConfiguration: ResolvedDaytonaConfiguration | null;
  spritesConfiguration: ResolvedSpritesConfiguration | null;
  mcpHosts: string[];
  secretNames: Awaited<ReturnType<typeof loadSecretEnvNames>>;
}

/**
 * Fetches every D1-backed input {@link resolveEffectiveComputeConfig} needs,
 * EXCEPT the workbench resource profile — that is the caller's concern (e.g.
 * a per-thread snapshot lookup) so it can be fetched lazily, or not at all on
 * a workspace that turns out to be disabled. See {@link needsWorkbenchResourceProfile}.
 */
export async function loadComputeConfigInputs(input: {
  env: Env;
  workspaceId: string;
  agentId: string;
}): Promise<ComputeConfigInputs> {
  // One D1 round-trip costs ~220ms from inside a thread DO, so the number of
  // sequential WAVES matters more than the query count. These four need only
  // workspaceId/agentId, so they share one wave; only Daytona resolution
  // genuinely depends on `workspace`, so it alone forms the second. (Was three
  // serial waves — ~600ms of a ~1.1s cold wake.)
  const [workspace, agent, mcpHosts, secretNames] = await Promise.all([
    getWorkspaceComputeSettings(input.env, input.workspaceId),
    getAgentComputeSettings(input.env, input.workspaceId, input.agentId),
    loadMcpHosts(input.env, input.workspaceId),
    loadSecretEnvNames(input.env, input.workspaceId, input.agentId),
  ]);
  const [daytonaConfiguration, spritesConfiguration] = await Promise.all([
    resolveWorkspaceDaytonaConfiguration(input.env, input.workspaceId, workspace),
    resolveWorkspaceSpritesConfiguration(input.env, input.workspaceId, workspace),
  ]);
  return { workspace, agent, daytonaConfiguration, spritesConfiguration, mcpHosts, secretNames };
}

/**
 * Pure (no I/O) resolution from already-fetched {@link ComputeConfigInputs}
 * plus a workbench profile. Split out from {@link resolveComputeConfigForAgent}
 * so a caller can resolve twice — once with no profile to decide whether the
 * profile is even needed, then again with the real one — while paying the D1
 * cost of {@link loadComputeConfigInputs} exactly once.
 */
export function computeConfigFromInputs(
  inputs: ComputeConfigInputs,
  workbenchResourceProfile?: ComputeResourceProfile | null,
) {
  return resolveEffectiveComputeConfig({
    workspace: inputs.workspace,
    agent: inputs.agent,
    daytonaCredentialPresent: inputs.daytonaConfiguration?.apiKey != null,
    daytonaProfiles: inputs.daytonaConfiguration?.profiles ?? { small: null, medium: null },
    spritesCredentialPresent: inputs.spritesConfiguration?.apiKey != null,
    mcpHosts: inputs.mcpHosts,
    workspaceSecretEnvNames: inputs.secretNames.workspace.map((secret) => secret.name),
    agentSecretEnvNames: inputs.secretNames.agent.map((secret) => secret.name),
    workbenchResourceProfile,
  });
}

export async function resolveComputeConfigForAgent(input: {
  env: Env;
  workspaceId: string;
  agentId: string;
  /** The thread's frozen workbench profile; forwarded as-is, undefined included. */
  workbenchResourceProfile?: ComputeResourceProfile | null;
}) {
  const inputs = await loadComputeConfigInputs(input);
  return computeConfigFromInputs(inputs, input.workbenchResourceProfile);
}

/**
 * Deployability of each provider for this workspace, surfaced to the browser so
 * the settings UI can gate provider selection (Task 5). Cloudflare is reported
 * even while the workspace runs on Daytona, because the UI needs Cloudflare's
 * `missingConfig`/`unsupported` to decide whether a switch is even possible.
 * Carries configuration NAMES only — never a value or secret.
 */
export interface ComputeReadiness {
  daytona: ComputeProviderReadiness;
  cloudflare: ComputeProviderReadiness;
  sprites: ComputeProviderReadiness;
}

export interface ComputeSettingsView {
  workspace: WorkspaceComputeSettings | null;
  agent: AgentComputeSettings | null;
  effective: Awaited<ReturnType<typeof resolveComputeConfigForAgent>>;
  readiness: ComputeReadiness;
  /**
   * True when deployment compute is provisioned by the service operator, so the
   * read-only Cloudflare deployment panel has nothing a tenant can act on and is
   * hidden. `readiness.cloudflare` still ships regardless — the provider
   * selector gates on its `unsupported` list, which stays meaningful on cloud.
   */
  operatorManagedCompute: boolean;
  daytonaMode: DaytonaConfigurationMode;
  daytonaAvailable: boolean;
  daytonaSecretPresent: boolean;
  spritesMode: SpritesConfigurationMode;
  spritesAvailable: boolean;
  spritesSecretPresent: boolean;
  /**
   * Whether the `mock` provider may be selected here. False on any deployment
   * that did not opt in with `DEFAULT_SANDBOX_PROVIDER=mock`, which hides it
   * from the provider list; the PUT handler refuses it on the same condition.
   */
  mockAvailable: boolean;
  /**
   * Whether the `cloudflare` provider may be selected here. False on celld,
   * which has no container bindings at all — distinct from
   * `readiness.cloudflare`, which answers "is this provisioned yet" on a
   * platform that HAS containers. The PUT handler refuses it on the same
   * condition.
   */
  cloudflareAvailable: boolean;
  workspaceSecretEnvVars: Array<{ name: string; updatedAt: string }>;
  agentSecretEnvVars: Array<{ name: string; updatedAt: string }>;
}

/**
 * A workspace is network-restricted when its EFFECTIVE config resolves a
 * non-empty host allowlist. This is the single authoritative signal (the server
 * holds it; the browser consumes the verdict and never recomputes it). `null`
 * and `[]` both mean unrestricted — matching how the Daytona backend and
 * `CloudflareComputeBackend.acquire`'s fail-closed check read `allowedHosts`.
 */
function isNetworkRestricted(
  effective: Awaited<ReturnType<typeof resolveComputeConfigForAgent>>,
): boolean {
  return effective.enabled && (effective.value.allowedHosts?.length ?? 0) > 0;
}

export async function getComputeSettingsView(input: {
  env: Env;
  workspaceId: string;
  agentId: string;
}): Promise<ComputeSettingsView> {
  const workspace = await getWorkspaceComputeSettings(input.env, input.workspaceId);
  const agent = await getAgentComputeSettings(input.env, input.workspaceId, input.agentId);
  const daytonaProviderConfig =
    workspace?.providerConfig.kind === "daytona"
      ? workspace.providerConfig
      : (defaultProviderConfig("daytona") as Extract<ProviderConfig, { kind: "daytona" }>);
  const spritesProviderConfig =
    workspace?.providerConfig.kind === "sprites"
      ? workspace.providerConfig
      : (defaultProviderConfig("sprites") as Extract<ProviderConfig, { kind: "sprites" }>);
  const [daytonaConfiguration, spritesConfiguration, mcpHosts, secretNames] = await Promise.all([
    resolveDaytonaConfiguration({
      env: input.env,
      workspaceId: input.workspaceId,
      providerConfig: daytonaProviderConfig,
    }),
    resolveSpritesConfiguration({
      env: input.env,
      workspaceId: input.workspaceId,
      providerConfig: spritesProviderConfig,
    }),
    loadMcpHosts(input.env, input.workspaceId),
    loadSecretEnvNames(input.env, input.workspaceId, input.agentId),
  ]);
  // No thread context here — this view is workspace/agent-scoped settings,
  // not a per-thread resolution — so `effective.resourceProfile` reports
  // `resolveEffectiveComputeConfig`'s default (DEFAULT_COMPUTE_RESOURCE_PROFILE)
  // rather than any real thread's frozen workbench profile. That is
  // deliberate: nothing renders `effective.resourceProfile` from this
  // endpoint today, and there is no caller that could supply a real one.
  const effective = resolveEffectiveComputeConfig({
    workspace,
    agent,
    daytonaCredentialPresent: daytonaConfiguration?.apiKey != null,
    daytonaProfiles: daytonaConfiguration?.profiles ?? { small: null, medium: null },
    spritesCredentialPresent: spritesConfiguration?.apiKey != null,
    mcpHosts,
    workspaceSecretEnvNames: secretNames.workspace.map((secret) => secret.name),
    agentSecretEnvNames: secretNames.agent.map((secret) => secret.name),
  });
  const networkRestricted = isNetworkRestricted(effective);
  return {
    workspace,
    agent,
    effective,
    readiness: {
      daytona: computeProviderReadiness({ env: input.env, provider: "daytona", networkRestricted }),
      cloudflare: computeProviderReadiness({
        env: input.env,
        provider: "cloudflare",
        networkRestricted,
      }),
      sprites: computeProviderReadiness({ env: input.env, provider: "sprites", networkRestricted }),
    },
    operatorManagedCompute: editionCapabilities(input.env).operatorManagedCompute,
    daytonaMode: daytonaConfiguration.mode,
    daytonaAvailable:
      daytonaConfiguration.apiKey !== null &&
      daytonaConfiguration.profiles.small !== null &&
      daytonaConfiguration.profiles.medium !== null,
    daytonaSecretPresent: daytonaConfiguration.mode === "byok",
    spritesMode: spritesConfiguration.mode,
    spritesAvailable: spritesConfiguration.apiKey !== null,
    spritesSecretPresent: spritesConfiguration.mode === "byok",
    mockAvailable: mockSandboxEnabled(input.env),
    cloudflareAvailable: platformCapabilities(input.env).containerSandbox,
    workspaceSecretEnvVars: secretNames.workspace,
    agentSecretEnvVars: secretNames.agent,
  };
}

export async function saveDaytonaApiKey(input: {
  env: Env;
  workspaceId: string;
  secretName: string;
  value: string;
}): Promise<void> {
  if (!/^[A-Za-z0-9._:-]{1,128}$/.test(input.secretName)) {
    throw new Error("invalid_secret_name");
  }
  if (!input.value.trim()) throw new Error("secret_value_required");
  const { writer } = createWorkspaceSecretsServices(input.env);
  await writer.ensureWorkspaceDek(input.workspaceId);
  await writer.set(input.workspaceId, input.secretName, input.value);
}
