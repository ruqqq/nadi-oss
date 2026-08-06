import { SELF, env, runInDurableObject } from "cloudflare:test";
import { beforeAll, describe, expect, it, vi } from "vitest";
import { drizzle } from "drizzle-orm/d1";
import * as schema from "../../src/db/schema";
import { applyRegistryTestSchema } from "./helpers/registry";

const now = 1_800_000_000_000;
// NADI_PLATFORM is a celld-only var, absent from the Cloudflare-generated env
// type; the pool env object still accepts it (see the NADI_PLATFORM mutations
// below, which the runtime reads).
const featureEnv = env as typeof env & { NADI_PLATFORM?: string | undefined };

async function seedUser(userId: string, token: string) {
  const db = drizzle(env.REGISTRY_DB, { schema });
  await db.insert(schema.users).values({
    id: userId,
    email: `${userId}@example.com`,
    name: null,
    createdAt: new Date(now),
    emailVerified: true,
    image: null,
    updatedAt: new Date(now),
  });
  await db.insert(schema.sessions).values({
    id: `session-${userId}`,
    userId,
    token,
    expiresAt: new Date(now + 60_000),
    createdAt: new Date(now),
    updatedAt: new Date(now),
    ipAddress: null,
    userAgent: null,
  });
}

describe("voice dictation routing", () => {
  beforeAll(async () => {
    await applyRegistryTestSchema(env.REGISTRY_DB);
  });

  it("rejects an unauthenticated websocket upgrade", async () => {
    const res = await SELF.fetch("https://nadi.test/agents/voice-agent/default", {
      headers: { upgrade: "websocket" },
    });
    expect(res.status).toBe(401);
  });

  it("routes a client-supplied room naming another user to the SESSION user's DO, not the victim's", async () => {
    await seedUser("victim", "victim-token");
    await seedUser("attacker", "attacker-token");

    // Authenticated as "attacker", but the WS path names "victim"'s room —
    // exactly what a malicious/misbehaving client could send.
    const res = await SELF.fetch("https://nadi.test/agents/voice-agent/victim", {
      headers: { upgrade: "websocket", cookie: "better-auth.session_token=attacker-token" },
    });
    expect(res.status).toBe(101);

    // Assert on DO identity directly (not on the HTTP response): the victim's
    // VoiceAgent DO must never see a connection, and the session user's DO must.
    const victimStub = env.VOICE_AGENT.get(env.VOICE_AGENT.idFromName("victim"));
    const attackerStub = env.VOICE_AGENT.get(env.VOICE_AGENT.idFromName("attacker"));

    await vi.waitFor(async () => {
      const attackerSocketCount = await runInDurableObject(
        attackerStub,
        (instance) => [...instance.getConnections()].length,
      );
      expect(attackerSocketCount).toBe(1);
    });

    const victimSocketCount = await runInDurableObject(
      victimStub,
      (instance) => [...instance.getConnections()].length,
    );
    expect(victimSocketCount).toBe(0);
  });

  // The kill switch has to bite on the server, not just hide the mic: a forged
  // socket must bill no audio. beforeCallStart runs before createTranscriber, so
  // returning false is what stops a transcriber from ever starting.
  it("starts no transcriber when VOICE_INPUT_ENABLED is off", async () => {
    const previous = env.VOICE_INPUT_ENABLED;
    env.VOICE_INPUT_ENABLED = "";
    try {
      const stub = env.VOICE_AGENT.get(env.VOICE_AGENT.idFromName("flag-off"));
      const started = await runInDurableObject(stub, (instance) =>
        instance.beforeCallStart({} as never),
      );
      expect(started).toBe(false);
    } finally {
      env.VOICE_INPUT_ENABLED = previous;
    }
  });

  it("starts a transcriber when VOICE_INPUT_ENABLED is on", async () => {
    const previous = env.VOICE_INPUT_ENABLED;
    env.VOICE_INPUT_ENABLED = "true";
    try {
      await seedUser("flag-on", "flag-on-token");
      const stub = env.VOICE_AGENT.get(env.VOICE_AGENT.idFromName("flag-on"));
      const started = await runInDurableObject(stub, (instance) =>
        instance.beforeCallStart({} as never),
      );
      expect(started).toBe(true);
    } finally {
      env.VOICE_INPUT_ENABLED = previous;
    }
  });

  // celld has no AI binding: the platform capability gate must refuse even
  // when the operator turns VOICE_INPUT_ENABLED on. Same DO path as the flag
  // kill switch — a boolean return, no error across the RPC boundary.
  it("starts no transcriber on celld even when VOICE_INPUT_ENABLED is on", async () => {
    const previousPlatform = featureEnv.NADI_PLATFORM;
    const previousFlag = env.VOICE_INPUT_ENABLED;
    featureEnv.NADI_PLATFORM = "celld";
    env.VOICE_INPUT_ENABLED = "true";
    try {
      const stub = env.VOICE_AGENT.get(env.VOICE_AGENT.idFromName("celld-flag-on"));
      const started = await runInDurableObject(stub, (instance) =>
        instance.beforeCallStart({} as never),
      );
      expect(started).toBe(false);
    } finally {
      featureEnv.NADI_PLATFORM = previousPlatform;
      env.VOICE_INPUT_ENABLED = previousFlag;
    }
  });
});
