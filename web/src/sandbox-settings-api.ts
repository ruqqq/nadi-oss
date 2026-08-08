import { appFetch } from "./lib/app-fetch";
import { errorFromResponse } from "./lib/http-error";
type FetchLike = typeof fetch;
const JSON_HEADERS = { "Content-Type": "application/json" } as const;

export type SandboxResourceProfile = "small" | "medium";

/** Where a profile's machine comes from. Mirrors the worker's `environmentSourceSchema`. */
export interface SandboxEnvironmentSource {
  kind: "image" | "snapshot";
  value: string;
}

export interface DaytonaProviderConfig {
  kind: "daytona";
  apiKeySecretName: string;
  apiUrl: string | null;
  target: string | null;
  profiles: Record<SandboxResourceProfile, SandboxEnvironmentSource | null>;
}

export interface CloudflareProviderConfig {
  kind: "cloudflare";
}

/** In-memory local-dev compute. Mirrors the worker's `MockProviderConfig`. */
export interface MockProviderConfig {
  kind: "mock";
}

export interface SpritesProviderConfig {
  kind: "sprites";
  apiKeySecretName: string;
}

export type SandboxProviderConfig =
  | DaytonaProviderConfig
  | CloudflareProviderConfig
  | SpritesProviderConfig
  | MockProviderConfig;

export interface SandboxWorkspaceSettings {
  enabled: boolean;
  provider: string;
  providerConfig: SandboxProviderConfig;
  idleTimeoutMs: number;
  recoveryTtlMs: number;
  maxProcessRuntimeMs: number;
  networkRestrictionEnabled: boolean;
  networkDomainAllowlist: string;
  envVars: Record<string, string>;
}

export interface SandboxAgentSettings {
  enabled: boolean | null;
  idleTimeoutMs: number | null;
  maxProcessRuntimeMs: number | null;
  networkDomainAllowlist: string | null;
  envVars: Record<string, string> | null;
}

export type SandboxEffectiveConfigReason =
  | "disabled"
  | "missing_workspace_settings"
  | "missing_secret"
  | "missing_source"
  | "unsupported_provider";

export interface SandboxEffectiveConfigValue {
  resourceProfile: SandboxResourceProfile;
  allowedHosts: string[] | null;
}

/** A capability a provider structurally cannot honor for a workspace. Mirrors the worker. */
export type ComputeUnsupportedCapability = "network_restrictions";

/**
 * Whether a provider is deployable for this workspace, and why not. Mirrors the
 * worker's `ComputeProviderReadiness`. Carries configuration NAMES only — never a
 * value or secret. `missingConfig` ("an operator hasn't provisioned this") and
 * `unsupported` ("this provider can't do this here") are DISTINCT; keep them apart.
 */
export interface ComputeProviderReadiness {
  provider: string;
  ready: boolean;
  missingConfig: string[];
  unsupported: ComputeUnsupportedCapability[];
}

export interface SandboxReadiness {
  daytona: ComputeProviderReadiness;
  cloudflare: ComputeProviderReadiness;
  sprites: ComputeProviderReadiness;
}

export interface SandboxSettingsResponse {
  workspace: SandboxWorkspaceSettings | null;
  agent: SandboxAgentSettings | null;
  readiness: SandboxReadiness;
  /**
   * Deployment compute is provisioned by the service operator, so the read-only
   * Cloudflare deployment panel is hidden — a tenant cannot change any of it.
   * Absent from an older server, which reads as self-hosted and shows the panel.
   */
  operatorManagedCompute?: boolean;
  daytonaMode: "system" | "byok";
  daytonaAvailable: boolean;
  daytonaSecretPresent: boolean;
  spritesMode: "system" | "byok";
  spritesAvailable: boolean;
  spritesSecretPresent: boolean;
  /** Whether `mock` may be selected — false unless the deployment set
   *  DEFAULT_SANDBOX_PROVIDER=mock. Optional so an older server that does not
   *  send it is treated as "not available" rather than crashing the panel. */
  mockAvailable?: boolean;
  workspaceSecretEnvVars: Array<{ name: string; updatedAt: string }>;
  agentSecretEnvVars: Array<{ name: string; updatedAt: string }>;
  effective: {
    enabled: boolean;
    reason?: SandboxEffectiveConfigReason;
    value?: SandboxEffectiveConfigValue;
  };
}

export async function getSandboxSettings(
  fetchImpl: FetchLike = appFetch,
): Promise<SandboxSettingsResponse> {
  const res = await fetchImpl("/api/settings/sandbox", { credentials: "include" });
  if (!res.ok) throw await errorFromResponse(res, "load sandbox settings");
  return (await res.json()) as SandboxSettingsResponse;
}

export async function saveWorkspaceSandboxSettings(
  input: Record<string, unknown>,
  fetchImpl: FetchLike = appFetch,
): Promise<SandboxSettingsResponse> {
  const res = await fetchImpl("/api/settings/sandbox", {
    method: "PUT",
    credentials: "include",
    headers: JSON_HEADERS,
    body: JSON.stringify(input),
  });
  if (!res.ok) throw await errorFromResponse(res, "save sandbox settings");
  return (await res.json()) as SandboxSettingsResponse;
}

export async function saveAgentSandboxSettings(
  input: Record<string, unknown>,
  fetchImpl: FetchLike = appFetch,
): Promise<SandboxSettingsResponse> {
  const res = await fetchImpl("/api/settings/sandbox/agent", {
    method: "PUT",
    credentials: "include",
    headers: JSON_HEADERS,
    body: JSON.stringify(input),
  });
  if (!res.ok) throw await errorFromResponse(res, "save agent sandbox settings");
  return (await res.json()) as SandboxSettingsResponse;
}

export async function saveDaytonaSecret(
  input: { value: string; secretName?: string },
  fetchImpl: FetchLike = appFetch,
): Promise<SandboxSettingsResponse> {
  const res = await fetchImpl("/api/settings/sandbox/daytona-secret", {
    method: "PUT",
    credentials: "include",
    headers: JSON_HEADERS,
    body: JSON.stringify(input),
  });
  if (!res.ok) throw await errorFromResponse(res, "save Daytona API key");
  return (await res.json()) as SandboxSettingsResponse;
}

export async function clearDaytonaOverride(
  fetchImpl: FetchLike = appFetch,
): Promise<SandboxSettingsResponse> {
  const res = await fetchImpl("/api/settings/sandbox/daytona-secret", {
    method: "DELETE",
    credentials: "include",
  });
  if (!res.ok) throw await errorFromResponse(res, "reset Daytona configuration");
  return (await res.json()) as SandboxSettingsResponse;
}

export async function saveSpritesSecret(
  input: { value: string; secretName?: string },
  fetchImpl: FetchLike = appFetch,
): Promise<SandboxSettingsResponse> {
  const res = await fetchImpl("/api/settings/sandbox/sprites-secret", {
    method: "PUT",
    credentials: "include",
    headers: JSON_HEADERS,
    body: JSON.stringify(input),
  });
  if (!res.ok) throw await errorFromResponse(res, "save Sprites API token");
  return (await res.json()) as SandboxSettingsResponse;
}

export async function clearSpritesOverride(
  fetchImpl: FetchLike = appFetch,
): Promise<SandboxSettingsResponse> {
  const res = await fetchImpl("/api/settings/sandbox/sprites-secret", {
    method: "DELETE",
    credentials: "include",
  });
  if (!res.ok) throw await errorFromResponse(res, "reset Sprites configuration");
  return (await res.json()) as SandboxSettingsResponse;
}

export interface SandboxConnectionTestResult {
  ok: boolean;
  phase?: "connection" | "cleanup";
  error?: string;
}

/**
 * Creates and deletes a temporary Daytona sandbox against the saved
 * workspace configuration. A non-2xx response still carries a structured
 * body (e.g. `{ ok: false, phase: "connection", error: "missing_secret" }`
 * for incomplete config), so this only throws on a response with no
 * parseable JSON body at all.
 */
export async function testConnection(
  fetchImpl: FetchLike = appFetch,
): Promise<SandboxConnectionTestResult> {
  const res = await fetchImpl("/api/settings/sandbox/test", {
    method: "POST",
    credentials: "include",
  });
  const body = (await res.json().catch(() => null)) as SandboxConnectionTestResult | null;
  if (!body) throw await errorFromResponse(res, "test the sandbox connection");
  return body;
}
