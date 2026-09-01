import type { ComputeProviderId, ComputeResourceProfile } from "./backend";

export type { ComputeProviderId, ComputeResourceProfile } from "./backend";

export type EnvironmentSource = { kind: "image" | "snapshot"; value: string };

export interface DaytonaProviderConfig {
  kind: "daytona";
  apiKeySecretName: string;
  apiUrl: string | null;
  target: string | null;
  profiles: Record<ComputeResourceProfile, EnvironmentSource | null>;
}

export interface CloudflareProviderConfig {
  kind: "cloudflare";
}

export interface SpritesProviderConfig {
  kind: "sprites";
  apiKeySecretName: string;
}

/**
 * In-memory local-dev compute. Needs no credentials or deployment config, so it
 * carries none. See `src/compute/backends/mock.ts`.
 */
export interface MockProviderConfig {
  kind: "mock";
}

export type ProviderConfig =
  | DaytonaProviderConfig
  | CloudflareProviderConfig
  | SpritesProviderConfig
  | MockProviderConfig;

export interface ComputeOutputLimits {
  tailMaxLines: number;
  tailMaxBytes: number;
  grepMaxMatches: number;
  grepMaxContextLines: number;
  grepMaxReturnedLines: number;
  grepMaxBytes: number;
  readMaxLines: number;
  readMaxBytes: number;
  maxProcessOutputBytes: number;
  maxThreadOutputBytes: number;
  maxUploadBytes: number;
  maxDownloadBytes: number;
}

export interface WorkspaceComputeSettings {
  enabled: boolean;
  provider: ComputeProviderId;
  providerConfig: ProviderConfig;
  idleTimeoutMs: number;
  recoveryTtlMs: number;
  maxProcessRuntimeMs: number;
  limits: ComputeOutputLimits;
  networkRestrictionEnabled: boolean;
  networkDomainAllowlist: string;
  envVars: Record<string, string>;
}

export interface AgentComputeSettings {
  /**
   * `agents.sandbox_enabled` — "this agent gets no machine". NOT the agent's
   * own on/off switch.
   *
   * It was called `enabled` and it read `sandbox_enabled`, so
   * `resolveEffectiveComputeConfig`'s `agent?.enabled === false` looked like it
   * gated on the agent being disabled and gated on something else entirely.
   * Disabling an agent therefore did not take the sandbox off its live threads.
   * Both names are spelled out here so the two settings cannot be confused
   * again; they are different settings and both must be honoured.
   */
  sandboxEnabled: boolean | null;
  /** `agents.enabled` — the agent's own switch. `false` means it refuses work. */
  agentEnabled: boolean;
  /** `agents.archived_at` — the user's DELETE. An archived agent gets no machine. */
  archivedAt: number | null;
  idleTimeoutMs: number | null;
  maxProcessRuntimeMs: number | null;
  networkDomainAllowlist: string | null;
  envVars: Record<string, string> | null;
}

/**
 * Why a compute session is being resolved.
 *
 * Three answers, and the two non-`work` ones exist for the same reason stated
 * twice: **"you may not WORK here" must never become "your machine is now
 * unreachable".** Once it does, the machine either bills forever or wedges a
 * workspace, and no user action can reach it.
 *
 * - `"work"` — every ordinary resolve: a turn, a tool.
 * - `"teardown"` — the caller is DESTROYING the machine. Lifts every gate that
 *   describes the AGENT's availability, and (since P3) the two that describe
 *   whether the agent is ALLOWED a machine, because neither says anything about
 *   whether one already exists.
 * - `"reclaim"` — the caller is RELEASING the machine: putting it to sleep, or
 *   ticking the alarm that decides to. It lifts `agents.enabled` and nothing
 *   else. A disabled agent's box is live and intentional, and if nothing can
 *   resolve for it, nothing can ever mark its ledger row `idle` — so it holds a
 *   workspace concurrency slot until the agent is deleted. `archived_at` is
 *   deliberately NOT lifted: an archived agent's box is being destroyed, its
 *   row is already excluded from reclaim candidates, and ticking against a
 *   destroyed sprite would only produce errors.
 *
 * A reclaim can never destroy — `releaseIfReclaimable` takes the recoverable
 * disposition unconditionally — which is what makes lifting a gate for it safe.
 */
export type ComputeResolvePurpose = "work" | "teardown" | "reclaim";

export interface EffectiveComputeConfig {
  provider: ComputeProviderId;
  providerConfig: ProviderConfig;
  resourceProfile: ComputeResourceProfile;
  idleTimeoutMs: number;
  recoveryTtlMs: number;
  maxProcessRuntimeMs: number;
  monitorPollIntervalMs: number;
  limits: ComputeOutputLimits;
  allowedHosts: string[] | null;
  editableEnv: Record<string, string>;
  agentEditableEnv: Record<string, string>;
  secretEnvNames: string[];
}

/**
 * `acquiring` — a slot is claimed and a sprite may or may not exist yet.
 * `active` — the box is awake and holds a workspace concurrency slot.
 * `idle` — the box is hibernated, disk intact, holding no slot.
 *
 * There is no "gone" status: a destroyed box has NO ROW. That is the whole
 * distinction the orphan reconciler runs on.
 */
export type AgentSandboxStatus = "acquiring" | "active" | "idle";

export interface AgentSandboxLedgerRow {
  agentId: string;
  /** Joined from `agents`; `agent_sandboxes` deliberately has no such column. */
  workspaceId: string;
  provider: string;
  /** The provider-side machine name, or null before/without one. */
  spriteName: string | null;
  status: AgentSandboxStatus;
  lastUsedAt: number;
}

export type ComputeConfigResult =
  | { enabled: true; value: EffectiveComputeConfig }
  | {
      enabled: false;
      reason:
        | "disabled"
        | "missing_workspace_settings"
        | "missing_secret"
        | "missing_source"
        | "unsupported_provider";
    };
