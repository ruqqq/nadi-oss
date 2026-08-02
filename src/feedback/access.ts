import { registryDb } from "../db/client";
import { FeedbackRepository } from "../db/repositories/feedback";
import type { Env } from "../env";

export interface FeedbackThreadScope {
  userId: string;
  workspaceId: string;
  threadId: string;
}

export async function assertFeedbackReporter(
  env: Env,
  threadId: string,
  userId: string,
): Promise<FeedbackThreadScope | null> {
  const mapping = await new FeedbackRepository(registryDb(env)).getThreadForUser(userId);
  if (!mapping || mapping.threadId !== threadId) return null;
  return { userId, workspaceId: mapping.workspaceId, threadId };
}
