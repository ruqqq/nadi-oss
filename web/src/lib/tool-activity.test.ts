import { describe, expect, it } from "vitest";
import type { ToolUIPart } from "ai";
import { isActiveToolState } from "./tool-activity";

describe("isActiveToolState", () => {
  it.each(["input-streaming", "input-available", "approval-responded"] as const)(
    "treats %s as active tool work",
    (state) => {
      expect(isActiveToolState(state)).toBe(true);
    },
  );

  it.each(["approval-requested", "output-available", "output-error", "output-denied"] as const)(
    "treats %s as inactive tool work",
    (state) => {
      expect(isActiveToolState(state as ToolUIPart["state"])).toBe(false);
    },
  );
});
