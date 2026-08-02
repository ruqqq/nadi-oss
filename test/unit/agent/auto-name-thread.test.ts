import type { ModelMessage } from "ai";
import { describe, expect, it } from "vitest";
import { fallbackTitle, firstUserText, sanitizeTitle } from "../../../src/agent/auto-name-thread";

describe("sanitizeTitle", () => {
  it("keeps a clean title as-is", () => {
    expect(sanitizeTitle("Adding D1 to the Worker")).toBe("Adding D1 to the Worker");
  });

  // Models pad titles in all these ways; every one of them would otherwise land
  // in the thread list verbatim.
  it.each([
    ['"Adding D1 to the Worker"', "Adding D1 to the Worker"],
    ["“Adding D1 to the Worker”", "Adding D1 to the Worker"],
    ["Title: Adding D1 to the Worker", "Adding D1 to the Worker"],
    ["Adding D1 to the Worker.", "Adding D1 to the Worker"],
    ["Adding D1 to the Worker\n\nThis title summarizes...", "Adding D1 to the Worker"],
    ["  Adding   D1  to the Worker  ", "Adding D1 to the Worker"],
  ])("strips model padding from %j", (raw, expected) => {
    expect(sanitizeTitle(raw)).toBe(expected);
  });

  it("truncates to the column limit", () => {
    expect(sanitizeTitle("word ".repeat(40)).length).toBeLessThanOrEqual(80);
  });

  it("returns empty for an empty answer", () => {
    expect(sanitizeTitle("\n  \n")).toBe("");
  });
});

describe("fallbackTitle", () => {
  it("takes the first six words of the user's message", () => {
    expect(fallbackTitle("how do I add D1 to this worker anyway")).toBe("how do I add D1 to");
  });

  it("collapses whitespace", () => {
    expect(fallbackTitle("  fix   the\nflaky test  ")).toBe("fix the flaky test");
  });

  it("truncates a single enormous word", () => {
    expect(fallbackTitle("x".repeat(200)).length).toBe(80);
  });
});

describe("firstUserText", () => {
  it("reads a plain string message", () => {
    const messages: ModelMessage[] = [{ role: "user", content: "hello there" }];
    expect(firstUserText(messages)).toBe("hello there");
  });

  it("joins the text parts of a multi-part message", () => {
    const messages: ModelMessage[] = [
      {
        role: "user",
        content: [
          { type: "text", text: "look at this" },
          { type: "text", text: "and this" },
        ],
      },
    ];
    expect(firstUserText(messages)).toBe("look at this\nand this");
  });

  it("skips the system prompt and reads the first USER message", () => {
    const messages: ModelMessage[] = [
      { role: "system", content: "You are Nadi." },
      { role: "user", content: "name this thread" },
      { role: "user", content: "second message" },
    ];
    expect(firstUserText(messages)).toBe("name this thread");
  });

  // An image-only first message names nothing; the caller leaves it untitled
  // rather than inventing a title from an empty string.
  it("returns empty when the first user message carries no text", () => {
    const messages: ModelMessage[] = [
      { role: "user", content: [{ type: "image", image: "https://example.com/a.png" }] },
    ];
    expect(firstUserText(messages)).toBe("");
  });

  it("falls through an attachment-only message to the next text one", () => {
    const messages: ModelMessage[] = [
      { role: "user", content: [{ type: "image", image: "https://example.com/a.png" }] },
      { role: "user", content: "what is in this image?" },
    ];
    expect(firstUserText(messages)).toBe("what is in this image?");
  });
});
