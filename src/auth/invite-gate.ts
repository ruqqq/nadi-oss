import { eq } from "drizzle-orm";
import type { DrizzleD1Database } from "drizzle-orm/d1";
import { users } from "../db/schema";
import type * as schema from "../db/schema";
import {
  INVITE_LIMIT,
  InviteRepository,
  WaitingListRepository,
  normalizeEmail,
} from "../db/repositories/invites";
import { isEmailAllowed } from "./email-whitelist";

type Db = DrizzleD1Database<typeof schema>;

/**
 * Superusers get unlimited invites and can see/act on the waiting list.
 * Same parsing as the `WHITELISTED_EMAILS` allowlist: comma-separated, exact
 * emails only, case-insensitive, trimmed.
 */
export function isSuperuser(email: string, raw: string | undefined): boolean {
  const candidate = normalizeEmail(email);
  if (candidate === "") return false;
  return (raw ?? "")
    .split(",")
    .map((entry) => entry.trim().toLowerCase())
    .filter((entry) => entry.length > 0)
    .includes(candidate);
}

export type SignInDecision =
  // Allowed through to the OTP.
  | { allowed: true }
  // Blocked; `waitlisted` is true when we recorded them on the waiting list.
  | { allowed: false; reason: "not-invited" | "inviter-out-of-invites"; waitlisted: boolean };

export interface SignInGateEnv {
  SUPERUSER_EMAILS?: string;
  WHITELISTED_EMAILS?: string;
}

/**
 * The sign-in gate. Runs before any OTP is created, so a denied email never
 * receives a code and never gets a `users` row (Better Auth signs up
 * implicitly on first successful OTP).
 */
export async function canSignIn(
  env: SignInGateEnv,
  db: Db,
  rawEmail: string,
): Promise<SignInDecision> {
  const email = normalizeEmail(rawEmail);
  if (email === "") return { allowed: false, reason: "not-invited", waitlisted: false };

  if (isSuperuser(email, env.SUPERUSER_EMAILS)) return { allowed: true };

  // Env allowlist stays as a dev/bootstrap escape hatch. It's empty in prod, and
  // `isEmailAllowed` returns true for everyone when empty — so only honour it
  // when it is actually configured.
  const whitelist = (env.WHITELISTED_EMAILS ?? "").trim();
  if (whitelist !== "" && isEmailAllowed(email, whitelist)) return { allowed: true };

  // Existing accounts are grandfathered in, invite row or not.
  const existing = await db
    .select({ id: users.id })
    .from(users)
    .where(eq(users.email, email))
    .get();
  if (existing) return { allowed: true };

  const inviteRepo = new InviteRepository(db);
  const invite = await inviteRepo.findByEmail(email);

  if (invite && invite.status !== "pending") {
    if (invite.status === "accepted") return { allowed: true };

    // Claimed: the slot is only spent on acceptance, so re-check the inviter's
    // quota here — this is where the 5-invite cap is actually enforced.
    const inviterEmail = await db
      .select({ email: users.email })
      .from(users)
      .where(eq(users.id, invite.inviterUserId))
      .get();
    if (inviterEmail && isSuperuser(inviterEmail.email, env.SUPERUSER_EMAILS)) {
      return { allowed: true };
    }
    const used = await inviteRepo.countAccepted(invite.inviterUserId);
    if (used < INVITE_LIMIT) return { allowed: true };
    return { allowed: false, reason: "inviter-out-of-invites", waitlisted: false };
  }

  await new WaitingListRepository(db).record(email);
  return { allowed: false, reason: "not-invited", waitlisted: true };
}
