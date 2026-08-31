import { getAgentByName } from "agents";
import type { Env } from "../env";
import type { WatcherCompletionInfo } from "../agent/system-reminder";
import type { SandboxCallResult } from "./agent-sandbox-do";
import { log } from "../log";

/**
 * The two capabilities the compute service needs that live on the CONVERSATION,
 * not on the machine: appending a system-reminder to the transcript, and arming
 * the thread DO's idle-eviction schedule. `AgentSandbox` owns the sandbox but
 * not the thread, so it calls back for these.
 *
 * Implemented by `ThinkThreadAgent`. Every method returns a
 * {@link SandboxCallResult} rather than throwing: a throw over DO RPC reaches
 * the caller as a phantom rejection it cannot attribute to a call.
 */
export interface SandboxThreadHost {
  deliverSystemReminderFromSandbox(input: {
    body: string;
    mode: "deferred" | "proactive";
    watcher?: WatcherCompletionInfo;
  }): Promise<SandboxCallResult<null>>;
  scheduleSandboxEviction(input: { timestampMs: number }): Promise<SandboxCallResult<null>>;
  cancelSandboxEviction(): Promise<SandboxCallResult<null>>;
}

/**
 * MUST be getAgentByName, not a raw `namespace.get(idFromName(...))` stub.
 * `ThinkThreadAgent` extends Think, which hydrates its transcript only in
 * `onStart()`; a raw DO RPC skips `onStart()`, so `this.messages` is still the
 * empty cache the constructor set and `addMessages` would append a reminder
 * into an EMPTY transcript — the same data loss documented on `archiveStub` in
 * `src/agent/archive-thread.ts`.
 *
 * This is deliberately the opposite of how `AGENT_SANDBOX` itself is addressed
 * (`idFromName`, correct there because a plain `DurableObject` has no
 * `onStart`). Both are right; do not harmonize them.
 */
async function threadHostStub(env: Env, threadId: string): Promise<SandboxThreadHost> {
  return (await getAgentByName(env.THINK_THREAD_AGENT, threadId)) as unknown as SandboxThreadHost;
}

/**
 * The subset of `ComputeToolHostDeps` that the sandbox DO cannot satisfy from
 * its own storage, wired to call back into the thread DO that owns `threadId`.
 *
 * Every call is best-effort: a failure (thread DO gone, RPC error, encoded
 * failure on the far side) is logged and SWALLOWED, never re-thrown into the
 * compute path — a command that already ran on the machine must not be reported
 * as failed because its notification could not be delivered.
 */
export function createSandboxThreadHostDeps(
  env: Env,
  threadId: string,
): {
  scheduleEviction: (timestampMs: number) => Promise<void>;
  cancelEviction: () => Promise<void>;
  deliverSystemReminder: (
    body: string,
    mode: "deferred" | "proactive",
    options?: { watcher?: WatcherCompletionInfo },
  ) => Promise<void>;
} {
  async function call(
    op: string,
    run: (host: SandboxThreadHost) => Promise<SandboxCallResult<null>>,
  ): Promise<void> {
    try {
      const result = await run(await threadHostStub(env, threadId));
      if (result.ok) return;
      log.warn("agent_sandbox.thread_back_call_rejected", {
        threadId,
        op,
        code: result.error.code,
        message: result.error.message,
      });
    } catch (error) {
      log.warn("agent_sandbox.thread_back_call_failed", {
        threadId,
        op,
        error: String(error),
      });
    }
  }

  return {
    scheduleEviction: (timestampMs) =>
      call("scheduleEviction", (host) => host.scheduleSandboxEviction({ timestampMs })),
    cancelEviction: () => call("cancelEviction", (host) => host.cancelSandboxEviction()),
    deliverSystemReminder: (body, mode, options) =>
      call("deliverSystemReminder", (host) =>
        host.deliverSystemReminderFromSandbox({
          body,
          mode,
          ...(options?.watcher ? { watcher: options.watcher } : {}),
        }),
      ),
  };
}
