import { appFetch } from "./lib/app-fetch";
import { errorFromResponse } from "./lib/http-error";
export type SettingsProvider =
  | "openai"
  | "anthropic"
  | "openrouter"
  | "openai-oauth"
  | "workers-ai"
  | "deepseek"
  | "zai"
  | "qwen"
  | "opencode-go"
  | "opencode-zen"
  | "openai-compatible";
export type ModelInputModality = "text" | "image" | "audio" | "video" | "file";
export type ModelOutputModality = "text" | "image" | "audio" | "video" | "file";
export type SaveDefaultAgentSettingsInput = {
  agent: {
    systemPrompt?: string;
    provider?: string;
    model?: string;
    modelInputModalities?: ModelInputModality[];
    showReasoning?: boolean;
    reasoningEffort?: ReasoningEffort;
    modelSupportsReasoning?: boolean | null;
  };
};

const SETTINGS_PROVIDERS: readonly SettingsProvider[] = [
  "openai",
  "anthropic",
  "openrouter",
  "openai-oauth",
  "workers-ai",
  "deepseek",
  "zai",
  "qwen",
  "opencode-go",
  "opencode-zen",
  "openai-compatible",
];

export type ProviderEndpointConfigBodyValue =
  | string
  | number
  | boolean
  | null
  | ProviderEndpointConfigBodyValue[]
  | { [key: string]: ProviderEndpointConfigBodyValue };

export interface ProviderEndpointConfig {
  baseUrl: string;
  /** Clean-egress proxy route, for the providers that need one. "" = direct. */
  proxyUrl: string;
  auth: "bearer" | "none";
  body: Record<string, ProviderEndpointConfigBodyValue>;
}

export interface ProviderSettingsView {
  provider: SettingsProvider;
  displayName: string;
  defaultSecretName: string;
  configuredSecretName: string;
  secretPresent: boolean;
  secretUpdatedAt: string | null;
  previewAvailable: boolean;
  endpointConfig: ProviderEndpointConfig;
  usable: boolean;
  /**
   * The models this workspace chose to see, or `null` when it has not curated
   * this provider. `null` and `[]` mean different things and must not be
   * collapsed: `null` offers the whole catalog, `[]` offers nothing.
   *
   * Optional on the wire so a client running against an older Worker still
   * parses; treat a missing field as `null`.
   */
  whitelistModels?: ProviderModelSearchResult[] | null;
}

export interface ProviderModelSearchResult {
  id: string;
  name?: string;
  description?: string;
  contextLength?: number;
  inputModalities: ModelInputModality[];
  outputModalities?: ModelOutputModality[];
  /**
   * Whether this MODEL can reason — nothing about whether its provider can
   * express effort. `undefined` is UNKNOWN and is never the same as `false`:
   * the effort control appears only on `true`, but only `false` is a claim that
   * the model cannot think.
   */
  reasoning?: boolean;
  /** What this model accepts for tuning reasoning. Absent = unknown; an EMPTY
   *  array means it reasons but exposes no control. */
  reasoningControls?: ReasoningControl[];
  source: "live" | "static";
}

export interface ProviderModelSearchResponse {
  provider: SettingsProvider;
  query: string;
  source: "live" | "static" | "mixed";
  models: ProviderModelSearchResult[];
}

export type ReasoningControl =
  | { type: "effort"; values: string[] }
  | { type: "budget_tokens"; min?: number; max?: number }
  | { type: "toggle" };

export const REASONING_EFFORTS = ["off", "low", "medium", "high"] as const;
export type ReasoningEffort = (typeof REASONING_EFFORTS)[number];

export function isReasoningEffort(value: unknown): value is ReasoningEffort {
  return typeof value === "string" && (REASONING_EFFORTS as readonly string[]).includes(value);
}

export interface AgentSettingsResponse {
  workspace: { id: string; name: string };
  agent: {
    id: string;
    name: string;
    systemPrompt: string;
    provider: string;
    model: string;
    modelInputModalities: ModelInputModality[];
    showReasoning: boolean;
    reasoningEffort: ReasoningEffort;
    /** `null` = unknown. Never conflate with `false`. */
    modelSupportsReasoning: boolean | null;
  };
  providers: ProviderSettingsView[];
}

export interface ProviderSecretPreview {
  provider: SettingsProvider;
  secretName: string;
  preview: string;
  chars: number;
  truncated: boolean;
  updatedAt: string;
}

export interface PrivacySettings {
  workspaceId: string;
  telemetryEnabled: boolean;
}

type FetchLike = typeof fetch;
const JSON_HEADERS = { "Content-Type": "application/json" } as const;

export function isSettingsProvider(value: string): value is SettingsProvider {
  return SETTINGS_PROVIDERS.includes(value as SettingsProvider);
}

export function buildDefaultAgentSettingsSaveInput(input: {
  systemPrompt: string;
  model: string;
  modelInputModalities?: ModelInputModality[];
  currentProvider: string;
  selectedProvider: SettingsProvider;
  providerChanged: boolean;
  showReasoning: boolean;
  reasoningEffort: ReasoningEffort;
  modelSupportsReasoning?: boolean | null;
}): SaveDefaultAgentSettingsInput {
  const agent: SaveDefaultAgentSettingsInput["agent"] = {
    systemPrompt: input.systemPrompt,
    model: input.model,
    modelInputModalities: input.modelInputModalities ?? ["text"],
    showReasoning: input.showReasoning,
    reasoningEffort: input.reasoningEffort,
    ...(input.modelSupportsReasoning === undefined
      ? {}
      : { modelSupportsReasoning: input.modelSupportsReasoning }),
  };
  if (isSettingsProvider(input.currentProvider) || input.providerChanged) {
    agent.provider = input.selectedProvider;
  }
  return { agent };
}

export async function searchProviderModels(
  provider: SettingsProvider,
  input: { query: string; limit?: number },
  fetchImpl: FetchLike = appFetch,
): Promise<ProviderModelSearchResponse> {
  const params = new URLSearchParams();
  params.set("q", input.query);
  if (input.limit !== undefined) params.set("limit", String(input.limit));
  const res = await fetchImpl(
    `/api/settings/providers/${encodeURIComponent(provider)}/models/search?${params.toString()}`,
    { credentials: "include" },
  );
  if (!res.ok) throw await errorFromResponse(res, "search provider models");
  return (await res.json()) as ProviderModelSearchResponse;
}

export interface ProviderModelCatalog {
  provider: SettingsProvider;
  models: ProviderModelSearchResult[];
  source: "live" | "static";
  fetchedAt: number;
  stale: boolean;
}

/**
 * The provider's full model list, served from the workspace's cached catalog.
 * Fetched once per surface and filtered locally — the old per-keystroke search
 * reached the provider's live API on every character typed.
 */
export async function getProviderModelCatalog(
  provider: SettingsProvider,
  input: { refresh?: boolean } = {},
  fetchImpl: FetchLike = appFetch,
): Promise<ProviderModelCatalog> {
  const query = input.refresh ? "?refresh=1" : "";
  const res = await fetchImpl(
    `/api/settings/providers/${encodeURIComponent(provider)}/models${query}`,
    { credentials: "include" },
  );
  if (!res.ok) throw await errorFromResponse(res, "load provider models");
  return (await res.json()) as ProviderModelCatalog;
}

/** `null` clears curation (offer every model again); `[]` selects nothing. */
export async function saveProviderModelWhitelist(
  provider: SettingsProvider,
  models: ProviderModelSearchResult[] | null,
  fetchImpl: FetchLike = appFetch,
): Promise<ProviderSettingsView> {
  const res = await fetchImpl(
    `/api/settings/providers/${encodeURIComponent(provider)}/models/whitelist`,
    {
      method: "PUT",
      credentials: "include",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ models }),
    },
  );
  if (!res.ok) throw await errorFromResponse(res, "save model list");
  return (await res.json()) as ProviderSettingsView;
}

export async function getDefaultAgentSettings(
  fetchImpl: FetchLike = appFetch,
): Promise<AgentSettingsResponse> {
  const res = await fetchImpl("/api/settings/agents/default", {
    credentials: "include",
  });
  if (!res.ok) throw await errorFromResponse(res, "load settings");
  return (await res.json()) as AgentSettingsResponse;
}

export async function getPrivacySettings(
  input: { workspaceId?: string } = {},
  fetchImpl: FetchLike = appFetch,
): Promise<PrivacySettings> {
  const path =
    input.workspaceId !== undefined
      ? `/api/settings/privacy?workspaceId=${encodeURIComponent(input.workspaceId)}`
      : "/api/settings/privacy";
  const res = await fetchImpl(path, { credentials: "include" });
  if (!res.ok) throw await errorFromResponse(res, "load privacy settings");
  return (await res.json()) as PrivacySettings;
}

export async function saveDefaultAgentSettings(
  input: SaveDefaultAgentSettingsInput,
  fetchImpl: FetchLike = appFetch,
): Promise<AgentSettingsResponse> {
  const res = await fetchImpl("/api/settings/agents/default", {
    method: "PUT",
    credentials: "include",
    headers: JSON_HEADERS,
    body: JSON.stringify(input),
  });
  if (!res.ok) throw await errorFromResponse(res, "save agent settings");
  return (await res.json()) as AgentSettingsResponse;
}

export async function savePrivacySettings(
  input: { telemetryEnabled: boolean },
  fetchImpl: FetchLike = appFetch,
): Promise<PrivacySettings> {
  const res = await fetchImpl("/api/settings/privacy", {
    method: "PUT",
    credentials: "include",
    headers: JSON_HEADERS,
    body: JSON.stringify(input),
  });
  if (!res.ok) throw await errorFromResponse(res, "save privacy settings");
  return (await res.json()) as PrivacySettings;
}

export async function saveProviderSecret(
  provider: SettingsProvider,
  input: { value: string; secretName?: string },
  fetchImpl: FetchLike = appFetch,
): Promise<ProviderSettingsView> {
  const res = await fetchImpl(`/api/settings/providers/${encodeURIComponent(provider)}/secret`, {
    method: "PUT",
    credentials: "include",
    headers: JSON_HEADERS,
    body: JSON.stringify(input),
  });
  if (!res.ok) throw await errorFromResponse(res, "save provider secret");
  return (await res.json()) as ProviderSettingsView;
}

export async function saveProviderConfig(
  provider: SettingsProvider,
  input: Partial<ProviderEndpointConfig>,
  fetchImpl: FetchLike = appFetch,
): Promise<ProviderSettingsView> {
  const res = await fetchImpl(`/api/settings/providers/${encodeURIComponent(provider)}/config`, {
    method: "PUT",
    credentials: "include",
    headers: JSON_HEADERS,
    body: JSON.stringify(input),
  });
  if (!res.ok) throw await errorFromResponse(res, "save provider config");
  return (await res.json()) as ProviderSettingsView;
}

export type ProviderKeyVerification = {
  reason: "valid" | "invalid" | "unreachable";
  valid: boolean;
};

export async function verifyProviderSecret(
  provider: SettingsProvider,
  input: { value: string; endpointConfig?: ProviderEndpointConfig },
  fetchImpl: FetchLike = appFetch,
): Promise<ProviderKeyVerification> {
  const res = await fetchImpl(`/api/settings/providers/${encodeURIComponent(provider)}/verify`, {
    method: "POST",
    credentials: "include",
    headers: JSON_HEADERS,
    body: JSON.stringify(input),
  });
  if (!res.ok) throw await errorFromResponse(res, "verify provider secret");
  return (await res.json()) as ProviderKeyVerification;
}

export interface WebToolsSettings {
  exaSecretPresent: boolean;
  exaSecretUpdatedAt: string | null;
  webSearchEnabled: boolean;
}

export async function getWebToolsSettings(
  fetchImpl: FetchLike = appFetch,
): Promise<WebToolsSettings> {
  const res = await fetchImpl("/api/settings/web-tools", { credentials: "include" });
  if (!res.ok) throw await errorFromResponse(res, "load web tools settings");
  return (await res.json()) as WebToolsSettings;
}

export async function saveExaSecret(
  value: string,
  fetchImpl: FetchLike = appFetch,
): Promise<WebToolsSettings> {
  const res = await fetchImpl("/api/settings/web-tools/exa-secret", {
    method: "PUT",
    credentials: "include",
    headers: JSON_HEADERS,
    body: JSON.stringify({ value }),
  });
  if (!res.ok) throw await errorFromResponse(res, "save the Exa API key");
  return (await res.json()) as WebToolsSettings;
}

export async function verifyExaSecret(
  value: string,
  fetchImpl: FetchLike = appFetch,
): Promise<{ reason: "valid" | "invalid" | "unreachable" }> {
  const res = await fetchImpl("/api/settings/web-tools/exa-secret/verify", {
    method: "POST",
    credentials: "include",
    headers: JSON_HEADERS,
    body: JSON.stringify({ value }),
  });
  if (!res.ok) throw await errorFromResponse(res, "verify the Exa API key");
  return (await res.json()) as { reason: "valid" | "invalid" | "unreachable" };
}

export async function deleteExaSecret(fetchImpl: FetchLike = appFetch): Promise<WebToolsSettings> {
  const res = await fetchImpl("/api/settings/web-tools/exa-secret", {
    method: "DELETE",
    credentials: "include",
  });
  if (!res.ok) throw await errorFromResponse(res, "remove the Exa API key");
  return (await res.json()) as WebToolsSettings;
}

export async function previewProviderSecret(
  provider: SettingsProvider,
  input: { chars?: number },
  fetchImpl: FetchLike = appFetch,
): Promise<ProviderSecretPreview> {
  const res = await fetchImpl(
    `/api/settings/providers/${encodeURIComponent(provider)}/secret-preview`,
    {
      method: "POST",
      credentials: "include",
      headers: JSON_HEADERS,
      body: JSON.stringify(input),
    },
  );
  if (!res.ok) throw await errorFromResponse(res, "preview provider secret");
  return (await res.json()) as ProviderSecretPreview;
}
