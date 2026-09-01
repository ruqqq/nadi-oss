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
 * `"work"` (the default) is every ordinary resolve: a turn, a tool, the idle
 * alarm. `"teardown"` is the one caller that is DESTROYING the machine rather
 * than using it, and it lifts exactly the two gates that describe the AGENT's
 * availability rather than the machine's existence — see
 * `resolveEffectiveComputeConfig`.
 */
export type ComputeResolvePurpose = "work" | "teardown";

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

export interface ContainerLedgerRow {
  threadId: string;
  workspaceId: string;
  provider: string;
  profile: string;
  lastUsedAt: number;
  expiresAt: number;
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
