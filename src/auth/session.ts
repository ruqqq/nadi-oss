import { and, eq, gt } from "drizzle-orm";
import type { Env } from "../env";
import { registryDb } from "../db/client";
import { sessions, users } from "../db/schema";
import { buildAuth } from "./options";

export interface AuthenticatedUser {
  id: string;
  email: string;
}

export interface AuthenticatedRequest {
  user: AuthenticatedUser;
}

export interface ValidatedSession {
  user: AuthenticatedUser;
  sessionId: string;
}

const SESSION_COOKIE_NAMES = ["better-auth.session_token", "__Secure-better-auth.session_token"];

export function readSessionCookie(req: Request): string | null {
  const raw = req.headers.get("cookie");
  if (!raw) return null;
  const pairs = raw.split(";").map((part) => part.trim());
  for (const pair of pairs) {
    const index = pair.indexOf("=");
    if (index === -1) continue;
    const name = pair.slice(0, index);
    if (SESSION_COOKIE_NAMES.includes(name)) return decodeURIComponent(pair.slice(index + 1));
  }
  return null;
}

export async function validateSessionToken(
  env: Env,
  token: string,
  nowMs = Date.now(),
): Promise<ValidatedSession | null> {
  if (token.trim().length === 0) return null;

  const db = registryDb(env);
  const row = await db
    .select({
      sessionId: sessions.id,
      userId: users.id,
      email: users.email,
    })
    .from(sessions)
    .innerJoin(users, eq(users.id, sessions.userId))
    .where(and(eq(sessions.token, token), gt(sessions.expiresAt, new Date(nowMs))))
    .get();

  if (!row) return null;

  return {
    sessionId: row.sessionId,
    user: {
      id: row.userId,
      email: row.email,
    },
  };
}

export async function validateRequestSession(
  env: Env,
  req: Request,
  nowMs = Date.now(),
): Promise<ValidatedSession | null> {
  // disableRefresh is deliberate: this reads the session for authorization, and
  // renewing here would be both wasteful (a D1 write per authenticated request)
  // and pointless (callers use the returned object, so the Set-Cookie that
  // carries the renewed expiry would be dropped). Renewal is the client's ping
  // to /api/auth/get-session — see web/src/lib/session-renewal.ts.
  const authSession = await buildAuth(env).api.getSession({
    headers: req.headers,
    query: { disableCookieCache: true, disableRefresh: true },
  });
  if (authSession) {
    return {
      sessionId: authSession.session.id,
      user: {
        id: authSession.user.id,
        email: authSession.user.email,
      },
    };
  }

  const token = readSessionCookie(req);
  if (!token) return null;
  return validateSessionToken(env, token, nowMs);
}
