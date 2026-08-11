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

  // Duration is billed while the DO is resident, and a socket accepted with
  // `connection.accept()` pins it for the whole time the tab is open — which is
  // minutes of dead air per dictation. Handing the socket to the runtime with
  // ctx.acceptWebSocket() instead lets an idle connection hibernate, which is
  // what @cloudflare/voice already assumes (it takes an explicit keepAlive() for
  // the duration of a call and releases it at end_call).
  //
  // getWebSockets() is exactly the difference: partyserver's non-hibernating
  // manager calls connection.accept() (partyserver/dist/index.js:196) and the
  // runtime never learns about the socket; the hibernating manager calls
  // ctx.acceptWebSocket() (line 243) and it shows up here.
  it("hands voice sockets to the runtime so an idle connection can hibernate", async () => {
    await seedUser("hibernator", "hibernator-token");
    const res = await SELF.fetch("https://nadi.test/agents/voice-agent/hibernator", {
      headers: { upgrade: "websocket", cookie: "better-auth.session_token=hibernator-token" },
    });
    expect(res.status).toBe(101);

    const stub = env.VOICE_AGENT.get(env.VOICE_AGENT.idFromName("hibernator"));
    await vi.waitFor(async () => {
      const runtimeOwned = await runInDurableObject(
        stub,
        (_instance, state) => state.getWebSockets().length,
      );
      expect(runtimeOwned).toBe(1);
    });
  });

  // The ceiling is the only server-side bound on how long one client can bill
  // audio, and under hibernation a setTimeout is instance state: it dies with the
  // isolate and takes the guarantee with it, silently. The mixin's keepAlive()
  // usually keeps the object resident for the length of a call, which makes the
  // failure rare rather than impossible — the wrong property for a cost guard.
  // A schedule row is durable, so the ceiling survives whatever happens to the
  // instance.
  it("arms the call ceiling durably, so losing the instance cannot lose the ceiling", async () => {
    const stub = env.VOICE_AGENT.get(env.VOICE_AGENT.idFromName("ceiling-armed"));
    const schedules = await runInDurableObject(stub, async (instance) => {
      await instance.onCallStart({ id: "conn-1" } as never);
      return instance.listSchedules();
    });
    expect(schedules).toHaveLength(1);
  });

  it("clears the durable ceiling when the call ends", async () => {
    const stub = env.VOICE_AGENT.get(env.VOICE_AGENT.idFromName("ceiling-cleared"));
    const remaining = await runInDurableObject(stub, async (instance) => {
      await instance.onCallStart({ id: "conn-1" } as never);
      await instance.onCallEnd({ id: "conn-1" } as never);
      return instance.listSchedules();
    });
    expect(remaining).toHaveLength(0);
  });

  // The DO is per-user and shared across every tab, so the ceilings have to stay
  // keyed by connection — one tab ending its call must not disarm another's.
  it("ends one tab's call without disarming another tab's ceiling", async () => {
    const stub = env.VOICE_AGENT.get(env.VOICE_AGENT.idFromName("ceiling-two-tabs"));
    const remaining = await runInDurableObject(stub, async (instance) => {
      await instance.onCallStart({ id: "tab-a" } as never);
      await instance.onCallStart({ id: "tab-b" } as never);
      await instance.onCallEnd({ id: "tab-a" } as never);
      return instance.listSchedules();
    });
    expect(remaining).toHaveLength(1);
    expect((remaining[0]?.payload as { connectionId?: string })?.connectionId).toBe("tab-b");
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
