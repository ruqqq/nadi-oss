import { providerUsesWorkspaceSecret } from "../agent/model-config";
import { DEFAULT_REASONING_EFFORT, parseReasoningEffort } from "../agent/reasoning-options";
import { validateRequestSession } from "../auth/session";
import { canUseProvider } from "../auth/provider-gate";
import { registryDb } from "../db/client";
import {
  AgentSettingsRepository,
  type AgentSettingsPatch,
} from "../db/repositories/agent-settings";
import { VoiceRepository } from "../db/repositories/voice";
import { UserPreferencesRepository } from "../db/repositories/user-preferences";
import { WorkspacePrivacySettingsRepository } from "../db/repositories/workspace-privacy-settings";
import { WorkspaceRepository } from "../db/repositories/workspaces";
import {
  filterProviderModels,
  normalizeModelSearchLimit,
  type ProviderModelSearchResponse,
  type ProviderModelSearchResult,
} from "../providers/model-search";
import { getProviderCatalog } from "../providers/model-catalog";
import { setProviderModelWhitelist } from "../db/repositories/provider-models";
import { verifyProviderKey } from "../providers/verify-key";
import { verifyExaKey } from "../web/exa-provider";
import type { Env } from "../env";
import {
  assertValidProviderBaseUrl,
  sanitizeProviderBodyDefaults,
  type ProviderConfigProvider,
  type ProviderEndpointConfig,
} from "../db/repositories/provider-configs";
import {
  listProviderSettings,
  parseProvider,
  previewProviderSecret,
  getProviderEndpointConfig,
  getProviderSecretValue,
  saveProviderEndpointConfig,
  saveProviderSecret,
} from "../settings/provider-settings";
import {
  deleteExaApiKey,
  getWebToolsSettingsView,
  saveExaApiKey,
} from "../settings/web-tools-settings";

const MOCK_AGENT_PROVIDERS = new Set([
  "mock",
  "mock-tool-call",
  "mock-reasoning",
  "mock-tool-loop",
]);

const MODEL_INPUT_MODALITIES = new Set(["text", "image", "audio", "video", "file"]);

export async function routeSettings(
  req: Request,
  env: Env,
  ctx: ExecutionContext | null = null,
): Promise<Response | null> {
  const url = new URL(req.url);
  if (url.pathname !== "/api/settings" && !url.pathname.startsWith("/api/settings/")) {
    return null;
  }

  if (url.pathname === "/api/settings/agents/default") {
    if (req.method === "GET") return getDefaultAgentSettings(req, env);
    if (req.method === "PUT") return updateDefaultAgentSettings(req, env);
    return new Response("Method not allowed", { status: 405 });
  }

  if (url.pathname === "/api/settings/privacy") {
    if (req.method === "GET") return getPrivacySettings(req, env, url.searchParams);
    if (req.method === "PUT") return updatePrivacySettings(req, env);
    return withNoStore(new Response("Method not allowed", { status: 405 }));
  }

  if (url.pathname === "/api/settings/voice") {
    const session = await validateRequestSession(env, req);
    if (!session) return withNoStore(new Response("Unauthorized", { status: 401 }));
    if (req.method === "GET")
      return withNoStore(await handleGetVoiceSettings(env, session.user.id));
    if (req.method === "PUT")
      return withNoStore(await handlePutVoiceSettings(req, env, session.user.id));
    return withNoStore(new Response("Method not allowed", { status: 405 }));
  }

  if (url.pathname === "/api/settings/preferences") {
    const session = await validateRequestSession(env, req);
    if (!session) return withNoStore(new Response("Unauthorized", { status: 401 }));
    if (req.method === "GET")
      return withNoStore(await handleGetUserPreferences(env, session.user.id));
    if (req.method === "PUT")
      return withNoStore(await handlePutUserPreferences(req, env, session.user.id));
    return withNoStore(new Response("Method not allowed", { status: 405 }));
  }

  if (url.pathname === "/api/settings/web-tools") {
    if (req.method === "GET") return getWebToolsSettings(req, env);
    return withNoStore(new Response("Method not allowed", { status: 405 }));
  }

  if (url.pathname === "/api/settings/web-tools/exa-secret") {
    if (req.method === "PUT") return updateWebToolsExaSecret(req, env);
    if (req.method === "DELETE") return removeWebToolsExaSecret(req, env);
    return withNoStore(new Response("Method not allowed", { status: 405 }));
  }

  if (url.pathname === "/api/settings/web-tools/exa-secret/verify") {
    if (req.method === "POST") return verifyWebToolsExaSecret(req, env);
    return withNoStore(new Response("Method not allowed", { status: 405 }));
  }

  const modelSearchProvider = matchProvider(
    url.pathname,
    /^\/api\/settings\/providers\/([^/]+)\/models\/search$/,
  );
  if (modelSearchProvider !== null) {
    if (modelSearchProvider === undefined) {
      return withNoStore(new Response("invalid provider path", { status: 400 }));
    }
    return searchProviderModelsRoute(req, env, ctx, modelSearchProvider, url.searchParams);
  }

  const whitelistProvider = matchProvider(
    url.pathname,
    /^\/api\/settings\/providers\/([^/]+)\/models\/whitelist$/,
  );
  if (whitelistProvider !== null) {
    if (whitelistProvider === undefined) {
      return withNoStore(new Response("invalid provider path", { status: 400 }));
    }
    return updateProviderModelWhitelistRoute(req, env, whitelistProvider);
  }

  const modelCatalogProvider = matchProvider(
    url.pathname,
    /^\/api\/settings\/providers\/([^/]+)\/models$/,
  );
  if (modelCatalogProvider !== null) {
    if (modelCatalogProvider === undefined) {
      return withNoStore(new Response("invalid provider path", { status: 400 }));
    }
    return getProviderModelCatalogRoute(req, env, ctx, modelCatalogProvider, url.searchParams);
  }

  const configProvider = matchProvider(
    url.pathname,
    /^\/api\/settings\/providers\/([^/]+)\/config$/,
  );
  if (configProvider !== null) {
    if (configProvider === undefined) return new Response("invalid provider path", { status: 400 });
    if (req.method === "PUT") return updateProviderConfig(req, env, configProvider);
    return new Response("Method not allowed", { status: 405 });
  }

  const secretProvider = matchProvider(
    url.pathname,
    /^\/api\/settings\/providers\/([^/]+)\/secret$/,
  );
  if (secretProvider !== null) {
    if (secretProvider === undefined) return new Response("invalid provider path", { status: 400 });
    if (req.method === "PUT") return updateProviderSecret(req, env, secretProvider);
    return new Response("Method not allowed", { status: 405 });
  }

  const previewProvider = matchProvider(
    url.pathname,
    /^\/api\/settings\/providers\/([^/]+)\/secret-preview$/,
  );
  if (previewProvider !== null) {
    if (previewProvider === undefined)
      return withNoStore(new Response("invalid provider path", { status: 400 }));
    if (req.method === "POST") return previewSecret(req, env, previewProvider);
    return withNoStore(new Response("Method not allowed", { status: 405 }));
  }

  const verifyProvider = matchProvider(
    url.pathname,
    /^\/api\/settings\/providers\/([^/]+)\/verify$/,
  );
  if (verifyProvider !== null) {
    if (verifyProvider === undefined)
      return withNoStore(new Response("invalid provider path", { status: 400 }));
    if (req.method === "POST") return verifySecret(req, env, verifyProvider);
    return withNoStore(new Response("Method not allowed", { status: 405 }));
  }

  return new Response("Not found", { status: 404 });
}

/** Nova-3's streaming languages. Malay, Indonesian, Thai, Vietnamese, and
 *  Tagalog are NOT supported by the model — do not add them here. */
export const VOICE_LANGUAGES = [
  "en",
  "es",
  "fr",
  "de",
  "hi",
  "ja",
  "pt",
  "it",
  "nl",
  "ru",
] as const;
export type VoiceLanguage = (typeof VOICE_LANGUAGES)[number];

function isVoiceLanguage(v: unknown): v is VoiceLanguage {
  return typeof v === "string" && (VOICE_LANGUAGES as readonly string[]).includes(v);
}

export async function handleGetVoiceSettings(env: Env, userId: string): Promise<Response> {
  const language = await new VoiceRepository(registryDb(env)).getLanguage(userId);
  return Response.json({ language: language ?? "en", supported: VOICE_LANGUAGES });
}

export async function handlePutVoiceSettings(
  req: Request,
  env: Env,
  userId: string,
): Promise<Response> {
  const body = (await req.json().catch(() => null)) as { language?: unknown } | null;
  if (!isVoiceLanguage(body?.language)) {
    return Response.json({ error: "Choose a supported dictation language." }, { status: 400 });
  }
  await new VoiceRepository(registryDb(env)).setLanguage({
    userId,
    language: body.language,
    now: Date.now(),
  });
  return Response.json({ language: body.language });
}

export async function handleGetUserPreferences(env: Env, userId: string): Promise<Response> {
  const showReasoning = await new UserPreferencesRepository(registryDb(env)).getShowReasoning(
    userId,
  );
  // No row is not "off": a user who has never touched the toggle sees thinking.
  return Response.json({ showReasoning: showReasoning ?? true });
}

export async function handlePutUserPreferences(
  req: Request,
  env: Env,
  userId: string,
): Promise<Response> {
  const body = (await req.json().catch(() => null)) as { showReasoning?: unknown } | null;
  if (typeof body?.showReasoning !== "boolean") {
    return Response.json({ error: "showReasoning must be true or false." }, { status: 400 });
  }
  await new UserPreferencesRepository(registryDb(env)).setShowReasoning({
    userId,
    showReasoning: body.showReasoning,
    now: Date.now(),
  });
  return Response.json({ showReasoning: body.showReasoning });
}

async function requireOwnerWorkspace(req: Request, env: Env) {
  const session = await validateRequestSession(env, req);
  if (!session)
    return { ok: false as const, response: new Response("Unauthorized", { status: 401 }) };

  const workspace = await new WorkspaceRepository(registryDb(env)).getCurrentWorkspaceForOwner(
    session.user.id,
  );
  if (!workspace)
    return { ok: false as const, response: new Response("Not found", { status: 404 }) };

  return { ok: true as const, workspace, session };
}

/**
 * Gated providers must be refused at the route, not merely hidden in the UI —
 * `workers-ai` bills our Cloudflare account, so a hand-crafted request from a
 * non-allowlisted account has to bounce.
 */
function forbiddenProvider(
  env: Env,
  provider: ProviderConfigProvider,
  email: string | null | undefined,
): Response | null {
  if (canUseProvider(env, provider, email)) return null;
  return withNoStore(new Response("provider not available", { status: 403 }));
}

/**
 * The default agent settings payload (`AgentSettingsResponse`) for a user's
 * owned workspace, or `null` when they own no workspace or it has no default
 * agent. Extracted so the startup bootstrap route can reuse the exact shape the
 * `GET /api/settings/agents/default` handler serves, without a second round trip.
 */
export async function buildDefaultAgentSettingsForUser(
  env: Env,
  userId: string,
  userEmail?: string | null,
) {
  const workspace = await new WorkspaceRepository(registryDb(env)).getCurrentWorkspaceForOwner(
    userId,
  );
  if (!workspace) return null;

  const agent = await new AgentSettingsRepository(registryDb(env)).getAgentSettings(workspace.id, {
    kind: "default",
  });
  if (!agent) return null;

  return {
    workspace,
    agent: serializeAgent(agent),
    providers: await listProviderSettings(env, workspace.id, userEmail),
  };
}

async function getDefaultAgentSettings(req: Request, env: Env): Promise<Response> {
  const session = await validateRequestSession(env, req);
  if (!session) return new Response("Unauthorized", { status: 401 });

  const settings = await buildDefaultAgentSettingsForUser(env, session.user.id, session.user.email);
  if (!settings) return new Response("Not found", { status: 404 });

  return Response.json(settings);
}

async function updateDefaultAgentSettings(req: Request, env: Env): Promise<Response> {
  const owner = await requireOwnerWorkspace(req, env);
  if (!owner.ok) return owner.response;

  const body = (await req.json().catch(() => null)) as {
    agent?: {
      systemPrompt?: unknown;
      provider?: unknown;
      model?: unknown;
      modelInputModalities?: unknown;
      reasoningEffort?: unknown;
      modelSupportsReasoning?: unknown;
    };
  } | null;
  const parsedPatch = parseAgentBehaviourPatch(env, owner.session.user.email, body?.agent);
  if (!parsedPatch.ok) return parsedPatch.response;
  const patch = parsedPatch.patch;

  if (Object.keys(patch).length === 0) {
    return new Response("No valid fields to update", { status: 400 });
  }

  const agent = await new AgentSettingsRepository(registryDb(env)).updateAgentSettings(
    owner.workspace.id,
    { kind: "default" },
    patch,
  );
  if (!agent) return new Response("Not found", { status: 404 });

  return Response.json({
    workspace: owner.workspace,
    agent: serializeAgent(agent),
    providers: await listProviderSettings(env, owner.workspace.id, owner.session.user.email),
  });
}

async function getPrivacySettings(
  req: Request,
  env: Env,
  searchParams: URLSearchParams,
): Promise<Response> {
  const session = await validateRequestSession(env, req);
  if (!session) return withNoStore(new Response("Unauthorized", { status: 401 }));

  const requestedWorkspaceId = searchParams.get("workspaceId");
  const db = registryDb(env);
  let workspaceId: string;

  if (requestedWorkspaceId) {
    try {
      await new WorkspaceRepository(db).assertMember({
        workspaceId: requestedWorkspaceId,
        userId: session.user.id,
      });
    } catch {
      return withNoStore(new Response("Not found", { status: 404 }));
    }
    workspaceId = requestedWorkspaceId;
  } else {
    const ownerWorkspace = await new WorkspaceRepository(db).getCurrentWorkspaceForOwner(
      session.user.id,
    );
    if (!ownerWorkspace) return withNoStore(new Response("Not found", { status: 404 }));
    workspaceId = ownerWorkspace.id;
  }

  const settings = await new WorkspacePrivacySettingsRepository(db).get(workspaceId);
  return withNoStore(Response.json({ workspaceId, ...settings }));
}

async function updatePrivacySettings(req: Request, env: Env): Promise<Response> {
  const owner = await requireOwnerWorkspace(req, env);
  if (!owner.ok) return withNoStore(owner.response);

  const body = (await req.json().catch(() => null)) as {
    telemetryEnabled?: unknown;
  } | null;
  if (typeof body?.telemetryEnabled !== "boolean") {
    return withNoStore(new Response("telemetryEnabled must be a boolean", { status: 400 }));
  }

  const settings = await new WorkspacePrivacySettingsRepository(
    registryDb(env),
  ).setTelemetryEnabled({
    workspaceId: owner.workspace.id,
    enabled: body.telemetryEnabled,
    now: Date.now(),
  });
  return withNoStore(Response.json({ workspaceId: owner.workspace.id, ...settings }));
}

/**
 * Provider routes all need the same four things: an owner session, a parsed
 * provider, the gate check, and the workspace's credential + endpoint. Resolved
 * once here so the three model routes cannot drift apart on authorization.
 */
async function resolveProviderRequest(
  req: Request,
  env: Env,
  providerInput: string,
): Promise<
  | {
      ok: true;
      workspaceId: string;
      provider: ProviderConfigProvider;
      viewerEmail: string | null;
    }
  | { ok: false; response: Response }
> {
  const owner = await requireOwnerWorkspace(req, env);
  if (!owner.ok) return { ok: false, response: withNoStore(owner.response) };

  const provider = parseProvider(providerInput);
  if (!provider) {
    return {
      ok: false,
      response: withNoStore(new Response("unsupported provider", { status: 400 })),
    };
  }

  const forbidden = forbiddenProvider(env, provider, owner.session.user.email);
  if (forbidden) return { ok: false, response: forbidden };

  return {
    ok: true,
    workspaceId: owner.workspace.id,
    provider,
    viewerEmail: owner.session.user.email ?? null,
  };
}

async function loadCatalogFor(
  env: Env,
  ctx: ExecutionContext | null,
  workspaceId: string,
  provider: ProviderConfigProvider,
  refresh: boolean,
) {
  const endpointConfig = await getProviderEndpointConfig(env, workspaceId, provider);
  const secret = await getProviderSecretValue(env, workspaceId, provider);
  return getProviderCatalog({ env, ctx, workspaceId, provider, secret, endpointConfig, refresh });
}

/** The full cached catalog. What the Settings model card and the picker's
 *  "search all models" both load — once, then filter on the client. */
async function getProviderModelCatalogRoute(
  req: Request,
  env: Env,
  ctx: ExecutionContext | null,
  providerInput: string,
  searchParams: URLSearchParams,
): Promise<Response> {
  if (req.method !== "GET") {
    return withNoStore(new Response("Method not allowed", { status: 405 }));
  }

  const resolved = await resolveProviderRequest(req, env, providerInput);
  if (!resolved.ok) return resolved.response;

  const catalog = await loadCatalogFor(
    env,
    ctx,
    resolved.workspaceId,
    resolved.provider,
    searchParams.get("refresh") === "1",
  );
  return Response.json(catalog, { headers: { "Cache-Control": "no-store" } });
}

/**
 * The pre-existing search endpoint, now served from the cached catalog rather
 * than a live upstream call per request. Response shape is unchanged.
 */
async function searchProviderModelsRoute(
  req: Request,
  env: Env,
  ctx: ExecutionContext | null,
  providerInput: string,
  searchParams: URLSearchParams,
): Promise<Response> {
  if (req.method !== "GET") {
    return withNoStore(new Response("Method not allowed", { status: 405 }));
  }

  const resolved = await resolveProviderRequest(req, env, providerInput);
  if (!resolved.ok) return resolved.response;

  const catalog = await loadCatalogFor(env, ctx, resolved.workspaceId, resolved.provider, false);
  const query = (searchParams.get("q") ?? "").trim();
  const limit = normalizeModelSearchLimit(searchParams.get("limit"));
  const response: ProviderModelSearchResponse & { fetchedAt: number } = {
    provider: resolved.provider,
    query,
    source: catalog.source,
    models: filterProviderModels(catalog.models, query).slice(0, limit),
    fetchedAt: catalog.fetchedAt,
  };

  return Response.json(response, { headers: { "Cache-Control": "no-store" } });
}

/**
 * Set or clear the workspace's curated model list for a provider.
 *
 * `{models: null}` deletes the row — back to "offer everything". `{models: []}`
 * is a real choice, not a clear, and is stored as such.
 */
async function updateProviderModelWhitelistRoute(
  req: Request,
  env: Env,
  providerInput: string,
): Promise<Response> {
  if (req.method !== "PUT") {
    return withNoStore(new Response("Method not allowed", { status: 405 }));
  }

  const resolved = await resolveProviderRequest(req, env, providerInput);
  if (!resolved.ok) return resolved.response;

  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return withNoStore(new Response("invalid JSON body", { status: 400 }));
  }

  const models = parseWhitelistModels(body);
  if (models === undefined) {
    return withNoStore(new Response("models must be an array of models or null", { status: 400 }));
  }

  await setProviderModelWhitelist(env, resolved.workspaceId, resolved.provider, models, Date.now());

  const providers = await listProviderSettings(env, resolved.workspaceId, resolved.viewerEmail);
  const updated = providers.find((entry) => entry.provider === resolved.provider);
  return withNoStore(
    Response.json(updated ?? { provider: resolved.provider, whitelistModels: models }),
  );
}

/** `undefined` = malformed. `null` = clear curation. An array = the choice. */
function parseWhitelistModels(body: unknown): ProviderModelSearchResult[] | null | undefined {
  if (typeof body !== "object" || body === null) return undefined;
  const value = (body as { models?: unknown }).models;
  if (value === null) return null;
  if (!Array.isArray(value)) return undefined;

  const models: ProviderModelSearchResult[] = [];
  for (const entry of value) {
    if (typeof entry !== "object" || entry === null) return undefined;
    const record = entry as Record<string, unknown>;
    if (typeof record.id !== "string" || record.id.trim() === "") return undefined;
    const parsedModalities = parseModelInputModalities(record.inputModalities);
    models.push({
      id: record.id,
      ...(typeof record.name === "string" ? { name: record.name } : {}),
      ...(typeof record.description === "string" ? { description: record.description } : {}),
      ...(typeof record.contextLength === "number" ? { contextLength: record.contextLength } : {}),
      inputModalities: (parsedModalities.ok
        ? parsedModalities.modalities
        : ["text"]) as ProviderModelSearchResult["inputModalities"],
      // Only a boolean is carried. Anything else — including a missing field —
      // stays absent, preserving "unknown" as distinct from "cannot reason";
      // this list is also where an admin's hand declaration is persisted, so
      // dropping the field here would silently discard it on save.
      ...(typeof record.reasoning === "boolean" ? { reasoning: record.reasoning } : {}),
      source: record.source === "live" ? "live" : "static",
    });
  }
  return models;
}

async function updateProviderConfig(
  req: Request,
  env: Env,
  providerInput: string,
): Promise<Response> {
  const owner = await requireOwnerWorkspace(req, env);
  if (!owner.ok) return owner.response;

  const provider = parseProvider(providerInput);
  if (!provider) return new Response("unsupported provider", { status: 400 });

  const forbidden = forbiddenProvider(env, provider, owner.session.user.email);
  if (forbidden) return forbidden;

  // Workers AI has no endpoint to point at and no auth mode to pick — the binding
  // is the whole configuration. Refuse rather than persist a config row that
  // nothing reads, which would also let `auth: "none"` be set on it.
  if (provider === "workers-ai") {
    return new Response("provider requires no configuration", { status: 400 });
  }

  const parsedBody = await parseOptionalJsonBody(req);
  if (!parsedBody.ok) return parsedBody.response;
  const body = parsedBody.body as {
    baseUrl?: unknown;
    proxyUrl?: unknown;
    auth?: unknown;
    body?: unknown;
  } | null;

  try {
    const configInput = {
      ...(typeof body?.baseUrl === "string" ? { baseUrl: body.baseUrl } : {}),
      ...(typeof body?.proxyUrl === "string" ? { proxyUrl: body.proxyUrl } : {}),
      auth: body?.auth === "none" ? ("none" as const) : ("bearer" as const),
      body: sanitizeProviderBodyDefaults(body?.body),
    };
    return Response.json(
      await saveProviderEndpointConfig(env, owner.workspace.id, provider, configInput),
    );
  } catch (err) {
    if (err instanceof Error && err.message === "provider_base_url_required") {
      return new Response("baseUrl is required", { status: 400 });
    }
    if (err instanceof Error && err.message === "provider_base_url_invalid") {
      return new Response("baseUrl must be HTTPS or localhost HTTP", { status: 400 });
    }
    if (err instanceof Error && err.message === "provider_proxy_url_invalid") {
      return new Response("proxyUrl must be HTTPS or localhost HTTP", { status: 400 });
    }
    if (err instanceof Error && err.message === "provider_proxy_url_unsupported") {
      return new Response("this provider has no egress proxy route", { status: 400 });
    }
    throw err;
  }
}

async function updateProviderSecret(
  req: Request,
  env: Env,
  providerInput: string,
): Promise<Response> {
  const owner = await requireOwnerWorkspace(req, env);
  if (!owner.ok) return owner.response;

  const provider = parseProvider(providerInput);
  if (!provider || !providerUsesWorkspaceSecret(provider)) {
    return new Response("unsupported provider", { status: 400 });
  }

  const parsedBody = await parseOptionalJsonBody(req);
  if (!parsedBody.ok) return parsedBody.response;
  const body = parsedBody.body as { value?: unknown; secretName?: unknown } | null;
  if (typeof body?.value !== "string" || !body.value.trim()) {
    return new Response("value must be a non-empty string", { status: 400 });
  }
  if ("secretName" in body && typeof body.secretName !== "string") {
    return new Response("secretName must be a string", { status: 400 });
  }

  const input: { value: string; secretName?: string } = { value: body.value };
  if (typeof body.secretName === "string") input.secretName = body.secretName;

  try {
    return Response.json(await saveProviderSecret(env, owner.workspace.id, provider, input));
  } catch (err) {
    if (err instanceof Error && err.message === "invalid_secret_name") {
      return new Response("secretName must be 1-128 characters using A-Z a-z 0-9 . _ : -", {
        status: 400,
      });
    }
    throw err;
  }
}

async function getWebToolsSettings(req: Request, env: Env): Promise<Response> {
  const owner = await requireOwnerWorkspace(req, env);
  if (!owner.ok) return withNoStore(owner.response);

  return withNoStore(Response.json(await getWebToolsSettingsView(env, owner.workspace.id)));
}

async function updateWebToolsExaSecret(req: Request, env: Env): Promise<Response> {
  const owner = await requireOwnerWorkspace(req, env);
  if (!owner.ok) return withNoStore(owner.response);

  const parsedBody = await parseOptionalJsonBody(req);
  if (!parsedBody.ok) return withNoStore(parsedBody.response);
  const body = parsedBody.body as { value?: unknown } | null;
  if (typeof body?.value !== "string" || !body.value.trim()) {
    return withNoStore(new Response("value must be a non-empty string", { status: 400 }));
  }

  return withNoStore(Response.json(await saveExaApiKey(env, owner.workspace.id, body.value)));
}

/**
 * The submitted key is used only for the verification request; it is never
 * stored here (saving goes through updateWebToolsExaSecret).
 */
async function verifyWebToolsExaSecret(req: Request, env: Env): Promise<Response> {
  const owner = await requireOwnerWorkspace(req, env);
  if (!owner.ok) return withNoStore(owner.response);

  const parsedBody = await parseOptionalJsonBody(req);
  if (!parsedBody.ok) return withNoStore(parsedBody.response);
  const body = parsedBody.body as { value?: unknown } | null;
  if (typeof body?.value !== "string" || !body.value.trim()) {
    return withNoStore(new Response("value must be a non-empty string", { status: 400 }));
  }

  const { reason } = await verifyExaKey(body.value.trim());
  return withNoStore(Response.json({ reason, valid: reason === "valid" }));
}

async function removeWebToolsExaSecret(req: Request, env: Env): Promise<Response> {
  const owner = await requireOwnerWorkspace(req, env);
  if (!owner.ok) return withNoStore(owner.response);

  return withNoStore(Response.json(await deleteExaApiKey(env, owner.workspace.id)));
}

async function previewSecret(req: Request, env: Env, providerInput: string): Promise<Response> {
  const owner = await requireOwnerWorkspace(req, env);
  if (!owner.ok) return withNoStore(owner.response);

  const provider = parseProvider(providerInput);
  if (!provider || !providerUsesWorkspaceSecret(provider)) {
    return withNoStore(new Response("unsupported provider", { status: 400 }));
  }

  const parsedBody = await parseOptionalJsonBody(req);
  if (!parsedBody.ok) return withNoStore(parsedBody.response);
  const body = parsedBody.body as { chars?: unknown } | null;
  const chars = typeof body?.chars === "number" ? body.chars : 8;
  const preview = await previewProviderSecret(env, owner.workspace.id, provider, chars);
  if (!preview) return withNoStore(new Response("Not found", { status: 404 }));

  return Response.json(preview, { headers: { "Cache-Control": "no-store" } });
}

async function verifySecret(req: Request, env: Env, providerInput: string): Promise<Response> {
  const owner = await requireOwnerWorkspace(req, env);
  if (!owner.ok) return withNoStore(owner.response);

  const provider = parseProvider(providerInput);
  if (!provider || !providerUsesWorkspaceSecret(provider)) {
    return withNoStore(new Response("unsupported provider", { status: 400 }));
  }

  const parsedBody = await parseOptionalJsonBody(req);
  if (!parsedBody.ok) return withNoStore(parsedBody.response);
  const body = parsedBody.body as {
    value?: unknown;
    endpointConfig?: { baseUrl?: unknown; auth?: unknown; body?: unknown };
  } | null;
  if (typeof body?.value !== "string" || !body.value.trim()) {
    return withNoStore(new Response("value must be a non-empty string", { status: 400 }));
  }
  const settings = await listProviderSettings(env, owner.workspace.id, owner.session.user.email);
  const current = settings.find((entry) => entry.provider === provider);
  const endpointConfig: ProviderEndpointConfig = {
    // Key verification always goes direct to the provider's own endpoint, so
    // proxyUrl is carried along untouched rather than overridden here.
    ...(current?.endpointConfig ?? {
      baseUrl: "",
      proxyUrl: "",
      auth: "bearer" as const,
      body: {},
    }),
    ...(body?.endpointConfig?.baseUrl !== undefined &&
    typeof body.endpointConfig.baseUrl === "string"
      ? { baseUrl: body.endpointConfig.baseUrl }
      : {}),
    ...(body?.endpointConfig?.auth === "none" ? { auth: "none" as const } : {}),
    ...(typeof body?.endpointConfig?.body === "object" && body.endpointConfig.body !== null
      ? { body: sanitizeProviderBodyDefaults(body.endpointConfig.body) }
      : {}),
  };
  try {
    assertValidProviderBaseUrl(provider, endpointConfig.baseUrl);
  } catch (err) {
    if (err instanceof Error && err.message === "provider_base_url_required") {
      return withNoStore(new Response("baseUrl is required", { status: 400 }));
    }
    if (err instanceof Error && err.message === "provider_base_url_invalid") {
      return withNoStore(new Response("baseUrl must be HTTPS or localhost HTTP", { status: 400 }));
    }
    throw err;
  }

  // The submitted key is used only for the verification request; it is never
  // stored here (saving goes through updateProviderSecret).
  const { reason } = await verifyProviderKey(provider, body.value.trim(), fetch, endpointConfig);
  return Response.json(
    { reason, valid: reason === "valid" },
    { headers: { "Cache-Control": "no-store" } },
  );
}

export function isSupportedAgentProvider(provider: string): boolean {
  return parseProvider(provider) !== null || MOCK_AGENT_PROVIDERS.has(provider);
}

async function parseOptionalJsonBody(
  req: Request,
): Promise<{ ok: true; body: unknown | null } | { ok: false; response: Response }> {
  const raw = await req.text();
  if (!raw.trim()) return { ok: true, body: null };

  try {
    return { ok: true, body: JSON.parse(raw) as unknown };
  } catch {
    return { ok: false, response: new Response("Malformed JSON", { status: 400 }) };
  }
}

function withNoStore(response: Response): Response {
  response.headers.set("Cache-Control", "no-store");
  return response;
}

export function parseModelInputModalities(
  value: unknown,
): { ok: true; modalities: string[] } | { ok: false } {
  if (!Array.isArray(value)) return { ok: false };
  const modalities = Array.from(new Set(value));
  if (
    modalities.length === 0 ||
    !modalities.every((entry) => typeof entry === "string" && MODEL_INPUT_MODALITIES.has(entry))
  ) {
    return { ok: false };
  }
  return { ok: true, modalities };
}

function parseStoredModelInputModalities(value: string | null | undefined): string[] {
  if (!value) return ["text"];
  try {
    const parsed = JSON.parse(value) as unknown;
    const result = parseModelInputModalities(parsed);
    return result.ok ? result.modalities : ["text"];
  } catch {
    return ["text"];
  }
}

function matchProvider(pathname: string, pattern: RegExp): string | null | undefined {
  const match = pathname.match(pattern);
  if (!match?.[1]) return null;
  try {
    return decodeURIComponent(match[1]);
  } catch {
    return undefined;
  }
}

function serializeAgent(agent: {
  id: string;
  name: string;
  systemPrompt: string;
  provider: string;
  model: string;
  modelInputModalities?: string | null;
  reasoningEffort?: string | null;
  modelSupportsReasoning?: boolean | null;
}) {
  return {
    id: agent.id,
    name: agent.name,
    systemPrompt: agent.systemPrompt,
    provider: agent.provider,
    model: agent.model,
    modelInputModalities: parseStoredModelInputModalities(agent.modelInputModalities),
    reasoningEffort: parseReasoningEffort(agent.reasoningEffort) ?? DEFAULT_REASONING_EFFORT,
    // Sent as null rather than omitted so the client can tell "unknown" from
    // "the field is missing because the Worker is old".
    modelSupportsReasoning: agent.modelSupportsReasoning ?? null,
  };
}

/**
 * Validate the behaviour half of an agent — instructions, provider, model,
 * reasoning. Shared by the workspace-default settings route and the per-agent
 * `PATCH /api/agents/:id`, so both surfaces accept and reject exactly the same
 * values instead of drifting apart.
 */
export function parseAgentBehaviourPatch(
  env: Env,
  email: string,
  agent:
    | {
        systemPrompt?: unknown;
        provider?: unknown;
        model?: unknown;
        modelInputModalities?: unknown;
        reasoningEffort?: unknown;
        modelSupportsReasoning?: unknown;
      }
    | undefined,
): { ok: true; patch: AgentSettingsPatch } | { ok: false; response: Response } {
  const patch: AgentSettingsPatch = {};

  if (agent?.systemPrompt !== undefined) {
    if (typeof agent.systemPrompt !== "string" || !agent.systemPrompt.trim()) {
      return {
        ok: false,
        response: new Response("systemPrompt must be a non-empty string", { status: 400 }),
      };
    }
    patch.systemPrompt = agent.systemPrompt.trim();
  }

  if (agent?.provider !== undefined) {
    if (typeof agent.provider !== "string" || !isSupportedAgentProvider(agent.provider)) {
      return { ok: false, response: new Response("unsupported provider", { status: 400 }) };
    }
    if (!canUseProvider(env, agent.provider, email)) {
      return { ok: false, response: new Response("provider not available", { status: 403 }) };
    }
    patch.provider = agent.provider;
  }

  if (agent?.model !== undefined) {
    if (typeof agent.model !== "string" || !agent.model.trim()) {
      return {
        ok: false,
        response: new Response("model must be a non-empty string", { status: 400 }),
      };
    }
    patch.model = agent.model.trim();
  }

  if (agent?.modelInputModalities !== undefined) {
    const parsed = parseModelInputModalities(agent.modelInputModalities);
    if (!parsed.ok) {
      return {
        ok: false,
        response: new Response("modelInputModalities must be an array of supported modalities", {
          status: 400,
        }),
      };
    }
    patch.modelInputModalities = JSON.stringify(parsed.modalities);
  }

  if (agent?.reasoningEffort !== undefined) {
    const effort = parseReasoningEffort(agent.reasoningEffort);
    if (effort === null) {
      return {
        ok: false,
        response: new Response("reasoningEffort must be one of off, low, medium, high", {
          status: 400,
        }),
      };
    }
    patch.reasoningEffort = effort;
  }

  if (agent?.modelSupportsReasoning !== undefined) {
    // `null` is meaningful: it clears the capability back to UNKNOWN, which is
    // what picking a model we know nothing about should record.
    const value = agent.modelSupportsReasoning;
    if (value !== null && typeof value !== "boolean") {
      return {
        ok: false,
        response: new Response("modelSupportsReasoning must be a boolean or null", { status: 400 }),
      };
    }
    patch.modelSupportsReasoning = value;
  }

  return { ok: true, patch };
}
