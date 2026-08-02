import { AIChatAgent, type OnChatMessageOptions } from "@cloudflare/ai-chat";
import { callable } from "agents";
import { type LanguageModel, type StreamTextOnFinishCallback, type ToolSet } from "ai";
import { eq } from "drizzle-orm";
import type { Env } from "../env";
import { backgroundWorkEnabled, isTruthyFlag, resolveWorkspaceBackgroundWork } from "../flags";
import { resolveEgressProxy } from "../providers/egress-proxy";
import { canUseProvider, isGatedProvider } from "../auth/provider-gate";
import { registryDb } from "../db/client";
import { DEFAULT_REASONING_EFFORT } from "./reasoning-options";
import { WorkspaceRepository } from "../db/repositories/workspaces";
import { agents, threadIndex, workspaces } from "../db/schema";
import {
  getProviderConfig,
  isOpenAICompatibleProvider,
  parseProviderEndpointConfig,
} from "../db/repositories/provider-configs";
import { createWorkspaceOpenAIOAuthManager } from "../providers/openai-oauth";
import { buildModel } from "../providers/model-factory";
import { createWorkspaceSecretsServices } from "../secrets";
import {
  SUPPORTED_RUNTIME_PROVIDERS,
  providerUsesWorkspaceSecret,
  resolveAgentModelConfig,
  resolveModelConfig,
} from "./model-config";
import { resolveProjectPromptContext, type ProjectPromptContext } from "./project-context";
import { log } from "../log";
import {
  resolveComputeService,
  scheduleComputeEviction,
  cancelComputeEviction,
  type ComputeToolHostDeps,
} from "./compute-tools";
import { teardownThreadBeforeDestroy } from "./thread-destroy-teardown";
import { sha256Hex } from "../compute/files/hash";
import { normalizeProseMessage } from "../thread-knowledge/prose-normalizer";
import { grepTranscript, readTranscriptPage } from "../thread-knowledge/transcript-reader";
import {
  THREAD_LAST_MESSAGE_PREVIEW_CHARS,
  THREAD_PROJECTION_DIGEST_PAGE,
  THREAD_PROJECTION_DOCUMENT_BATCH,
  type InternalGrepRequest,
  type InternalGrepResult,
  type InternalReadRequest,
  type InternalReadResult,
  type RawTranscriptStat,
  type ThreadOrder,
  type ThreadSearchDigest,
  type ThreadSearchDocument,
  type TranscriptSource,
} from "../thread-knowledge/types";

/** DO storage key for this thread's single, thread-scoped composer draft. */
const DRAFT_STORAGE_KEY = "composer:draft";

type ModelConfig = ReturnType<typeof resolveModelConfig>;

export interface ThreadRuntimeConfig {
  workspaceId: string;
  agentId: string;
  kind: "regular" | "feedback";
  modelConfig: ModelConfig;
  titleSet: boolean;
  archivedAt: number | null;
  source: "manual" | "automaton";
  backgroundWorkEnabled: boolean;
  projectContext?: ProjectPromptContext;
}

export async function resolveThreadRuntimeConfigForAgent(
  env: Env,
  threadId: string,
): Promise<ThreadRuntimeConfig | null> {
  const db = registryDb(env);
  const row = await db
    .select({
      workspaceId: threadIndex.workspaceId,
      agentId: threadIndex.agentId,
      projectId: threadIndex.projectId,
      titleSet: threadIndex.titleSet,
      archivedAt: threadIndex.archivedAt,
      source: threadIndex.source,
      kind: threadIndex.kind,
      threadModelProvider: threadIndex.modelProvider,
      threadModel: threadIndex.model,
      threadModelInputModalities: threadIndex.modelInputModalities,
      threadShowReasoning: threadIndex.showReasoning,
      threadReasoningEffort: threadIndex.reasoningEffort,
      threadModelSupportsReasoning: threadIndex.modelSupportsReasoning,
      provider: agents.provider,
      model: agents.model,
      systemPrompt: agents.systemPrompt,
      modelInputModalities: agents.modelInputModalities,
      showReasoning: agents.showReasoning,
      reasoningEffort: agents.reasoningEffort,
      modelSupportsReasoning: agents.modelSupportsReasoning,
      flagsJson: workspaces.flagsJson,
    })
    .from(threadIndex)
    .leftJoin(agents, eq(threadIndex.agentId, agents.id))
    .innerJoin(workspaces, eq(threadIndex.workspaceId, workspaces.id))
    .where(eq(threadIndex.id, threadId))
    .get();

  if (!row) return null;
  if (
    row.systemPrompt === null ||
    (row.threadModelProvider === null && row.provider === null) ||
    (row.threadModel === null && row.model === null) ||
    (row.threadModelInputModalities === null && row.modelInputModalities === null)
  ) {
    throw new Error(`thread_agent_not_registered:${threadId}:${row.agentId}`);
  }

  const useThreadSnapshot =
    isSupportedRuntimeProvider(row.threadModelProvider) &&
    row.threadModel !== null &&
    row.threadModel.trim().length > 0 &&
    hasValidStoredInputModalities(row.threadModelInputModalities);

  const provider = useThreadSnapshot ? row.threadModelProvider : row.provider;
  const model = useThreadSnapshot ? row.threadModel : row.model;
  const systemPrompt = row.systemPrompt;
  const projectContext = await resolveProjectPromptContext({
    env,
    thread: {
      threadId,
      workspaceId: row.workspaceId,
      projectId: row.projectId,
    },
  });
  const modelInputModalities = useThreadSnapshot
    ? row.threadModelInputModalities
    : row.modelInputModalities;
  if (
    provider === null ||
    model === null ||
    systemPrompt === null ||
    modelInputModalities === null
  ) {
    throw new Error(`thread_agent_not_registered:${threadId}:${row.agentId}`);
  }

  return {
    workspaceId: row.workspaceId,
    agentId: row.agentId,
    kind: row.kind,
    titleSet: row.titleSet,
    archivedAt: row.archivedAt,
    source: row.source,
    backgroundWorkEnabled: resolveWorkspaceBackgroundWork({
      deploymentEnabled: backgroundWorkEnabled(env),
      flagsJson: row.flagsJson,
    }),
    ...(projectContext ? { projectContext } : {}),
    modelConfig: resolveAgentModelConfig({
      provider,
      model,
      systemPrompt,
      modelInputModalities,
      showReasoning: useThreadSnapshot
        ? (row.threadShowReasoning ?? true)
        : (row.showReasoning ?? true),
      // The thread snapshot wins when it has one; a NULL snapshot inherits the
      // agent's, which is what pre-existing threads all do.
      // `agents` is LEFT joined, so its columns are nullable here even though
      // the column itself is NOT NULL.
      reasoningEffort:
        (useThreadSnapshot ? row.threadReasoningEffort : null) ??
        row.reasoningEffort ??
        DEFAULT_REASONING_EFFORT,
      // NULL stays NULL — unknown, not "cannot reason". Collapsing it to false
      // here would stop thinking on every thread created before this shipped.
      modelSupportsReasoning:
        (useThreadSnapshot ? row.threadModelSupportsReasoning : null) ?? row.modelSupportsReasoning,
    }),
  };
}

const MODEL_INPUT_MODALITIES = new Set(["text", "image", "audio", "video", "file"]);

function isSupportedRuntimeProvider(provider: string | null | undefined): provider is string {
  return typeof provider === "string" && SUPPORTED_RUNTIME_PROVIDERS.has(provider);
}

function hasValidStoredInputModalities(value: string | null | undefined): value is string {
  if (value === null || value === undefined) return false;
  try {
    const parsed = JSON.parse(value) as unknown;
    return (
      Array.isArray(parsed) &&
      parsed.length > 0 &&
      parsed.every((entry) => typeof entry === "string" && MODEL_INPUT_MODALITIES.has(entry))
    );
  } catch {
    return false;
  }
}

export async function buildThreadModelForWorkspace(
  env: Env,
  cfg: ReturnType<typeof resolveModelConfig>,
  workspaceId: string,
): Promise<LanguageModel> {
  // Allowlisted providers bill us, not the user, so re-check the gate here: this
  // is the last check that still applies to a thread row persisted while its
  // owner was allowlisted, and it must stop working once they are removed.
  if (isGatedProvider(cfg.provider)) {
    if (!workspaceId) {
      throw new Error(`gated_provider_workspace_id_required:${cfg.provider}`);
    }
    const ownerEmail = await new WorkspaceRepository(registryDb(env)).getOwnerEmail(workspaceId);
    if (!canUseProvider(env, cfg.provider, ownerEmail)) {
      throw new Error(`provider_not_allowed:${cfg.provider}`);
    }
  }

  // Workers AI has no workspace secret — it authenticates via the `AI` binding.
  if (cfg.provider === "workers-ai") {
    return buildModel({ ...cfg, workersAI: { binding: env.AI } });
  }

  if (!providerUsesWorkspaceSecret(cfg.provider)) {
    return buildModel(cfg);
  }

  if (!workspaceId) {
    throw new Error("workspace_provider_secret_workspace_id_required");
  }

  const providerConfig = await getProviderConfig(env, workspaceId, cfg.provider);
  const secretName = providerConfig?.secretName ?? fallbackProviderSecretName(cfg.provider);
  if (isOpenAICompatibleProvider(cfg.provider)) {
    const endpointConfig = parseProviderEndpointConfig(cfg.provider, providerConfig?.configJson);
    if (!endpointConfig.baseUrl) {
      throw new Error(`openai_compatible_base_url_missing:${cfg.provider}`);
    }
    let apiKey = "";
    if (endpointConfig.auth === "bearer") {
      const { store } = createWorkspaceSecretsServices(env);
      apiKey = (await store.get(workspaceId, secretName)) ?? "";
      if (!apiKey) {
        throw new Error(`openai_compatible_secret_missing:${cfg.provider}`);
      }
    }
    const proxy = resolveEgressProxy(env, cfg.provider, endpointConfig);
    const openAICompatible: {
      endpointConfig: typeof endpointConfig;
      proxy?: { url: string; token: string };
    } = { endpointConfig };
    if (proxy) openAICompatible.proxy = proxy;
    log.info("provider.egress_configured", {
      workspaceId,
      provider: cfg.provider,
      egressMode: proxy ? "proxy" : "direct",
      proxyConfigured: Boolean(endpointConfig.proxyUrl),
    });
    return buildModel({
      ...cfg,
      apiKey,
      openAICompatible,
    });
  }

  if (cfg.provider !== "openai-oauth") {
    const { store } = createWorkspaceSecretsServices(env);
    const apiKey = await store.get(workspaceId, secretName);
    if (!apiKey) {
      throw new Error(`workspace_provider_secret_missing:${cfg.provider}`);
    }
    return buildModel({ ...cfg, apiKey });
  }

  const auth = createWorkspaceOpenAIOAuthManager({
    env,
    workspaceId,
    secretName,
  });

  // Prefer the workspace's configured proxy route. Flip CODEX_DIRECT_ENABLED
  // to test Cloudflare Worker egress to ChatGPT's Codex backend directly.
  const endpointConfig = parseProviderEndpointConfig("openai-oauth", providerConfig?.configJson);
  const proxy = resolveEgressProxy(env, "openai-oauth", endpointConfig);
  const openaiOAuth: {
    auth: typeof auth;
    logContext: Record<string, string>;
    proxy?: { url: string; token: string };
  } = {
    auth,
    logContext: { workspaceId },
  };
  if (proxy) openaiOAuth.proxy = proxy;
  log.info("provider.egress_configured", {
    workspaceId,
    provider: "openai-oauth",
    egressMode: proxy ? "proxy" : "direct",
    directEnabled: isTruthyFlag(env.CODEX_DIRECT_ENABLED),
    proxyConfigured: Boolean(endpointConfig.proxyUrl),
  });

  return buildModel({
    ...cfg,
    openaiOAuth,
  });
}

export class ThreadAgentV2 extends AIChatAgent<Env> {
  private async resolveRuntimeConfig(): Promise<ThreadRuntimeConfig> {
    const config = await resolveThreadRuntimeConfigForAgent(this.env, this.name);
    if (!config) {
      throw new Error(`thread_workspace_not_registered:${this.name}`);
    }
    return config;
  }

  private async resolveWorkspaceId(): Promise<string> {
    return (await this.resolveRuntimeConfig()).workspaceId;
  }

  async resolveWorkspaceIdForTest(): Promise<string> {
    return this.resolveWorkspaceId();
  }

  /** @internal for tests only */
  async resolveRuntimeConfigForTest(): Promise<ThreadRuntimeConfig> {
    return this.resolveRuntimeConfig();
  }

  /**
   * Reports whether a chat turn is currently in flight. The delete route calls
   * this over RPC and refuses to destroy a thread mid-stream: a DO is a single
   * global instance, so this stub routes to the same isolate running the turn,
   * making it the authoritative check. (`_activeRequestId` is the SDK's
   * protected view of the resumable stream's active request.)
   */
  hasActiveTurn(): boolean {
    return this._activeRequestId !== null;
  }

  /**
   * Return this thread's persisted messages (same content the SDK's
   * `/get-messages` route serves). The archive routine calls this over RPC to
   * snapshot history to D1 before destroying the DO.
   */
  async exportHistory() {
    return this.messages;
  }

  private legacyTranscriptRows(): Array<RawTranscriptStat & { raw: unknown }> {
    return this.messages.flatMap((raw, position) => {
      const id = rawMessageId(raw, position);
      if (id.startsWith("compaction_")) return [];
      return [{ id, position, bytes: rawMessageBytes(raw), raw }];
    });
  }

  private legacyTranscriptSource(): TranscriptSource {
    return {
      listStats: async (input) => {
        const rows = this.legacyTranscriptRows().map(({ raw: _raw, ...stat }) => stat);
        return pageTranscriptStats(rows, input);
      },
      getMessage: async (id) =>
        this.legacyTranscriptRows().find((row) => row.id === id)?.raw ?? null,
    };
  }

  async readThreadProsePage(input: InternalReadRequest): Promise<InternalReadResult> {
    return readTranscriptPage(this.legacyTranscriptSource(), input);
  }

  async grepThreadProse(input: InternalGrepRequest): Promise<InternalGrepResult> {
    return grepTranscript(this.legacyTranscriptSource(), input);
  }

  async listThreadSearchDigests(input: { afterPosition?: number; limit: number }): Promise<{
    digests: ThreadSearchDigest[];
    nextPosition?: number;
    lastMessagePreview: string;
  }> {
    const rows = pageTranscriptStats(this.legacyTranscriptRows(), {
      ...(input.afterPosition === undefined ? {} : { afterPosition: input.afterPosition }),
      order: "chronological",
      limit: capDigestLimit(input.limit),
    });
    const digests: ThreadSearchDigest[] = [];
    let lastMessagePreview = "";
    for (const row of rows.stats) {
      const raw = "raw" in row ? row.raw : null;
      const normalized = normalizeProseMessage(raw);
      if (normalized.message !== null) {
        lastMessagePreview = previewText(normalized.message.text);
      }
      digests.push({
        messageId: row.id,
        sourceHash: await sourceHash(raw),
        indexable: normalized.message !== null,
      });
    }
    return {
      digests,
      ...(rows.nextPosition === undefined ? {} : { nextPosition: rows.nextPosition }),
      lastMessagePreview,
    };
  }

  async getThreadSearchDocuments(messageIds: string[]): Promise<ThreadSearchDocument[]> {
    const byId = new Map(this.legacyTranscriptRows().map((row) => [row.id, row.raw]));
    const documents: ThreadSearchDocument[] = [];
    for (const messageId of messageIds.slice(0, THREAD_PROJECTION_DOCUMENT_BATCH)) {
      const raw = byId.get(messageId) ?? null;
      const normalized = normalizeProseMessage(raw);
      if (normalized.message === null) continue;
      documents.push({
        message: normalized.message,
        sourceHash: await sourceHash(raw),
      });
    }
    return documents;
  }

  /**
   * Legacy runtime startup is intentionally inert. New threads are Think-only;
   * legacy Durable Objects remain bound only so existing rows can load enough
   * state for read/delete/draft cleanup without continuing feature parity work.
   */
  async onStart(): Promise<void> {}

  async onChatMessage(
    _onFinish: StreamTextOnFinishCallback<ToolSet>,
    _options?: OnChatMessageOptions,
  ): Promise<Response | undefined> {
    return Response.json(
      {
        error: "legacy_thread_runtime_unavailable",
        message: "This legacy thread runtime is no longer supported. Start a new Think thread.",
      },
      { status: 410 },
    );
  }

  /** Read this thread's saved composer draft (empty string when none). */
  async getDraft(): Promise<string> {
    return (await this.ctx.storage.get<string>(DRAFT_STORAGE_KEY)) ?? "";
  }

  /** Save the composer draft; whitespace-only text clears it (no blank rows). */
  async setDraft(text: string): Promise<void> {
    if (text.trim() === "") {
      await this.ctx.storage.delete(DRAFT_STORAGE_KEY);
    } else {
      await this.ctx.storage.put(DRAFT_STORAGE_KEY, text);
    }
  }

  /** Minimal host wiring retained for legacy compute cleanup/delete paths. */
  private sandboxHostDeps(): ComputeToolHostDeps {
    return {
      env: this.env,
      threadId: this.name,
      storage: this.ctx.storage,
      supportsProcessMonitor: false,
      resolveRuntimeConfig: async () => {
        const config = await this.resolveRuntimeConfig();
        return { workspaceId: config.workspaceId, agentId: config.agentId };
      },
      scheduleEviction: (timestampMs) =>
        scheduleComputeEviction(
          {
            storage: this.ctx.storage,
            schedule: (when, callback) => this.schedule(when, callback as keyof this),
            cancelSchedule: (id) => this.cancelSchedule(id),
          },
          timestampMs,
          "runSandboxEviction",
        ),
      cancelEviction: () =>
        cancelComputeEviction({
          storage: this.ctx.storage,
          cancelSchedule: (id) => this.cancelSchedule(id),
        }),
      deliverSystemReminder: async () => {},
      serializeCreation: (fn) => this.ctx.blockConcurrencyWhile(fn),
    };
  }

  override async destroy(): Promise<void> {
    await teardownThreadBeforeDestroy({
      threadId: this.name,
      logPrefix: "thread",
      resolveComputeService: () => resolveComputeService(this.sandboxHostDeps()),
    });
    await super.destroy();
  }

  /** Legacy alarm callback retained only to finish compute cleanup for old threads. */
  async runSandboxEviction(): Promise<void> {
    try {
      const resolved = await resolveComputeService(this.sandboxHostDeps());
      if (!resolved) return;
      await resolved.service.runComputeTick();
    } catch (error) {
      log.warn("thread.sandbox_eviction_failed", {
        threadId: this.name,
        error: String(error),
      });
    }
  }
}

function rawMessageId(raw: unknown, position: number): string {
  if (typeof raw === "object" && raw !== null && typeof (raw as { id?: unknown }).id === "string") {
    return (raw as { id: string }).id;
  }
  return `legacy:${position}`;
}

function rawMessageBytes(raw: unknown): number {
  return new TextEncoder().encode(JSON.stringify(raw)).byteLength;
}

function pageTranscriptStats<T extends RawTranscriptStat>(
  stats: T[],
  input: { afterPosition?: number; order: ThreadOrder; limit: number },
): { stats: T[]; nextPosition?: number } {
  const ordered =
    input.order === "chronological" ? stats : [...stats].sort((a, b) => b.position - a.position);
  const afterIndex =
    input.afterPosition === undefined
      ? -1
      : ordered.findIndex((stat) => stat.position === input.afterPosition);
  const start = afterIndex < 0 ? 0 : afterIndex + 1;
  const page = ordered.slice(start, start + input.limit);
  const last = page.at(-1);
  const hasMore = ordered.length > start + page.length;
  return {
    stats: page,
    ...(hasMore && last !== undefined ? { nextPosition: last.position } : {}),
  };
}

function capDigestLimit(limit: number): number {
  return Math.min(Math.max(Math.floor(limit), 1), THREAD_PROJECTION_DIGEST_PAGE);
}

function previewText(text: string): string {
  return text.slice(0, THREAD_LAST_MESSAGE_PREVIEW_CHARS);
}

async function sourceHash(raw: unknown): Promise<string> {
  const bytes = new TextEncoder().encode(JSON.stringify(raw));
  return sha256Hex(bytes.buffer);
}

export type ThreadAgent = ThreadAgentV2;

// Apply @callable() decorators manually (TC39-compatible runtime registration),
// mirroring WorkspaceMcpAgent. Exposes the draft methods to the web client RPC.
callable()(ThreadAgentV2.prototype.getDraft, null as unknown as ClassMethodDecoratorContext);
callable()(ThreadAgentV2.prototype.setDraft, null as unknown as ClassMethodDecoratorContext);
callable()(ThreadAgentV2.prototype.exportHistory, null as unknown as ClassMethodDecoratorContext);
callable()(
  ThreadAgentV2.prototype.readThreadProsePage,
  null as unknown as ClassMethodDecoratorContext,
);
callable()(ThreadAgentV2.prototype.grepThreadProse, null as unknown as ClassMethodDecoratorContext);
callable()(
  ThreadAgentV2.prototype.listThreadSearchDigests,
  null as unknown as ClassMethodDecoratorContext,
);
callable()(
  ThreadAgentV2.prototype.getThreadSearchDocuments,
  null as unknown as ClassMethodDecoratorContext,
);

export function fallbackProviderSecretName(provider: string): string {
  return `provider:${provider}`;
}
