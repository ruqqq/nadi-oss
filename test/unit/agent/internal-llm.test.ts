import { describe, expect, it, vi } from "vitest";
import { MockLanguageModelV3 } from "ai/test";
import { generateInternalText, INTERNAL_FALLBACK_MODEL } from "../../../src/agent/internal-llm";
import type { Env } from "../../../src/env";

/**
 * These calls are OURS (compaction summaries, thread auto-naming), not the
 * user's turn. Two production failures drive this module, and each has a test:
 *
 *  - `generateText` (non-streaming) is not served by every provider — the
 *    openai-oauth/codex backend returns "Invalid JSON response" for it. A thread
 *    whose model cannot serve the summarizer can NEVER compact; it just grows
 *    until the provider rejects it.
 *  - So a failing thread model must fall back, not give up — but the ledger
 *    must attribute that call to the FALLBACK model, not the thread's model,
 *    since the fallback is a different model entirely.
 */

const buildModelMock = vi.hoisted(() => vi.fn());
vi.mock("../../../src/providers/model-factory", () => ({
  buildModel: (opts: unknown) => buildModelMock(opts),
}));

function v3Usage(opts: {
  inputTokens?: number;
  outputTokens?: number;
  cacheReadTokens?: number;
  cacheWriteTokens?: number;
}) {
  return {
    inputTokens: {
      total: opts.inputTokens,
      noCache: undefined,
      cacheRead: opts.cacheReadTokens,
      cacheWrite: opts.cacheWriteTokens,
    },
    outputTokens: {
      total: opts.outputTokens,
      text: undefined,
      reasoning: undefined,
    },
  };
}

function okModel(
  text: string,
  usage: ReturnType<typeof v3Usage> = v3Usage({ inputTokens: 0, outputTokens: 0 }),
) {
  return new MockLanguageModelV3({
    doStream: async () => ({
      stream: new ReadableStream({
        start(controller) {
          controller.enqueue({ type: "text-start", id: "0" });
          controller.enqueue({ type: "text-delta", id: "0", delta: text });
          controller.enqueue({ type: "text-end", id: "0" });
          controller.enqueue({
            type: "finish",
            finishReason: { unified: "stop", raw: undefined },
            usage,
          });
          controller.close();
        },
      }),
    }),
  });
}

function failingModel(message: string) {
  return new MockLanguageModelV3({
    doStream: async () => {
      throw new Error(message);
    },
  });
}

const env = {} as Env;

describe("generateInternalText", () => {
  it("returns the usage and the primary model that served the call", async () => {
    const result = await generateInternalText({
      env,
      purpose: "test",
      primaryProvider: "anthropic",
      primaryModel: "claude-sonnet-5",
      buildPrimary: async () => okModel("a title", v3Usage({ inputTokens: 120, outputTokens: 4 })),
      system: "s",
      prompt: "p",
    });

    expect(result.text).toBe("a title");
    expect(result.provider).toBe("anthropic");
    expect(result.model).toBe("claude-sonnet-5");
    expect(result.usedFallback).toBe(false);
    expect(result.usage.inputTokens).toBe(120);
    expect(result.usage.outputTokens).toBe(4);
  });

  // A live probe (Task 1) proved cache-write tokens arrive on
  // `usage.inputTokenDetails.cacheWriteTokens` — dropping that field while
  // mapping the SDK's usage into our StepUsage would silently zero cache-write
  // accounting for every compaction.
  it("carries inputTokenDetails.cacheWriteTokens through to the mapped usage", async () => {
    const result = await generateInternalText({
      env,
      purpose: "test",
      primaryProvider: "anthropic",
      primaryModel: "claude-sonnet-5",
      buildPrimary: async () =>
        okModel(
          "hi",
          v3Usage({ inputTokens: 30, outputTokens: 2, cacheReadTokens: 5, cacheWriteTokens: 25 }),
        ),
      system: "s",
      prompt: "p",
    });

    expect(result.usage.inputTokenDetails?.cacheWriteTokens).toBe(25);
    expect(result.usage.inputTokenDetails?.cacheReadTokens).toBe(5);
  });

  it("attributes a fallback call to the FALLBACK model, not the thread's model", async () => {
    // No AI binding on env => the fallback cannot run either; assert the
    // primary failure still yields a well-formed, zeroed result rather than a throw.
    buildModelMock.mockReset();

    const result = await generateInternalText({
      env,
      purpose: "test",
      primaryProvider: "anthropic",
      primaryModel: "claude-sonnet-5",
      buildPrimary: async () => {
        throw new Error("primary is down");
      },
      system: "s",
      prompt: "p",
    });

    expect(result.text).toBe("");
    expect(result.usage.inputTokens ?? 0).toBe(0);
    expect(result.usedFallback).toBe(false);
    expect(buildModelMock).not.toHaveBeenCalled();
  });

  // The production bug: codex/openai-oauth cannot serve the call at all.
  it("falls back to a keyless Workers AI model, attributing usage+model to the fallback", async () => {
    buildModelMock
      .mockReset()
      .mockReturnValue(okModel("fallback summary", v3Usage({ inputTokens: 50, outputTokens: 10 })));
    const envWithAi = { AI: {} } as unknown as Env;

    const result = await generateInternalText({
      env: envWithAi,
      purpose: "compaction_summary",
      primaryProvider: "openai-oauth",
      primaryModel: "gpt-5.3-codex-spark",
      buildPrimary: async () => failingModel("AI_APICallError: Invalid JSON response"),
      system: "sys",
      prompt: "p",
    });

    expect(result.text).toBe("fallback summary");
    expect(result.provider).toBe("workers-ai");
    expect(result.model).toBe(INTERNAL_FALLBACK_MODEL);
    expect(result.usedFallback).toBe(true);
    expect(result.usage.inputTokens).toBe(50);
    expect(result.usage.outputTokens).toBe(10);
    expect(buildModelMock).toHaveBeenCalledWith(
      expect.objectContaining({ provider: "workers-ai", model: INTERNAL_FALLBACK_MODEL }),
    );
  });

  it("falls back when the thread's model returns nothing usable", async () => {
    buildModelMock
      .mockReset()
      .mockReturnValue(okModel("ok", v3Usage({ inputTokens: 5, outputTokens: 1 })));
    const envWithAi = { AI: {} } as unknown as Env;

    const result = await generateInternalText({
      env: envWithAi,
      purpose: "thread_auto_name",
      primaryProvider: "weak",
      primaryModel: "model",
      buildPrimary: async () => okModel("   "),
      system: "sys",
      prompt: "p",
    });

    expect(result.text).toBe("ok");
    expect(result.usedFallback).toBe(true);
  });

  // The primary RAN. It streamed nothing usable, but its (possibly ~100k-token)
  // input was billed. Reporting only the fallback's usage loses that spend
  // forever — tokens never written down cannot be backfilled.
  it("reports BOTH attempts when an empty primary falls back — each against the model that ran it", async () => {
    buildModelMock
      .mockReset()
      .mockReturnValue(okModel("summary", v3Usage({ inputTokens: 50, outputTokens: 10 })));
    const envWithAi = { AI: {} } as unknown as Env;

    const result = await generateInternalText({
      env: envWithAi,
      purpose: "compaction_summary",
      primaryProvider: "openai-oauth",
      primaryModel: "gpt-5.3-codex-spark",
      buildPrimary: async () => okModel("", v3Usage({ inputTokens: 98_000, outputTokens: 0 })),
      system: "sys",
      prompt: "p",
    });

    expect(result.usedFallback).toBe(true);
    expect(result.attempts).toEqual([
      {
        provider: "openai-oauth",
        model: "gpt-5.3-codex-spark",
        usage: expect.objectContaining({ inputTokens: 98_000 }),
      },
      {
        provider: "workers-ai",
        model: INTERNAL_FALLBACK_MODEL,
        usage: expect.objectContaining({ inputTokens: 50, outputTokens: 10 }),
      },
    ]);
  });

  it("still reports the primary's spend when there is no fallback binding to run", async () => {
    const result = await generateInternalText({
      env,
      purpose: "compaction_summary",
      primaryProvider: "openai-oauth",
      primaryModel: "gpt-5.3-codex-spark",
      buildPrimary: async () => okModel("", v3Usage({ inputTokens: 4_200, outputTokens: 0 })),
      system: "sys",
      prompt: "p",
    });

    expect(result.text).toBe("");
    expect(result.attempts).toHaveLength(1);
    expect(result.attempts[0]).toMatchObject({
      provider: "openai-oauth",
      usage: expect.objectContaining({ inputTokens: 4_200 }),
    });
  });

  it("reports NO attempts when no provider was ever reached — a call that never ran is not a call", async () => {
    buildModelMock.mockReset();
    const result = await generateInternalText({
      env,
      purpose: "thread_auto_name",
      primaryProvider: "anthropic",
      primaryModel: "claude-sonnet-5",
      buildPrimary: async () => {
        throw new Error("primary is down");
      },
      system: "s",
      prompt: "p",
    });

    expect(result.attempts).toEqual([]);
  });

  // Both failing must return a zeroed result — not throw: the CALLER decides
  // what an empty result means (auto-naming has a heuristic title; compaction
  // reports a real failure). Throwing here would resurrect the bug where a
  // failed summarizer surfaced to the user as "Nothing to compact yet."
  it("returns a zeroed result — not a throw — when the fallback also fails", async () => {
    buildModelMock.mockReset().mockReturnValue(failingModel("fallback down"));
    const envWithAi = { AI: {} } as unknown as Env;

    const result = await generateInternalText({
      env: envWithAi,
      purpose: "compaction_summary",
      primaryProvider: "x",
      primaryModel: "y",
      buildPrimary: async () => failingModel("primary down"),
      system: "sys",
      prompt: "p",
    });

    expect(result.text).toBe("");
    expect(result.usage.inputTokens ?? 0).toBe(0);
    expect(result.provider).toBe("x");
    expect(result.model).toBe("y");
    expect(result.usedFallback).toBe(false);
  });

  it("returns a zeroed result when there is no AI binding to fall back to", async () => {
    buildModelMock.mockReset();

    const result = await generateInternalText({
      env: {} as unknown as Env,
      purpose: "compaction_summary",
      primaryProvider: "x",
      primaryModel: "y",
      buildPrimary: async () => failingModel("primary down"),
      system: "sys",
      prompt: "p",
    });

    expect(result.text).toBe("");
    expect(buildModelMock).not.toHaveBeenCalled();
  });
});
