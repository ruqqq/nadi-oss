import { isCompactionMessage } from "agents/experimental/memory/utils";
import { convertToModelMessages, type UIMessage } from "ai";
import { describe, expect, it } from "vitest";
import { createNadiCompactFunction } from "../../../src/agent/compaction";
import { resolveContextBudget } from "../../../src/agent/context-budget";
import { modelSwitchPart, readModelSwitchPart } from "../../../src/agent/model-switch";
import {
  restoreModelSwitchMarker,
  sanitizeCrossModelReasoning,
} from "../../../src/agent/cross-model-reasoning-sanitize";

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

/**
 * The failure that made `restoreModelSwitchMarker` necessary: compaction
 * ARCHIVES the message the marker rode on, and a marker-less transcript reads
 * as one same-origin segment. Everything here is real — the real Nadi compact
 * function picks the span, and the summary message is materialized exactly as
 * the SDK's `applyCompactions` does (an assistant message with one text part
 * and a `compaction_*` id, which `isCompactionMessage` is asserted to accept
 * below so the fixture cannot drift from the contract the restore relies on).
 */
describe("sanitizer x compaction", () => {
  const budget = resolveContextBudget(200_000);
  const ANTHROPIC = { provider: "openrouter", model: "anthropic/claude-opus-5" };
  const GPT = { provider: "openrouter", model: "openai/gpt-5" };

  /** The SDK replaces [fromMessageId..toMessageId] with ONE assistant message
   *  carrying only the summary text — see `session/index.js`'s
   *  `applyCompactions`. Parts of the archived span, marker included, are gone. */
  function applyCompaction(
    messages: UIMessage[],
    result: { fromMessageId: string; toMessageId: string; summary: string },
  ): UIMessage[] {
    const start = messages.findIndex((m) => m.id === result.fromMessageId);
    const end = messages.findIndex((m) => m.id === result.toMessageId);
    return [
      ...messages.slice(0, start),
      {
        id: "compaction_c1",
        role: "assistant",
        parts: [{ type: "text", text: result.summary }],
      } as UIMessage,
      ...messages.slice(end + 1),
    ];
  }

  function longTranscript(): UIMessage[] {
    const filler = "x".repeat(6_000);
    const messages: UIMessage[] = [
      user("m0", [{ type: "text", text: `opening ${filler}` }]),
      // The signed Anthropic thinking block that must never reach gpt-5.
      assistant("m1", [anthropicReasoning, { type: "text", text: `claude turn ${filler}` }]),
      user("m2", [{ type: "text", text: `more ${filler}` }]),
    ];
    for (let i = 3; i < 40; i += 1) {
      messages.push(
        (i % 2 === 0 ? user : assistant)(`m${i}`, [{ type: "text", text: `turn ${i} ${filler}` }]),
      );
    }
    // The switch itself, mid-transcript — the marker rides the user message
    // whose turn committed it.
    messages.push(user("m40", [SWITCH, { type: "text", text: `switch here ${filler}` }]));
    for (let i = 41; i < 60; i += 1) {
      messages.push(
        (i % 2 === 0 ? user : assistant)(`m${i}`, [{ type: "text", text: `turn ${i} ${filler}` }]),
      );
    }
    return messages;
  }

  it("loses the marker to compaction, and the sanitizer then keeps foreign reasoning", async () => {
    const compact = createNadiCompactFunction({
      budget,
      summarize: async () => "## Topic\nEverything so far.",
      onOutcome: () => {},
    });
    const before = longTranscript();
    const result = await compact(before as never);
    expect(result).not.toBeNull();

    const after = applyCompaction(before, result!);
    expect(isCompactionMessage(after.find((m) => m.id === "compaction_c1") as never)).toBe(true);
    // The premise: the marker really is gone, and message 1's Anthropic
    // reasoning really did survive in the protected head.
    expect(after.some((m) => m.parts.some((p) => readModelSwitchPart(p)))).toBe(false);
    expect(after[1]?.parts).toContain(anthropicReasoning);
    // ... and with no marker the sanitizer alone is a no-op, so the signed
    // Anthropic block would be replayed at gpt-5.
    expect(sanitizeCrossModelReasoning(after)).toBe(after);
  });

  it("restores segmentation from the durable origin record and drops the foreign reasoning", async () => {
    const compact = createNadiCompactFunction({
      budget,
      summarize: async () => "## Topic\nEverything so far.",
      onOutcome: () => {},
    });
    const before = longTranscript();
    const after = applyCompaction(before, (await compact(before as never))!);

    const restored = restoreModelSwitchMarker(after, {
      from: ANTHROPIC,
      to: GPT,
      anchorMessageId: "m40",
    });
    const sanitized = sanitizeCrossModelReasoning(restored);

    // The head is pre-switch again, so its signed Anthropic block is dropped.
    expect(sanitized[1]?.parts).toEqual([before[1]!.parts[1]]);
    // The marker lands on the summary message (the anchor was archived), so
    // everything after it stays attributed to the current tuple.
    expect(readModelSwitchPart(sanitized[3]?.parts[0])).toEqual({ from: ANTHROPIC, to: GPT });
    expect(sanitized[3]?.id).toBe("compaction_c1");
    // Deterministic: a second pass over an already-restored transcript is a
    // no-op, which is what keeps prompt caching to one miss per switch.
    expect(restoreModelSwitchMarker(restored, { from: ANTHROPIC, to: GPT })).toBe(restored);
  });

  it("prefers the anchor message itself when it survived", () => {
    const messages = [
      user("u1", [{ type: "text", text: "hi" }]),
      assistant("a1", [anthropicReasoning, { type: "text", text: "claude" }]),
      user("u2", [{ type: "text", text: "switch now" }]),
      assistant("a2", [openaiReasoning, { type: "text", text: "gpt" }]),
    ];
    const restored = restoreModelSwitchMarker(messages, {
      from: ANTHROPIC,
      to: GPT,
      anchorMessageId: "u2",
    });
    expect(readModelSwitchPart(restored[2]?.parts[0])).toEqual({ from: ANTHROPIC, to: GPT });
    const sanitized = sanitizeCrossModelReasoning(restored);
    expect(sanitized[1]?.parts).toEqual([{ type: "text", text: "claude" }]);
    expect(sanitized[3]?.parts).toEqual([openaiReasoning, { type: "text", text: "gpt" }]);
  });

  it("leaves the transcript alone when there is no record, no anchor and no summary", () => {
    const messages = [assistant("a1", [anthropicReasoning, { type: "text", text: "claude" }])];
    expect(restoreModelSwitchMarker(messages, null)).toBe(messages);
    // No position to anchor to: a marker at index 0 would claim the whole
    // transcript is POST-switch, which is the unsafe reading.
    expect(
      restoreModelSwitchMarker(messages, { from: ANTHROPIC, to: GPT, anchorMessageId: "gone" }),
    ).toBe(messages);
  });
});

/**
 * The oscillating thread. `restoreModelSwitchMarker` used to skip restoration
 * whenever ANY surviving marker named `origin.to` — a different question from
 * the one the sanitizer asks. With A->B on m10, B->A on m20 and A->B on m30,
 * compaction can archive m30 while m10 and m20 survive in the protected head:
 * m10 still names `to: B`, so the restore no-oped, but `segmentTuples` resolved
 * the CURRENT tuple to A (from m20) and the head's Anthropic reasoning shipped
 * to B as same-origin. The gate now compares against the current tuple.
 */
describe("restoreModelSwitchMarker x oscillating switches", () => {
  const ANTHROPIC = { provider: "openrouter", model: "anthropic/claude-opus-5" };
  const GPT = { provider: "openrouter", model: "openai/gpt-5" };
  const toGpt = modelSwitchPart({
    from: ANTHROPIC,
    to: GPT,
  }) as unknown as UIMessage["parts"][number];
  const toAnthropic = modelSwitchPart({
    from: GPT,
    to: ANTHROPIC,
  }) as unknown as UIMessage["parts"][number];

  /** Head: m0..m21 (two surviving markers). The span holding m30's A->B marker
   *  was archived into `compaction_c1`; m40 ran on the current tuple. */
  function afterCompaction(): UIMessage[] {
    return [
      user("m0", [{ type: "text", text: "start" }]),
      assistant("m1", [anthropicReasoning, { type: "text", text: "claude one" }]),
      user("m10", [toGpt, { type: "text", text: "use gpt" }]),
      assistant("m11", [openaiReasoning, { type: "text", text: "gpt one" }]),
      user("m20", [toAnthropic, { type: "text", text: "back to claude" }]),
      assistant("m21", [anthropicReasoning, { type: "text", text: "claude two" }]),
      {
        id: "compaction_c1",
        role: "assistant",
        parts: [{ type: "text", text: "summary" }],
      } as UIMessage,
      assistant("m40", [openaiReasoning, { type: "text", text: "gpt two" }]),
    ];
  }

  it("restores even though a surviving marker names the target tuple", () => {
    const messages = afterCompaction();
    // The premise: a marker for `to: GPT` survives, yet the transcript's
    // current tuple is Anthropic — the two answers that used to be conflated.
    expect(readModelSwitchPart(messages[2]?.parts[0])?.to).toEqual(GPT);

    const restored = restoreModelSwitchMarker(messages, {
      from: ANTHROPIC,
      to: GPT,
      anchorMessageId: "m30",
    });
    expect(restored).not.toBe(messages);
    expect(readModelSwitchPart(restored[6]?.parts[0])).toEqual({ from: ANTHROPIC, to: GPT });

    const sanitized = sanitizeCrossModelReasoning(restored);
    // Both Anthropic segments are now foreign and stripped...
    expect(sanitized[1]?.parts).toEqual([{ type: "text", text: "claude one" }]);
    expect(sanitized[5]?.parts).toEqual([{ type: "text", text: "claude two" }]);
    // ...while the current tuple's own reasoning still ships.
    expect(sanitized[7]?.parts).toEqual([openaiReasoning, { type: "text", text: "gpt two" }]);
  });

  it("still no-ops once the transcript's current tuple IS the origin target", () => {
    const restored = restoreModelSwitchMarker(afterCompaction(), {
      from: ANTHROPIC,
      to: GPT,
      anchorMessageId: "m30",
    });
    // Idempotent: the injected marker is now the last one, so the current
    // tuple matches and a second pass returns the same array identity.
    expect(
      restoreModelSwitchMarker(restored, { from: ANTHROPIC, to: GPT, anchorMessageId: "m30" }),
    ).toBe(restored);
  });
});
