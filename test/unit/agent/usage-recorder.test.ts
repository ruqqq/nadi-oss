import { describe, expect, it } from "vitest";
import {
  TurnUsageAccumulator,
  cacheWriteTokensFrom,
  contextTokensFromUsage,
} from "../../../src/agent/usage-recorder";

const KEY = { provider: "anthropic", model: "claude-sonnet-5", source: "chat" } as const;

describe("TurnUsageAccumulator", () => {
  it("starts empty", () => {
    const acc = new TurnUsageAccumulator();
    expect(acc.isEmpty()).toBe(true);
    expect(acc.entries()).toEqual([]);
    expect(acc.context()).toBeNull();
  });

  it("sums usage across the steps of a tool loop into one entry", () => {
    const acc = new TurnUsageAccumulator();
    acc.add(KEY, { inputTokens: 100, outputTokens: 10, cachedInputTokens: 0 });
    acc.add(KEY, { inputTokens: 150, outputTokens: 20, cachedInputTokens: 90 });
    acc.add(KEY, { inputTokens: 200, outputTokens: 5, reasoningTokens: 7 });

    expect(acc.entries()).toEqual([
      {
        ...KEY,
        inputTokens: 450,
        cachedInputTokens: 90,
        cacheWriteTokens: 0,
        outputTokens: 35,
        reasoningTokens: 7,
        calls: 3,
      },
    ]);
  });

  it("keeps a separate entry per (provider, model, source) — a compaction on the fallback model is not the thread's model", () => {
    const acc = new TurnUsageAccumulator();
    acc.add(KEY, { inputTokens: 100, outputTokens: 10 });
    acc.add(
      { provider: "workers-ai", model: "@cf/zai-org/glm-5.2", source: "compaction" },
      { inputTokens: 5000, outputTokens: 300 },
    );

    const entries = acc.entries();
    expect(entries).toHaveLength(2);
    expect(entries.map((e) => e.source).sort()).toEqual(["chat", "compaction"]);
    expect(acc.isEmpty()).toBe(false);
  });

  it("treats missing usage fields as zero rather than NaN", () => {
    const acc = new TurnUsageAccumulator();
    acc.add(KEY, {});
    expect(acc.entries()[0]).toMatchObject({
      inputTokens: 0,
      outputTokens: 0,
      cachedInputTokens: 0,
      reasoningTokens: 0,
      calls: 1,
    });
  });

  it("picks up cache-write tokens from usage.inputTokenDetails.cacheWriteTokens (the verified source)", () => {
    const acc = new TurnUsageAccumulator();
    acc.add(KEY, { inputTokens: 10, inputTokenDetails: { cacheWriteTokens: 2048 } });
    expect(acc.entries()[0]!.cacheWriteTokens).toBe(2048);
  });

  it("falls back to providerMetadata.anthropic.cacheCreationInputTokens when inputTokenDetails is absent", () => {
    const acc = new TurnUsageAccumulator();
    acc.add(KEY, { inputTokens: 10 }, { anthropic: { cacheCreationInputTokens: 2048 } });
    expect(acc.entries()[0]!.cacheWriteTokens).toBe(2048);
  });

  it("prefers usage.inputTokenDetails.cacheWriteTokens over providerMetadata when both are present", () => {
    const acc = new TurnUsageAccumulator();
    acc.add(
      KEY,
      { inputTokens: 10, inputTokenDetails: { cacheWriteTokens: 111 } },
      { anthropic: { cacheCreationInputTokens: 999 } },
    );
    expect(acc.entries()[0]!.cacheWriteTokens).toBe(111);
  });

  it("keeps only the LAST recorded context — a turn that compacts mid-flight must report the post-compaction size", () => {
    const acc = new TurnUsageAccumulator();
    acc.recordContext("anthropic", { inputTokens: 180_000 }, 200_000); // pre-compaction step
    acc.recordContext("anthropic", { inputTokens: 40_000 }, 200_000); // post-compaction step
    expect(acc.context()).toMatchObject({ contextTokens: 40_000, contextWindow: 200_000 });
  });

  it("merge() folds a failed flush's snapshot back in, summing per key", () => {
    const snapshot = new TurnUsageAccumulator();
    snapshot.add(KEY, { inputTokens: 10, outputTokens: 1 });
    snapshot.recordContext("anthropic", { inputTokens: 10 }, 200_000, 118_400);

    const live = new TurnUsageAccumulator();
    live.add(KEY, { inputTokens: 5, outputTokens: 2 });
    live.merge(snapshot);

    const entries = live.entries();
    expect(entries).toHaveLength(1);
    expect(entries[0]).toMatchObject({ inputTokens: 15, outputTokens: 3, calls: 2 });
  });

  it("merge() keeps the NEWER context reading — the gauge is a point in time, not a sum", () => {
    const snapshot = new TurnUsageAccumulator();
    snapshot.recordContext("anthropic", { inputTokens: 180_000 }, 200_000, 118_400);

    const live = new TurnUsageAccumulator();
    live.recordContext("anthropic", { inputTokens: 40_000 }, 200_000, 118_400);
    live.merge(snapshot);
    expect(live.context()?.contextTokens).toBe(40_000);

    const empty = new TurnUsageAccumulator();
    empty.merge(snapshot);
    expect(empty.context()?.contextTokens).toBe(180_000);
  });

  it("records the turn's real compaction trigger alongside the gauge", () => {
    const acc = new TurnUsageAccumulator();
    acc.recordContext("anthropic", { inputTokens: 40_000 }, 200_000, 118_400);
    expect(acc.context()).toEqual({
      contextTokens: 40_000,
      contextWindow: 200_000,
      compactAfterTokens: 118_400,
    });
  });

  it("leaves the trigger NULL when the turn didn't resolve one", () => {
    const acc = new TurnUsageAccumulator();
    acc.recordContext("anthropic", { inputTokens: 40_000 }, 200_000);
    expect(acc.context()?.compactAfterTokens).toBeNull();
  });
});

describe("cacheWriteTokensFrom", () => {
  // Signature is (usage, providerMetadata?): usage.inputTokenDetails.cacheWriteTokens
  // is the verified primary source; providerMetadata is the fallback. These cases
  // exercise the fallback path with an empty/absent usage, so they isolate the
  // providerMetadata handling exactly as the brief intended.
  it("returns 0 for absent or malformed metadata (with no usage-level cache-write value)", () => {
    expect(cacheWriteTokensFrom({}, undefined)).toBe(0);
    expect(cacheWriteTokensFrom({}, null)).toBe(0);
    expect(cacheWriteTokensFrom({}, {})).toBe(0);
    expect(cacheWriteTokensFrom({}, { anthropic: {} })).toBe(0);
    expect(cacheWriteTokensFrom({}, { anthropic: { cacheCreationInputTokens: "nope" } })).toBe(0);
  });

  it("returns 0 when usage.inputTokenDetails.cacheWriteTokens is absent or malformed and there is no metadata fallback", () => {
    expect(cacheWriteTokensFrom({ inputTokenDetails: {} })).toBe(0);
    expect(
      cacheWriteTokensFrom({
        inputTokenDetails: { cacheWriteTokens: Number.NaN },
      }),
    ).toBe(0);
  });
});

describe("contextTokensFromUsage", () => {
  // CORRECTION (Task 1 live probe): cached tokens are INCLUDED in `inputTokens`
  // on every provider measured (both an Anthropic-family and an OpenAI-family
  // model via OpenRouter). CACHED_INPUT_ADDITIVE is therefore EMPTY, and
  // `contextTokensFromUsage` must NOT add cachedInputTokens on top of
  // inputTokens for any currently-known provider, including "anthropic".
  it("counts inputTokens as the whole context size — cached tokens are already included, not additive, for every currently-verified provider", () => {
    const anthropic = contextTokensFromUsage("anthropic", {
      inputTokens: 40_000,
      cachedInputTokens: 38_000,
    });
    const openai = contextTokensFromUsage("openai", {
      inputTokens: 40_000,
      cachedInputTokens: 38_000,
    });
    expect(anthropic).toBe(40_000);
    expect(openai).toBe(40_000);
  });

  it("documents the additive seam: a provider listed in CACHED_INPUT_ADDITIVE would add cachedInputTokens on top of inputTokens (no provider is currently listed — this is a seam test, not a live claim)", () => {
    // We can't reach into the module's private Set from outside, so this test
    // documents the CONTRACT via the two provider paths above: as long as
    // CACHED_INPUT_ADDITIVE stays empty, "anthropic" and "openai" (and any
    // other provider name) behave identically — inclusive, not additive.
    // If a future probe of the native providers proves one IS additive, that
    // provider joins the set and this test's symmetry assertion below breaks,
    // which is the intended signal to update it.
    const a = contextTokensFromUsage("anthropic", {
      inputTokens: 10_000,
      cachedInputTokens: 9_000,
    });
    const b = contextTokensFromUsage("some-future-additive-provider", {
      inputTokens: 10_000,
      cachedInputTokens: 9_000,
    });
    expect(a).toBe(b);
    expect(a).toBe(10_000);
  });

  it("is 0, not NaN, when the provider reports nothing", () => {
    expect(contextTokensFromUsage("anthropic", {})).toBe(0);
  });
});

describe("compaction attribution", () => {
  it("bills a fallback-served compaction to the fallback model, not the thread's", () => {
    const acc = new TurnUsageAccumulator();
    // The thread's own chat turn.
    acc.add(
      { provider: "openai-oauth", model: "codex", source: "chat" },
      { inputTokens: 100_000, outputTokens: 500 },
    );
    // Its model could not serve the summarizer; the keyless Workers AI model did.
    acc.add(
      { provider: "workers-ai", model: "@cf/zai-org/glm-5.2", source: "compaction" },
      { inputTokens: 90_000, outputTokens: 1_200 },
    );

    const compaction = acc.entries().find((e) => e.source === "compaction");
    expect(compaction?.provider).toBe("workers-ai");
    expect(compaction?.model).toBe("@cf/zai-org/glm-5.2");
    // And the chat entry is untouched by it.
    expect(acc.entries().find((e) => e.source === "chat")?.inputTokens).toBe(100_000);
  });
});
