import { describe, expect, it } from "vitest";
import { formatMemoryIndex } from "../../../src/agent/memory-index";

describe("formatMemoryIndex", () => {
  it("renders one line per memory, id first so it can be read in full", () => {
    const out = formatMemoryIndex({
      total: 1,
      entries: [{ id: "mem_1", kind: "fact", hook: "Box RAM — the box has ~3.8GB" }],
    });

    expect(out).toContain("- [fact] mem_1: Box RAM — the box has ~3.8GB");
    expect(out).toContain("search_memories");
  });

  // A truncated index that says nothing about what it dropped reads as "this is
  // everything you know", which is exactly the wrong belief.
  it("says what it left out when the index is truncated", () => {
    const out = formatMemoryIndex({
      total: 120,
      entries: [{ id: "mem_1", kind: "fact", hook: "one of many" }],
    });

    expect(out).toContain("1 most recently updated of 120");
  });

  it("stays silent about truncation when the index is complete", () => {
    const out = formatMemoryIndex({
      total: 1,
      entries: [{ id: "mem_1", kind: "fact", hook: "the only one" }],
    });

    expect(out).not.toContain("most recently updated of");
  });
});
