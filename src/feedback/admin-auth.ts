import { validateRequestSession, type ValidatedSession } from "../auth/session";
import type { Env } from "../env";

export function isFeedbackAdmin(
  env: Pick<Env, "FEEDBACK_ADMIN_EMAILS">,
  email: string | null | undefined,
): boolean {
  if (!email) return false;
  const normalized = email.trim().toLowerCase();
  return (env.FEEDBACK_ADMIN_EMAILS ?? "")
    .split(",")
    .map((entry) => entry.trim().toLowerCase())
    .filter((entry) => entry.includes("@"))
    .includes(normalized);
}

export async function requireFeedbackAdmin(
  req: Request,
  env: Env,
): Promise<ValidatedSession | Response> {
  const session = await validateRequestSession(env, req);
  if (!session || !isFeedbackAdmin(env, session.user.email)) {
    return new Response("Not found", { status: 404, headers: { "Cache-Control": "no-store" } });
  }
  return session;
}
