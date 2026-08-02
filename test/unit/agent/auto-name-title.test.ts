import { describe, expect, it } from "vitest";
import { fallbackTitle, sanitizeTitle } from "../../../src/agent/auto-name-thread";

describe("sanitizeTitle", () => {
  it("keeps a real title, stripping the padding models add", () => {
    expect(sanitizeTitle('Title: "Adding D1 to the Worker".')).toBe("Adding D1 to the Worker");
    expect(sanitizeTitle("Flaky CI login test\n\nI chose this because...")).toBe(
      "Flaky CI login test",
    );
  });

  // The title a thread actually shipped with, on deepseek-v4-flash: the model
  // answered the message instead of naming it.
  it("rejects the answer that shipped to production", () => {
    expect(sanitizeTitle("I can't access past conversations, but here's general guidance:")).toBe(
      "",
    );
  });

  it.each([
    ["I'd suggest checking the logs first", "first person"],
    ["Sure, I can help with that", "assistant opener"],
    ["Here's how to add D1", "answer opener"],
    ["Unfortunately that is not possible", "refusal opener"],
    ["To fix this you should:", "trailing colon"],
    ["It depends. First, check the binding", "two sentences"],
    ["Adding D1 to the Worker and then wiring up the migrations properly", "over the word cap"],
  ])("rejects %j (%s)", (raw) => {
    expect(sanitizeTitle(raw)).toBe("");
  });

  // Rejection is anchored on the OPENER, so ordinary titles that merely contain
  // one of those words are still titles.
  it.each([
    "Debugging I/O throughput",
    "Where the login test fails",
    "Notes on hi-fi audio pipelines",
    "Yesterday's deploy rollback",
  ])("keeps %j", (raw) => {
    expect(sanitizeTitle(raw)).toBe(raw);
  });

  it("truncates to the column width", () => {
    expect(sanitizeTitle("Supercalifragilistic".repeat(10))).toHaveLength(80);
  });
});

describe("fallbackTitle", () => {
  // What a rejected answer falls back to — mediocre, but the user's own words.
  it("uses the first six words of the user's message", () => {
    expect(fallbackTitle("what did we talk about last time we spoke")).toBe(
      "what did we talk about last",
    );
  });
});
