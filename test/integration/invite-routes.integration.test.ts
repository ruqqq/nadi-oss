import { SELF, env } from "cloudflare:test";
import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { drizzle } from "drizzle-orm/d1";
import { eq } from "drizzle-orm";
import * as schema from "../../src/db/schema";
import { canSignIn } from "../../src/auth/invite-gate";
import { applyRegistryTestSchema } from "./helpers/registry";

const now = 1_800_000_000_000;
const SUPERUSER = "boss@example.com";

const db = () => drizzle(env.REGISTRY_DB, { schema });
const cookie = (token: string) => ({ cookie: `better-auth.session_token=${token}` });

/**
 * Integration tests disable real email delivery. Temporarily enable the binding
 * and swap in a fake `send` so waitlist-acceptance mail can be asserted.
 */
function stubAuthEmailDelivery(send: ReturnType<typeof vi.fn>): () => void {
  const mutable = env as unknown as {
    EMAIL_DELIVERY_DISABLED?: string;
    EMAIL: { send: typeof send };
  };
  const previousDisabled = mutable.EMAIL_DELIVERY_DISABLED;
  const previousEmail = mutable.EMAIL;
  mutable.EMAIL_DELIVERY_DISABLED = "";
  mutable.EMAIL = { send };
  return () => {
    if (previousDisabled === undefined) {
      delete mutable.EMAIL_DELIVERY_DISABLED;
    } else {
      mutable.EMAIL_DELIVERY_DISABLED = previousDisabled;
    }
    mutable.EMAIL = previousEmail;
  };
}

async function seedUser(id: string, email: string, token: string) {
  await db()
    .insert(schema.users)
    .values({
      id,
      email,
      name: null,
      createdAt: new Date(now),
      emailVerified: true,
      image: null,
      updatedAt: new Date(now),
    });
  await db()
    .insert(schema.sessions)
    .values({
      id: `sess-${id}`,
      userId: id,
      token,
      expiresAt: new Date(now + 60_000),
      createdAt: new Date(now),
      updatedAt: new Date(now),
      ipAddress: null,
      userAgent: null,
    });
  return { id, email, token };
}

/** Give `inviterId` `count` already-accepted invites, burning that many slots. */
async function burnSlots(inviterId: string, count: number) {
  for (let i = 0; i < count; i++) {
    const acceptedId = `burned-user-${inviterId}-${i}`;
    await seedUser(acceptedId, `burned-${inviterId}-${i}@example.com`, `burned-tok-${acceptedId}`);
    await db()
      .insert(schema.invites)
      .values({
        id: `burned-invite-${inviterId}-${i}`,
        token: null,
        inviterUserId: inviterId,
        email: `burned-${inviterId}-${i}@example.com`,
        status: "accepted",
        acceptedUserId: acceptedId,
        createdAt: now,
        claimedAt: now,
        acceptedAt: now,
      });
  }
}

beforeAll(async () => {
  await applyRegistryTestSchema(env.REGISTRY_DB);
});

beforeEach(() => {
  env.SUPERUSER_EMAILS = SUPERUSER;
  // The env allowlist is a separate escape hatch; keep it out of the way so
  // these tests exercise the invite gate itself.
  env.WHITELISTED_EMAILS = "";
});

describe("invite gate (canSignIn)", () => {
  it("allows a superuser", async () => {
    await expect(canSignIn(env, db(), SUPERUSER)).resolves.toEqual({ allowed: true });
  });

  it("grandfathers an existing user with no invite row", async () => {
    await seedUser("legacy", "legacy@example.com", "legacy-tok");
    await expect(canSignIn(env, db(), "legacy@example.com")).resolves.toEqual({ allowed: true });
  });

  it("denies an unknown email and puts it on the waiting list", async () => {
    await expect(canSignIn(env, db(), "Stranger@Example.com")).resolves.toEqual({
      allowed: false,
      reason: "not-invited",
      waitlisted: true,
    });

    const waiting = await db().select().from(schema.waitingList).all();
    // Stored lowercased.
    expect(waiting.map((w) => w.email)).toEqual(["stranger@example.com"]);
    expect(waiting[0]?.attempts).toBe(1);

    // A second attempt bumps the counter rather than duplicating the row.
    await canSignIn(env, db(), "stranger@example.com");
    const again = await db().select().from(schema.waitingList).all();
    expect(again).toHaveLength(1);
    expect(again[0]?.attempts).toBe(2);
  });

  it("allows a claimed invite while the inviter is under quota", async () => {
    const inviter = await seedUser("inviter", "inviter@example.com", "inviter-tok");
    await burnSlots(inviter.id, 4);
    await db().insert(schema.invites).values({
      id: "inv-under",
      token: "tok-under",
      inviterUserId: inviter.id,
      email: "guest@example.com",
      status: "claimed",
      createdAt: now,
      claimedAt: now,
    });

    await expect(canSignIn(env, db(), "guest@example.com")).resolves.toEqual({ allowed: true });
  });

  it("denies a claimed invite once the inviter has spent all 5 slots", async () => {
    const inviter = await seedUser("inviter", "inviter@example.com", "inviter-tok");
    await burnSlots(inviter.id, 5);
    await db().insert(schema.invites).values({
      id: "inv-over",
      token: "tok-over",
      inviterUserId: inviter.id,
      email: "guest@example.com",
      status: "claimed",
      createdAt: now,
      claimedAt: now,
    });

    await expect(canSignIn(env, db(), "guest@example.com")).resolves.toEqual({
      allowed: false,
      reason: "inviter-out-of-invites",
      waitlisted: false,
    });
  });

  it("ignores the quota when the inviter is a superuser", async () => {
    const boss = await seedUser("boss", SUPERUSER, "boss-tok");
    await burnSlots(boss.id, 7);
    await db().insert(schema.invites).values({
      id: "inv-boss",
      token: null,
      inviterUserId: boss.id,
      email: "guest@example.com",
      status: "claimed",
      createdAt: now,
      claimedAt: now,
    });

    await expect(canSignIn(env, db(), "guest@example.com")).resolves.toEqual({ allowed: true });
  });

  it("does not allow an unclaimed link's token holder until they claim it", async () => {
    const inviter = await seedUser("inviter", "inviter@example.com", "inviter-tok");
    await db().insert(schema.invites).values({
      id: "inv-pending",
      token: "tok-pending",
      inviterUserId: inviter.id,
      email: null,
      status: "pending",
      createdAt: now,
    });

    await expect(canSignIn(env, db(), "guest@example.com")).resolves.toMatchObject({
      allowed: false,
      reason: "not-invited",
    });
  });
});

describe("invite routes", () => {
  it("requires a session to list or create", async () => {
    expect((await SELF.fetch("https://nadi.test/api/invites")).status).toBe(401);
    expect((await SELF.fetch("https://nadi.test/api/invites", { method: "POST" })).status).toBe(
      401,
    );
  });

  it("creates a link, previews it, claims it, and opens the OTP gate", async () => {
    const inviter = await seedUser("inviter", "inviter@example.com", "inviter-tok");

    // The invitee is blocked before any invite exists.
    const before = await SELF.fetch("https://nadi.test/api/auth/email-otp/send-verification-otp", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ email: "guest@example.com", type: "sign-in" }),
    });
    expect(before.status).toBe(403);

    const created = await SELF.fetch("https://nadi.test/api/invites", {
      method: "POST",
      headers: { "Content-Type": "application/json", ...cookie(inviter.token) },
      body: JSON.stringify({}),
    });
    expect(created.status).toBe(201);
    const { invite } = (await created.json()) as {
      invite: { id: string; token: string; status: string };
    };
    expect(invite.status).toBe("pending");
    expect(invite.token).toBeTruthy();

    // Public preview names the inviter so the sign-in page can show a banner.
    const preview = await SELF.fetch(`https://nadi.test/api/invites/claim?token=${invite.token}`);
    expect(preview.status).toBe(200);
    expect(await preview.json()).toEqual({ valid: true, inviterEmail: "inviter@example.com" });

    // Claim binds the link to an email.
    const claim = await SELF.fetch("https://nadi.test/api/invites/claim", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ token: invite.token, email: "guest@example.com" }),
    });
    expect(claim.status).toBe(204);

    // The gate now lets that email through, and an OTP is issued.
    const after = await SELF.fetch("https://nadi.test/api/auth/email-otp/send-verification-otp", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ email: "guest@example.com", type: "sign-in" }),
    });
    expect(after.status).toBe(200);

    const otp = (await db().select().from(schema.verifications).all())
      .find((row) => row.identifier.includes("guest@example.com"))
      ?.value.split(":")
      .at(0);
    expect(otp).toBeDefined();

    const signIn = await SELF.fetch("https://nadi.test/api/auth/sign-in/email-otp", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ email: "guest@example.com", otp }),
    });
    expect(signIn.status).toBe(200);

    // Signing in is what spends the slot.
    const row = await db()
      .select()
      .from(schema.invites)
      .where(eq(schema.invites.id, invite.id))
      .get();
    expect(row?.status).toBe("accepted");
    expect(row?.acceptedUserId).toBeTruthy();

    const list = await SELF.fetch("https://nadi.test/api/invites", {
      headers: cookie(inviter.token),
    });
    expect(await list.json()).toMatchObject({
      quota: { used: 1, limit: 5 },
      isSuperuser: false,
    });
  });

  it("refuses a claimed link to a second email, and is idempotent for the same one", async () => {
    const inviter = await seedUser("inviter", "inviter@example.com", "inviter-tok");
    await db().insert(schema.invites).values({
      id: "inv-1",
      token: "tok-1",
      inviterUserId: inviter.id,
      email: null,
      status: "pending",
      createdAt: now,
    });

    const claim = (email: string) =>
      SELF.fetch("https://nadi.test/api/invites/claim", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ token: "tok-1", email }),
      });

    expect((await claim("first@example.com")).status).toBe(204);
    expect((await claim("first@example.com")).status).toBe(204);
    expect((await claim("second@example.com")).status).toBe(409);
  });

  it("blocks an ordinary user from creating a 6th invite", async () => {
    const inviter = await seedUser("inviter", "inviter@example.com", "inviter-tok");
    await burnSlots(inviter.id, 5);

    const res = await SELF.fetch("https://nadi.test/api/invites", {
      method: "POST",
      headers: { "Content-Type": "application/json", ...cookie(inviter.token) },
      body: JSON.stringify({}),
    });
    expect(res.status).toBe(403);
  });

  it("lets a superuser invite a waiting-list email directly and clears the entry", async () => {
    const boss = await seedUser("boss", SUPERUSER, "boss-tok");
    const send = vi.fn(async () => ({ messageId: "email_waitlist_1" }));
    const restoreEmail = stubAuthEmailDelivery(send);

    try {
      // Stranger tries to sign in and lands on the waiting list.
      await SELF.fetch("https://nadi.test/api/auth/email-otp/send-verification-otp", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ email: "hopeful@example.com", type: "sign-in" }),
      });

      const listed = await SELF.fetch("https://nadi.test/api/invites", {
        headers: cookie(boss.token),
      });
      expect(await listed.json()).toMatchObject({
        isSuperuser: true,
        quota: { limit: null },
        waitingList: [{ email: "hopeful@example.com", attempts: 1 }],
      });

      const invited = await SELF.fetch("https://nadi.test/api/invites", {
        method: "POST",
        headers: { "Content-Type": "application/json", ...cookie(boss.token) },
        body: JSON.stringify({ email: "hopeful@example.com" }),
      });
      expect(invited.status).toBe(201);

      // Off the waiting list, and now able to request an OTP.
      expect(await db().select().from(schema.waitingList).all()).toHaveLength(0);
      expect(send).toHaveBeenCalledWith({
        from: { name: "Nadi", email: "signin@nadi.test" },
        to: "hopeful@example.com",
        subject: "You're in — sign in to Nadi",
        text: "There's room for you on Nadi. Sign in at https://nadi.test with this email address.",
      });
      const otpRes = await SELF.fetch(
        "https://nadi.test/api/auth/email-otp/send-verification-otp",
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ email: "hopeful@example.com", type: "sign-in" }),
        },
      );
      expect(otpRes.status).toBe(200);
    } finally {
      restoreEmail();
    }
  });

  it("still admits a waiting-list email when acceptance mail fails to send", async () => {
    const boss = await seedUser("boss", SUPERUSER, "boss-tok");
    const send = vi.fn(async () => {
      throw new Error("binding rejected");
    });
    const restoreEmail = stubAuthEmailDelivery(send);

    try {
      await SELF.fetch("https://nadi.test/api/auth/email-otp/send-verification-otp", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ email: "resilient@example.com", type: "sign-in" }),
      });

      const invited = await SELF.fetch("https://nadi.test/api/invites", {
        method: "POST",
        headers: { "Content-Type": "application/json", ...cookie(boss.token) },
        body: JSON.stringify({ email: "resilient@example.com" }),
      });
      expect(invited.status).toBe(201);
      expect(await db().select().from(schema.waitingList).all()).toHaveLength(0);
      expect(send).toHaveBeenCalled();
      // Gate opens even though delivery failed — the invite row is what matters.
      await expect(canSignIn(env, db(), "resilient@example.com")).resolves.toEqual({
        allowed: true,
      });
    } finally {
      restoreEmail();
    }
  });

  it("does not let an ordinary user invite a specific email or see the waiting list", async () => {
    const inviter = await seedUser("inviter", "inviter@example.com", "inviter-tok");
    await SELF.fetch("https://nadi.test/api/auth/email-otp/send-verification-otp", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ email: "hopeful@example.com", type: "sign-in" }),
    });

    const res = await SELF.fetch("https://nadi.test/api/invites", {
      method: "POST",
      headers: { "Content-Type": "application/json", ...cookie(inviter.token) },
      body: JSON.stringify({ email: "hopeful@example.com" }),
    });
    expect(res.status).toBe(403);

    const listed = await SELF.fetch("https://nadi.test/api/invites", {
      headers: cookie(inviter.token),
    });
    expect(await listed.json()).toMatchObject({ isSuperuser: false, waitingList: [] });
  });

  it("revokes a pending invite but not an accepted one", async () => {
    const inviter = await seedUser("inviter", "inviter@example.com", "inviter-tok");
    await burnSlots(inviter.id, 1);
    await db().insert(schema.invites).values({
      id: "inv-pending",
      token: "tok-pending",
      inviterUserId: inviter.id,
      email: null,
      status: "pending",
      createdAt: now,
    });

    const revoked = await SELF.fetch("https://nadi.test/api/invites/inv-pending", {
      method: "DELETE",
      headers: cookie(inviter.token),
    });
    expect(revoked.status).toBe(204);

    const accepted = await SELF.fetch("https://nadi.test/api/invites/burned-invite-inviter-0", {
      method: "DELETE",
      headers: cookie(inviter.token),
    });
    expect(accepted.status).toBe(409);
  });

  it("does not let a user revoke someone else's invite", async () => {
    const inviter = await seedUser("inviter", "inviter@example.com", "inviter-tok");
    const other = await seedUser("other", "other@example.com", "other-tok");
    await db().insert(schema.invites).values({
      id: "inv-theirs",
      token: "tok-theirs",
      inviterUserId: inviter.id,
      email: null,
      status: "pending",
      createdAt: now,
    });

    const res = await SELF.fetch("https://nadi.test/api/invites/inv-theirs", {
      method: "DELETE",
      headers: cookie(other.token),
    });
    expect(res.status).toBe(404);
  });
});
