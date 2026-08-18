import { convertToModelMessages, type UIMessage } from "ai";
import { describe, expect, it } from "vitest";
import { modelSwitchPart } from "../../../src/agent/model-switch";
import { sanitizeCrossModelReasoning } from "../../../src/agent/cross-model-reasoning-sanitize";

const anthropicReasoning = {
  type: "reasoning" as const,
  text: "thinking as claude",
  providerMetadata: { anthropic: { signature: "sig-abc" } },
};

const openaiReasoning = {
  type: "reasoning" as const,
  text: "thinking as gpt",
  providerMetadata: { openai: { itemId: "rs_123" } },
};

function assistant(id: string, parts: UIMessage["parts"]): UIMessage {
  return { id, role: "assistant", parts } as UIMessage;
}

function user(id: string, parts: UIMessage["parts"]): UIMessage {
  return { id, role: "user", parts } as UIMessage;
}

const SWITCH = modelSwitchPart({
  from: { provider: "anthropic", model: "claude-opus-5" },
  to: { provider: "openai", model: "gpt-5" },
}) as unknown as UIMessage["parts"][number];

describe("sanitizeCrossModelReasoning", () => {
  it("keeps every reasoning part when the thread has never switched", () => {
    const messages = [
      user("u1", [{ type: "text", text: "hi" }]),
      assistant("a1", [anthropicReasoning, { type: "text", text: "hello" }]),
    ];
    expect(sanitizeCrossModelReasoning(messages)).toBe(messages);
  });

  it("drops reasoning produced before the switch", () => {
    const result = sanitizeCrossModelReasoning([
      assistant("a1", [anthropicReasoning, { type: "text", text: "old" }]),
      user("u2", [SWITCH, { type: "text", text: "now use gpt" }]),
      assistant("a2", [openaiReasoning, { type: "text", text: "new" }]),
    ]);
    expect(result[0]?.parts).toEqual([{ type: "text", text: "old" }]);
    expect(result[2]?.parts).toEqual([openaiReasoning, { type: "text", text: "new" }]);
  });

  it("keeps reasoning from an earlier segment with the SAME tuple (A -> B -> A)", () => {
    const back = modelSwitchPart({
      from: { provider: "openai", model: "gpt-5" },
      to: { provider: "anthropic", model: "claude-opus-5" },
    }) as unknown as UIMessage["parts"][number];

    const result = sanitizeCrossModelReasoning([
      assistant("a1", [anthropicReasoning]),
      user("u2", [SWITCH]),
      assistant("a2", [openaiReasoning]),
      user("u3", [back]),
      assistant("a3", [anthropicReasoning]),
    ]);
    expect(result[0]?.parts).toEqual([anthropicReasoning]);
    expect(result[2]?.parts).toEqual([]);
    expect(result[4]?.parts).toEqual([anthropicReasoning]);
  });

  it("drops reasoning on a model-only switch inside one provider", () => {
    const orSwitch = modelSwitchPart({
      from: { provider: "openrouter", model: "anthropic/claude-opus-5" },
      to: { provider: "openrouter", model: "openai/gpt-5" },
    }) as unknown as UIMessage["parts"][number];

    const orReasoning = {
      type: "reasoning" as const,
      text: "claude via openrouter",
      providerMetadata: {
        openrouter: {
          reasoning_details: [
            { type: "reasoning.text", format: "anthropic-claude-v1", signature: "sig-xyz" },
          ],
        },
      },
    };

    const result = sanitizeCrossModelReasoning([
      assistant("a1", [orReasoning]),
      user("u2", [orSwitch]),
      assistant("a2", [{ type: "text", text: "answer" }]),
    ]);
    expect(result[0]?.parts).toEqual([]);
  });

  it("is deterministic: the same transcript sanitizes identically twice", () => {
    const messages = [
      assistant("a1", [anthropicReasoning]),
      user("u2", [SWITCH]),
      assistant("a2", [openaiReasoning]),
    ];
    const once = JSON.stringify(sanitizeCrossModelReasoning(messages));
    const twice = JSON.stringify(sanitizeCrossModelReasoning(messages));
    expect(once).toBe(twice);
  });

  it("is prefix-stable: appending a turn does not change the earlier prefix", () => {
    const base = [
      assistant("a1", [anthropicReasoning]),
      user("u2", [SWITCH]),
      assistant("a2", [openaiReasoning]),
    ];
    const grown = [
      ...base,
      user("u3", [{ type: "text", text: "more" }]),
      assistant("a3", [openaiReasoning]),
    ];
    const prefixBefore = JSON.stringify(sanitizeCrossModelReasoning(base));
    const prefixAfter = JSON.stringify(sanitizeCrossModelReasoning(grown).slice(0, 3));
    expect(prefixAfter).toBe(prefixBefore);
  });

  it("never lets the marker reach the model", async () => {
    const modelMessages = await convertToModelMessages([
      user("u2", [SWITCH, { type: "text", text: "now use gpt" }]),
    ]);
    expect(JSON.stringify(modelMessages)).not.toContain("model-switch");
  });

  it("treats a marker on message index 0 as a zero-iteration backfill (no misattribution)", () => {
    // The backfill loop in segmentTuples runs `for i in 0..index-1` to
    // attribute messages BEFORE the first marker. When the first marker is on
    // message 0 itself, that loop must do nothing rather than write anything
    // (there is nothing before index 0 to backfill).
    const away = modelSwitchPart({
      from: { provider: "openai", model: "gpt-5" },
      to: { provider: "anthropic", model: "claude-opus-5" },
    }) as unknown as UIMessage["parts"][number];

    const result = sanitizeCrossModelReasoning([
      user("u1", [SWITCH]),
      assistant("a1", [openaiReasoning, { type: "text", text: "new" }]),
      user("u2", [away]),
      assistant("a2", [anthropicReasoning, { type: "text", text: "later" }]),
    ]);
    // a1 was produced by the marker's `to` tuple (openai/gpt-5), which is
    // superseded by the later switch back to anthropic — its reasoning drops.
    expect(result[1]?.parts).toEqual([{ type: "text", text: "new" }]);
    // a2 is produced by the CURRENT tuple (anthropic/claude-opus-5) — kept.
    expect(result[3]?.parts).toEqual([anthropicReasoning, { type: "text", text: "later" }]);
  });

  it("attributes a message with several markers to the LAST marker's `to` tuple", () => {
    // Two switches land on the SAME message: anthropic -> openai -> google.
    // Only the FIRST marker may trigger the backfill (it is already
    // guarded by `sawMarker`), but the message's own `active` tuple — used to
    // attribute the very next assistant turn — must end up as the LAST
    // marker's `to` (google), not the first marker's `to` (openai).
    //
    // A trailing THIRD switch (google -> deepseek) is required to make this
    // observable: without it, "the message's own attribution" and "the
    // transcript's current tuple" are read from the same final `active`
    // value and always agree, so a first-vs-last bug would go unnoticed. The
    // trailing switch pulls `current` away from what u2 should have been
    // attributed to, so a3's origin is compared against something OTHER than
    // whatever the buggy code happened to leave in `active`.
    const bToC = modelSwitchPart({
      from: { provider: "openai", model: "gpt-5" },
      to: { provider: "google", model: "gemini-3-pro" },
    }) as unknown as UIMessage["parts"][number];

    const cToD = modelSwitchPart({
      from: { provider: "google", model: "gemini-3-pro" },
      to: { provider: "deepseek", model: "deepseek-v4" },
    }) as unknown as UIMessage["parts"][number];

    const googleReasoning = {
      type: "reasoning" as const,
      text: "thinking as gemini",
      providerMetadata: { google: { thoughtSignature: "sig-g" } },
    };

    const deepseekReasoning = {
      type: "reasoning" as const,
      text: "thinking as deepseek",
      providerMetadata: { deepseek: { signature: "sig-d" } },
    };

    const result = sanitizeCrossModelReasoning([
      assistant("a1", [anthropicReasoning]),
      user("u2", [SWITCH, bToC, { type: "text", text: "now use gemini" }]),
      assistant("a3", [googleReasoning, { type: "text", text: "gemini turn" }]),
      user("u4", [cToD, { type: "text", text: "now use deepseek" }]),
      assistant("a5", [deepseekReasoning, { type: "text", text: "deepseek turn" }]),
    ]);
    // a3 is attributed to u2's LAST marker (google), which the trailing
    // switch supersedes — so its reasoning is dropped. This IS the
    // discriminating case: a buggy implementation that lets only the first
    // marker of a message win (openai, guarded by the SAME `sawMarker` flag
    // that gates the backfill) would also stop updating `active` on every
    // later marker, so `current` would stay wrongly pinned at openai too —
    // making a3's (wrong) origin equal the (wrong) current, and keeping
    // reasoning that should have been dropped.
    expect(result[2]?.parts).toEqual([{ type: "text", text: "gemini turn" }]);
    // a5 is attributed to the CURRENT tuple (deepseek) and survives — this
    // pins that later markers keep updating `active` at all, which the same
    // buggy variant above would also break.
    expect(result[4]?.parts).toEqual([deepseekReasoning, { type: "text", text: "deepseek turn" }]);
  });
});

describe("assembly order", () => {
  it("sanitizes before truncation so the budget reflects what is sent", async () => {
    // truncateOlderMessages lives in the agents SDK, not in this repo — the
    // ordering assertion below is the real guard; this import just confirms
    // the symbol the source string refers to actually exists.
    const { truncateOlderMessages } = await import("agents/experimental/memory/utils");
    expect(typeof truncateOlderMessages).toBe("function");
    // Guard: this test exists to pin the ORDER in
    // assembleWindowScaledModelMessages. If the sanitizer moves after
    // truncation, the truncation budget counts reasoning that never ships.
    const source = await import("node:fs").then((fs) =>
      fs.readFileSync("src/agent/think-thread-agent.ts", "utf8"),
    );
    const sanitizeAt = source.indexOf("sanitizeCrossModelReasoning(");
    const truncateAt = source.indexOf("truncateOlderMessages(sanitized");
    expect(sanitizeAt).toBeGreaterThan(-1);
    expect(truncateAt).toBeGreaterThan(-1);
    expect(sanitizeAt).toBeLessThan(truncateAt);
  });
});
