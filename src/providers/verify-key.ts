/**
 * Lightweight provider API-key validation. Hits each provider's cheapest
 * authenticated endpoint (models list / key info) — no tokens are spent — to
 * distinguish a definitively rejected key (401/403) from a provider that's
 * merely unreachable (5xx/network), so callers can hard-block only the former.
 */
import {
  assertValidProviderBaseUrl,
  isOpenAICompatibleProvider,
  normalizeProviderBaseUrl,
  type ProviderConfigProvider,
  type ProviderEndpointConfig,
} from "../db/repositories/provider-configs";

export type KeyVerificationReason = "valid" | "invalid" | "unreachable";

type VerifiableProvider = "openai" | "anthropic" | "openrouter";

const ENDPOINTS: Record<
  VerifiableProvider,
  (key: string) => { url: string; headers: Record<string, string> }
> = {
  openai: (key) => ({
    url: "https://api.openai.com/v1/models",
    headers: { Authorization: `Bearer ${key}` },
  }),
  anthropic: (key) => ({
    url: "https://api.anthropic.com/v1/models",
    headers: { "x-api-key": key, "anthropic-version": "2023-06-01" },
  }),
  openrouter: (key) => ({
    url: "https://openrouter.ai/api/v1/key",
    headers: { Authorization: `Bearer ${key}` },
  }),
};

export async function verifyProviderKey(
  provider: string,
  key: string,
  fetchImpl: typeof fetch = fetch,
  endpointConfig?: ProviderEndpointConfig,
): Promise<{ reason: KeyVerificationReason }> {
  if (isOpenAICompatibleProvider(provider) && endpointConfig) {
    return verifyOpenAICompatibleKey(provider, key, endpointConfig, fetchImpl);
  }

  const build = ENDPOINTS[provider as VerifiableProvider];
  if (!build) return { reason: "unreachable" };

  const { url, headers } = build(key);
  try {
    const res = await fetchImpl(url, { method: "GET", headers });
    if (res.ok) return { reason: "valid" };
    if (res.status === 401 || res.status === 403) return { reason: "invalid" };
    return { reason: "unreachable" };
  } catch {
    return { reason: "unreachable" };
  }
}

async function verifyOpenAICompatibleKey(
  provider: ProviderConfigProvider,
  key: string,
  endpointConfig: ProviderEndpointConfig,
  fetchImpl: typeof fetch,
): Promise<{ reason: KeyVerificationReason }> {
  if (!endpointConfig.baseUrl) return { reason: "unreachable" };
  try {
    assertValidProviderBaseUrl(provider, endpointConfig.baseUrl);
  } catch {
    return { reason: "unreachable" };
  }
  const baseUrl = normalizeProviderBaseUrl(endpointConfig.baseUrl);
  const noAuth = provider === "openai-compatible" && endpointConfig.auth === "none";
  const headers = noAuth ? {} : { Authorization: `Bearer ${key}` };
  try {
    const res = await fetchImpl(`${baseUrl}/models`, { method: "GET", headers });
    if (res.ok) return { reason: "valid" };
    if (res.status === 401 || res.status === 403) return { reason: "invalid" };
    return { reason: "unreachable" };
  } catch {
    return { reason: "unreachable" };
  }
}
