import { createOpenAICompatible } from "@ai-sdk/openai-compatible";
import type { LanguageModel } from "ai";
import {
  sanitizeProviderBodyDefaults,
  type ProviderConfigJsonValue,
  type ProviderEndpointConfig,
} from "../db/repositories/provider-configs";
import { createDeepSeekModel } from "./deepseek";
import { applyProxyGateHeader, stripEgressHeaders } from "./egress-proxy";

/**
 * Providers reached over an OpenAI-shaped HTTP API rather than a bespoke one.
 *
 * These deliberately do NOT use `@ai-sdk/openai`: that package models the real
 * OpenAI API, and in particular has no `reasoning_content` handling, so DeepSeek
 * / GLM / Qwen / Zen thinking text was silently discarded. `@ai-sdk/openai-compatible`
 * maps it (streaming and not), keys `providerOptions` by the provider's own name,
 * and passes unknown keys straight through to the request body — which is how
 * each provider's native thinking parameter is reachable.
 *
 * `createOpenAICompatibleFetch` still wraps every request, so admin-configured
 * body defaults and no-auth endpoints keep working regardless of adapter.
 */
export function createOpenAICompatibleModel(input: {
  provider: string;
  model: string;
  apiKey: string;
  endpointConfig: ProviderEndpointConfig;
  fetch?: typeof fetch;
  /**
   * Optional clean-egress proxy. When set, requests go to `proxy.url` instead
   * of the provider's own endpoint, gated with the exe.dev VM `proxy.token`.
   * Used where a provider blocks or throttles Cloudflare-origin traffic.
   */
  proxy?: { url: string; token: string };
}): LanguageModel {
  if (!input.endpointConfig.baseUrl) {
    throw new Error(`openai_compatible_base_url_missing:${input.provider}`);
  }
  const auth = input.provider === "openai-compatible" ? input.endpointConfig.auth : "bearer";
  const apiKey = auth === "none" ? "no-auth-placeholder" : input.apiKey;
  const baseURL = input.proxy ? input.proxy.url : input.endpointConfig.baseUrl;
  const fetchOptions: Parameters<typeof createOpenAICompatibleFetch>[0] = {
    auth,
    bodyDefaults: input.endpointConfig.body,
  };
  if (input.fetch !== undefined) fetchOptions.fetch = input.fetch;
  if (input.proxy !== undefined) fetchOptions.proxyToken = input.proxy.token;
  const wrappedFetch = createOpenAICompatibleFetch(fetchOptions);

  // DeepSeek gets the generic adapter too, configured in `deepseek.ts`. Its
  // official package is text-only — the converter drops image parts — so the
  // native adapter cost us vision on `deepseek-v4-flash-vision-exp`.
  if (input.provider === "deepseek") {
    const deepseekInput: Parameters<typeof createDeepSeekModel>[0] = {
      model: input.model,
      apiKey,
      baseURL,
      fetch: wrappedFetch,
    };
    return createDeepSeekModel(deepseekInput);
  }

  return createOpenAICompatible({
    name: input.provider,
    apiKey,
    baseURL,
    fetch: wrappedFetch,
  }).chatModel(input.model) as LanguageModel;
}

export function createOpenAICompatibleFetch(input: {
  fetch?: typeof fetch;
  auth: ProviderEndpointConfig["auth"];
  bodyDefaults: Record<string, ProviderConfigJsonValue>;
  /** Set when the request is routed through the egress proxy. */
  proxyToken?: string;
}): typeof fetch {
  const fetchImpl = input.fetch ?? fetch;
  const bodyDefaults = sanitizeProviderBodyDefaults(input.bodyDefaults);
  return async (requestInfo, init) => {
    const request = await readRequestParts(requestInfo, init);
    const headers = new Headers(request.headers);
    if (input.auth === "none") headers.delete("authorization");
    if (input.proxyToken !== undefined) {
      stripEgressHeaders(headers);
      applyProxyGateHeader(headers, input.proxyToken);
    }
    const body = await mergeBodyDefaults(request.url, headers, request.body, bodyDefaults);
    const nextInit: RequestInit = {
      method: request.method,
      headers,
    };
    if (body !== undefined) nextInit.body = body;
    if (request.signal !== null) nextInit.signal = request.signal;
    return fetchImpl(request.url, nextInit);
  };
}

async function readRequestParts(
  requestInfo: RequestInfo | URL,
  init?: RequestInit,
): Promise<{
  url: string;
  method: string;
  headers: Headers;
  body: BodyInit | null | undefined;
  signal: AbortSignal | null;
}> {
  if (requestInfo instanceof Request) {
    const headers = new Headers(requestInfo.headers);
    if (init?.headers) new Headers(init.headers).forEach((value, key) => headers.set(key, value));
    return {
      url: requestInfo.url,
      method: init?.method ?? requestInfo.method,
      headers,
      body:
        init?.body ?? (requestInfo.body === null ? undefined : await requestInfo.clone().text()),
      signal: init?.signal ?? requestInfo.signal,
    };
  }
  return {
    url: String(requestInfo),
    method: init?.method ?? "GET",
    headers: new Headers(init?.headers),
    body: init?.body,
    signal: init?.signal ?? null,
  };
}

async function mergeBodyDefaults(
  url: string,
  headers: Headers,
  body: BodyInit | null | undefined,
  bodyDefaults: Record<string, ProviderConfigJsonValue>,
): Promise<BodyInit | null | undefined> {
  if (!new URL(url).pathname.endsWith("/chat/completions")) return body;
  const contentType = headers.get("content-type");
  if (contentType && !contentType.includes("application/json")) return body;
  if (typeof body !== "string") return body;
  try {
    const parsed = JSON.parse(body) as Record<string, unknown>;
    if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) return body;
    return JSON.stringify({ ...bodyDefaults, ...parsed });
  } catch {
    return body;
  }
}
