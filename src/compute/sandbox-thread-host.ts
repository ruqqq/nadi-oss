import { getAgentByName } from "agents";
import type { Env } from "../env";
import type { WatcherCompletionInfo } from "../agent/system-reminder";
import type { WorkRow, WorkTerminal } from "../agent/work-ledger";
import type { WorkLedgerSink } from "../agent/work-ledger-store";
import type { SandboxCallResult } from "./agent-sandbox-do";
import type { SandboxSession } from "./agent-sandbox-session";
import type { EffectiveComputeConfig } from "./types";
import { log } from "../log";

/**
 * How the sandbox alarm tells the thread DO's sweep what session to use. The
 * three cases are `runWorkLedgerSweep`'s own `undefined`/`null` contract made
 * explicit, because an RPC boundary is not a safe place to carry the difference
 * between an absent key and an `undefined` one.
 */
export type SandboxSweepResolution =
  | { kind: "unresolved" }
  | { kind: "disabled" }
  | {
      kind: "session";
      session: SandboxSession;
      workspaceId: string;
      config: EffectiveComputeConfig;
    };

/**
 * The capabilities the compute service needs that live on the CONVERSATION,
 * not on the machine: the transcript (system reminders), the background work
 * ledger (which spans subagent runs and is read by the reaper on the thread DO)
 * and its sweep, the child-subagent lease, and the "workspace verified clean"
 * bit (whose SubAgent override targets the PARENT thread). `AgentSandbox` owns
 * the sandbox but not the thread, so it calls back for these.
 *
 * The idle-eviction SCHEDULE is no longer among them: the sandbox owns the
 * machine, so it owns the machine's alarm — `AgentSandbox` arms its own
 * `ctx.storage.setAlarm` directly. What crosses back is the ledger SWEEP, which
 * the alarm chains behind its tick.
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
  sweepSandboxWorkLedger(input: {
    resolution: SandboxSweepResolution;
  }): Promise<SandboxCallResult<null>>;
  sandboxWorkLedgerRegister(input: { row: WorkRow }): Promise<SandboxCallResult<null>>;
  sandboxWorkLedgerStampAlive(input: { id: string; at: number }): Promise<SandboxCallResult<null>>;
  sandboxWorkLedgerTerminalize(input: {
    id: string;
    terminal: WorkTerminal;
  }): Promise<SandboxCallResult<boolean>>;
  sandboxWorkLedgerMarkDelivered(input: {
    id: string;
    at: number;
  }): Promise<SandboxCallResult<boolean>>;
  sandboxWorkLedgerIsDelivered(input: { id: string }): Promise<SandboxCallResult<boolean>>;
  sandboxWorkLedgerDeleteRow(input: { id: string }): Promise<SandboxCallResult<null>>;
  getSandboxWorkHorizon(input?: { now?: number }): Promise<SandboxCallResult<number | null>>;
  sandboxHasBlockingWork(): Promise<SandboxCallResult<boolean>>;
  setSandboxDeclaredCleanFromSandbox(input: { clean: boolean }): Promise<SandboxCallResult<null>>;
  isSandboxDeclaredCleanFromSandbox(): Promise<SandboxCallResult<boolean>>;
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
 * The work-ledger sink for ONE thread. Split out of
 * {@link createSandboxThreadHostDeps} because since P3 the compute service
 * reaches it through a ROUTER keyed by the thread that owns each row, not
 * through a sink bound to the thread that resolved the service.
 *
 * `attempt` is passed in rather than rebuilt so the log lines keep naming the
 * thread the call was actually addressed to.
 */
function workLedgerSinkFor(env: Env, threadId: string): WorkLedgerSink {
  const attempt = backCallAttempt(env, threadId);
  const call = async (
    op: string,
    run: (host: SandboxThreadHost) => Promise<SandboxCallResult<null>>,
  ): Promise<void> => {
    await attempt(op, run);
  };
  const read = async <T>(
    op: string,
    run: (host: SandboxThreadHost) => Promise<SandboxCallResult<T>>,
    onUnreachable: T,
  ): Promise<T> => {
    const result = await attempt(op, run);
    return result ? result.value : onUnreachable;
  };
  return {
    register: (row) =>
      call("workLedger.register", (host) => host.sandboxWorkLedgerRegister({ row })),
    stampAlive: (id, at) =>
      call("workLedger.stampAlive", (host) => host.sandboxWorkLedgerStampAlive({ id, at })),
    // `false` = "this call did not close the row". The return value gates
    // hold release and the delivery stamp, so a failed terminalize claiming
    // `true` would own a teardown it never performed and stamp a delivery
    // that never happened. Both are worse than a row the reaper closes later.
    terminalize: (id, terminal) =>
      read(
        "workLedger.terminalize",
        (host) => host.sandboxWorkLedgerTerminalize({ id, terminal }),
        false,
      ),
    // `false` = "nothing was stamped", which is the truth: the row stays owed
    // and the sweep retries the delivery.
    markDelivered: (id, at) =>
      read(
        "workLedger.markDelivered",
        (host) => host.sandboxWorkLedgerMarkDelivered({ id, at }),
        false,
      ),
    // `false` = "not known to have been told", so the caller speaks. A
    // duplicate card beats silence (thread-service.ts:3020-3045), and the
    // same unreachable thread makes `markDelivered` fail too, so the row
    // stays owed and the sweep can still say it.
    isDelivered: (id) =>
      read("workLedger.isDelivered", (host) => host.sandboxWorkLedgerIsDelivered({ id }), false),
    deleteRow: (id) =>
      call("workLedger.deleteRow", (host) => host.sandboxWorkLedgerDeleteRow({ id })),
  };
}

/**
 * Run one back-call against `threadId`'s DO and return its encoded result, or
 * `null` when the call could not be completed at all. Never throws.
 */
function backCallAttempt(env: Env, threadId: string) {
  return async function attempt<T>(
    op: string,
    run: (host: SandboxThreadHost) => Promise<SandboxCallResult<T>>,
  ): Promise<{ ok: true; value: T } | null> {
    try {
      const result = await run(await threadHostStub(env, threadId));
      if (result.ok) return result;
      log.warn("agent_sandbox.thread_back_call_rejected", {
        threadId,
        op,
        code: result.error.code,
        message: result.error.message,
      });
      return null;
    } catch (error) {
      log.warn("agent_sandbox.thread_back_call_failed", {
        threadId,
        op,
        error: String(error),
      });
      return null;
    }
  };
}

/**
 * Deliver ONE system reminder into the conversation named by `input.threadId`.
 *
 * A free function, not a method on the per-thread deps, because the thread it
 * targets is decided per CALL: the compute service is resolved for one thread
 * but a watcher completing on another must be announced where the work
 * started. The `threadId` the deps object was built with is not consulted here
 * at all — the caller states it, every time.
 */
export async function deliverSandboxSystemReminder(
  env: Env,
  input: {
    threadId: string;
    body: string;
    mode: "deferred" | "proactive";
    watcher?: WatcherCompletionInfo;
    mustDeliver?: boolean;
  },
): Promise<void> {
  const result = await backCallAttempt(env, input.threadId)("deliverSystemReminder", (host) =>
    host.deliverSystemReminderFromSandbox({
      body: input.body,
      mode: input.mode,
      ...(input.watcher ? { watcher: input.watcher } : {}),
    }),
  );
  if (result || !input.mustDeliver) return;
  // The watcher-poll path. See the header: a throw here is what leaves the
  // ledger row owed so the sweep retries. Swallowing would silently
  // discharge an obligation the model never saw.
  throw new Error(`sandbox_reminder_undelivered: ${input.threadId}`);
}

/**
 * The subset of `ComputeServiceHostDeps` (plus the alarm's sweep) that the
 * sandbox DO cannot satisfy from its own storage, wired to call back into the
 * thread DO that owns `threadId`.
 *
 * Best-effort BY DEFAULT: a failure (thread DO gone, RPC error, encoded failure
 * on the far side) is logged and swallowed, never re-thrown into the compute
 * path — a command that already ran on the machine must not be reported as
 * failed because its notification could not be delivered.
 *
 * There is exactly ONE exception, and it is load-bearing: the WATCHER-POLL
 * reminder (`options.mustDeliver`). `ThreadComputeService.pollWatcher` calls
 * `workLedger.markDelivered` unconditionally and AFTER the await precisely so a
 * throw leaves the ledger row owed and `runWorkLedgerSweep` retries it. Swallow
 * there and the row is stamped delivered for a reminder the model never saw —
 * the closed-and-silent bug documented at `thread-service.ts:3020-3045`. So
 * that one call re-throws on the NEAR side (the sandbox's own isolate); the RPC
 * method on the far side still encodes, as every RPC method must.
 *
 * The read back-calls cannot swallow into nothing — they must return SOMETHING
 * — so each picks the answer that is safe when the thread DO is unreachable.
 * Each is justified at its call site below; the rule is "preserve work, never
 * destroy it, and prefer a duplicate notification to silence".
 */
export function createSandboxThreadHostDeps(
  env: Env,
  threadId: string,
): {
  sweepWorkLedger: (resolution: SandboxSweepResolution) => Promise<void>;
  /**
   * ROUTED, not bound: `input.threadId` decides the target, and `threadId`
   * above is not consulted. See {@link deliverSandboxSystemReminder}.
   */
  deliverSystemReminder: (input: {
    threadId: string;
    body: string;
    mode: "deferred" | "proactive";
    watcher?: WatcherCompletionInfo;
    mustDeliver?: boolean;
  }) => Promise<void>;
  /** ROUTED, not bound — see {@link workLedgerSinkFor}. */
  workLedgerFor: (rowThreadId: string) => WorkLedgerSink;
  /**
   * This thread's own sink. The invariant-keeping wrapper in
   * `AgentSandbox.threadHostDeps` needs a sink it can wrap for ONE named
   * thread, and the alarm's roster fan-out addresses one thread at a time.
   */
  workLedger: WorkLedgerSink;
  getWorkHorizon: (now?: number) => Promise<number | null>;
  /**
   * {@link getWorkHorizon} with the "the thread DO answered" fact KEPT, instead
   * of collapsed into the unreachable fallback.
   *
   * The alarm's sweep roster needs that distinction and `getWorkHorizon` cannot
   * carry it: an unreachable thread and a thread with nothing owed both answer
   * `null`, and pruning the roster on the first would silently drop the sweep of
   * a thread that still has open work. `reachable: false` means "no answer" —
   * never "nothing to do".
   */
  probeWorkHorizon: (now?: number) => Promise<{ reachable: boolean; horizon: number | null }>;
  hasBlockingWork: () => Promise<boolean>;
  markSandboxDirty: () => Promise<void>;
  setSandboxDeclaredClean: (clean: boolean) => Promise<void>;
  isSandboxDeclaredClean: () => Promise<boolean>;
} {
  const attempt = backCallAttempt(env, threadId);

  /** Fire-and-forget back-call: a failure is logged and dropped. */
  async function call(
    op: string,
    run: (host: SandboxThreadHost) => Promise<SandboxCallResult<null>>,
  ): Promise<void> {
    await attempt(op, run);
  }

  /** Read back-call with an explicit fallback for "the thread is unreachable". */
  async function read<T>(
    op: string,
    run: (host: SandboxThreadHost) => Promise<SandboxCallResult<T>>,
    onUnreachable: T,
  ): Promise<T> {
    const result = await attempt(op, run);
    return result ? result.value : onUnreachable;
  }

  /** See the return type above: the reachability fact, kept rather than collapsed. */
  async function probeWorkHorizon(
    now?: number,
  ): Promise<{ reachable: boolean; horizon: number | null }> {
    const result = await attempt("probeWorkHorizon", (host) =>
      host.getSandboxWorkHorizon(now === undefined ? {} : { now }),
    );
    return result
      ? { reachable: true, horizon: result.value }
      : { reachable: false, horizon: null };
  }

  return {
    // The alarm's chained sweep. Swallowed like every other fire-and-forget
    // back-call: the tick above already ran, and the alarm's fallback re-arm
    // must still get its chance to give the thread another wake.
    sweepWorkLedger: (resolution) =>
      call("sweepWorkLedger", (host) => host.sweepSandboxWorkLedger({ resolution })),
    deliverSystemReminder: (input) => deliverSandboxSystemReminder(env, input),
    workLedgerFor: (rowThreadId) => workLedgerSinkFor(env, rowThreadId),
    workLedger: workLedgerSinkFor(env, threadId),
    // `null` = "no ledger wake to fold in". The alarm's other components
    // (watcher polls, the release time) still arm, and the alarm callback's own
    // fallback arm covers a fold that never ran.
    getWorkHorizon: async (now) => (await probeWorkHorizon(now)).horizon,
    probeWorkHorizon,
    // `true` = "assume a child subagent holds this machine". The consequence of
    // a wrong `false` is deleting a shared container out from under a live
    // child; the consequence of a wrong `true` is a sandbox that stays up until
    // the thread is reachable again. Only one of those loses work.
    hasBlockingWork: () => read("hasBlockingWork", (host) => host.sandboxHasBlockingWork(), true),
    markSandboxDirty: () =>
      call("markSandboxDirty", (host) => host.setSandboxDeclaredCleanFromSandbox({ clean: false })),
    setSandboxDeclaredClean: (clean) =>
      call("setSandboxDeclaredClean", (host) => host.setSandboxDeclaredCleanFromSandbox({ clean })),
    // `false` = "not verified clean", which sends the idle disposition down the
    // git probe / preserve path instead of discarding a workspace nobody
    // confirmed was saved.
    isSandboxDeclaredClean: () =>
      read("isSandboxDeclaredClean", (host) => host.isSandboxDeclaredCleanFromSandbox(), false),
  };
}
