import { createAnthropic } from "@ai-sdk/anthropic";
import { createOpenAI } from "@ai-sdk/openai";
import { createOpenRouter } from "@openrouter/ai-sdk-provider";
import { createWorkersAI } from "workers-ai-provider";
import type { LanguageModel } from "ai";
import { simulateReadableStream } from "ai";
import { MockLanguageModelV3 } from "ai/test";
import type { ProviderEndpointConfig } from "../db/repositories/provider-configs";
import { createOpenAICompatibleModel } from "./openai-compatible";
import { createOpenAIOAuthModel } from "./openai-oauth";
import type { OpenAIOAuthAuthManager } from "./openai-oauth";

export function buildModel(input: {
  provider: string;
  model: string;
  apiKey: string;
  openaiOAuth?: {
    auth: OpenAIOAuthAuthManager;
    fetch?: typeof fetch;
    logContext?: Record<string, string>;
    proxy?: { url: string; token: string };
  };
  openAICompatible?: {
    endpointConfig: ProviderEndpointConfig;
    fetch?: typeof fetch;
    proxy?: { url: string; token: string };
  };
  workersAI?: {
    binding: Ai;
  };
}): LanguageModel {
  const { provider, model, apiKey } = input;

  if (provider === "openai") {
    return createOpenAI({ apiKey })(model);
  }

  if (provider === "workers-ai") {
    // Authenticated by the binding, not an API key — the caller must supply it.
    // Check the binding itself, not just the options object: an env without the
    // `AI` binding yields `{ binding: undefined }`, which is truthy and would
    // otherwise surface as an opaque error from inside the provider package.
    const binding = input.workersAI?.binding;
    if (!binding) {
      throw new Error("workers_ai_binding_required");
    }
    return createWorkersAI({ binding })(model);
  }

  if (provider === "anthropic") {
    return createAnthropic({ apiKey })(model);
  }

  if (provider === "openrouter") {
    return createOpenRouter({ apiKey })(model);
  }

  if (provider === "openai-oauth") {
    if (!input.openaiOAuth) {
      throw new Error("openai_oauth_options_required");
    }
    const oauthInput: {
      model: string;
      auth: OpenAIOAuthAuthManager;
      fetch?: typeof fetch;
      logContext?: Record<string, string>;
      proxy?: { url: string; token: string };
    } = {
      model,
      auth: input.openaiOAuth.auth,
    };
    if (input.openaiOAuth.fetch !== undefined) oauthInput.fetch = input.openaiOAuth.fetch;
    if (input.openaiOAuth.logContext !== undefined)
      oauthInput.logContext = input.openaiOAuth.logContext;
    if (input.openaiOAuth.proxy !== undefined) oauthInput.proxy = input.openaiOAuth.proxy;
    return createOpenAIOAuthModel(oauthInput);
  }

  if (
    provider === "deepseek" ||
    provider === "zai" ||
    provider === "qwen" ||
    provider === "opencode-go" ||
    provider === "opencode-zen" ||
    provider === "openai-compatible"
  ) {
    if (!input.openAICompatible) {
      throw new Error(`openai_compatible_options_required:${provider}`);
    }
    const compatibleInput: {
      provider: string;
      model: string;
      apiKey: string;
      endpointConfig: ProviderEndpointConfig;
      fetch?: typeof fetch;
      proxy?: { url: string; token: string };
    } = {
      provider,
      model,
      apiKey,
      endpointConfig: input.openAICompatible.endpointConfig,
    };
    if (input.openAICompatible.fetch !== undefined) {
      compatibleInput.fetch = input.openAICompatible.fetch;
    }
    if (input.openAICompatible.proxy !== undefined) {
      compatibleInput.proxy = input.openAICompatible.proxy;
    }
    return createOpenAICompatibleModel(compatibleInput);
  }

  if (provider === "mock-tool-call") {
    // Emits a single tool-call for "demo_tool" then finishes — used in DO-persistence approval tests.
    return new MockLanguageModelV3({
      provider: "mock",
      modelId: "mock-tool-call",
      doStream: async () => ({
        stream: simulateReadableStream({
          initialDelayInMs: null,
          chunkDelayInMs: null,
          chunks: [
            {
              type: "tool-call" as const,
              toolCallId: "tc-approval-1",
              toolName: "demo_tool",
              input: '{"action":"test"}',
            },
            {
              type: "finish" as const,
              finishReason: { unified: "tool-calls" as const, raw: "tool_calls" },
              usage: {
                inputTokens: { total: 10, noCache: 10, cacheRead: 0, cacheWrite: 0 },
                outputTokens: { total: 5, text: 5, reasoning: 0 },
              },
            },
          ],
        }),
        rawCall: { rawPrompt: null, rawSettings: {} },
      }),
    }) as unknown as LanguageModel;
  }

  if (provider === "mock-tool-loop") {
    // Drives the run-loop to its step budget: as long as tools are available for
    // the step, emit a tool-call (forcing another step); once the wind-down step
    // sets activeTools:[] (so options.tools is empty), emit a text summary and
    // finish with "stop". A closure counter gives each tool-call a unique id —
    // buildModel runs once per turn, so the counter persists across that turn's
    // steps. Used by the wind-down integration test.
    let step = 0;
    return new MockLanguageModelV3({
      provider: "mock",
      modelId: "mock-tool-loop",
      doStream: async (options) => {
        const toolsAvailable = Array.isArray(options.tools) && options.tools.length > 0;
        if (toolsAvailable) {
          return {
            stream: simulateReadableStream({
              initialDelayInMs: null,
              chunkDelayInMs: null,
              chunks: [
                {
                  type: "tool-call" as const,
                  toolCallId: `tc-loop-${step++}`,
                  toolName: "demo_tool",
                  input: '{"action":"loop"}',
                },
                {
                  type: "finish" as const,
                  finishReason: { unified: "tool-calls" as const, raw: "tool_calls" },
                  usage: {
                    inputTokens: { total: 10, noCache: 10, cacheRead: 0, cacheWrite: 0 },
                    outputTokens: { total: 5, text: 5, reasoning: 0 },
                  },
                },
              ],
            }),
            rawCall: { rawPrompt: null, rawSettings: {} },
          };
        }
        return {
          stream: simulateReadableStream({
            initialDelayInMs: null,
            chunkDelayInMs: null,
            chunks: [
              { type: "text-start" as const, id: "summary" },
              {
                type: "text-delta" as const,
                id: "summary",
                delta: "Reached the tool-call limit; here is the summary.",
              },
              { type: "text-end" as const, id: "summary" },
              {
                type: "finish" as const,
                finishReason: { unified: "stop" as const, raw: "stop" },
                usage: {
                  inputTokens: { total: 1, noCache: 1, cacheRead: 0, cacheWrite: 0 },
                  outputTokens: { total: 5, text: 5, reasoning: 0 },
                },
              },
            ],
          }),
          rawCall: { rawPrompt: null, rawSettings: {} },
        };
      },
    }) as unknown as LanguageModel;
  }

  if (provider === "mock-reasoning") {
    // Emits a reasoning summary part (with text) then a text answer — exercises
    // the reasoning persistence path (sanitizeMessage keeps non-empty reasoning).
    return new MockLanguageModelV3({
      provider: "mock",
      modelId: "mock-reasoning",
      doStream: async () => ({
        stream: simulateReadableStream({
          initialDelayInMs: null,
          chunkDelayInMs: null,
          chunks: [
            { type: "reasoning-start" as const, id: "r1" },
            { type: "reasoning-delta" as const, id: "r1", delta: "Considering the request" },
            { type: "reasoning-end" as const, id: "r1" },
            { type: "text-start" as const, id: "1" },
            { type: "text-delta" as const, id: "1", delta: "Done." },
            { type: "text-end" as const, id: "1" },
            {
              type: "finish" as const,
              finishReason: { unified: "stop" as const, raw: "stop" },
              usage: {
                inputTokens: { total: 1, noCache: 1, cacheRead: 0, cacheWrite: 0 },
                outputTokens: { total: 2, text: 1, reasoning: 1 },
              },
            },
          ],
        }),
        rawCall: { rawPrompt: null, rawSettings: {} },
      }),
    }) as unknown as LanguageModel;
  }

  if (provider === "mock") {
    return new MockLanguageModelV3({
      provider: "mock",
      modelId: "mock",
      doStream: async (options) => {
        // Find the last user message text from the prompt.
        const prompt = options.prompt;
        let lastUserText = "";
        for (let i = prompt.length - 1; i >= 0; i--) {
          const msg = prompt[i];
          if (msg !== undefined && msg.role === "user") {
            for (const part of msg.content) {
              if (part.type === "text") {
                lastUserText = part.text;
                break;
              }
            }
            break;
          }
        }
        const echoText = `Echo: ${lastUserText}`;
        return {
          stream: simulateReadableStream({
            initialDelayInMs: null,
            chunkDelayInMs: null,
            chunks: [
              { type: "text-start" as const, id: "1" },
              { type: "text-delta" as const, id: "1", delta: echoText },
              { type: "text-end" as const, id: "1" },
              {
                type: "finish" as const,
                finishReason: { unified: "stop" as const, raw: "stop" },
                usage: {
                  inputTokens: { total: 1, noCache: 1, cacheRead: 0, cacheWrite: 0 },
                  outputTokens: { total: 1, text: 1, reasoning: 0 },
                },
              },
            ],
          }),
        };
      },
      // double-cast: MockLanguageModelV3 from ai/test does not match ai's LanguageModel union type
    }) as unknown as LanguageModel;
  }

  throw new Error("unsupported_provider");
}
