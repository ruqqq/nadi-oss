import { inArray } from "drizzle-orm";
import { sql } from "drizzle-orm";
import { fanOutToUsers } from "../agent/fan-out";
import type { UserEvent } from "../agent/user-events";
import { registryDb } from "../db/client";
import { users } from "../db/schema";
import type { Env } from "../env";

function feedbackAdminEmails(env: Pick<Env, "FEEDBACK_ADMIN_EMAILS">): string[] {
  return (env.FEEDBACK_ADMIN_EMAILS ?? "")
    .split(",")
    .map((entry) => entry.trim().toLowerCase())
    .filter((entry) => entry.includes("@"));
}

export async function notifyFeedbackAdmins(env: Env, event: UserEvent): Promise<void> {
  try {
    if (event.type !== "feedback.report.created") return;
    const emails = feedbackAdminEmails(env);
    if (emails.length === 0) return;
    const rows = await registryDb(env)
      .select({ id: users.id })
      .from(users)
      .where(inArray(sql<string>`lower(${users.email})`, emails))
      .all();
    await fanOutToUsers(
      env.USER_HUB,
      rows.map((row) => row.id),
      event,
    );
  } catch {
    // Best-effort: a missed live notification must never fail report submission.
  }
}
