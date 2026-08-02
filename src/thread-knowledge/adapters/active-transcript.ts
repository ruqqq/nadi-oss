import { getAgentByName } from "agents";
import type { Env } from "../../env";
import { normalizeThreadRuntime } from "../../agent/thread-runtime";
import type { ActiveTranscriptRpc } from "../types";

export async function activeTranscriptRpc(
  env: Env,
  thread: { id: string; runtime: string },
): Promise<ActiveTranscriptRpc> {
  return normalizeThreadRuntime(thread.runtime) === "think"
    ? ((await getAgentByName(env.THINK_THREAD_AGENT, thread.id)) as unknown as ActiveTranscriptRpc)
    : ((await getAgentByName(env.THREAD_AGENT, thread.id)) as unknown as ActiveTranscriptRpc);
}
