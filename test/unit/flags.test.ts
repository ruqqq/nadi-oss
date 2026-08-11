import { describe, expect, it } from "vitest";
import { backgroundWorkEnabled, voiceInputEnabled } from "../../src/flags";

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

describe("voiceInputEnabled", () => {
  it("refuses on celld even when VOICE_INPUT_ENABLED is on", () => {
    // celld has no AI binding; the flag can only turn voice OFF, never on.
    expect(voiceInputEnabled({ NADI_PLATFORM: "celld", VOICE_INPUT_ENABLED: "true" })).toBe(false);
  });

  it("refuses on celld when the flag is off too", () => {
    expect(voiceInputEnabled({ NADI_PLATFORM: "celld", VOICE_INPUT_ENABLED: "false" })).toBe(false);
    expect(voiceInputEnabled({ NADI_PLATFORM: "celld" })).toBe(false);
  });

  it("allows on cloudflare when the flag is on", () => {
    expect(voiceInputEnabled({ VOICE_INPUT_ENABLED: "true" })).toBe(true);
    expect(voiceInputEnabled({ NADI_PLATFORM: "cloudflare", VOICE_INPUT_ENABLED: "1" })).toBe(true);
  });

  it("refuses on cloudflare when the flag is off", () => {
    expect(voiceInputEnabled({ VOICE_INPUT_ENABLED: "false" })).toBe(false);
    expect(voiceInputEnabled({})).toBe(false);
  });
});
