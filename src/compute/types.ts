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
  enabled: boolean | null;
  idleTimeoutMs: number | null;
  maxProcessRuntimeMs: number | null;
  networkDomainAllowlist: string | null;
  envVars: Record<string, string> | null;
}

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
  environmentEditableEnv: Record<string, string>;
  environmentSecretEnvNames: string[];
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
