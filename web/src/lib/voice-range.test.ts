import { describe, it, expect } from "vitest";
import { beginVoiceRange, applyVoiceText, cancelVoiceRange } from "./voice-range";

describe("voice range", () => {
  it("begins an empty range at the end of the existing text", () => {
    expect(beginVoiceRange("hello")).toEqual({ start: 5, length: 0 });
  });

  it("inserts voice text at the range start", () => {
    const range = beginVoiceRange("");
    const next = applyVoiceText("", range, "add a retry");
    expect(next.text).toBe("add a retry");
    expect(next.range).toEqual({ start: 0, length: 11 });
  });

  it("replaces the previous voice text rather than appending it twice", () => {
    const r0 = beginVoiceRange("");
    const a = applyVoiceText("", r0, "add a");
    const b = applyVoiceText(a.text, a.range, "add a retry");
    expect(b.text).toBe("add a retry");
  });

  it("keeps text typed before the range intact", () => {
    const r0 = beginVoiceRange("note: ");
    const a = applyVoiceText("note: ", r0, "add a retry");
    expect(a.text).toBe("note: add a retry");
  });

  it("separates the first voice word from typed text with no trailing space", () => {
    const r0 = beginVoiceRange("note:");
    const a = applyVoiceText("note:", r0, "add a retry");
    expect(a.text).toBe("note: add a retry");
    // The separator belongs to the voice range, so Cancel takes it back out.
    expect(cancelVoiceRange(a.text, a.range)).toBe("note:");
  });

  it("does not double the separator across successive finals", () => {
    const r0 = beginVoiceRange("note:");
    const a = applyVoiceText("note:", r0, "add a");
    const b = applyVoiceText(a.text, a.range, "add a retry");
    expect(b.text).toBe("note: add a retry");
  });

  it("cancel removes only the voice range", () => {
    const r0 = beginVoiceRange("note: ");
    const a = applyVoiceText("note: ", r0, "add a retry");
    expect(cancelVoiceRange(a.text, a.range)).toBe("note: ");
  });

  it("cancel on an empty range is a no-op", () => {
    expect(cancelVoiceRange("typed", { start: 5, length: 0 })).toBe("typed");
  });
});
