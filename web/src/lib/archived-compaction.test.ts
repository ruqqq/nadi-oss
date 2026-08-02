import { describe, expect, it } from "vitest";
import type { UIMessage } from "ai";
import { applyArchivedCompactions, type ArchivedSummary } from "./archived-compaction";

function msg(id: string, text: string): UIMessage {
  return { id, role: "user", parts: [{ type: "text", text }] } as UIMessage;
}

const raw: UIMessage[] = [
  msg("m0", "first"),
  msg("m1", "hidden A"),
  msg("m2", "hidden B"),
  msg("m3", "hidden C"),
  msg("m4", "last"),
];

const summary: ArchivedSummary = {
  id: "row1",
  fromMessageId: "m1",
  toMessageId: "m3",
  summary: "## Topic\nthe digest",
};

describe("applyArchivedCompactions", () => {
  it("collapses the summarized span behind one synthetic summary", () => {
    const out = applyArchivedCompactions(raw, [summary]);

    expect(out.map((m) => m.id)).toEqual(["m0", "compaction_row1", "m4"]);
    // The divider carries the digest, exactly as the live thread showed it.
    expect(JSON.stringify(out[1]?.parts)).toContain("the digest");
  });

  it("leaves the raw transcript alone when the thread never compacted", () => {
    expect(applyArchivedCompactions(raw, [])).toBe(raw);
  });

  // The archive stores the RAW messages precisely so they are not destroyed; the
  // summaries are a view folded in at render time. Nothing here mutates the input.
  it("does not mutate the stored transcript", () => {
    const before = raw.map((m) => m.id);
    applyArchivedCompactions(raw, [summary]);
    expect(raw.map((m) => m.id)).toEqual(before);
  });

  it("ignores a summary whose span is not in the transcript", () => {
    const orphan: ArchivedSummary = { ...summary, toMessageId: "nope" };
    // Better to show every real message than to swallow the span behind a summary
    // whose end we cannot find.
    expect(applyArchivedCompactions(raw, [orphan]).map((m) => m.id)).toEqual([
      "m0",
      "m1",
      "m2",
      "m3",
      "m4",
    ]);
  });

  it("prefers the newest summary when several share an anchor", () => {
    const older: ArchivedSummary = { ...summary, id: "old", toMessageId: "m2" };
    const newer: ArchivedSummary = { ...summary, id: "new", toMessageId: "m3" };

    const out = applyArchivedCompactions(raw, [older, newer]);

    expect(out.map((m) => m.id)).toEqual(["m0", "compaction_new", "m4"]);
  });
});
