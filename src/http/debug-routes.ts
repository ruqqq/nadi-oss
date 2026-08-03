import { getAgentByName } from "agents";
import { desc, eq } from "drizzle-orm";
import type { Env } from "../env";
import { registryDb } from "../db/client";
import { agents, attachments, threadIndex, users } from "../db/schema";
import { McpServerRepository } from "../db/repositories/mcp-servers";
import { NotificationRepository } from "../db/repositories/notifications";
import { isWebPushConfigured, sendWebPush } from "../notifications/web-push";
import { WorkspaceRepository } from "../db/repositories/workspaces";
import { getMcpOAuthClient, hasMcpOAuthTokens } from "../mcp/oauth-store";
import {
  answerFromVisionModel,
  arrayBufferToBase64,
  buildExtractionQuestion,
  EXTRACTION_MAX_TOKENS,
  EXTRACTION_MAX_TOKENS_WITH_QUERY,
} from "../agent/attachment-extraction";
import {
  isSupportedAgentProvider,
  isUsableProviderForWorkspace,
} from "../settings/model-selection";
import { isProviderConfigProvider } from "../db/repositories/provider-configs";
import { getProviderEndpointConfig, getProviderSecretValue } from "../settings/provider-settings";
import { modelListUrl, searchProviderModels } from "../providers/model-search";
import { repairStaleThreadSearchProjections } from "../thread-knowledge/repair";
import { archiveThreadCore } from "../agent/archive-thread";
import {
  analyzeAnswer,
  answerFromVision,
  buildVisionInput,
  DEFAULT_VISION_MODEL,
  DEFAULT_VISION_PARAMS,
  imageParts,
  substituteImage,
  TO_MARKDOWN,
} from "./debug-vision";
import type { VisionProbeConfig } from "./debug-vision";

/** RPC surface of ThinkThreadAgent's DEBUG-only methods (token-gated routes). */
interface DebugThreadStub {
  debugExecStart(command: string): Promise<{ processId: string; status: string }>;
  debugFileTools(): Promise<{ steps: Array<{ step: string; ok: boolean; detail: string }> }>;
  debugThreadKnowledgeTools(): Promise<{
    steps: Array<{
      step: "search" | "read" | "grep" | "weekly-list" | "cleanup";
      ok: boolean;
      detail: unknown;
    }>;
  }>;
  debugCloudflareCompute(): Promise<{
    steps: Array<{ step: string; ok: boolean; detail: string }>;
  }>;
  debugCloudflareShutdown(): Promise<{ sandboxId: string; destroyed: string[]; errors: string[] }>;
  debugSandboxReset(): Promise<{
    provider: string;
    processId: string;
    generationBefore: string | null;
    generationAfter: string | null;
    generationState: "unknown" | "known" | "absent";
    generationDiverged: boolean;
    resetPathExercised: boolean;
    outcome: string | null;
    reason: string | null;
    reminderDelivered: boolean;
    reminderText: string | null;
    terminalViaExplicitSweep: boolean;
    postResetListing:
      | { ok: true; entries: string[] }
      | { ok: false; errorName?: string; errorMessage: string }
      | null;
    elapsedMs: number;
    steps: Array<{ step: string; ok: boolean; detail: string }>;
  }>;
  debugWorkHealthy(sleepSeconds?: number): Promise<{
    provider: string;
    processId: string;
    generation: string | null;
    aliveAfterStaleWindow: boolean;
    stampAdvancedMs: number;
    outcome: string | null;
    reason: string | null;
    faultDelivered: boolean;
    faultText: string | null;
    elapsedMs: number;
    steps: Array<{ step: string; ok: boolean; detail: string }>;
  }>;
  debugShutdown(): Promise<unknown>;
  debugExecOutput(
    processId: string,
  ): Promise<{ status: string; exitCode: number | null; stdout: string; stderr: string }>;
  debugExecStatus(
    processId: string,
  ): Promise<{ status: string; exitCode: number | null; elapsedMs: number }>;
  debugExec(
    command: string,
    uploads?: number,
  ): Promise<{ elapsedMs: number; uploadMs: number; result: unknown }>;
  debugCancelTurn(waitMs?: number): Promise<{
    processId: string;
    statusBefore: string;
    statusAfter: string;
    exitCode: unknown;
  }>;
  debugSkillScript(sleepSeconds?: number): Promise<{ durationMs: number; result: unknown }>;
  debugSpawnSubagent(task: string, label?: string): Promise<{ runId: string } | { error: string }>;
  debugSubagentState(): Promise<{
    timings: Record<string, { startedAt: number; finishedAt?: number }>;
    leases: string[];
  }>;
  debugReadMessages(limit?: number): Promise<Array<{ id: string; role: string; text: string }>>;
  debugReadMessageParts(limit?: number): Promise<Array<Record<string, unknown>>>;
  debugCompareViews(): Promise<{
    durable: string[];
    cached: string[];
    durableOverlays: number;
    cachedOverlays: number;
  }>;
  debugRawPath(): Promise<Array<{ id: string; bytes: number }>>;
  debugWorkLedger(): Promise<{ rows: unknown[] }>;
  debugPurgePersistedOverlays(): Promise<{ purged: string[] }>;
  debugReadCompactions(): Promise<
    Array<{ id: string; fromMessageId: string; toMessageId: string; summaryHead: string }>
  >;
  debugRunBackstop(): Promise<{
    attached: string[];
    watchers: Array<{ processId: string; command: string; deadlineAt: number }>;
    runningProcesses: Array<{ processId: string; status: string }>;
  }>;
  debugRawProcessStatus(processId: string): Promise<unknown>;
  debugToolCallTiming(): Promise<{ rows: unknown[] }>;
  debugSeedAndCompact(): Promise<{
    provider: string;
    model: string;
    budget: { contextWindow: number; compactAfterTokens: number };
    seeded: { messages: number; estimatedTokens: number };
    compacted: boolean;
    outcome:
      | { status: "shortened"; summarizedMessages: number; summaryTokens: number }
      | { status: "noop"; reason: string }
      | { status: "failed"; error: string }
      | null;
  }>;
}

const IMAGE_MIME_RE = /^image\/(?:png|jpeg|webp|gif)$/;

type VisionSource = { buffer: ArrayBuffer; mimeType: string; origin: Record<string, unknown> };

/** Accepts a multipart upload, a stored attachment, or inline base64. */
async function resolveVisionSource(
  env: Env,
  form: FormData | null,
  body: Record<string, unknown>,
): Promise<VisionSource | Response> {
  const file = form?.get("file");
  if (file instanceof File) {
    const mimeType = file.type || "image/png";
    if (!IMAGE_MIME_RE.test(mimeType)) {
      return new Response(`unsupported image type: ${mimeType}`, { status: 415 });
    }
    return {
      buffer: await file.arrayBuffer(),
      mimeType,
      origin: { kind: "upload", filename: file.name, byteSize: file.size, mimeType },
    };
  }

  const inlineBase64 = typeof body.imageBase64 === "string" ? body.imageBase64 : null;
  if (inlineBase64) {
    const mimeType = typeof body.mimeType === "string" ? body.mimeType : "image/png";
    if (!IMAGE_MIME_RE.test(mimeType)) {
      return new Response(`unsupported image type: ${mimeType}`, { status: 415 });
    }
    const base64 = inlineBase64.replace(/^data:[^;]+;base64,/, "");
    const bytes = Uint8Array.from(atob(base64), (c) => c.charCodeAt(0));
    return {
      buffer: bytes.buffer as ArrayBuffer,
      mimeType,
      origin: { kind: "inline", byteSize: bytes.length, mimeType },
    };
  }

  const attachmentId = typeof body.attachmentId === "string" ? body.attachmentId : null;
  if (!attachmentId) {
    return new Response("file (multipart), imageBase64, or attachmentId required", { status: 400 });
  }
  const row = await registryDb(env)
    .select()
    .from(attachments)
    .where(eq(attachments.id, attachmentId))
    .get();
  if (!row) return new Response("attachment not found", { status: 404 });
  if (!IMAGE_MIME_RE.test(row.mimeType)) {
    return new Response("attachment must be an image", { status: 415 });
  }
  const object = await env.ATTACHMENTS_BUCKET.get(row.r2Key);
  if (!object) return new Response("attachment bytes not found", { status: 404 });
  return {
    buffer: await object.arrayBuffer(),
    mimeType: row.mimeType,
    origin: {
      kind: "attachment",
      id: row.id,
      filename: row.filename,
      byteSize: row.byteSize,
      mimeType: row.mimeType,
    },
  };
}

/**
 * One vision run, every knob overridable. `question` is the raw prompt; `query`
 * instead composes the two-section prompt the extractor builds, so prod
 * behaviour and hand-written prompts are both reachable. `params` merges over
 * the extractor's defaults, which is how an undocumented field like
 * repetition_penalty gets probed without shipping code.
 */
async function handleVisionProbe(req: Request, env: Env): Promise<Response> {
  const isMultipart = (req.headers.get("content-type") ?? "").includes("multipart/form-data");
  const form = isMultipart ? await req.formData().catch(() => null) : null;
  const body: Record<string, unknown> = isMultipart
    ? Object.fromEntries(
        [...(form?.entries() ?? [])]
          .filter(([, value]) => typeof value === "string")
          .map(([key, value]) => [key, value]),
      )
    : ((await req.json().catch(() => ({}))) as Record<string, unknown>);

  const source = await resolveVisionSource(env, form, body);
  if (source instanceof Response) return source;

  // In multipart, params arrives as a JSON string; in JSON it is already an object.
  let overrides: Record<string, unknown> = {};
  if (typeof body.params === "string") {
    try {
      overrides = JSON.parse(body.params) as Record<string, unknown>;
    } catch {
      return new Response("params must be valid JSON", { status: 400 });
    }
  } else if (typeof body.params === "object" && body.params !== null) {
    overrides = body.params as Record<string, unknown>;
  }

  let rawInput: unknown = null;
  if (typeof body.rawInput === "string") {
    try {
      rawInput = JSON.parse(body.rawInput);
    } catch {
      return new Response("rawInput must be valid JSON", { status: 400 });
    }
  } else if (typeof body.rawInput === "object" && body.rawInput !== null) {
    rawInput = body.rawInput;
  }

  const rawQuestion = typeof body.question === "string" ? body.question.trim() : "";
  const query = typeof body.query === "string" ? body.query.trim() : "";
  const config: VisionProbeConfig = {
    model: typeof body.model === "string" && body.model ? body.model : DEFAULT_VISION_MODEL,
    question: rawQuestion || buildExtractionQuestion(query || undefined),
    imageFormat: body.imageFormat === "byteArray" ? "byteArray" : "dataUri",
    params: { ...DEFAULT_VISION_PARAMS, ...overrides },
  };

  return tryJson(async () => {
    // toMarkdown is the incumbent non-model path: no prompt, no params. It
    // belongs in the comparison even though it is not a `run()` call.
    if (config.model === TO_MARKDOWN) {
      const startedAt = Date.now();
      const results = await (
        env.AI as unknown as { toMarkdown(files: { name: string; blob: Blob }[]): Promise<unknown> }
      ).toMarkdown([{ name: "probe", blob: new Blob([source.buffer], { type: source.mimeType }) }]);
      const elapsedMs = Date.now() - startedAt;
      const answer = (results as { data?: string }[])[0]?.data ?? null;
      return {
        source: source.origin,
        model: TO_MARKDOWN,
        question: null,
        imageFormat: null,
        params: null,
        elapsedMs,
        answer,
        analysis: analyzeAnswer(answer, results),
        raw: results,
      };
    }

    // rawInput wins outright: it exists to send a shape this code does not know
    // how to build, so imposing our defaults on it would defeat the point.
    const input = rawInput
      ? (substituteImage(rawInput, imageParts(source.buffer, source.mimeType)) as Record<
          string,
          unknown
        >)
      : buildVisionInput(source.buffer, source.mimeType, config);
    const startedAt = Date.now();
    const raw = await (env.AI as unknown as MoondreamRunner).run(config.model, input);
    const elapsedMs = Date.now() - startedAt;
    const answer = answerFromVision(raw);
    return {
      source: source.origin,
      model: config.model,
      question: config.question,
      imageFormat: rawInput ? "rawInput" : config.imageFormat,
      params: rawInput ? null : config.params,
      elapsedMs,
      answer,
      analysis: analyzeAnswer(answer, raw),
      raw,
    };
  });
}

type MoondreamRunner = {
  run(model: string, input: Record<string, unknown>): Promise<unknown>;
};

/**
 * `getAgentByName`, not `namespace.get(idFromName(...))`: the raw stub skips
 * `onStart()`, leaving `this.session` undefined. Any RPC that touches the
 * session (e.g. `execShutdown`) then dies with `reading 'getMessage'`.
 */
async function threadStub(env: Env, threadId: string): Promise<DebugThreadStub> {
  const stub = await getAgentByName(env.THINK_THREAD_AGENT, threadId);
  return stub as unknown as DebugThreadStub;
}

/** Run a debug handler, surfacing any thrown error as JSON instead of a 1101. */
async function tryJson(fn: () => Promise<unknown>): Promise<Response> {
  try {
    return Response.json(await fn());
  } catch (error) {
    const detail =
      typeof error === "object" && error !== null && "detail" in error
        ? (error as { detail?: unknown }).detail
        : undefined;
    return Response.json(
      {
        error: String(error),
        detail,
        stack: error instanceof Error ? error.stack : undefined,
      },
      { status: 500 },
    );
  }
}

/** Explicit query param wins, then DEBUG_WORKSPACE_ID, then the real "default" tenant. */
export function resolveDebugWorkspaceId(env: Env, queryParam: string | null): string {
  return queryParam ?? env.DEBUG_WORKSPACE_ID ?? env.DEFAULT_WORKSPACE_ID;
}

/**
 * Token-gated debug surface (/api/debug/*). Gated by the DEBUG_TOKEN secret via
 * an `x-debug-token` header: if DEBUG_TOKEN is unset (tests) or the header
 * doesn't match, every debug route 404s (no existence signal). These endpoints
 * expose internal MCP state for diagnosis — NEVER secret values (only existence
 * flags for tokens/client-info).
 */
export async function routeDebug(req: Request, env: Env): Promise<Response | null> {
  const url = new URL(req.url);
  if (!url.pathname.startsWith("/api/debug/")) return null;

  const token = env.DEBUG_TOKEN;
  if (!token || req.headers.get("x-debug-token") !== token) {
    return new Response("Not found", { status: 404 });
  }

  const workspaceId = resolveDebugWorkspaceId(env, url.searchParams.get("workspaceId"));

  // GET /api/debug/provider-chat?provider=&model=&n= — fire N chat completions
  // with the stored key, then immediately re-list models. Zen rate-limits; when
  // it does, /models 429s too and searchProviderModels silently degrades to the
  // static list. This shows both halves in one shot.
  if (url.pathname === "/api/debug/provider-chat" && req.method === "GET") {
    const provider = url.searchParams.get("provider") ?? "";
    if (!isProviderConfigProvider(provider)) {
      return Response.json({ error: "unknown provider", provider }, { status: 400 });
    }
    const model = url.searchParams.get("model") ?? "deepseek-v4-flash-free";
    const runs = Math.min(Math.max(Number(url.searchParams.get("n") ?? "5"), 1), 30);

    const endpointConfig = await getProviderEndpointConfig(env, workspaceId, provider);
    const secret = await getProviderSecretValue(env, workspaceId, provider);
    const base = endpointConfig.baseUrl.replace(/\/+$/, "");

    // ?noauth=1 sends NO key from the same egress IP. If the keyed call is 429
    // but the keyless one is 200, the limit follows the account, not the IP.
    const noAuth = url.searchParams.get("noauth") === "1";
    const chats: Array<Record<string, unknown>> = [];
    for (let i = 0; i < runs; i++) {
      try {
        const res = await fetch(`${base}/chat/completions`, {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            ...(secret && !noAuth ? { Authorization: `Bearer ${secret}` } : {}),
          },
          body: JSON.stringify({ model, messages: [{ role: "user", content: "hi" }] }),
        });
        const text = await res.text();
        chats.push({
          i,
          status: res.status,
          ok: res.ok,
          ...(res.ok ? {} : { body: text.slice(0, 200) }),
        });
      } catch (err) {
        chats.push({ i, threw: err instanceof Error ? err.message : String(err) });
      }
    }

    // Immediately after: is the model list collateral damage?
    let modelsAfter: Record<string, unknown> = {};
    const listUrl = modelListUrl(provider, endpointConfig.baseUrl);
    if (listUrl) {
      try {
        const res = await fetch(listUrl, {
          headers: {
            Accept: "application/json",
            ...(secret ? { Authorization: `Bearer ${secret}` } : {}),
          },
        });
        const text = await res.text();
        modelsAfter = {
          status: res.status,
          ok: res.ok,
          ...(res.ok ? {} : { body: text.slice(0, 200) }),
        };
      } catch (err) {
        modelsAfter = { threw: err instanceof Error ? err.message : String(err) };
      }
    }

    const search = await searchProviderModels({
      provider,
      query: "",
      limit: 50,
      fetchImpl: fetch,
      secret,
      endpointConfig,
    }).catch(() => null);

    return Response.json(
      {
        provider,
        model,
        sentKey: !noAuth && secret !== null && secret !== "",
        chats,
        modelsAfter,
        searchSourceAfter: search?.source ?? "threw",
        searchCountAfter: search?.models.length ?? null,
      },
      { headers: { "Cache-Control": "no-store" } },
    );
  }

  // GET /api/debug/provider-models?provider=…&q=… — what the Worker actually
  // sees when it lists a provider's models. searchProviderModels degrades to the
  // static list on ANY live-fetch failure, which is indistinguishable from
  // success in the UI. This reports the raw upstream status/body next to the
  // resolved source, so a silent fallback is visible. Never returns the secret —
  // only whether one is present.
  if (url.pathname === "/api/debug/provider-models" && req.method === "GET") {
    const provider = url.searchParams.get("provider") ?? "";
    if (!isProviderConfigProvider(provider)) {
      return Response.json({ error: "unknown provider", provider }, { status: 400 });
    }

    const endpointConfig = await getProviderEndpointConfig(env, workspaceId, provider);
    const secret = await getProviderSecretValue(env, workspaceId, provider);
    const listUrl = modelListUrl(provider, endpointConfig.baseUrl);

    // Spy on the fetch the search path ACTUALLY makes, rather than fetching
    // separately — a separate probe would itself be a request the provider could
    // rate-limit, confounding the result.
    const calls: Array<Record<string, unknown>> = [];
    const spyFetch: typeof fetch = async (input, init) => {
      const target = typeof input === "string" ? input : String((input as Request).url ?? input);
      try {
        const res = await fetch(input as RequestInfo, init);
        const clone = res.clone();
        const text = await clone.text().catch(() => "");
        calls.push({
          url: target,
          status: res.status,
          ok: res.ok,
          bodySnippet: text.slice(0, 200),
          bodyBytes: text.length,
        });
        return res;
      } catch (err) {
        calls.push({ url: target, threw: err instanceof Error ? err.message : String(err) });
        throw err;
      }
    };

    const runs = Math.min(Math.max(Number(url.searchParams.get("n") ?? "1"), 1), 20);
    const outcomes: Array<Record<string, unknown>> = [];
    let search: Awaited<ReturnType<typeof searchProviderModels>> | null = null;
    for (let i = 0; i < runs; i++) {
      const before = calls.length;
      const r = await searchProviderModels({
        provider,
        query: url.searchParams.get("q") ?? "",
        limit: 50,
        fetchImpl: spyFetch,
        secret,
        endpointConfig,
      }).catch(() => null);
      search = r;
      const call = calls[before] ?? {};
      outcomes.push({
        i,
        source: r?.source ?? "threw",
        count: r?.models.length ?? null,
        status: call.status ?? call.threw ?? "no-fetch",
      });
    }
    const searchThrew: string | null = null;

    return Response.json(
      {
        provider,
        workspaceId,
        endpointConfig,
        secretPresent: secret !== null && secret !== "",
        listUrl,
        // Every fetch the search path made, as it saw it.
        outcomes,
        searchThrew,
        // "static" here means the live fetch was discarded and nobody was told.
        resolvedSource: search?.source ?? null,
        modelCount: search?.models.length ?? null,
        modelIds: search?.models.map((m) => m.id) ?? null,
      },
      { headers: { "Cache-Control": "no-store" } },
    );
  }

  // POST /api/debug/ai/vision — run ONE vision model with fully overridable
  // params against an uploaded image or an existing attachment, and score the
  // output for degeneration. Multipart (`file` + fields) or JSON
  // (`attachmentId` | `imageBase64`). See handleVisionProbe.
  if (url.pathname === "/api/debug/ai/vision" && req.method === "POST") {
    return handleVisionProbe(req, env);
  }

  // GET /api/debug/attachments?limit= — newest attachments with their extraction
  // state, so a probe can be pointed at a just-uploaded image. Metadata only;
  // extracted text is reported by length, never echoed.
  if (url.pathname === "/api/debug/attachments" && req.method === "GET") {
    const limit = Math.min(Number(url.searchParams.get("limit")) || 10, 50);
    return tryJson(async () => {
      const rows = await registryDb(env)
        .select()
        .from(attachments)
        .orderBy(desc(attachments.createdAt))
        .limit(limit)
        .all();
      return {
        attachments: rows.map((row) => ({
          id: row.id,
          threadId: row.threadId,
          mimeType: row.mimeType,
          filename: row.filename,
          byteSize: row.byteSize,
          width: row.width,
          height: row.height,
          createdAt: row.createdAt,
          extractedSource: row.extractedSource,
          extractedChars: row.extractedText?.length ?? null,
          extractedError: row.extractedError,
          extractedAttempts: row.extractedAttempts,
        })),
      };
    });
  }

  // POST /api/debug/ai/moondream {attachmentId, question?, query?} — load an
  // existing image attachment from R2 and probe the current Moondream input
  // contract. `query` composes the same two-section prompt the agent builds
  // from a user's message; `question` overrides the prompt outright.
  if (url.pathname === "/api/debug/ai/moondream" && req.method === "POST") {
    const body = (await req.json().catch(() => ({}))) as {
      attachmentId?: string;
      question?: string;
      query?: string;
    };
    if (!body.attachmentId) return new Response("attachmentId required", { status: 400 });

    const row = await registryDb(env)
      .select()
      .from(attachments)
      .where(eq(attachments.id, body.attachmentId))
      .get();
    if (!row) return new Response("attachment not found", { status: 404 });
    if (!IMAGE_MIME_RE.test(row.mimeType)) {
      return new Response("attachment must be an image", { status: 415 });
    }

    const object = await env.ATTACHMENTS_BUCKET.get(row.r2Key);
    if (!object) return new Response("attachment bytes not found", { status: 404 });

    return tryJson(async () => {
      const startedAt = Date.now();
      const image = `data:${row.mimeType};base64,${arrayBufferToBase64(await object.arrayBuffer())}`;
      const override = body.question?.trim();
      const query = override ? undefined : body.query?.trim();
      const question = override || buildExtractionQuestion(query);
      const raw = await (env.AI as unknown as MoondreamRunner).run(DEFAULT_VISION_MODEL, {
        image,
        max_tokens: query ? EXTRACTION_MAX_TOKENS_WITH_QUERY : EXTRACTION_MAX_TOKENS,
        question,
        reasoning: false,
        stream: false,
        task: "query",
        temperature: 0,
      });

      return {
        attachment: {
          id: row.id,
          mimeType: row.mimeType,
          filename: row.filename,
          byteSize: row.byteSize,
          r2Key: row.r2Key,
        },
        answer: answerFromVisionModel(raw),
        elapsedMs: Date.now() - startedAt,
        model: DEFAULT_VISION_MODEL,
        question,
        raw,
      };
    });
  }

  // GET /api/debug/mcp/servers?workspaceId= — list a workspace's MCP servers (D1).
  if (url.pathname === "/api/debug/mcp/servers" && req.method === "GET") {
    const servers = await new McpServerRepository(registryDb(env)).list(workspaceId);
    return Response.json({ workspaceId, servers });
  }

  // GET /api/debug/mcp/discover?workspaceId=&serverId=&url= — raw discovery dump.
  // url is looked up from D1 if omitted.
  if (url.pathname === "/api/debug/mcp/discover" && req.method === "GET") {
    const serverId = url.searchParams.get("serverId");
    if (!serverId) return new Response("serverId required", { status: 400 });
    let serverUrl = url.searchParams.get("url");
    if (!serverUrl) {
      const row = await new McpServerRepository(registryDb(env)).getById(serverId);
      serverUrl = row?.url ?? null;
    }
    if (!serverUrl) return new Response("url required (unknown server)", { status: 400 });
    const stub = await getAgentByName(env.WORKSPACE_MCP_AGENT, `workspace:${workspaceId}`);
    const result = await stub.debugDiscover(serverId, serverUrl);
    return Response.json(result);
  }

  // GET /api/debug/mcp/oauth?workspaceId=&serverId= — stored-credential existence.
  if (url.pathname === "/api/debug/mcp/oauth" && req.method === "GET") {
    const serverId = url.searchParams.get("serverId");
    if (!serverId) return new Response("serverId required", { status: 400 });
    const hasToken = await hasMcpOAuthTokens(env, workspaceId, serverId);
    const client = await getMcpOAuthClient(env, workspaceId, serverId);
    return Response.json({ workspaceId, serverId, hasToken, hasClient: client != null });
  }

  // POST /api/debug/thread?workspaceId= {provider?, model?} — register a
  // throwaway `think` thread on the workspace's agent, so its sandbox +
  // subagents can be driven below. An optional provider/model overrides the
  // agent's default on the thread's OWN `thread_index` row (the same
  // per-thread snapshot `PATCH /api/threads/:id` writes), so
  // `resolveRuntimeConfigForThink()` — and therefore the context budget, the
  // compaction threshold, and the summarizer — all resolve to it instead of
  // the owner's (likely much larger) default model.
  if (url.pathname === "/api/debug/thread" && req.method === "POST") {
    const db = registryDb(env);
    const agent = await db
      .select({
        id: agents.id,
        provider: agents.provider,
        model: agents.model,
        modelInputModalities: agents.modelInputModalities,
        showReasoning: agents.showReasoning,
      })
      .from(agents)
      .where(eq(agents.workspaceId, workspaceId))
      .get();
    if (!agent) return new Response("no agent for workspace", { status: 404 });

    const body = (await req.json().catch(() => ({}))) as {
      provider?: string;
      model?: string;
    };

    let provider = agent.provider;
    let model = agent.model;
    if (body.provider !== undefined || body.model !== undefined) {
      if (typeof body.provider !== "string" || !isSupportedAgentProvider(body.provider)) {
        return new Response("unsupported provider", { status: 400 });
      }
      if (typeof body.model !== "string" || !body.model.trim()) {
        return new Response("model must be a non-empty string", { status: 400 });
      }
      // Same gate `resolveThreadModelForCall` applies at turn time (an
      // ownership-scoped allowlist, not the browser session's viewer) — check
      // it here so a gated pair (e.g. workers-ai without an allowlisted
      // owner) 400s now instead of failing confusingly mid-compaction.
      const ownerEmail = await new WorkspaceRepository(db).getOwnerEmail(workspaceId);
      if (!(await isUsableProviderForWorkspace(env, workspaceId, body.provider, ownerEmail))) {
        return new Response(`provider not usable for this workspace: ${body.provider}`, {
          status: 400,
        });
      }
      provider = body.provider;
      model = body.model.trim();
    }

    const now = Date.now();
    const threadId = `thr_${crypto.randomUUID()}`;
    await db.insert(threadIndex).values({
      id: threadId,
      workspaceId,
      agentId: agent.id,
      modelProvider: provider,
      model,
      modelInputModalities: agent.modelInputModalities,
      showReasoning: agent.showReasoning,
      title: "debug thread",
      titleSet: true,
      runtime: "think",
      source: "manual",
      automatonId: null,
      automatonRunId: null,
      lastEventId: null,
      lastMessagePreview: "",
      createdAt: now,
      updatedAt: now,
    });
    return Response.json({ threadId, workspaceId, agentId: agent.id, provider, model });
  }

  // POST /api/debug/exec-start {threadId, command} — start a background command
  // in the thread's own sandbox. Returns the process id to poll below.
  if (url.pathname === "/api/debug/exec-start" && req.method === "POST") {
    const body = (await req.json().catch(() => ({}))) as { threadId?: string; command?: string };
    if (!body.threadId || !body.command)
      return new Response("threadId + command required", { status: 400 });
    return tryJson(async () =>
      (await threadStub(env, body.threadId!)).debugExecStart(body.command!),
    );
  }

  // GET /api/debug/exec-output?threadId=&processId= — captured output (refreshes
  // from the provider first). Poll this to observe R1 output capture.
  if (url.pathname === "/api/debug/exec-output" && req.method === "GET") {
    const threadId = url.searchParams.get("threadId");
    const processId = url.searchParams.get("processId");
    if (!threadId || !processId)
      return new Response("threadId + processId required", { status: 400 });
    return tryJson(async () => (await threadStub(env, threadId)).debugExecOutput(processId));
  }

  // POST /api/debug/cancel-turn {threadId, waitMs?} — start a long process, run a
  // REAL turn, then abort it exactly as the UI stop button does. statusAfter
  // "running" means stop did not stop the sandbox.
  if (url.pathname === "/api/debug/cancel-turn" && req.method === "POST") {
    const body = (await req.json().catch(() => ({}))) as { threadId?: string; waitMs?: number };
    if (!body.threadId) return new Response("threadId required", { status: 400 });
    return tryJson(async () =>
      (await threadStub(env, body.threadId!)).debugCancelTurn(body.waitMs),
    );
  }

  // POST /api/debug/exec {threadId, command} — drive the REAL sync-first exec(),
  // foreground poll loop included. exec-start bypasses that loop, so only this
  // shows whether exec hits the getProcess-at-exit wedge.
  if (url.pathname === "/api/debug/exec" && req.method === "POST") {
    const body = (await req.json().catch(() => ({}))) as {
      threadId?: string;
      command?: string;
      uploads?: number;
    };
    if (!body.threadId || !body.command) {
      return new Response("threadId + command required", { status: 400 });
    }
    return tryJson(async () =>
      (await threadStub(env, body.threadId!)).debugExec(body.command!, body.uploads),
    );
  }

  // GET /api/debug/exec-status?threadId=&processId= — the PROVIDER's status for a
  // process, bypassing the store. This is what the skill-script poll loop sees;
  // exec-output's status comes from the store and only advances via a watcher.
  if (url.pathname === "/api/debug/exec-status" && req.method === "GET") {
    const threadId = url.searchParams.get("threadId");
    const processId = url.searchParams.get("processId");
    if (!threadId || !processId)
      return new Response("threadId + processId required", { status: 400 });
    return tryJson(async () => (await threadStub(env, threadId)).debugExecStatus(processId));
  }

  // POST /api/debug/file-tools {threadId} — drive read_file/write_file/apply_patch
  // against the LIVE compute backend. Unit tests use the fake, which cannot prove
  // the provider reports `type: "symlink"` (the path-escape guard) or that
  // movePath(overwrite) replaces an existing destination.
  if (url.pathname === "/api/debug/file-tools" && req.method === "POST") {
    const body = (await req.json().catch(() => ({}))) as { threadId?: string };
    if (!body.threadId) return new Response("threadId required", { status: 400 });
    return tryJson(async () => (await threadStub(env, body.threadId!)).debugFileTools());
  }

  // POST /api/debug/thread-knowledge-tools {threadId} — fixed, self-cleaning
  // walkthrough for weekly-digest retrieval via the REAL model-facing tools.
  if (url.pathname === "/api/debug/thread-knowledge-tools" && req.method === "POST") {
    const body = (await req.json().catch(() => ({}))) as { threadId?: string };
    if (!body.threadId) return new Response("threadId required", { status: 400 });
    return tryJson(async () => (await threadStub(env, body.threadId!)).debugThreadKnowledgeTools());
  }

  // POST /api/debug/thread-search-repair {limit?} — drive the scheduled search
  // repair batch on demand. Cron triggers cannot be invoked manually, so this is
  // the only way to drain the backfill (or exercise the repair path at all)
  // without waiting for the daily run. `remaining` reports the backlog after the
  // batch, so a caller can loop until it hits 0; a `failed` count that does not
  // shrink across loops means those threads are permanently broken, not slow.
  if (url.pathname === "/api/debug/thread-search-repair" && req.method === "POST") {
    const body = (await req.json().catch(() => ({}))) as { limit?: number };
    if (body.limit !== undefined && (!Number.isFinite(body.limit) || body.limit < 1)) {
      return new Response("limit must be a positive number", { status: 400 });
    }
    return tryJson(async () =>
      body.limit === undefined
        ? repairStaleThreadSearchProjections(env)
        : repairStaleThreadSearchProjections(env, body.limit),
    );
  }

  // POST /api/debug/skill-script {threadId, sleepSeconds?} — run the REAL
  // ComputeSkillScriptRunner end-to-end against the thread's live sandbox (no
  // model turn). The script sleeps so it outlives execStart, exercising the
  // completion poll; the request lists the script in `resources` (the real SDK
  // shape). Expect ok:true in ~sleepSeconds + a few poll intervals.
  if (url.pathname === "/api/debug/skill-script" && req.method === "POST") {
    const body = (await req.json().catch(() => ({}))) as {
      threadId?: string;
      sleepSeconds?: number;
    };
    if (!body.threadId) return new Response("threadId required", { status: 400 });
    return tryJson(async () =>
      (await threadStub(env, body.threadId!)).debugSkillScript(body.sleepSeconds),
    );
  }

  // POST /api/debug/cloudflare-compute {threadId} — drive the LIVE Cloudflare
  // Sandbox provider through every contract a fake can only assert (sandbox-id
  // derivation, fail-closed egress, /workspace, file round-trip, movePath
  // overwrite, in-band-vs-throw, symlink type, recoverable restore, discard
  // divergence). Constructs the Cloudflare backend DIRECTLY regardless of the
  // thread's configured provider. WARNING: each run creates a REAL container that
  // costs money and shared disk; the run self-cleans, and /cloudflare-shutdown
  // reclaims a wedged one.
  if (url.pathname === "/api/debug/cloudflare-compute" && req.method === "POST") {
    const body = (await req.json().catch(() => ({}))) as { threadId?: string };
    if (!body.threadId) return new Response("threadId required", { status: 400 });
    return tryJson(async () => (await threadStub(env, body.threadId!)).debugCloudflareCompute());
  }

  // POST /api/debug/cloudflare-shutdown {threadId} — out-of-band cleanup: destroy
  // the derived (workspace, thread) Cloudflare container on each binding.
  if (url.pathname === "/api/debug/cloudflare-shutdown" && req.method === "POST") {
    const body = (await req.json().catch(() => ({}))) as { threadId?: string };
    if (!body.threadId) return new Response("threadId required", { status: 400 });
    return tryJson(async () => (await threadStub(env, body.threadId!)).debugCloudflareShutdown());
  }

  // POST /api/debug/sandbox-reset {threadId} — prove against a REAL container
  // that a sandbox reset is DETECTED and REPORTED. FakeComputeBackend cannot OOM,
  // so no unit test can settle this. Starts a watched long process, destroys the
  // container out of band, waits for the watcher's failing poll to PROBE the
  // nonce, then reads the ledger terminal AND the thread's messages.
  //
  // It no longer forces a re-provision: the 2026-07-16 live run showed the SDK
  // silently hands back a working container on the same sandbox id after a
  // destroy, so the nonce never diverges and re-provision is not a lever. The
  // reset is now detectable without one — a live container whose nonce file is
  // gone IS a reset (`generationState: "absent"`).
  //
  // `resetPathExercised` is read from the TERMINAL the model was told about,
  // never from the probe, and stays false if the path did not fire — read
  // `steps`, not just the booleans.
  //
  // `postResetListing` is a Task 5 probe (item 1 gate), NOT a fix: it calls the
  // raw SDK `listFiles("/tmp", { includeHidden: true })` directly, bypassing
  // both `inspectPath` and `listDirectory`, and reports the verbatim answer.
  // It settles whether a wiped container's `listFiles` answers cleanly (no
  // entry), fails IN BAND, or throws — three outcomes, not two:
  //   - `{ ok: true, entries }` — the raw SDK reported `success: true`. This
  //     probe does NOT check the SDK's echoed `path` against `/tmp`, unlike
  //     `listDirectory` post-Task-6, so `entries` here is not proof the
  //     listing was of `/tmp` — only `listDirectory`'s own path check is.
  //   - `{ ok: false, errorMessage }` (no `errorName`) — the raw SDK
  //     RESOLVED `{ success: false }`, an in-band failure with no throw.
  //   - `{ ok: false, errorName, errorMessage }` — the call threw (raw
  //     message, unclassified by `isPathNotFound`).
  // WARNING: boots a REAL container that costs money; self-cleans in a `finally`.
  // Never run it in a loop.
  if (url.pathname === "/api/debug/sandbox-reset" && req.method === "POST") {
    const body = (await req.json().catch(() => ({}))) as { threadId?: string };
    if (!body.threadId) return new Response("threadId required", { status: 400 });
    return tryJson(async () => (await threadStub(env, body.threadId!)).debugSandboxReset());
  }

  // POST /api/debug/work-healthy {threadId, sleepSeconds?} — the FALSE-FAULT
  // direction: a healthy process that outlives PROCESS_STALE_AFTER_MS (21s) must
  // stay `alive` and must never be faulted. Enforcement ships live, so this
  // matters as much as the reset direction. Same money warning as above.
  if (url.pathname === "/api/debug/work-healthy" && req.method === "POST") {
    const body = (await req.json().catch(() => ({}))) as {
      threadId?: string;
      sleepSeconds?: number;
    };
    if (!body.threadId) return new Response("threadId required", { status: 400 });
    return tryJson(async () =>
      (await threadStub(env, body.threadId!)).debugWorkHealthy(body.sleepSeconds),
    );
  }

  // POST /api/debug/shutdown {threadId} — destroy the thread's sandbox. Debug
  // threads each hold one and the org's disk quota is shared.
  if (url.pathname === "/api/debug/shutdown" && req.method === "POST") {
    const body = (await req.json().catch(() => ({}))) as { threadId?: string };
    if (!body.threadId) return new Response("threadId required", { status: 400 });
    return tryJson(async () => (await threadStub(env, body.threadId!)).debugShutdown());
  }

  // POST /api/debug/spawn-subagent {threadId, task, label?} — dispatch a subagent
  // directly (no model turn).
  if (url.pathname === "/api/debug/spawn-subagent" && req.method === "POST") {
    const body = (await req.json().catch(() => ({}))) as {
      threadId?: string;
      task?: string;
      label?: string;
    };
    if (!body.threadId || !body.task)
      return new Response("threadId + task required", { status: 400 });
    return tryJson(async () =>
      (await threadStub(env, body.threadId!)).debugSpawnSubagent(body.task!, body.label),
    );
  }

  // GET /api/debug/subagent-state?threadId= — parent subagent bookkeeping.
  if (url.pathname === "/api/debug/subagent-state" && req.method === "GET") {
    const threadId = url.searchParams.get("threadId");
    if (!threadId) return new Response("threadId required", { status: 400 });
    return tryJson(async () => (await threadStub(env, threadId)).debugSubagentState());
  }

  // GET /api/debug/messages?threadId=&limit= — recent thread message texts.
  // GET /api/debug/compactions?threadId= — the raw overlay rows. Two rows with
  // DIFFERENT fromMessageIds means the model is reading two summaries where it
  // should read one.
  // GET /api/debug/views?threadId= — durable history vs the cached view the model
  // and the UI actually read. A disagreement means the model sees phantom messages.
  if (url.pathname === "/api/debug/views" && req.method === "GET") {
    const threadId = url.searchParams.get("threadId");
    if (!threadId) return new Response("threadId required", { status: 400 });
    return tryJson(async () => (await threadStub(env, threadId)).debugCompareViews());
  }

  // POST /api/debug/purge-overlays?threadId= — delete compaction overlays that were
  // wrongly persisted as real messages, re-parenting their children first.
  if (url.pathname === "/api/debug/purge-overlays" && req.method === "POST") {
    const threadId = url.searchParams.get("threadId");
    if (!threadId) return new Response("threadId required", { status: 400 });
    return tryJson(async () => (await threadStub(env, threadId)).debugPurgePersistedOverlays());
  }

  // GET /api/debug/work-ledger?threadId= — the full background_work ledger,
  // rows as-is (outcome/reason/startedAt/lastAliveAt). Auditing classification
  // accuracy is the whole point, so this never filters or prettifies.
  if (url.pathname === "/api/debug/work-ledger" && req.method === "GET") {
    const threadId = url.searchParams.get("threadId");
    if (!threadId) return new Response("threadId required", { status: 400 });
    return tryJson(async () => (await threadStub(env, threadId)).debugWorkLedger());
  }

  // GET /api/debug/raw-path?threadId= — the stored message rows, pre-overlay.
  if (url.pathname === "/api/debug/raw-path" && req.method === "GET") {
    const threadId = url.searchParams.get("threadId");
    if (!threadId) return new Response("threadId required", { status: 400 });
    return tryJson(async () => (await threadStub(env, threadId)).debugRawPath());
  }

  if (url.pathname === "/api/debug/compactions" && req.method === "GET") {
    const threadId = url.searchParams.get("threadId");
    if (!threadId) return new Response("threadId required", { status: 400 });
    return tryJson(async () => (await threadStub(env, threadId)).debugReadCompactions());
  }

  // `?raw=1` keeps every part intact (tool arguments + tool results) instead of
  // collapsing them to `[tool-name]`. That is the only view that can diagnose a
  // model-facing tool failure after the turn has already settled.
  if (url.pathname === "/api/debug/messages" && req.method === "GET") {
    const threadId = url.searchParams.get("threadId");
    if (!threadId) return new Response("threadId required", { status: 400 });
    const limit = Number(url.searchParams.get("limit") ?? "12");
    const raw = url.searchParams.get("raw") === "1";
    return tryJson(async () => {
      const stub = await threadStub(env, threadId);
      return raw ? stub.debugReadMessageParts(limit) : stub.debugReadMessages(limit);
    });
  }

  // POST /api/debug/run-backstop {threadId} — run the turn-end backstop sweep
  // (as onChatResponse does) and report what it attached + what the read-only UI
  // callable now sees. Diagnoses whether the backstop attaches a watcher.
  if (url.pathname === "/api/debug/run-backstop" && req.method === "POST") {
    const body = (await req.json().catch(() => ({}))) as { threadId?: string };
    if (!body.threadId) return new Response("threadId required", { status: 400 });
    return tryJson(async () => (await threadStub(env, body.threadId!)).debugRunBackstop());
  }

  // POST /api/debug/compact {threadId} — seed enough synthetic history to make
  // a REAL compaction genuinely necessary for the thread's resolved model, then
  // force it through the same `session.compact()` path `compactThread()` uses,
  // and report the resolved budget + outcome. Verifies against a live provider
  // that a real compaction writes a `compaction`-source ledger row (attributed
  // to whichever model actually served the summarizer, which may be the keyless
  // Workers AI fallback) and that `chat` input tokens rise while the thread's
  // context gauge falls. Does not provision a sandbox.
  if (url.pathname === "/api/debug/compact" && req.method === "POST") {
    const body = (await req.json().catch(() => ({}))) as { threadId?: string };
    if (!body.threadId) return new Response("threadId required", { status: 400 });
    return tryJson(async () => (await threadStub(env, body.threadId!)).debugSeedAndCompact());
  }

  // GET /api/debug/tool-timing?threadId= — per-call tool durations, newest
  // first. Rows with a null finishedAt are STILL OPEN: either running now, or a
  // call that never returned. The latter is the whole reason the row is written
  // before the call rather than after it.
  if (url.pathname === "/api/debug/tool-timing" && req.method === "GET") {
    const threadId = url.searchParams.get("threadId");
    if (!threadId) return new Response("threadId required", { status: 400 });
    return tryJson(async () => (await threadStub(env, threadId)).debugToolCallTiming());
  }

  // GET /api/debug/raw-status?threadId=&processId= — raw Daytona command dump.
  if (url.pathname === "/api/debug/raw-status" && req.method === "GET") {
    const threadId = url.searchParams.get("threadId");
    const processId = url.searchParams.get("processId");
    if (!threadId || !processId)
      return new Response("threadId + processId required", { status: 400 });
    return tryJson(async () => (await threadStub(env, threadId)).debugRawProcessStatus(processId));
  }

  // TEMPORARY (push-tap diagnosis). Fire a real web push at your own devices so
  // the launch/resume routing can be exercised on demand instead of waiting for
  // a long-running turn to finish. Remove with the rest of the push-debug
  // instrumentation once the tap behavior is confirmed.
  //
  //   GET  /api/debug/push?email=you@example.com
  //        → the subscriptions on that account (endpoint host + UA, never keys)
  //   POST /api/debug/push?email=you@example.com&threadId=thr_123[&endpoint=…]
  //        → sends {title, body, url:/threads/thr_123} to each subscription;
  //          `endpoint` (a substring match) narrows it to one device.
  // GET /api/debug/presence?email=you@example.com
  //   → every live user-hub socket for that account: what it claims, how old
  //     the claim is, and whether it is currently suppressing push. This is the
  //     direct read of the thing that decides, instead of inferring it from
  //     whether a notification showed up.
  if (url.pathname === "/api/debug/presence" && req.method === "GET") {
    const email = url.searchParams.get("email");
    if (!email) return new Response("email required", { status: 400 });
    return tryJson(async () => {
      const db = registryDb(env);
      const user = await db.select().from(users).where(eq(users.email, email)).get();
      if (!user) return { error: "no such user", email };
      const stub = env.USER_HUB.get(env.USER_HUB.idFromName(user.id)) as unknown as {
        presenceSnapshot(): unknown;
      };
      return { userId: user.id, presence: await stub.presenceSnapshot() };
    });
  }

  if (url.pathname === "/api/debug/push" && (req.method === "GET" || req.method === "POST")) {
    const email = url.searchParams.get("email");
    if (!email) return new Response("email required", { status: 400 });
    return tryJson(async () => {
      const db = registryDb(env);
      const user = await db.select().from(users).where(eq(users.email, email)).get();
      if (!user) return { error: "no such user", email };
      const subscriptions = await new NotificationRepository(db).listSubscriptionsForUser(user.id);
      const match = url.searchParams.get("endpoint");
      const targets = match
        ? subscriptions.filter((row) => row.endpoint.includes(match))
        : subscriptions;

      if (req.method === "GET") {
        return {
          userId: user.id,
          webPushConfigured: isWebPushConfigured(env),
          subscriptions: subscriptions.map((row) => ({
            id: row.id,
            // The endpoint is a bearer capability — host + tail is enough to
            // tell devices apart without printing one into a log.
            endpointHost: new URL(row.endpoint).host,
            endpointTail: row.endpoint.slice(-12),
            userAgent: row.userAgent,
            lastSeenAt: row.lastSeenAt,
          })),
        };
      }

      const threadId = url.searchParams.get("threadId");
      if (!threadId) return { error: "threadId required" };
      const payload = {
        title: "Push routing test",
        body: `Tap me — this should open ${threadId}.`,
        url: `/threads/${encodeURIComponent(threadId)}`,
      };
      const results = [];
      for (const row of targets) {
        results.push({
          endpointTail: row.endpoint.slice(-12),
          userAgent: row.userAgent,
          result: await sendWebPush({ env, subscription: row, payload }),
        });
      }
      return { payload, sent: results.length, results };
    });
  }

  // GET  /api/debug/legacy-threads          — inventory of `runtime: "legacy"` rows.
  // POST /api/debug/legacy-threads?limit=25 — archive the still-active ones.
  //
  // Retirement tooling for ThreadAgentV2. Archiving snapshots each legacy DO's
  // transcript into D1 and destroys the DO, which is what lets the class be
  // removed from the Worker: after this reports `remaining: 0`, no request path
  // can reach a legacy Durable Object. `allowEmptySnapshot` is on because the
  // usual refusal (see archiveThreadCore) would strand exactly the threads this
  // sweep exists to drain — an empty legacy thread has nothing to lose, and
  // leaving it active points a live row at a class that is about to be deleted.
  if (url.pathname === "/api/debug/legacy-threads") {
    if (req.method !== "GET" && req.method !== "POST") {
      return new Response("method not allowed", { status: 405 });
    }
    return tryJson(async () => {
      const db = registryDb(env);
      const legacy = await db
        .select({
          id: threadIndex.id,
          workspaceId: threadIndex.workspaceId,
          title: threadIndex.title,
          updatedAt: threadIndex.updatedAt,
          archivedAt: threadIndex.archivedAt,
        })
        .from(threadIndex)
        .where(eq(threadIndex.runtime, "legacy"))
        .orderBy(threadIndex.updatedAt)
        .all();

      const active = legacy.filter((row) => row.archivedAt === null);
      if (req.method === "GET") {
        return {
          total: legacy.length,
          archived: legacy.length - active.length,
          active: active.length,
          threads: active,
        };
      }

      const limit = Math.min(Math.max(Number(url.searchParams.get("limit") ?? 25), 1), 200);
      const results: Array<{ threadId: string; outcome: string }> = [];
      for (const row of active.slice(0, limit)) {
        try {
          results.push({
            threadId: row.id,
            outcome: await archiveThreadCore(env, row.id, { allowEmptySnapshot: true }),
          });
        } catch (error) {
          results.push({ threadId: row.id, outcome: `error: ${String(error)}` });
        }
      }
      return {
        attempted: results.length,
        remaining: active.length - results.filter((r) => r.outcome === "archived").length,
        results,
      };
    });
  }

  return new Response("debug route not found", { status: 404 });
}
