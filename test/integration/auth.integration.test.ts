import { SELF, env } from "cloudflare:test";
import { beforeAll, beforeEach, describe, expect, it } from "vitest";
import { drizzle } from "drizzle-orm/d1";
import { eq } from "drizzle-orm";
import * as schema from "../../src/db/schema";
import { applyRegistryTestSchema } from "./helpers/registry";
import { validateRequestSession } from "../../src/auth/session";

beforeAll(async () => {
  await applyRegistryTestSchema(env.REGISTRY_DB);
});

// Sign-in is invite-gated, so a brand-new email is rejected by default. These
// tests exercise OTP/session mechanics rather than the gate, so allow the whole
// example.com domain via the env escape hatch. Invite behavior is covered in
// invite-routes.integration.test.ts and unit/auth/invite-gate.test.ts.
beforeEach(() => {
  env.WHITELISTED_EMAILS = "example.com";
});

describe("auth routes", () => {
  it("routes Better Auth API paths", async () => {
    const res = await SELF.fetch("https://nadi.test/api/auth/session");
    expect([200, 401, 404]).toContain(res.status);
  });

  it("OTP request persists a verification record in D1", async () => {
    // Correct Better Auth v1.6 endpoint: /email-otp/send-verification-otp
    // Body requires both email and type; type "sign-in" triggers OTP creation
    // even for users that don't yet exist (disableSignUp not set).
    const res = await SELF.fetch("https://nadi.test/api/auth/email-otp/send-verification-otp", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ email: "persist-test@example.com", type: "sign-in" }),
    });
    // Better Auth returns 200 { success: true } on success
    expect([200, 201]).toContain(res.status);

    // Assert D1 row exists — confirms the adapter wrote to D1, not just memory
    const db = drizzle(env.REGISTRY_DB, { schema });
    const rows = await db.select().from(schema.verifications).all();
    const match = rows.find((r) => r.identifier.includes("persist-test@example.com"));
    expect(match).toBeDefined();
  });

  it("reuses an existing sign-in OTP when requesting another code", async () => {
    const email = "reuse-test@example.com";
    const send = () =>
      SELF.fetch("https://nadi.test/api/auth/email-otp/send-verification-otp", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ email, type: "sign-in" }),
      });

    expect((await send()).status).toBe(200);

    const db = drizzle(env.REGISTRY_DB, { schema });
    const first = await db.select().from(schema.verifications).all();
    const firstOtp = first
      .find((r) => r.identifier.includes(email))
      ?.value.split(":")
      .at(0);
    expect(firstOtp).toBeDefined();

    expect((await send()).status).toBe(200);

    const second = await db.select().from(schema.verifications).all();
    const matching = second.filter((r) => r.identifier.includes(email));
    expect(matching).toHaveLength(1);
    expect(matching[0]?.value.split(":").at(0)).toBe(firstOtp);

    const res = await SELF.fetch("https://nadi.test/api/auth/sign-in/email-otp", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ email, otp: firstOtp }),
    });
    expect(res.status).toBe(200);
  });

  it("validates the signed Better Auth session cookie from OTP sign-in", async () => {
    const email = "signed-cookie-test@example.com";
    const send = await SELF.fetch("https://nadi.test/api/auth/email-otp/send-verification-otp", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ email, type: "sign-in" }),
    });
    expect(send.status).toBe(200);

    const db = drizzle(env.REGISTRY_DB, { schema });
    const verification = (await db.select().from(schema.verifications).all()).find((row) =>
      row.identifier.includes(email),
    );
    const otp = verification?.value.split(":").at(0);
    expect(otp).toBeDefined();

    const signIn = await SELF.fetch("https://nadi.test/api/auth/sign-in/email-otp", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ email, otp }),
    });
    expect(signIn.status).toBe(200);

    const cookie = signIn.headers
      .get("set-cookie")
      ?.match(/(?:^|,\s*)((?:__Secure-)?better-auth\.session_token=[^;,]+)/)?.[1];
    expect(cookie).toBeDefined();

    await expect(
      validateRequestSession(
        env,
        new Request("https://nadi.test/protected", {
          headers: { cookie: cookie ?? "" },
        }),
      ),
    ).resolves.toMatchObject({ user: { email } });
  });

  it("blocks OTP requests from non-whitelisted emails and allows whitelisted domains", async () => {
    const previous = env.WHITELISTED_EMAILS;
    env.WHITELISTED_EMAILS = "allowed@example.com, whitelisted.test";
    try {
      const blocked = await SELF.fetch(
        "https://nadi.test/api/auth/email-otp/send-verification-otp",
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ email: "stranger@notallowed.test", type: "sign-in" }),
        },
      );
      expect(blocked.status).toBe(403);
      // The 403 has to carry this flag through Better Auth's error serializer,
      // or the client cannot tell "you're on the list" from "you're refused" and
      // shows a stranger a red failure for doing exactly what we asked.
      expect(await blocked.json()).toMatchObject({ waitlisted: true });

      const db = drizzle(env.REGISTRY_DB, { schema });
      const afterBlock = await db.select().from(schema.verifications).all();
      expect(
        afterBlock.find((r) => r.identifier.includes("stranger@notallowed.test")),
      ).toBeUndefined();

      // A blocked stranger lands on the waiting list rather than vanishing.
      const waiting = await db.select().from(schema.waitingList).all();
      expect(waiting.map((w) => w.email)).toContain("stranger@notallowed.test");

      const allowedByDomain = await SELF.fetch(
        "https://nadi.test/api/auth/email-otp/send-verification-otp",
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ email: "anyone@whitelisted.test", type: "sign-in" }),
        },
      );
      expect(allowedByDomain.status).toBe(200);
    } finally {
      env.WHITELISTED_EMAILS = previous;
    }
  });

  it("provisions an owner workspace for a brand-new user on first sign-in", async () => {
    const email = "fresh-user@example.com";
    const send = await SELF.fetch("https://nadi.test/api/auth/email-otp/send-verification-otp", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ email, type: "sign-in" }),
    });
    expect(send.status).toBe(200);

    const db = drizzle(env.REGISTRY_DB, { schema });
    const otp = (await db.select().from(schema.verifications).all())
      .find((row) => row.identifier.includes(email))
      ?.value.split(":")
      .at(0);
    expect(otp).toBeDefined();

    const signIn = await SELF.fetch("https://nadi.test/api/auth/sign-in/email-otp", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ email, otp }),
    });
    expect(signIn.status).toBe(200);

    const user = (await db.select().from(schema.users).all()).find((u) => u.email === email);
    expect(user).toBeDefined();
    if (!user) throw new Error("expected signed-in user to exist");

    const ownerMemberships = (await db.select().from(schema.workspaceMembers).all()).filter(
      (m) => m.userId === user.id && m.role === "owner",
    );
    expect(ownerMemberships).toHaveLength(1);

    const workspace = await db
      .select()
      .from(schema.workspaces)
      .where(eq(schema.workspaces.id, ownerMemberships[0]!.workspaceId))
      .get();
    expect(workspace).toBeDefined();
  });

  it("rejects a signed session cookie after the session is revoked in D1", async () => {
    const email = "revoked-cookie-test@example.com";
    const send = await SELF.fetch("https://nadi.test/api/auth/email-otp/send-verification-otp", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ email, type: "sign-in" }),
    });
    expect(send.status).toBe(200);

    const db = drizzle(env.REGISTRY_DB, { schema });
    const verification = (await db.select().from(schema.verifications).all()).find((row) =>
      row.identifier.includes(email),
    );
    const otp = verification?.value.split(":").at(0);
    expect(otp).toBeDefined();

    const signIn = await SELF.fetch("https://nadi.test/api/auth/sign-in/email-otp", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ email, otp }),
    });
    expect(signIn.status).toBe(200);

    const cookie = signIn.headers
      .get("set-cookie")
      ?.match(/(?:^|,\s*)((?:__Secure-)?better-auth\.session_token=[^;,]+)/)?.[1];
    expect(cookie).toBeDefined();

    const buildReq = () =>
      new Request("https://nadi.test/protected", { headers: { cookie: cookie ?? "" } });

    // The signed cookie validates while the session row is live.
    await expect(validateRequestSession(env, buildReq())).resolves.toMatchObject({
      user: { email },
    });

    // Revoke by deleting the user's session rows in D1.
    const user = (await db.select().from(schema.users).all()).find((u) => u.email === email);
    expect(user).toBeDefined();
    if (!user) throw new Error("expected signed-in user to exist");
    await db.delete(schema.sessions).where(eq(schema.sessions.userId, user.id));

    // getSession (disableCookieCache) must re-read D1 and reject the revoked session.
    await expect(validateRequestSession(env, buildReq())).resolves.toBeNull();
  });

  it("sign-out clears legacy and secure session cookies", async () => {
    const db = drizzle(env.REGISTRY_DB, { schema });
    const userId = "sign-out-legacy-user";
    const email = "sign-out-legacy@example.com";
    const token = "legacy-sign-out-token";
    await db.insert(schema.users).values({
      id: userId,
      email,
      emailVerified: false,
      createdAt: new Date(1),
      updatedAt: new Date(1),
    });
    await db.insert(schema.sessions).values({
      id: "sign-out-legacy-session",
      userId,
      token,
      expiresAt: new Date(Date.now() + 60_000),
      createdAt: new Date(1),
      updatedAt: new Date(1),
    });

    await expect(
      validateRequestSession(
        env,
        new Request("https://nadi.test/protected", {
          headers: { cookie: `better-auth.session_token=${token}` },
        }),
      ),
    ).resolves.toMatchObject({ user: { email } });

    const res = await SELF.fetch("https://nadi.test/api/auth/sign-out", {
      method: "POST",
      headers: {
        cookie: `better-auth.session_token=${token}`,
        origin: "https://nadi.test",
      },
      redirect: "manual",
    });
    expect(res.status).toBe(200);

    const setCookie = res.headers.get("set-cookie") ?? "";
    expect(setCookie).toContain("__Secure-better-auth.session_token=");
    expect(setCookie).toContain("better-auth.session_token=");

    await expect(
      validateRequestSession(
        env,
        new Request("https://nadi.test/protected", {
          headers: { cookie: `better-auth.session_token=${token}` },
        }),
      ),
    ).resolves.toBeNull();
  });

  // The session lifetime used to be Better Auth's invisible 7-day default, which
  // nothing in this repo had chosen. Pin it here so a change to it is a decision.
  it("issues a 30-day session on sign-in", async () => {
    const { setCookie } = await signIn("session-lifetime-test@example.com");

    expect(setCookie).toMatch(/Max-Age=2592000/);
  });

  // The renewal the client's 12-hour ping depends on. If this stops extending
  // the session, every active user is signed out 30 days after sign-in.
  it("extends a session that is due for renewal", async () => {
    const email = "session-renewal-test@example.com";
    const { cookie } = await signIn(email);

    const db = drizzle(env.REGISTRY_DB, { schema });
    const before = await sessionRowFor(db, email);

    // Backdate the session to look signed-in two days ago: past the 1-day
    // updateAge, so the next read is due to roll it forward.
    const backdated = new Date(Date.now() + THIRTY_DAYS_MS - 2 * DAY_MS);
    await db
      .update(schema.sessions)
      .set({ expiresAt: backdated })
      .where(eq(schema.sessions.id, before.id));

    const res = await SELF.fetch("https://nadi.test/api/auth/get-session", {
      headers: { cookie },
    });
    expect(res.status).toBe(200);

    // The row moved forward...
    const after = await sessionRowFor(db, email);
    expect(after.expiresAt.getTime()).toBeGreaterThan(backdated.getTime() + DAY_MS);

    // ...and the browser was told, or the cookie would still die on the old clock.
    expect(res.headers.get("set-cookie")).toMatch(/Max-Age=2592000/);
  });
});

const DAY_MS = 24 * 60 * 60 * 1000;
const THIRTY_DAYS_MS = 30 * DAY_MS;

async function signIn(email: string): Promise<{ cookie: string; setCookie: string }> {
  const send = await SELF.fetch("https://nadi.test/api/auth/email-otp/send-verification-otp", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ email, type: "sign-in" }),
  });
  expect(send.status).toBe(200);

  const db = drizzle(env.REGISTRY_DB, { schema });
  const verification = (await db.select().from(schema.verifications).all()).find((row) =>
    row.identifier.includes(email),
  );
  const otp = verification?.value.split(":").at(0);
  expect(otp).toBeDefined();

  const res = await SELF.fetch("https://nadi.test/api/auth/sign-in/email-otp", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ email, otp }),
  });
  expect(res.status).toBe(200);

  const setCookie = res.headers.get("set-cookie");
  if (setCookie === null) throw new Error("expected sign-in to set a session cookie");
  const cookie = setCookie.match(
    /(?:^|,\s*)((?:__Secure-)?better-auth\.session_token=[^;,]+)/,
  )?.[1];
  if (cookie === undefined) throw new Error("expected a session cookie in the sign-in response");
  return { cookie, setCookie };
}

async function sessionRowFor(db: ReturnType<typeof drizzle>, email: string) {
  const user = (await db.select().from(schema.users).all()).find((u) => u.email === email);
  if (!user) throw new Error(`expected a user for ${email}`);
  const row = (await db.select().from(schema.sessions).all()).find((s) => s.userId === user.id);
  if (!row) throw new Error(`expected a session for ${email}`);
  return row;
}
