/**
 * Per-thread agent configuration: resolve a thread's workspace/agent/model from
 * D1, and build the provider-bound LanguageModel that turn will run against.
 *
 * This file used to also define `ThreadAgentV2`, the original chat Durable
 * Object. That class is gone; ThinkThreadAgent is the only chat runtime. What
 * remains is the configuration layer both it and SubAgent share.
 */
import { type LanguageModel } from "ai";
import { eq } from "drizzle-orm";
import type { Env } from "../env";
import {
  backgroundWorkEnabled,
  isTruthyFlag,
  resolveWorkspaceBackgroundCapabilities,
} from "../flags";
import { resolveEgressProxy } from "../providers/egress-proxy";
import { canUseProvider, isGatedProvider, providerBindingMissing } from "../auth/provider-gate";
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
type ModelConfig = ReturnType<typeof resolveModelConfig>;

export interface ThreadRuntimeConfig {
  workspaceId: string;
  agentId: string;
  kind: "regular" | "feedback";
  modelConfig: ModelConfig;
  titleSet: boolean;
  archivedAt: number | null;
  source: "manual" | "automaton";
  /** The two background capabilities, resolved independently — see
   *  `resolveWorkspaceBackgroundCapabilities`. Pinned for the whole turn so
   *  every tool in it sees one capability surface. */
  backgroundExecEnabled: boolean;
  subagentsEnabled: boolean;
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
      threadReasoningEffort: threadIndex.reasoningEffort,
      threadModelSupportsReasoning: threadIndex.modelSupportsReasoning,
      provider: agents.provider,
      model: agents.model,
      systemPrompt: agents.systemPrompt,
      modelInputModalities: agents.modelInputModalities,
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
    ...(() => {
      const capabilities = resolveWorkspaceBackgroundCapabilities({
        deploymentEnabled: backgroundWorkEnabled(env),
        flagsJson: row.flagsJson,
      });
      return {
        backgroundExecEnabled: capabilities.backgroundExec,
        subagentsEnabled: capabilities.subagents,
      };
    })(),
    ...(projectContext ? { projectContext } : {}),
    modelConfig: resolveAgentModelConfig({
      provider,
      model,
      systemPrompt,
      modelInputModalities,
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
    // Distinguish the two denials: a missing binding is a deployment problem
    // and must not be reported as an allowlist decision, or the operator debugs
    // the wrong thing.
    if (providerBindingMissing(env, cfg.provider)) {
      throw new Error("workers_ai_binding_required");
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

export function fallbackProviderSecretName(provider: string): string {
  return `provider:${provider}`;
}
