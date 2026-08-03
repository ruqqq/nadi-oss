import { getAgentByName } from "agents";
import type { Env } from "../../env";
import type { ActiveTranscriptRpc } from "../types";

/**
 * Dial a thread's live Durable Object. Callers MUST gate on `hasLiveTranscript`
 * first (see src/agent/thread-runtime.ts): a retired-runtime or archived thread
 * has no DO here, and dialing anyway would mint — and persist — an empty phantom
 * under a name that never belonged to the Think namespace.
 */
export async function activeTranscriptRpc(
  env: Env,
  thread: { id: string },
): Promise<ActiveTranscriptRpc> {
  return (await getAgentByName(
    env.THINK_THREAD_AGENT,
    thread.id,
  )) as unknown as ActiveTranscriptRpc;
}
