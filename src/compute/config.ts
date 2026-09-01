import { z } from "zod";
import { mergeComputeEnv } from "./env-vars";
import { DEFAULT_MONITOR_POLL_INTERVAL_MS } from "./watchers";
import type {
  AgentComputeSettings,
  ComputeConfigResult,
  ComputeResolvePurpose,
  ComputeOutputLimits,
  ComputeResourceProfile,
  EnvironmentSource,
  ProviderConfig,
  WorkspaceComputeSettings,
} from "./types";

export const COMPUTE_RESOURCE_PROFILE_IDS = [
  "small",
  "medium",
] as const satisfies readonly ComputeResourceProfile[];
export const DEFAULT_COMPUTE_RESOURCE_PROFILE: ComputeResourceProfile = "small";
export const DEFAULT_COMPUTE_RECOVERY_TTL_MS = 86_400_000;

export const environmentSourceSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("image"), value: z.string() }),
  z.object({ kind: z.literal("snapshot"), value: z.string() }),
]);

export const providerConfigSchema = z.discriminatedUnion("kind", [
  z.object({
    kind: z.literal("daytona"),
    apiKeySecretName: z.string(),
    apiUrl: z.string().nullable(),
    target: z.string().nullable(),
    profiles: z.record(z.enum(["small", "medium"]), environmentSourceSchema.nullable()),
  }),
  z.object({ kind: z.literal("cloudflare") }),
  z.object({ kind: z.literal("sprites"), apiKeySecretName: z.string() }),
  z.object({ kind: z.literal("mock") }),
]);

export function parseProviderConfigJson(raw: string): ProviderConfig {
  try {
    return providerConfigSchema.parse(JSON.parse(raw)) as ProviderConfig;
  } catch {
    throw new Error("invalid_provider_config_json");
  }
}

export const DEFAULT_COMPUTE_LIMITS: ComputeOutputLimits = {
  tailMaxLines: 200,
  tailMaxBytes: 32_000,
  grepMaxMatches: 50,
  grepMaxContextLines: 5,
  grepMaxReturnedLines: 300,
  grepMaxBytes: 64_000,
  readMaxLines: 500,
  readMaxBytes: 64_000,
  maxProcessOutputBytes: 20_000_000,
  maxThreadOutputBytes: 100_000_000,
  maxUploadBytes: 25_000_000,
  maxDownloadBytes: 25_000_000,
};

export const DEFAULT_COMPUTE_ALLOWED_HOSTS = [
  "registry.npmjs.org",
  "registry.yarnpkg.com",
  "pypi.org",
  "files.pythonhosted.org",
  "github.com",
  "*.github.com",
  "*.githubusercontent.com",
  "deb.debian.org",
  "security.debian.org",
  "archive.ubuntu.com",
  "security.ubuntu.com",
];

const DOMAIN_RE = /^(\*\.)?([a-z0-9-]+\.)+[a-z]{2,}$/i;

export function isComputeResourceProfile(value: string): value is ComputeResourceProfile {
  return (COMPUTE_RESOURCE_PROFILE_IDS as readonly string[]).includes(value);
}

export function validateComputeResourceProfile(value: string): ComputeResourceProfile {
  if (!isComputeResourceProfile(value)) throw new Error("invalid_compute_resource_profile");
  return value;
}

export function clampPositiveInt(value: unknown, fallback: number, max: number): number {
  if (typeof value !== "number" || !Number.isFinite(value)) return fallback;
  return Math.min(max, Math.max(1, Math.trunc(value)));
}

export function parseDomainList(raw: string | null | undefined): string[] {
  if (!raw) return [];
  return raw
    .split(/[,\n]/)
    .map((value) => value.trim().toLowerCase())
    .filter(Boolean);
}

export function validateSandboxDomain(value: string): string {
  const domain = value.trim().toLowerCase();
  if (!domain) throw new Error("sandbox_domain_required");
  if (!DOMAIN_RE.test(domain)) throw new Error("sandbox_domain_invalid");
  return domain;
}

/**
 * Whether producing a final {@link ComputeConfigResult} for this PRELIMINARY
 * result (one resolved with no agent profile) requires fetching the
 * thread's actual agent profile. `true` for anything that will end up
 * enabled, and for the one bail reason (`missing_source`) that itself depends
 * on the profile — every other bail (`missing_workspace_settings`,
 * `disabled`, `unsupported_provider`, `missing_secret`) is decided before the
 * profile is ever consulted, so a preliminary bail on one of those means the
 * real answer can't change once the profile is known. Callers that own a
 * separate, potentially-expensive profile lookup (e.g. a per-thread D1 query)
 * use this to skip that lookup entirely on a genuinely-disabled workspace.
 */
export function needsAgentResourceProfile(preliminary: ComputeConfigResult): boolean {
  return preliminary.enabled || preliminary.reason === "missing_source";
}

export function resolveEffectiveComputeConfig(input: {
  workspace: WorkspaceComputeSettings | null;
  agent: AgentComputeSettings | null;
  daytonaCredentialPresent: boolean;
  daytonaProfiles: Record<ComputeResourceProfile, EnvironmentSource | null>;
  spritesCredentialPresent?: boolean;
  mcpHosts?: string[];
  workspaceSecretEnvNames?: string[];
  agentSecretEnvNames?: string[];
  /** The thread's agent's resource profile, read live. */
  agentResourceProfile?: ComputeResourceProfile | null | undefined;
  /** Defaults to `"work"`. See {@link ComputeResolvePurpose}. */
  purpose?: ComputeResolvePurpose | undefined;
}): ComputeConfigResult {
  const { workspace, agent } = input;
  if (!workspace) return { enabled: false, reason: "missing_workspace_settings" };
  // FOUR separate switches, all of which mean "no machine", and none of which
  // implies another. What `purpose` turns on is not which of them is a
  // PERMISSION — all four are — but whether a machine may still EXIST despite
  // one of them being off:
  //
  //  - the workspace's master compute toggle;
  //  - `agents.sandbox_enabled === false` — this agent works without a machine;
  //  - `agents.enabled` — the agent is turned off. This gate was MISSING
  //    entirely at one point: the check read `agent.enabled`, but that field
  //    carried `sandbox_enabled`, so disabling an agent left its live threads
  //    holding a full sandbox while the UI said "Turn this off to stop the
  //    agent from running";
  //  - `agents.archived_at` — the user deleted the agent.
  //
  // ALL FOUR ARE LIFTED FOR `purpose: "teardown"`, and the last two were the
  // easy half. The first two used to sit in an always-enforced arm on the
  // premise "there has never been a machine to destroy" — WHICH IS FALSE FOR
  // ANY BOX THAT PREDATES THE TOGGLE. Untick an agent's sandbox setting (which
  // tears nothing down), then delete the agent: the teardown resolved `null`,
  // the route dropped the ledger row anyway, and the dialog still said "Its
  // files are destroyed". On sprites the reconciler collects the machine; on
  // every other provider nothing does and it bills forever. The workspace
  // master toggle has the identical shape. Neither says anything about whether
  // a provider is configured — that is what `unsupported_provider` and
  // `missing_secret` below are for, and those stay enforced for every purpose
  // precisely because they DO mean "nothing to issue a destroy against".
  //
  // `agents.enabled` alone is additionally lifted for `purpose: "reclaim"`.
  // A disabled agent's box is live and intentional, so something must still be
  // able to put it to SLEEP: nothing else can ever write its ledger row `idle`,
  // and an `active` row that nothing can move holds a workspace concurrency
  // slot until the agent is deleted. See {@link ComputeResolvePurpose}.
  //
  // The rule under all of it: "you may not WORK here" must never become "your
  // machine is now unreachable, and therefore undeletable — or unreleasable".
  //
  // The four are collapsed to one `reason` deliberately: the wire type is
  // consumed by the settings UI, and a disabled agent's user-facing explanation
  // comes from the send-path refusal (`assertThreadWritable`), not from here.
  // THE THREE PURPOSES, STATED AS WHAT EACH LIFTS, because the temptation is to
  // lift one gate at a time and the gates do not divide that way:
  //
  //   work      lifts nothing.
  //   reclaim   lifts everything EXCEPT `archived_at`.
  //   teardown  lifts everything.
  //
  // `reclaim` differs from `teardown` in exactly one place, and the asymmetry is
  // the point: an archived agent's box is being DESTROYED, its row is already
  // excluded from reclaim candidates, and ticking against a destroyed sprite
  // would only produce errors — whereas every other switch is a statement about
  // PERMISSION that says nothing about whether a machine exists.
  //
  // Grouping `sandbox_enabled` and the workspace toggle with the other two was
  // the fix's own second miss. They were lifted for teardown precisely because
  // "there has never been a machine to destroy" is FALSE for a box that predates
  // the toggle — and that premise is no more true for a release than for a
  // destroy. `updateAgentSandboxSettings` writes the column and nothing else: no
  // teardown, no release. So unticking Settings → Sandbox on an agent with a
  // live box froze its row at `active` with a stale `last_used_at`, and since
  // `listReclaimCandidates` orders by `last_used_at ASC` that agent was handed
  // out FIRST on every cap-pressure reclaim and refused every time. One slot
  // lost per such agent, until it was deleted.
  const teardown = input.purpose === "teardown";
  const reclaim = input.purpose === "reclaim";
  const mayReachMachine = teardown || reclaim;
  const agentEnabledGate = mayReachMachine || agent?.agentEnabled !== false;
  const sandboxAllowed = mayReachMachine || (workspace.enabled && agent?.sandboxEnabled !== false);
  const notArchived = teardown || agent == null || agent.archivedAt === null;
  if (!sandboxAllowed || !agentEnabledGate || !notArchived) {
    return { enabled: false, reason: "disabled" };
  }
  if (workspace.provider !== workspace.providerConfig.kind) {
    return { enabled: false, reason: "unsupported_provider" };
  }
  if (workspace.providerConfig.kind === "daytona" && !input.daytonaCredentialPresent) {
    return { enabled: false, reason: "missing_secret" };
  }
  if (workspace.providerConfig.kind === "sprites" && !input.spritesCredentialPresent) {
    return { enabled: false, reason: "missing_secret" };
  }

  // The agent's own resource profile is the only source of sandbox size, and
  // every thread has an agent. Resolved BEFORE the missing_source check below
  // so validation sees the profile that will actually be acquired.
  const resourceProfile = input.agentResourceProfile ?? DEFAULT_COMPUTE_RESOURCE_PROFILE;
  if (
    workspace.providerConfig.kind === "daytona" &&
    input.daytonaProfiles[resourceProfile] === null
  ) {
    return { enabled: false, reason: "missing_source" };
  }

  // The workspace toggle is the master switch. When on, the allowlist is the
  // workspace domains (or the sensible defaults if none) unioned with enabled
  // MCP server hosts. Agent-specific additions are layered on later at
  // compute acquisition (they need the thread's agent, unknown here). When
  // off, the network is unrestricted (null).
  let allowedHosts: string[] | null = null;
  if (workspace.networkRestrictionEnabled) {
    const configured = parseDomainList(workspace.networkDomainAllowlist);
    const workspaceHosts = configured.length
      ? configured
      : DEFAULT_COMPUTE_ALLOWED_HOSTS.map((host) => host.toLowerCase());
    const mcpHosts = (input.mcpHosts ?? [])
      .map((host) => host.trim().toLowerCase())
      .filter(Boolean);
    allowedHosts = [...new Set([...workspaceHosts, ...mcpHosts])];
  }

  return {
    enabled: true,
    value: {
      provider: workspace.provider,
      providerConfig: workspace.providerConfig,
      resourceProfile,
      idleTimeoutMs: agent?.idleTimeoutMs ?? workspace.idleTimeoutMs,
      recoveryTtlMs: workspace.recoveryTtlMs,
      maxProcessRuntimeMs: agent?.maxProcessRuntimeMs ?? workspace.maxProcessRuntimeMs,
      monitorPollIntervalMs: DEFAULT_MONITOR_POLL_INTERVAL_MS,
      limits: workspace.limits,
      allowedHosts,
      editableEnv: mergeComputeEnv(workspace.envVars, agent?.envVars ?? undefined),
      agentEditableEnv: agent?.envVars ?? {},
      secretEnvNames: [
        ...new Set([
          ...(input.workspaceSecretEnvNames ?? []),
          ...(input.agentSecretEnvNames ?? []),
        ]),
      ].sort(),
    },
  };
}

/**
 * The compute provider a new workspace's default sandbox is created with.
 * `DEFAULT_SANDBOX_PROVIDER` opts a deployment out of the production default
 * (`cloudflare`); local dev sets it to `mock`. An unrecognized value falls back
 * to `cloudflare` so a typo can never silently hand new users a broken sandbox.
 */
export function resolveDefaultSandboxProvider(env: {
  DEFAULT_SANDBOX_PROVIDER?: string | undefined;
}): "cloudflare" | "daytona" | "sprites" | "mock" {
  const raw = env.DEFAULT_SANDBOX_PROVIDER?.trim().toLowerCase();
  if (raw === "mock" || raw === "daytona" || raw === "sprites" || raw === "cloudflare") return raw;
  return "cloudflare";
}

/**
 * Whether the in-memory `mock` provider may be SELECTED on this deployment.
 *
 * Mock is a test double: its state is process-global, resets on restart, and
 * runs no real commands. Offering it in Settings on a deployment that never
 * asked for it invites someone to pick "Mock (local dev)" on a production
 * workspace and watch every sandbox tool silently do nothing.
 *
 * The gate is the deployment already having opted in via
 * `DEFAULT_SANDBOX_PROVIDER=mock` — the same signal `.dev.vars` sets for local
 * offline dev — rather than a second flag that could drift out of step with it.
 *
 * This gates SELECTION, not construction: `buildComputeBackend` still builds a
 * mock backend for a workspace already configured with one, so tests (which
 * construct backends directly) and an existing local workspace are unaffected.
 */
export function mockSandboxEnabled(env: {
  DEFAULT_SANDBOX_PROVIDER?: string | undefined;
}): boolean {
  return resolveDefaultSandboxProvider(env) === "mock";
}

export function defaultProviderConfig(provider: string): ProviderConfig {
  if (provider === "cloudflare") return { kind: "cloudflare" };
  if (provider === "mock") return { kind: "mock" };
  if (provider === "sprites") return { kind: "sprites", apiKeySecretName: "sandbox:sprites" };
  return {
    kind: "daytona",
    apiKeySecretName: "sandbox:daytona",
    apiUrl: null,
    target: null,
    profiles: { small: null, medium: null },
  };
}

export type { EnvironmentSource };
