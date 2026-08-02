import { describe, it, expect } from "vitest";
import { rewriteVoiceRoom } from "../../src/agent-routing/voice-room";

describe("rewriteVoiceRoom", () => {
  it("replaces the client-supplied room with the session user id", () => {
    const url = new URL("https://nadiai.app/agents/voice-agent/default");
    expect(rewriteVoiceRoom(url, "user-123").pathname).toBe("/agents/voice-agent/user-123");
  });

  it("discards a room naming another user", () => {
    const url = new URL("https://nadiai.app/agents/voice-agent/victim-user");
    expect(rewriteVoiceRoom(url, "attacker").pathname).toBe("/agents/voice-agent/attacker");
  });

  it("preserves the query string", () => {
    const url = new URL("https://nadiai.app/agents/voice-agent/default?_pk=1");
    expect(rewriteVoiceRoom(url, "u1").search).toBe("?_pk=1");
  });
});
