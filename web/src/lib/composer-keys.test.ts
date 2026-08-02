import { describe, expect, it } from "vitest";
import { composerKeyAction } from "./composer-keys";

const key = (over: Partial<Parameters<typeof composerKeyAction>[0]> = {}) =>
  composerKeyAction({
    key: "Enter",
    metaKey: false,
    ctrlKey: false,
    altKey: false,
    shiftKey: false,
    isComposing: false,
    ...over,
  });

describe("composerKeyAction", () => {
  it("sends on Cmd+Enter and Ctrl+Enter", () => {
    expect(key({ metaKey: true })).toBe("send");
    expect(key({ ctrlKey: true })).toBe("send");
  });

  it("steers on Cmd+Shift+Enter and Ctrl+Shift+Enter", () => {
    expect(key({ metaKey: true, shiftKey: true })).toBe("steer");
    expect(key({ ctrlKey: true, shiftKey: true })).toBe("steer");
  });

  it("inserts a newline on Alt/Option+Enter", () => {
    expect(key({ altKey: true })).toBe("newline");
  });

  it("ignores plain Enter (the textarea inserts a newline natively)", () => {
    expect(key()).toBe("ignore");
  });

  it("ignores Shift+Enter (native newline already)", () => {
    expect(key({ shiftKey: true })).toBe("ignore");
  });

  it("ignores Enter while an IME composition is active", () => {
    expect(key({ metaKey: true, isComposing: true })).toBe("ignore");
    expect(key({ altKey: true, isComposing: true })).toBe("ignore");
  });

  it("ignores non-Enter keys", () => {
    expect(key({ key: "a", metaKey: true })).toBe("ignore");
  });
});
