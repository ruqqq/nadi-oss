import type { Env } from "../env";
import type { AgentConfig } from "../db/schema";
import {
  DEFAULT_REASONING_EFFORT,
  parseReasoningEffort,
  type ReasoningEffort,
} from "./reasoning-options";
import type { ProviderConfigProvider } from "../db/repositories/provider-configs";

export const DEFAULT_SYSTEM_PROMPT = "You are Nadi, a helpful AI assistant. Be concise and clear.";

export const SUPPORTED_MODEL_PROVIDERS: Record<string, true> = {
  openai: true,
  anthropic: true,
  openrouter: true,
  "openai-oauth": true,
  // Authenticated by the `AI` binding, not a workspace secret — so it is
  // deliberately absent from WORKSPACE_SECRET_PROVIDERS below.
  "workers-ai": true,
  deepseek: true,
  zai: true,
  qwen: true,
  "opencode-go": true,
  "opencode-zen": true,
  "openai-compatible": true,
  mock: true,
  "mock-tool-call": true,
  "mock-tool-loop": true,
  "mock-reasoning": true,
};

export const WORKSPACE_SECRET_PROVIDERS: Record<string, true> = {
  openai: true,
  anthropic: true,
  openrouter: true,
  "openai-oauth": true,
  deepseek: true,
  zai: true,
  qwen: true,
  "opencode-go": true,
  "opencode-zen": true,
  "openai-compatible": true,
};

/**
 * Providers accepted on a *persisted* thread/agent row when rehydrating its
 * model snapshot. Lives here, not in thread-agent, so it stays importable
 * outside the Durable Object runtime (and so all three provider allowlists sit
 * together). Includes the mock providers, which tests persist.
 */
export const SUPPORTED_RUNTIME_PROVIDERS = new Set([
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
  "mock",
  "mock-tool-call",
  "mock-tool-loop",
  "mock-reasoning",
]);

export function resolveModelConfig(env: Env): ResolvedModelConfig {
  return resolveModelConfigInput(
    {
      provider: env.DEFAULT_MODEL_PROVIDER,
      model: env.DEFAULT_MODEL,
      systemPrompt: DEFAULT_SYSTEM_PROMPT,
      modelInputModalities: ["text"],
      showReasoning: true,
      reasoningEffort: DEFAULT_REASONING_EFFORT,
      modelSupportsReasoning: undefined,
    },
    "DEFAULT_MODEL_PROVIDER",
  );
}

export interface ResolvedModelConfig {
  provider: string;
  model: string;
  apiKey: string;
  systemPrompt: string;
  modelInputModalities: string[];
  /** Display only: whether the thinking text is rendered. */
  showReasoning: boolean;
  /** How hard to think. Independent of showReasoning. */
  reasoningEffort: ReasoningEffort;
  /** `undefined` = unknown; only an explicit `false` withholds reasoning. */
  modelSupportsReasoning: boolean | undefined;
}

export function resolveAgentModelConfig(
  agent: Pick<
    AgentConfig,
    | "provider"
    | "model"
    | "systemPrompt"
    | "modelInputModalities"
    | "showReasoning"
    | "reasoningEffort"
    | "modelSupportsReasoning"
  >,
): ResolvedModelConfig {
  return resolveModelConfigInput(
    {
      ...agent,
      modelInputModalities: parseStoredModelInputModalities(agent.modelInputModalities),
      reasoningEffort: parseReasoningEffort(agent.reasoningEffort) ?? DEFAULT_REASONING_EFFORT,
      modelSupportsReasoning: agent.modelSupportsReasoning ?? undefined,
    },
    "agents.provider",
  );
}

function resolveModelConfigInput(
  input: {
    provider: string;
    model: string;
    systemPrompt: string;
    modelInputModalities: string[];
    showReasoning: boolean;
    reasoningEffort: ReasoningEffort;
    modelSupportsReasoning: boolean | undefined;
  },
  providerSource: string,
): ResolvedModelConfig {
  const provider = input.provider;
  if (!(provider in SUPPORTED_MODEL_PROVIDERS)) {
    throw new Error(
      `Unknown model provider "${provider}". Must be one of: ${Object.keys(SUPPORTED_MODEL_PROVIDERS).join(", ")}. Check ${providerSource}.`,
    );
  }
  return {
    provider,
    model: input.model,
    apiKey: "",
    systemPrompt: input.systemPrompt,
    modelInputModalities: input.modelInputModalities,
    showReasoning: input.showReasoning,
    reasoningEffort: input.reasoningEffort,
    modelSupportsReasoning: input.modelSupportsReasoning,
  };
}

export function providerUsesWorkspaceSecret(provider: string): provider is ProviderConfigProvider {
  return provider in WORKSPACE_SECRET_PROVIDERS;
}

function parseStoredModelInputModalities(value: string | null | undefined): string[] {
  if (!value) return ["text"];
  try {
    const parsed = JSON.parse(value) as unknown;
    if (!Array.isArray(parsed)) return ["text"];
    const modalities = parsed.filter((entry): entry is string => {
      return (
        entry === "text" ||
        entry === "image" ||
        entry === "audio" ||
        entry === "video" ||
        entry === "file"
      );
    });
    return modalities.length > 0 ? Array.from(new Set(modalities)) : ["text"];
  } catch {
    return ["text"];
  }
}
