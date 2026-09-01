/**
 * `/api/settings/**` — agent defaults, providers, privacy, web tools, voice,
 * sandbox, GitHub, and per-user preferences.
 *
 * Two shapes worth calling out:
 *  - `POST /api/settings/sandbox/test` is parsed as JSON even on a non-2xx, so a
 *    failure must still carry `{ok:false, phase, error}` rather than a bare status.
 *  - Every sandbox mutation returns the WHOLE `SandboxSettingsResponse`, not a patch.
 */

import { http, HttpResponse } from "msw";
import type { DaytonaProviderConfig, SpritesProviderConfig } from "../../sandbox-settings-api";
import type { ProviderModelSearchResult, SettingsProvider } from "../../settings-api";
import { getStore } from "../store";
import { notFound, pathParam } from "./util";

/** Enough of a catalogue that model search returns something for the two
 *  providers the default scenario configures. */
/** GitHub caps `/installation/repositories` at 100 per page; the mock matches it. */
const PER_PAGE = 100;

/** `[id, display name]`. Real providers return a name distinct from the id, and
 *  the model rows render both — a fixture that sets `name: id` would show the
 *  same string twice and hide that. */
/** `[id, name, reasoning]`. The third slot is deliberately OMITTED on some rows:
 *  that is the "unknown" state, which is what surfaces the per-model
 *  declaration control in the Models card. Encoding it as `false` instead would
 *  make a state the real app reaches unreachable in the mock. */
const MODEL_CATALOGUE: Partial<Record<SettingsProvider, Array<[string, string, boolean?]>>> = {
  anthropic: [
    ["claude-opus-4-8", "Claude Opus 4.8", true],
    ["claude-sonnet-4-5", "Claude Sonnet 4.5", true],
    // Known NOT to reason — the composer must hide the thinking control here,
    // which is different from hiding it because we do not know.
    ["claude-haiku-4-5", "Claude Haiku 4.5", false],
  ],
  openai: [
    ["gpt-5.2", "GPT-5.2", true],
    ["gpt-5.2-mini", "GPT-5.2 mini", true],
    ["o4-mini", "o4-mini", true],
  ],
  // Seeded as configured, so it is what a new chat falls back to when another
  // provider is curated to zero. Without a catalogue here that fallback lands on
  // an empty picker — a dead end the real provider (which has a static list)
  // would never produce.
  "openai-oauth": [
    ["gpt-5.4-mini", "GPT-5.4 mini", true],
    ["gpt-5.5", "GPT-5.5", true],
    // Unknown: no third element. Drives the "Thinking?" declaration affordance.
    ["gpt-5.6-sol", "GPT-5.6 Sol"],
  ],
  openrouter: [
    ["anthropic/claude-sonnet-4-5", "Claude Sonnet 4.5", true],
    ["openai/gpt-5.2", "GPT-5.2", true],
    ["google/gemini-3-pro", "Gemini 3 Pro", true],
  ],
  "workers-ai": [
    ["@cf/meta/llama-4-scout", "Llama 4 Scout", false],
    ["@cf/qwen/qwen3-coder", "Qwen3 Coder", true],
  ],
};

function catalogFor(provider: SettingsProvider) {
  return (MODEL_CATALOGUE[provider] ?? []).map(([id, name, reasoning]) => ({
    id,
    name,
    contextLength: 200_000,
    inputModalities: ["text", "image"] as const,
    outputModalities: ["text"] as const,
    ...(reasoning === undefined ? {} : { reasoning }),
    source: "static" as const,
  }));
}

export const settingsHandlers = [
  http.get("/api/settings/agents/default", () => {
    const settings = getStore().settings;
    if (!settings) return notFound("Your workspace settings");
    return HttpResponse.json(settings);
  }),

  http.put("/api/settings/agents/default", async ({ request }) => {
    const store = getStore();
    if (!store.settings) return notFound("Your workspace settings");
    const input = (await request.json().catch(() => ({}))) as {
      agent?: Partial<(typeof store.settings)["agent"]>;
    };
    store.settings.agent = { ...store.settings.agent, ...input.agent };
    return HttpResponse.json(store.settings);
  }),

  http.get("/api/settings/providers/:provider/models/search", ({ params, request }) => {
    const provider = pathParam(params, "provider") as SettingsProvider;
    const url = new URL(request.url);
    const query = (url.searchParams.get("q") ?? "").toLowerCase();
    const limit = Number.parseInt(url.searchParams.get("limit") ?? "20", 10);
    const models = catalogFor(provider)
      .filter((model) => model.id.toLowerCase().includes(query))
      .slice(0, Number.isFinite(limit) ? limit : 20);
    return HttpResponse.json({
      provider,
      query,
      source: "static",
      models,
      fetchedAt: Date.now(),
    });
  }),

  http.get("/api/settings/providers/:provider/models", ({ params }) => {
    const provider = pathParam(params, "provider") as SettingsProvider;
    return HttpResponse.json({
      provider,
      models: catalogFor(provider),
      source: "static",
      fetchedAt: Date.now() - 2 * 60 * 60 * 1000,
      stale: false,
    });
  }),

  http.put("/api/settings/providers/:provider/models/whitelist", async ({ params, request }) => {
    const provider = pathParam(params, "provider") as SettingsProvider;
    const store = getStore();
    if (!store.settings) return notFound("Your workspace settings");
    const body = (await request.json().catch(() => ({}))) as { models?: unknown };
    // `null` clears curation; an array is the choice. Anything else is a bug in
    // the caller, and the mock should say so rather than quietly storing null.
    const models = body.models === null ? null : Array.isArray(body.models) ? body.models : null;

    const view = store.settings.providers.find((entry) => entry.provider === provider);
    if (!view) return notFound(`Provider ${provider}`);
    // Not `ProviderSettingsView["whitelistModels"]`: that indexed type includes
    // `undefined` (the field is optional on the wire), which
    // exactOptionalPropertyTypes rejects on assignment.
    view.whitelistModels = models as ProviderModelSearchResult[] | null;
    return HttpResponse.json(view);
  }),

  http.put("/api/settings/providers/:provider/secret", async ({ params, request }) => {
    const store = getStore();
    const provider = pathParam(params, "provider");
    const input = (await request.json().catch(() => ({}))) as {
      value?: string;
      secretName?: string;
    };
    const view = store.settings?.providers.find((p) => p.provider === provider);
    if (!view) return notFound("That provider");
    view.secretPresent = (input.value ?? "").length > 0;
    view.usable = view.secretPresent;
    view.previewAvailable = view.secretPresent;
    view.secretUpdatedAt = view.secretPresent ? new Date().toISOString() : null;
    if (input.secretName) view.configuredSecretName = input.secretName;
    return HttpResponse.json(view);
  }),

  http.put("/api/settings/providers/:provider/config", async ({ params, request }) => {
    const store = getStore();
    const view = store.settings?.providers.find((p) => p.provider === pathParam(params, "provider"));
    if (!view) return notFound("That provider");
    const input = (await request.json().catch(() => ({}))) as Partial<
      (typeof view)["endpointConfig"]
    >;
    view.endpointConfig = { ...view.endpointConfig, ...input };
    return HttpResponse.json(view);
  }),

  http.post("/api/settings/providers/:provider/verify", () =>
    HttpResponse.json({ reason: "valid", valid: true }),
  ),

  http.post("/api/settings/providers/:provider/secret-preview", ({ params }) => {
    const store = getStore();
    const provider = pathParam(params, "provider");
    const view = store.settings?.providers.find((p) => p.provider === provider);
    if (!view || !view.secretPresent) return notFound("A saved key for that provider");
    return HttpResponse.json({
      provider,
      secretName: view.configuredSecretName,
      preview: "sk-ant-…mock",
      chars: 8,
      truncated: true,
      updatedAt: view.secretUpdatedAt ?? new Date().toISOString(),
    });
  }),

  http.get("/api/settings/privacy", () => HttpResponse.json(getStore().privacy)),

  http.put("/api/settings/privacy", async ({ request }) => {
    const store = getStore();
    const input = (await request.json().catch(() => ({}))) as { telemetryEnabled?: boolean };
    if (typeof input.telemetryEnabled === "boolean") {
      store.privacy.telemetryEnabled = input.telemetryEnabled;
    }
    return HttpResponse.json(store.privacy);
  }),

  http.get("/api/settings/web-tools", () => HttpResponse.json(getStore().webTools)),

  http.put("/api/settings/web-tools/exa-secret", async ({ request }) => {
    const store = getStore();
    const input = (await request.json().catch(() => ({}))) as { value?: string };
    const present = (input.value ?? "").length > 0;
    store.webTools = {
      exaSecretPresent: present,
      exaSecretUpdatedAt: present ? new Date().toISOString() : null,
      webSearchEnabled: present,
    };
    return HttpResponse.json(store.webTools);
  }),

  http.post("/api/settings/web-tools/exa-secret/verify", () =>
    HttpResponse.json({ reason: "valid" }),
  ),

  http.delete("/api/settings/web-tools/exa-secret", () => {
    const store = getStore();
    store.webTools = {
      exaSecretPresent: false,
      exaSecretUpdatedAt: null,
      webSearchEnabled: false,
    };
    return HttpResponse.json(store.webTools);
  }),

  http.get("/api/settings/voice", () => HttpResponse.json(getStore().voice)),

  http.put("/api/settings/voice", async ({ request }) => {
    const store = getStore();
    const input = (await request.json().catch(() => ({}))) as { language?: string };
    const next = store.voice.supported.find((l) => l === input.language);
    if (next) store.voice = { ...store.voice, language: next };
    return HttpResponse.json(store.voice);
  }),

  http.get("/api/settings/preferences", () => HttpResponse.json(getStore().preferences)),

  http.put("/api/settings/preferences", async ({ request }) => {
    const store = getStore();
    const input = (await request.json()) as { showReasoning?: unknown };
    if (typeof input.showReasoning !== "boolean") {
      return HttpResponse.json({ error: "showReasoning must be true or false." }, { status: 400 });
    }
    store.preferences = { showReasoning: input.showReasoning };
    return HttpResponse.json(store.preferences);
  }),

  // --- sandbox -------------------------------------------------------------

  http.get("/api/settings/sandbox", () => HttpResponse.json(getStore().sandbox)),

  http.put("*/api/settings/sandbox", async ({ request }) => {
    const store = getStore();
    const patch = (await request.json().catch(() => ({}))) as Record<string, unknown>;
    if (store.sandbox.workspace) {
      const current = store.sandbox.workspace;
      const providerConfig = patch.providerConfig;
      let mergedProviderConfig = current.providerConfig;
      if (providerConfig && typeof providerConfig === "object" && "kind" in providerConfig) {
        if (providerConfig.kind === "daytona" && current.providerConfig.kind === "daytona") {
          const daytonaPatch = providerConfig as Partial<DaytonaProviderConfig> & {
            kind: "daytona";
          };
          mergedProviderConfig = {
            ...current.providerConfig,
            ...daytonaPatch,
            kind: "daytona",
            profiles: daytonaPatch.profiles
              ? { ...current.providerConfig.profiles, ...daytonaPatch.profiles }
              : current.providerConfig.profiles,
          };
        } else if (providerConfig.kind === "daytona") {
          mergedProviderConfig = providerConfig as DaytonaProviderConfig;
        } else if (providerConfig.kind === "cloudflare") {
          mergedProviderConfig = { kind: "cloudflare" };
        } else if (providerConfig.kind === "sprites") {
          mergedProviderConfig = providerConfig as SpritesProviderConfig;
        } else if (providerConfig.kind === "mock") {
          mergedProviderConfig = { kind: "mock" };
        }
      }
      store.sandbox.workspace = {
        ...current,
        ...patch,
        providerConfig: mergedProviderConfig,
      };
      if (store.sandbox.daytonaMode === "byok" && mergedProviderConfig.kind === "daytona") {
        store.sandbox.daytonaAvailable =
          store.sandbox.daytonaSecretPresent &&
          mergedProviderConfig.profiles.small !== null &&
          mergedProviderConfig.profiles.medium !== null;
      }
    }
    return HttpResponse.json(store.sandbox);
  }),

  http.put("/api/settings/sandbox/agent", async ({ request }) => {
    const store = getStore();
    const patch = (await request.json().catch(() => ({}))) as Record<string, unknown>;
    store.sandbox.agent = {
      sandboxEnabled: null,
      agentEnabled: true,
      archivedAt: null,
      idleTimeoutMs: null,
      maxProcessRuntimeMs: null,
      networkDomainAllowlist: null,
      envVars: null,
      ...store.sandbox.agent,
      ...patch,
    };
    return HttpResponse.json(store.sandbox);
  }),

  http.put("*/api/settings/sandbox/daytona-secret", async ({ request }) => {
    const store = getStore();
    const input = (await request.json().catch(() => ({}))) as { value?: string };
    store.sandbox.daytonaSecretPresent = (input.value ?? "").length > 0;
    store.sandbox.daytonaMode = "byok";
    const config = store.sandbox.workspace?.providerConfig;
    store.sandbox.daytonaAvailable =
      store.sandbox.daytonaSecretPresent &&
      config?.kind === "daytona" &&
      config.profiles.small !== null &&
      config.profiles.medium !== null;
    return HttpResponse.json(store.sandbox);
  }),

  http.delete("*/api/settings/sandbox/daytona-secret", () => {
    const store = getStore();
    store.sandbox.daytonaMode = "system";
    store.sandbox.daytonaAvailable = store.daytonaSystemAvailable;
    store.sandbox.daytonaSecretPresent = false;
    if (store.sandbox.workspace?.providerConfig.kind === "daytona") {
      store.sandbox.workspace.providerConfig = {
        kind: "daytona",
        apiKeySecretName: "sandbox:daytona",
        apiUrl: null,
        target: null,
        profiles: { small: null, medium: null },
      };
      store.sandbox.workspace.idleTimeoutMs = 900_000;
    }
    return HttpResponse.json(store.sandbox);
  }),

  http.put("*/api/settings/sandbox/sprites-secret", async ({ request }) => {
    const store = getStore();
    const input = (await request.json().catch(() => ({}))) as { value?: string };
    store.sandbox.spritesSecretPresent = (input.value ?? "").length > 0;
    store.sandbox.spritesMode = "byok";
    // The server derives `spritesAvailable` from `apiKey !== null`, and a stored
    // BYOK key IS that key — unlike Daytona there are no profiles to complete.
    store.sandbox.spritesAvailable = store.sandbox.spritesSecretPresent;
    return HttpResponse.json(store.sandbox);
  }),

  http.delete("*/api/settings/sandbox/sprites-secret", () => {
    const store = getStore();
    store.sandbox.spritesMode = "system";
    store.sandbox.spritesSecretPresent = false;
    // Back to system mode: availability is whatever the operator's own key
    // gives, and no mock scenario ships a system SPRITES_API_KEY.
    store.sandbox.spritesAvailable = false;
    if (store.sandbox.workspace?.providerConfig.kind === "sprites") {
      store.sandbox.workspace.providerConfig = {
        kind: "sprites",
        apiKeySecretName: "sandbox:sprites",
      };
      // `clearSpritesOverride` resets the idle timeout alongside the provider
      // config in the same D1 write.
      store.sandbox.workspace.idleTimeoutMs = 900_000;
    }
    return HttpResponse.json(store.sandbox);
  }),

  /**
   * Parsed as JSON even on a non-2xx by `testConnection`, so the failure path
   * must be a body, not a status.
   */
  http.post("*/api/settings/sandbox/test", () => {
    const store = getStore();
    if (!store.sandbox.daytonaAvailable) {
      return HttpResponse.json(
        { ok: false, phase: "connection", error: "missing_secret" },
        { status: 400 },
      );
    }
    return HttpResponse.json({ ok: true });
  }),

  http.put("/api/settings/sandbox/env", async ({ request }) => {
    const store = getStore();
    const input = (await request.json().catch(() => ({}))) as {
      envVars?: Record<string, string>;
    };
    if (store.sandbox.workspace) store.sandbox.workspace.envVars = input.envVars ?? {};
    return HttpResponse.json(store.sandbox);
  }),

  http.put("/api/settings/sandbox/agent/env", async ({ request }) => {
    const store = getStore();
    const input = (await request.json().catch(() => ({}))) as {
      envVars?: Record<string, string>;
    };
    if (store.sandbox.agent) store.sandbox.agent.envVars = input.envVars ?? {};
    return HttpResponse.json(store.sandbox);
  }),

  http.put("/api/settings/sandbox/secret-env", async ({ request }) => {
    const store = getStore();
    const input = (await request.json().catch(() => ({}))) as {
      envVars?: Record<string, string>;
    };
    store.sandbox.workspaceSecretEnvVars = upsertSecrets(
      store.sandbox.workspaceSecretEnvVars,
      input.envVars ?? {},
    );
    return HttpResponse.json(store.sandbox);
  }),

  http.delete("/api/settings/sandbox/secret-env", async ({ request }) => {
    const store = getStore();
    const input = (await request.json().catch(() => ({}))) as { name?: string };
    store.sandbox.workspaceSecretEnvVars = store.sandbox.workspaceSecretEnvVars.filter(
      (s) => s.name !== input.name,
    );
    return HttpResponse.json(store.sandbox);
  }),

  http.put("/api/settings/sandbox/agent/secret-env", async ({ request }) => {
    const store = getStore();
    const input = (await request.json().catch(() => ({}))) as {
      envVars?: Record<string, string>;
    };
    store.sandbox.agentSecretEnvVars = upsertSecrets(
      store.sandbox.agentSecretEnvVars,
      input.envVars ?? {},
    );
    return HttpResponse.json(store.sandbox);
  }),

  http.delete("/api/settings/sandbox/agent/secret-env", async ({ request }) => {
    const store = getStore();
    const input = (await request.json().catch(() => ({}))) as { name?: string };
    store.sandbox.agentSecretEnvVars = store.sandbox.agentSecretEnvVars.filter(
      (s) => s.name !== input.name,
    );
    return HttpResponse.json(store.sandbox);
  }),

  // --- github --------------------------------------------------------------

  http.get("/api/settings/github", () => HttpResponse.json(getStore().github)),

  http.get("/api/settings/github/installations/:installationId/repositories", ({ request }) => {
    // Mirrors GitHub's 100-per-page cap so the picker's page walk is exercised.
    const parsed = Number.parseInt(new URL(request.url).searchParams.get("page") ?? "1", 10);
    const page = Number.isFinite(parsed) && parsed > 0 ? parsed : 1;
    const all = getStore().githubRepositories;
    const repositories = all.slice((page - 1) * PER_PAGE, page * PER_PAGE);
    return HttpResponse.json({ repositories, hasNextPage: page * PER_PAGE < all.length });
  }),

  http.post("/api/settings/github/disconnect", async ({ request }) => {
    const store = getStore();
    const input = (await request.json().catch(() => ({}))) as { installationId?: number };
    store.github.installations = store.github.installations.filter(
      (i) => i.installationId !== input.installationId,
    );
    return HttpResponse.json({ ok: true });
  }),
];

function upsertSecrets(
  existing: Array<{ name: string; updatedAt: string }>,
  envVars: Record<string, string>,
): Array<{ name: string; updatedAt: string }> {
  const updatedAt = new Date().toISOString();
  const next = [...existing];
  for (const name of Object.keys(envVars)) {
    const found = next.find((s) => s.name === name);
    if (found) found.updatedAt = updatedAt;
    else next.push({ name, updatedAt });
  }
  return next;
}
