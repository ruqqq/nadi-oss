import { getAgentByName } from "agents";
import type { Env } from "../../env";
import { normalizeThreadRuntime } from "../../agent/thread-runtime";
import type { ActiveTranscriptRpc } from "../types";

/**
 * A thread's transcript is live in its DO only while it is unarchived AND on the
 * current runtime. A `legacy` row fails the second half: `ThreadAgentV2` is gone,
 * so dialing Think for one would mint an empty phantom DO under a name that
 * never belonged to it — and persist it. Callers must fall back to the archived
 * (D1) adapter instead, which is where such a thread's transcript already lives.
 */
export function hasLiveTranscript(thread: { runtime: string; archivedAt: number | null }): boolean {
  return thread.archivedAt === null && normalizeThreadRuntime(thread.runtime) === "think";
}

export async function activeTranscriptRpc(
  env: Env,
  thread: { id: string },
): Promise<ActiveTranscriptRpc> {
  return (await getAgentByName(
    env.THINK_THREAD_AGENT,
    thread.id,
  )) as unknown as ActiveTranscriptRpc;
}
