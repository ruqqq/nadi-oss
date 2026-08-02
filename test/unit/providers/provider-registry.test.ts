/**
 * Adding a provider means threading its id through ~15 places. The unions and
 * total Records are compile-checked; these lists are not — a miss fails
 * silently at runtime (drop it from SUPPORTED_RUNTIME_PROVIDERS and a thread
 * quietly reverts to the default model on rehydrate; drop it from
 * WORKSPACE_SECRET_PROVIDERS and its key is never looked up).
 *
 * SUPPORTED_PROVIDER_CONFIGS is the source of truth. Everything else must agree
 * with it.
 */
import { describe, expect, it } from "vitest";
import {
  SUPPORTED_MODEL_PROVIDERS,
  SUPPORTED_RUNTIME_PROVIDERS,
  WORKSPACE_SECRET_PROVIDERS,
  providerUsesWorkspaceSecret,
} from "../../../src/agent/model-config";
import {
  SUPPORTED_PROVIDER_CONFIGS,
  defaultProviderEndpointConfig,
  isOpenAICompatibleProvider,
  isProviderConfigProvider,
} from "../../../src/db/repositories/provider-configs";
import { STATIC_MODELS, modelListUrl } from "../../../src/providers/model-search";

const PROVIDERS = SUPPORTED_PROVIDER_CONFIGS.map((entry) => entry.provider);

/** Authenticated by the `AI` binding, not a workspace secret. */
const BINDING_AUTH_PROVIDERS = new Set(["workers-ai"]);

/** The user must supply a base URL; we have no sensible default. */
const USER_SUPPLIED_BASE_URL = new Set(["qwen", "openai-compatible"]);

describe("provider registry", () => {
  it("has at least one provider to check", () => {
    expect(PROVIDERS.length).toBeGreaterThan(0);
  });

  it.each(PROVIDERS)("%s is a recognized provider id", (provider) => {
    expect(isProviderConfigProvider(provider)).toBe(true);
  });

  it.each(PROVIDERS)("%s is accepted by the model-config runtime", (provider) => {
    expect(SUPPORTED_MODEL_PROVIDERS[provider]).toBe(true);
  });

  it.each(PROVIDERS)("%s survives a thread model-snapshot rehydrate", (provider) => {
    expect(SUPPORTED_RUNTIME_PROVIDERS.has(provider)).toBe(true);
  });

  it.each(PROVIDERS)("%s resolves its key from the right place", (provider) => {
    const usesSecret = !BINDING_AUTH_PROVIDERS.has(provider);
    expect(WORKSPACE_SECRET_PROVIDERS[provider] ?? false).toBe(usesSecret);
    expect(providerUsesWorkspaceSecret(provider)).toBe(usesSecret);
  });

  it.each(PROVIDERS)("%s has a static model list entry", (provider) => {
    expect(STATIC_MODELS[provider]).toBeDefined();
  });

  it.each(PROVIDERS)("%s ships a usable default base URL", (provider) => {
    if (!isOpenAICompatibleProvider(provider)) return;
    const { baseUrl, auth } = defaultProviderEndpointConfig(provider);
    expect(auth).toBe("bearer");
    if (USER_SUPPLIED_BASE_URL.has(provider)) {
      expect(baseUrl).toBe("");
    } else {
      expect(baseUrl).toMatch(/^https:\/\//);
    }
  });

  it.each(PROVIDERS)("%s lists models over https, or not at all", (provider) => {
    const url = modelListUrl(provider, defaultProviderEndpointConfig(provider).baseUrl);
    if (url !== null) expect(url).toMatch(/^https:\/\//);
  });
});

describe("opencode-zen", () => {
  it("points at the Zen gateway, not the Go plan", () => {
    // The two are separate products with separate keys and catalogs. Only Zen
    // has the free models; crossing the wires would 404 every free id.
    expect(defaultProviderEndpointConfig("opencode-zen").baseUrl).toBe(
      "https://opencode.ai/zen/v1",
    );
    expect(defaultProviderEndpointConfig("opencode-go").baseUrl).toBe(
      "https://opencode.ai/zen/go/v1",
    );
    expect(modelListUrl("opencode-zen", "")).toBe("https://opencode.ai/zen/v1/models");
  });

  it("does not curate the free models", () => {
    // Zen's `*-free` models are throttled per egress IP, and a Worker's IP is
    // shared across all of Cloudflare — they answer 429 FreeUsageLimitError from
    // Nadi no matter whose key is attached. Listing one would sell a model that
    // cannot answer. Verified against the deployed Worker: keyless from the
    // Worker is throttled identically to keyed, while keyless from a normal IP
    // succeeds, so the limit follows the IP, not the account.
    const ids = STATIC_MODELS["opencode-zen"].map((m) => m.id);
    expect(ids).not.toHaveLength(0);
    for (const id of ids) expect(id.endsWith("-free")).toBe(false);
  });

  it("is reachable as an OpenAI-compatible provider", () => {
    expect(isOpenAICompatibleProvider("opencode-zen")).toBe(true);
  });
});
