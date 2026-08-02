import { describe, expect, test } from "vitest";
import {
  isCompactCommand,
  resolveSubmitButton,
  resolveSubmitButtonStatus,
  steerMenuAvailable,
} from "./composer-submit";

describe("resolveSubmitButton", () => {
  test("idle composer sends and is enabled when ready", () => {
    expect(resolveSubmitButton(undefined, false, true, false)).toEqual({
      mode: "send",
      disabled: false,
    });
  });

  test("idle composer is a disabled send button while not ready (e.g. draft loading)", () => {
    expect(resolveSubmitButton(undefined, true, true, false)).toEqual({
      mode: "send",
      disabled: true,
    });
  });

  test("streaming empty composer becomes an enabled stop button", () => {
    expect(resolveSubmitButton("streaming", true, true, false)).toEqual({
      mode: "stop",
      disabled: false,
    });
  });

  test("streaming composer with content stays a send button", () => {
    expect(resolveSubmitButton("streaming", false, true, true)).toEqual({
      mode: "send",
      disabled: false,
    });
  });

  test("submitted empty composer becomes an enabled stop button", () => {
    expect(resolveSubmitButton("submitted", true, true, false)).toEqual({
      mode: "stop",
      disabled: false,
    });
  });

  test("without a stop handler, a busy composer stays a disabled send button", () => {
    expect(resolveSubmitButton("submitted", true, false, false)).toEqual({
      mode: "send",
      disabled: true,
    });
  });

  test("send mode suppresses busy status so the button renders the send icon", () => {
    expect(resolveSubmitButtonStatus("streaming", "send")).toBeUndefined();
    expect(resolveSubmitButtonStatus("submitted", "send")).toBeUndefined();
  });

  test("stop mode preserves busy status so the button renders the stop affordance", () => {
    expect(resolveSubmitButtonStatus("streaming", "stop")).toBe("streaming");
    expect(resolveSubmitButtonStatus("submitted", "stop")).toBe("submitted");
  });

  test("sendBlocked disables an otherwise-ready send button (reconnect/reload)", () => {
    expect(resolveSubmitButton(undefined, false, true, false, true)).toEqual({
      mode: "send",
      disabled: true,
    });
  });

  test("sendBlocked disables the stop button too (can't stop over a dead socket)", () => {
    expect(resolveSubmitButton("streaming", true, true, false, true)).toEqual({
      mode: "stop",
      disabled: true,
    });
  });

  test("sendBlocked keeps a content send button disabled while streaming", () => {
    expect(resolveSubmitButton("streaming", false, true, true, true)).toEqual({
      mode: "send",
      disabled: true,
    });
  });
});

describe("steerMenuAvailable", () => {
  test("offered only when busy AND has content AND allowSteer", () => {
    expect(steerMenuAvailable({ status: "streaming", hasContent: true, allowSteer: true })).toBe(
      true,
    );
    expect(steerMenuAvailable({ status: "submitted", hasContent: true, allowSteer: true })).toBe(
      true,
    );
  });

  test("not offered when idle, empty, or steering disallowed (legacy runtime)", () => {
    expect(steerMenuAvailable({ status: undefined, hasContent: true, allowSteer: true })).toBe(
      false,
    );
    expect(steerMenuAvailable({ status: "streaming", hasContent: false, allowSteer: true })).toBe(
      false,
    );
    expect(steerMenuAvailable({ status: "streaming", hasContent: true, allowSteer: false })).toBe(
      false,
    );
  });

  test("not offered while the send path is blocked (reconnect/reload)", () => {
    expect(
      steerMenuAvailable({
        status: "streaming",
        hasContent: true,
        allowSteer: true,
        sendBlocked: true,
      }),
    ).toBe(false);
  });
});

describe("isCompactCommand", () => {
  test("matches only the hidden compact command", () => {
    expect(isCompactCommand("/compact")).toBe(true);
    expect(isCompactCommand("  /compact\n")).toBe(true);
    expect(isCompactCommand("/compact now")).toBe(false);
    expect(isCompactCommand("please /compact")).toBe(false);
  });
});
