import { describe, expect, it } from "vitest";
import { backgroundWorkEnabled } from "../../src/flags";

describe("backgroundWorkEnabled", () => {
  it.each([undefined, "", "false", "0", "off", "unexpected"])(
    "disables background work for %s",
    (value) => {
      expect(backgroundWorkEnabled({ BACKGROUND_WORK_ENABLED: value })).toBe(false);
    },
  );

  it.each(["1", "true", "TRUE", "yes", "YES"])("enables background work for %s", (value) => {
    expect(backgroundWorkEnabled({ BACKGROUND_WORK_ENABLED: value })).toBe(true);
  });
});
