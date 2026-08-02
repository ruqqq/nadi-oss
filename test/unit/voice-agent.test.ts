import { describe, it, expect } from "vitest";
// Imported from the pure module rather than voice-agent.ts (which re-exports it):
// voice-agent.ts pulls in `agents` → `cloudflare:workers`, unavailable in this project.
import { resolveVoiceLanguage } from "../../src/agent/voice-language";
import { VOICE_CALL_CEILING_MS } from "../../src/agent/voice-limits";

describe("VOICE_CALL_CEILING_MS", () => {
  // The server ceiling exists to kill a wedged or forged client, so it must sit
  // clear of the client's worst legitimate call: 5s idle + 30s of speech.
  it("sits comfortably above the client's worst legitimate call", () => {
    const worstClientCall = (5 + 30) * 1000;
    expect(VOICE_CALL_CEILING_MS).toBeGreaterThan(worstClientCall * 2);
  });
});

describe("resolveVoiceLanguage", () => {
  it("defaults to English when unset", () => {
    expect(resolveVoiceLanguage(undefined)).toBe("en");
  });

  it("defaults to English when empty", () => {
    expect(resolveVoiceLanguage("")).toBe("en");
  });

  it("passes a stored language through", () => {
    expect(resolveVoiceLanguage("es")).toBe("es");
  });
});
