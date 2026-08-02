import { describe, expect, it } from "vitest";
import { extractPushPreview } from "../../../src/notifications/push-preview";

const text = (value: string) => ({ type: "text", text: value });
const message = (...parts: Array<Record<string, unknown>>) => [{ parts }];

describe("extractPushPreview", () => {
  it("returns a short reply verbatim, with no ellipsis", () => {
    expect(extractPushPreview(message(text("The CSV writer dropped the last row.")))).toBe(
      "The CSV writer dropped the last row.",
    );
  });

  it("joins multiple text parts with a space", () => {
    expect(extractPushPreview(message(text("Found it."), text("One-line fix.")))).toBe(
      "Found it. One-line fix.",
    );
  });

  it("collapses newlines and runs of whitespace", () => {
    expect(extractPushPreview(message(text("  Found it.\n\nThe   writer\tdropped a row.  ")))).toBe(
      "Found it. The writer dropped a row.",
    );
  });

  // The word length is chosen so that character 160 falls MID-word: with
  // 11-char units, 160 lands inside the 15th word. A hard slice would leave
  // "abcde…" dangling, so this test fails if the boundary logic is removed.
  it("truncates to 160 characters at a word boundary", () => {
    const long = "abcdefghij ".repeat(20).trim();
    const preview = extractPushPreview(message(text(long)));

    expect(preview).not.toBeNull();
    // The ellipsis is allowed on top of the 160 characters of content.
    expect(preview!.length).toBeLessThanOrEqual(161);
    expect(preview!.endsWith("…")).toBe(true);

    const body = preview!.slice(0, -1);
    expect(body).toBe(body.trimEnd());
    // Every word survives whole — none clipped by the cut.
    for (const word of body.split(" ")) {
      expect(word).toBe("abcdefghij");
    }
  });

  it("hard-cuts a single word longer than the limit rather than returning nothing", () => {
    const preview = extractPushPreview(message(text("z".repeat(400))));

    expect(preview).toBe(`${"z".repeat(160)}…`);
  });

  it("keeps a reply that is exactly at the limit intact", () => {
    const exact = "a".repeat(160);
    expect(extractPushPreview(message(text(exact)))).toBe(exact);
  });

  it("ignores reasoning, so private chain-of-thought never reaches a lock screen", () => {
    expect(
      extractPushPreview(
        message({ type: "reasoning", text: "The user is probably wrong about" }, text("Done.")),
      ),
    ).toBe("Done.");
  });

  it("ignores tool and file parts", () => {
    expect(
      extractPushPreview(
        message(
          { type: "tool-exec_run", input: { command: "git push --force" } },
          { type: "dynamic-tool", input: {} },
          { type: "file", url: "https://example.test/a.png" },
          text("Pushed."),
        ),
      ),
    ).toBe("Pushed.");
  });

  it("returns null for a message with no text parts", () => {
    expect(
      extractPushPreview(message({ type: "tool-exec_run", input: { command: "ls" } })),
    ).toBeNull();
  });

  it("returns null for whitespace-only text", () => {
    expect(extractPushPreview(message(text("   \n  ")))).toBeNull();
  });

  it("reads only the last message", () => {
    expect(
      extractPushPreview([{ parts: [text("Earlier turn.")] }, { parts: [text("Latest turn.")] }]),
    ).toBe("Latest turn.");
  });

  // Turn-end injection flush can append a user-role system-reminder after the
  // assistant reply. The preview must still quote the assistant, not that
  // injection — otherwise the lock screen shows `<system-reminder>` prose.
  it("reads the last assistant message, skipping a trailing user message", () => {
    expect(
      extractPushPreview([
        { role: "user", parts: [text("What broke?")] },
        { role: "assistant", parts: [text("The projector race.")] },
        {
          role: "user",
          parts: [text("<system-reminder>\nWatcher finished.\n</system-reminder>")],
        },
      ]),
    ).toBe("The projector race.");
  });

  it("skips earlier assistant turns and keeps the latest assistant reply", () => {
    expect(
      extractPushPreview([
        { role: "assistant", parts: [text("Earlier turn.")] },
        { role: "user", parts: [text("Try again.")] },
        { role: "assistant", parts: [text("Latest turn.")] },
      ]),
    ).toBe("Latest turn.");
  });

  it("returns null when no assistant message has text", () => {
    expect(
      extractPushPreview([
        { role: "user", parts: [text("Hello")] },
        { role: "assistant", parts: [{ type: "tool-exec_run", input: { command: "ls" } }] },
      ]),
    ).toBeNull();
  });

  it("returns null for empty, absent, or malformed input", () => {
    expect(extractPushPreview([])).toBeNull();
    expect(extractPushPreview([{}])).toBeNull();
    expect(extractPushPreview([{ parts: [] }])).toBeNull();
    expect(extractPushPreview([{ parts: [{ type: "text" }] }])).toBeNull();
  });
});
