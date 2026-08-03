import { describe, expect, it } from "vitest";
import { normalizeThreadRuntime } from "../../../src/agent/thread-runtime";

describe("thread runtime helpers", () => {
  // Only `think` is a live runtime. Everything else — the retired `legacy`, a
  // NULL column, an unrecognized string — normalizes to `legacy`, which every
  // caller treats as read-only. Failing closed matters more than round-tripping
  // the stored value: the alternative is dialing a DO class that was deleted.
  it("treats anything that is not Think as the retired runtime", () => {
    expect(normalizeThreadRuntime("think")).toBe("think");
    expect(normalizeThreadRuntime("legacy")).toBe("legacy");
    expect(normalizeThreadRuntime(null)).toBe("legacy");
    expect(normalizeThreadRuntime("bad")).toBe("legacy");
  });
});
