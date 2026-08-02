import { and, desc, eq } from "drizzle-orm";
import { registryDb } from "../client";
import { providerConfigs } from "../schema";
import type { Env } from "../../env";

export type ProviderConfigProvider =
  | "openrouter"
  | "openai"
  | "anthropic"
  | "openai-oauth"
  | "workers-ai"
  | "deepseek"
  | "zai"
  | "qwen"
  | "opencode-go"
  | "opencode-zen"
  | "openai-compatible";

export type ProviderAuthMode = "bearer" | "none";

export type ProviderConfigJsonValue =
  | string
  | number
  | boolean
  | null
  | ProviderConfigJsonValue[]
  | { [key: string]: ProviderConfigJsonValue };

export interface ProviderEndpointConfig {
  baseUrl: string;
  /**
   * Clean-egress proxy route this provider's inference traffic is sent through
   * instead of `baseUrl`, e.g. `https://proxy.example.com/opencode-zen`. Empty means
   * direct. Only meaningful for PROVIDERS_WITH_PROXY; the route prefix has to
   * match one the proxy serves (`infra/egress-proxy/server.mjs`).
   */
  proxyUrl: string;
  auth: ProviderAuthMode;
  body: Record<string, ProviderConfigJsonValue>;
}

/**
 * Providers whose traffic may be routed through the egress proxy. Mirrors the
 * ROUTES table in `infra/egress-proxy/server.mjs` — a provider listed here with
 * no matching route there would 404.
 */
export const PROVIDERS_WITH_PROXY: ProviderConfigProvider[] = ["openai-oauth", "opencode-zen"];

export function providerSupportsProxy(provider: string): boolean {
  return PROVIDERS_WITH_PROXY.some((entry) => entry === provider);
}

export interface ProviderMetadata {
  provider: ProviderConfigProvider;
  displayName: string;
  defaultSecretName: string;
  configuredSecretName: string;
  endpointConfig: ProviderEndpointConfig;
}

export const SUPPORTED_PROVIDER_CONFIGS: Array<{
  provider: ProviderConfigProvider;
  displayName: string;
}> = [
  { provider: "openai", displayName: "OpenAI" },
  { provider: "openai-oauth", displayName: "OpenAI OAuth" },
  { provider: "anthropic", displayName: "Anthropic" },
  { provider: "workers-ai", displayName: "Cloudflare Workers AI" },
  { provider: "openrouter", displayName: "OpenRouter" },
  { provider: "deepseek", displayName: "DeepSeek" },
  { provider: "zai", displayName: "Z.AI GLM" },
  { provider: "qwen", displayName: "Qwen / DashScope" },
  { provider: "opencode-go", displayName: "OpenCode Go" },
  { provider: "opencode-zen", displayName: "OpenCode Zen" },
  { provider: "openai-compatible", displayName: "OpenAI Compatible" },
];

const BODY_ALLOWLIST = new Set([
  "reasoning_effort",
  "thinking",
  "enable_thinking",
  "preserve_thinking",
  "thinking_budget",
  "tool_stream",
]);

export function isProviderConfigProvider(value: string): value is ProviderConfigProvider {
  return SUPPORTED_PROVIDER_CONFIGS.some((entry) => entry.provider === value);
}

export function defaultProviderSecretName(provider: ProviderConfigProvider): string {
  return `provider:${provider}`;
}

export function defaultProviderEndpointConfig(
  provider: ProviderConfigProvider,
): ProviderEndpointConfig {
  const base = { proxyUrl: "", auth: "bearer" as const, body: {} };
  switch (provider) {
    case "deepseek":
      return { ...base, baseUrl: "https://api.deepseek.com" };
    case "zai":
      return { ...base, baseUrl: "https://api.z.ai/api/paas/v4" };
    case "qwen":
      return { ...base, baseUrl: "" };
    case "opencode-go":
      return { ...base, baseUrl: "https://opencode.ai/zen/go/v1" };
    // The Zen gateway, not the Go subscription plan: a different endpoint, key,
    // and catalog. Zen is the only one with free models.
    case "opencode-zen":
      return { ...base, baseUrl: "https://opencode.ai/zen/v1" };
    case "openai-compatible":
      return { ...base, baseUrl: "" };
    default:
      return { ...base, baseUrl: "" };
  }
}

export function isOpenAICompatibleProvider(
  provider: string,
): provider is "deepseek" | "zai" | "qwen" | "opencode-go" | "opencode-zen" | "openai-compatible" {
  return (
    provider === "deepseek" ||
    provider === "zai" ||
    provider === "qwen" ||
    provider === "opencode-go" ||
    provider === "opencode-zen" ||
    provider === "openai-compatible"
  );
}

export function normalizeProviderBaseUrl(input: string): string {
  return input.trim().replace(/\/+$/, "");
}

/**
 * Providers whose `endpointConfig.baseUrl` is a real, user-editable address —
 * the OpenAI-compatible gateways. openai-oauth is NOT one: its upstream is a
 * constant in the provider module and the only address a workspace sets is
 * `proxyUrl`.
 */
export function providerUsesConfigurableBaseUrl(
  provider: string,
): provider is "deepseek" | "zai" | "qwen" | "opencode-go" | "opencode-zen" | "openai-compatible" {
  return isOpenAICompatibleProvider(provider);
}

export function assertValidProviderBaseUrl(
  provider: ProviderConfigProvider,
  baseUrl: string,
): void {
  if (!providerUsesConfigurableBaseUrl(provider)) return;
  const normalized = normalizeProviderBaseUrl(baseUrl);
  if ((provider === "qwen" || provider === "openai-compatible") && !normalized) {
    throw new Error("provider_base_url_required");
  }
  if (!normalized) return;
  assertValidProviderUrl(normalized, "provider_base_url_invalid");
}

export function assertValidProviderProxyUrl(
  provider: ProviderConfigProvider,
  proxyUrl: string,
): void {
  const normalized = normalizeProviderBaseUrl(proxyUrl);
  if (!normalized) return;
  if (!providerSupportsProxy(provider)) throw new Error("provider_proxy_url_unsupported");
  assertValidProviderUrl(normalized, "provider_proxy_url_invalid");
}

/** https everywhere, plus plain http on localhost so `wrangler dev` can point
 *  at a proxy running on the same box. */
function assertValidProviderUrl(normalized: string, errorCode: string): void {
  let parsed: URL;
  try {
    parsed = new URL(normalized);
  } catch {
    throw new Error(errorCode);
  }
  const localHttp =
    parsed.protocol === "http:" &&
    (parsed.hostname === "localhost" || parsed.hostname === "127.0.0.1");
  if (parsed.protocol !== "https:" && !localHttp) {
    throw new Error(errorCode);
  }
}

export function sanitizeProviderBodyDefaults(
  body: unknown,
): Record<string, ProviderConfigJsonValue> {
  if (typeof body !== "object" || body === null || Array.isArray(body)) return {};
  const next: Record<string, ProviderConfigJsonValue> = {};
  for (const [key, value] of Object.entries(body)) {
    if (!BODY_ALLOWLIST.has(key)) continue;
    if (isProviderConfigJsonValue(value)) next[key] = value;
  }
  return next;
}

export function parseProviderEndpointConfig(
  provider: ProviderConfigProvider,
  configJson: string | null | undefined,
): ProviderEndpointConfig {
  const defaults = defaultProviderEndpointConfig(provider);
  if (!configJson) return defaults;
  let parsed: unknown;
  try {
    parsed = JSON.parse(configJson);
  } catch {
    return defaults;
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) return defaults;
  const obj = parsed as Record<string, unknown>;
  const auth = provider === "openai-compatible" && obj.auth === "none" ? "none" : "bearer";
  const baseUrl =
    typeof obj.baseUrl === "string" ? normalizeProviderBaseUrl(obj.baseUrl) : defaults.baseUrl;
  const proxyUrl =
    providerSupportsProxy(provider) && typeof obj.proxyUrl === "string"
      ? normalizeProviderBaseUrl(obj.proxyUrl)
      : defaults.proxyUrl;
  return {
    baseUrl,
    proxyUrl,
    auth,
    body: sanitizeProviderBodyDefaults(obj.body),
  };
}

export function stringifyProviderEndpointConfig(
  provider: ProviderConfigProvider,
  input: Partial<ProviderEndpointConfig>,
): string {
  const defaults = defaultProviderEndpointConfig(provider);
  const baseUrl =
    input.baseUrl !== undefined ? normalizeProviderBaseUrl(input.baseUrl) : defaults.baseUrl;
  assertValidProviderBaseUrl(provider, baseUrl);
  const proxyUrl =
    input.proxyUrl !== undefined ? normalizeProviderBaseUrl(input.proxyUrl) : defaults.proxyUrl;
  assertValidProviderProxyUrl(provider, proxyUrl);
  const auth = provider === "openai-compatible" && input.auth === "none" ? "none" : "bearer";
  return JSON.stringify({
    baseUrl,
    proxyUrl,
    auth,
    body: sanitizeProviderBodyDefaults(input.body),
  });
}

function isProviderConfigJsonValue(value: unknown): value is ProviderConfigJsonValue {
  if (
    value === null ||
    typeof value === "string" ||
    typeof value === "number" ||
    typeof value === "boolean"
  ) {
    return Number.isFinite(value as number) || typeof value !== "number";
  }
  if (Array.isArray(value)) return value.every(isProviderConfigJsonValue);
  if (typeof value === "object") {
    return Object.values(value as Record<string, unknown>).every(isProviderConfigJsonValue);
  }
  return false;
}

export async function getProviderConfig(
  env: Env,
  workspaceId: string,
  provider: ProviderConfigProvider,
) {
  const db = registryDb(env);
  return db
    .select()
    .from(providerConfigs)
    .where(
      and(eq(providerConfigs.workspaceId, workspaceId), eq(providerConfigs.provider, provider)),
    )
    .orderBy(desc(providerConfigs.createdAt), desc(providerConfigs.id))
    .get();
}

export async function listProviderConfigMetadata(
  env: Env,
  workspaceId: string,
): Promise<ProviderMetadata[]> {
  const rows = await Promise.all(
    SUPPORTED_PROVIDER_CONFIGS.map(async (entry) => {
      const config = await getProviderConfig(env, workspaceId, entry.provider);
      const defaultSecretName = defaultProviderSecretName(entry.provider);
      return {
        provider: entry.provider,
        displayName: config?.displayName ?? entry.displayName,
        defaultSecretName,
        configuredSecretName: config?.secretName ?? defaultSecretName,
        endpointConfig: parseProviderEndpointConfig(entry.provider, config?.configJson),
      };
    }),
  );
  return rows;
}

export async function upsertProviderConfig(
  env: Env,
  workspaceId: string,
  input: {
    provider: ProviderConfigProvider;
    displayName?: string;
    secretName?: string;
    config?: Partial<ProviderEndpointConfig>;
  },
) {
  if (!isProviderConfigProvider(input.provider)) {
    throw new Error(`unsupported_provider:${input.provider}`);
  }

  const fallback = SUPPORTED_PROVIDER_CONFIGS.find((entry) => entry.provider === input.provider);
  if (!fallback) throw new Error(`unsupported_provider:${input.provider}`);

  const currentConfig = await getProviderConfig(env, workspaceId, input.provider);
  const displayName = input.displayName?.trim() ?? "";
  const secretName = input.secretName?.trim() ?? "";
  const defaultSecretName = defaultProviderSecretName(input.provider);
  const previousConfigJson = currentConfig?.configJson ?? null;
  const configJson =
    input.config === undefined
      ? previousConfigJson
      : stringifyProviderEndpointConfig(input.provider, input.config);

  const id = `pcfg_${crypto.randomUUID()}`;

  await env.REGISTRY_DB.prepare(
    [
      "INSERT INTO provider_configs",
      "(id, workspace_id, provider, display_name, secret_name, config_json, created_at)",
      "VALUES (",
      "?,",
      "?,",
      "?,",
      "coalesce(nullif(?, ''), nullif((select display_name from provider_configs where workspace_id = ? and provider = ? order by created_at desc, id desc limit 1), ''), ?),",
      "coalesce(nullif(?, ''), nullif((select secret_name from provider_configs where workspace_id = ? and provider = ? order by created_at desc, id desc limit 1), ''), ?),",
      "?,",
      "max(coalesce((select max(created_at) from provider_configs where workspace_id = ? and provider = ?), 0) + 1, ?)",
      ")",
    ].join(" "),
  )
    .bind(
      id,
      workspaceId,
      input.provider,
      displayName,
      workspaceId,
      input.provider,
      fallback.displayName,
      secretName,
      workspaceId,
      input.provider,
      defaultSecretName,
      configJson,
      workspaceId,
      input.provider,
      Date.now(),
    )
    .run();

  const row = await registryDb(env)
    .select()
    .from(providerConfigs)
    .where(eq(providerConfigs.id, id))
    .get();
  if (!row) throw new Error("provider_config_insert_failed");
  return row;
}
