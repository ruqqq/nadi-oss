import type { Env } from "../env";
import { buildAuth } from "../auth/options";
import { validateSessionToken } from "../auth/session";
import { registryDb } from "../db/client";
import { sessions } from "../db/schema";
import { eq } from "drizzle-orm";

export async function routeAuth(req: Request, env: Env): Promise<Response | null> {
  const url = new URL(req.url);
  if (!url.pathname.startsWith("/api/auth/")) return null;
  if (url.pathname === "/api/auth/sign-out" && req.method === "POST") {
    return signOut(req, env);
  }
  return buildAuth(env).handler(req);
}

async function signOut(req: Request, env: Env): Promise<Response> {
  const legacySession = await readLegacySession(req, env);
  const res = await buildAuth(env).handler(req);
  if (legacySession !== null) {
    await registryDb(env).delete(sessions).where(eq(sessions.id, legacySession.sessionId));
  }

  const headers = new Headers(res.headers);
  expireSessionCookie(headers, "better-auth.session_token", false);
  expireSessionCookie(headers, "__Secure-better-auth.session_token", true);
  return new Response(res.body, {
    status: res.status,
    statusText: res.statusText,
    headers,
  });
}

async function readLegacySession(req: Request, env: Env) {
  const token = readCookie(req, "better-auth.session_token");
  if (token === null) return null;
  return validateSessionToken(env, token);
}

function readCookie(req: Request, name: string): string | null {
  const raw = req.headers.get("cookie");
  if (!raw) return null;
  const pairs = raw.split(";").map((part) => part.trim());
  for (const pair of pairs) {
    const index = pair.indexOf("=");
    if (index === -1) continue;
    if (pair.slice(0, index) === name) return decodeURIComponent(pair.slice(index + 1));
  }
  return null;
}

function expireSessionCookie(headers: Headers, name: string, secure: boolean): void {
  headers.append(
    "Set-Cookie",
    `${name}=; Max-Age=0; Path=/; HttpOnly; SameSite=Lax${secure ? "; Secure" : ""}`,
  );
}
