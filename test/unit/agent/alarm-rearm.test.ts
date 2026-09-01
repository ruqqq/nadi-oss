import { describe, expect, it, vi } from "vitest";
import type { WorkSweepResult } from "../../../src/agent/think-thread-agent";
import { ThinkThreadAgent } from "../../../src/agent/think-thread-agent";
import { runSandboxComputeAlarm, type SandboxAlarmHost } from "../../../src/compute/sandbox-alarm";
import {
  PROCESS_STALE_AFTER_MS,
  SUBAGENT_STALE_AFTER_MS,
  WORK_DELIVERY_RETRY_MS,
  type CurrentGeneration,
  nextSweepAt,
  type WorkRow,
} from "../../../src/agent/work-ledger";
import { FakeComputeBackend } from "../../../src/compute/backends/fake";
import { DEFAULT_COMPUTE_LIMITS } from "../../../src/compute/config";
import { ThreadComputeService } from "../../../src/compute/thread-service";
import type { ThreadComputeStoreLike } from "../../../src/compute/thread-service";
import type { EffectiveComputeConfig } from "../../../src/compute/types";
import { DEFAULT_MONITOR_POLL_INTERVAL_MS } from "../../../src/compute/watchers";
import { createMemoryComputeStore } from "../compute/helpers/memory-store";
import { localWorkLedgerSink } from "../../../src/agent/work-ledger-store";

/**
 * The ALARM RE-ARM WIRING of `runSandboxComputeAlarm` — the body of
 * `AgentSandbox.alarm()`.
 *
 * The sandbox has exactly one alarm and `ctx.storage.setAlarm` is a SET on that
 * single alarm — not a min-fold. So the alarm callback must make two things
 * true at once:
 *
 *   1. never a SECOND arm — arming after the tick already armed CANCELS the
 *      tick's nearer alarm (this tripled the 7s watcher poll to 21s), and
 *   2. never an unwaked open row — if NOTHING armed, the thread never wakes
 *      again and background work silently never notifies. That is the original
 *      bug this whole project exists to kill.
 *
 * Both fall out of gating on the FACT that something armed
 * (`ThreadComputeService.alarmArmCount()`, incremented only when `armAlarm`
 * reaches `setAlarm`) instead of a proxy for it. "The tick did not throw" is
 * such a proxy, and it is wrong in both directions: a tick can throw AFTER
 * arming, and can return having armed nothing.
 *
 * These drive the real `runSandboxComputeAlarm` over a real
 * `ThreadComputeService`; only the store, backend and host wiring are fakes.
 * The sweep is a HOST call here because it is one in production too: the sweep
 * stays on the thread DO and the alarm chains it behind the tick.
 */

vi.mock("../../../src/db/client", () => ({ registryDb: () => ({}) }));

const holder = vi.hoisted(() => ({
  resolved: undefined as { service: unknown } | undefined,
}));

// Fully replaced, never importOriginal: the real module pulls in `cloudflare:`
// imports the node ESM loader cannot resolve.
vi.mock("../../../src/agent/compute-tools", () => ({
  resolveComputeService: async () => holder.resolved,
  createComputeTools: () => ({}),
}));

const CONFIG: EffectiveComputeConfig = {
  provider: "fake",
  providerConfig: { kind: "cloudflare" },
  resourceProfile: "small",
  idleTimeoutMs: 60_000,
  recoveryTtlMs: 5_000,
  maxProcessRuntimeMs: 600_000,
  // Mirrors production (`resolveEffectiveComputeConfig` in compute/config.ts):
  // the watcher's own registered cadence and the rearm gate's fallback floor
  // (`DEFAULT_MONITOR_POLL_INTERVAL_MS`, read directly by
  // `runSandboxComputeAlarm`) are the SAME value in production.
  // A hardcoded literal here drifted from that constant once already (see
  // "floors a watcher whose nextPollAt is already PAST" below).
  monitorPollIntervalMs: DEFAULT_MONITOR_POLL_INTERVAL_MS,
  limits: DEFAULT_COMPUTE_LIMITS,
  allowedHosts: null,
  editableEnv: {},
  agentEditableEnv: {},
  secretEnvNames: [],
};

function openRow(overrides?: Partial<WorkRow>): WorkRow {
  return {
    id: "p1",
    kind: "process",
    startedAt: 0,
    lastAliveAt: 1_000,
    staleAfterMs: PROCESS_STALE_AFTER_MS,
    deadlineAt: 10_000_000,
    generation: "gen-a",
    terminal: null,
    deliveredAt: null,
    ...overrides,
  };
}

/**
 * The real `WorkLedgerSink` contract over a plain array, so a test can drive the
 * REAL compute writes (`register`/`stampAlive`/`terminalize` from
 * `pollWatcher`) against the REAL `runWorkLedgerSweep`. `rows` is the same array
 * the service writes into and `getWorkHorizon`/`listOpen` read out of.
 */
function memoryLedger(rows: WorkRow[]) {
  return {
    rows,
    listOpen: () => rows.filter((row) => !row.terminal),
    get: (id: string) => rows.find((row) => row.id === id) ?? null,
    register: (row: WorkRow) => {
      const at = rows.findIndex((existing) => existing.id === row.id);
      if (at === -1) rows.push(row);
      else rows[at] = row;
    },
    stampAlive: (id: string, at: number) => {
      const index = rows.findIndex((row) => row.id === id);
      if (index !== -1) rows[index] = { ...(rows[index] as WorkRow), lastAliveAt: at };
    },
    terminalize: (id: string, terminal: WorkRow["terminal"]) => {
      const index = rows.findIndex((row) => row.id === id);
      if (index === -1 || rows[index]?.terminal) return false;
      rows[index] = { ...(rows[index] as WorkRow), terminal };
      return true;
    },
    deleteRow: (id: string) => {
      const index = rows.findIndex((row) => row.id === id);
      if (index !== -1) rows.splice(index, 1);
    },
    markDelivered: (id: string, at: number) => {
      const index = rows.findIndex((row) => row.id === id);
      const row = rows[index];
      if (!row?.terminal || row.deliveredAt !== null) return false;
      rows[index] = { ...row, deliveredAt: at };
      return true;
    },
    listUndelivered: () => rows.filter((row) => row.terminal && row.deliveredAt === null),
    countUndelivered: () => rows.filter((row) => row.terminal && row.deliveredAt === null).length,
    isDelivered: (id: string) => rows.find((row) => row.id === id)?.deliveredAt != null,
    // The real sweep calls this unconditionally after classification; this
    // test drives none of its rows past the retention window, so a no-op
    // keeps parity with `WorkLedgerStore.prune` without pruning anything here.
    prune: (_before: number) => undefined,
  };
}

function setup(input: {
  now: { value: number };
  rows: WorkRow[];
  supportsProcessMonitor?: boolean;
  store?: ThreadComputeStoreLike;
  backend?: FakeComputeBackend;
  quota?: { admit(): Promise<void>; refresh(): Promise<boolean>; release(): Promise<void> };
  /** Wire the REAL ledger sink into the service (drives real register/stamp/terminalize). */
  ledger?: ReturnType<typeof memoryLedger>;
}) {
  const backend = input.backend ?? new FakeComputeBackend();
  const store = input.store ?? createMemoryComputeStore();
  const scheduleEviction = vi.fn(async (_timestampMs: number) => undefined);
  const getWorkHorizon = async () => nextSweepAt(input.rows);
  const service = new ThreadComputeService({
    backend,
    store,
    config: CONFIG,
    environmentId: "thread_test",
    threadId: "thr_alarm_rearm",
    env: {},
    // Mirrors compute-tools: the service's setAlarm IS the host's scheduleEviction.
    setAlarm: (timestamp) => scheduleEviction(timestamp),
    now: () => input.now.value,
    supportsProcessMonitor: input.supportsProcessMonitor ?? true,
    getWorkHorizon,
    ...(input.quota ? { quota: input.quota } : {}),
    // A SPREAD, so excess-property checking does not apply to it: this line said
    // `workLedger:` after the dep became `workLedgerFor`, typecheck stayed
    // silent, and the service simply ran with no ledger — the whole suite green
    // except the one assertion that counted open rows. Keep the key correct.
    ...(input.ledger ? { workLedgerFor: () => localWorkLedgerSink(input.ledger!) } : {}),
  });
  holder.resolved = { service };

  /**
   * The narrowest THREAD-side collaborator the sweep needs. In production this
   * is the `ThinkThreadAgent` the alarm back-calls; here it is also what the
   * host below reads its ledger horizon out of.
   */
  const agent = {
    name: "thr_test",
    env: {},
    primeAttachedContext: vi.fn(async () => undefined),
    openSandbox: async () => holder.resolved ?? null,
    // The sweep's own decisions are covered by reaper.test.ts; here it must only
    // not interfere with the arm decision.
    runWorkLedgerSweep: vi.fn(async (_resolved?: unknown) => ({
      classified: [],
      terminalized: [],
      redelivered: [],
    })),
    // The REAL horizon fold (open rows + a retry wake for anything owed) — this
    // is what the fallback re-arm decides on, so it must not be a stub.
    workHorizon: (ThinkThreadAgent.prototype as unknown as { workHorizon: unknown }).workHorizon,
    workLedger: input.ledger ?? {
      listOpen: () => input.rows.filter((row) => !row.terminal),
      listUndelivered: () => [],
      countUndelivered: () => 0,
    },
    setSandboxDeclaredClean: vi.fn(async (_clean: boolean) => undefined),
  };

  /**
   * The sandbox DO's side. `openSession` resolves fresh per invocation (an alarm
   * may reuse nothing), `sweepWorkLedger` is the back-call into the thread, and
   * `setAlarm` is this sandbox's single alarm.
   */
  const host: SandboxAlarmHost<{ service: ThreadComputeService }> = {
    agentId: "agent_alarm_rearm",
    openSession: async () =>
      (holder.resolved as { service: ThreadComputeService } | undefined) ?? null,
    sweepWorkLedger: async (resolved) => {
      await agent.runWorkLedgerSweep(resolved);
    },
    workHorizon: async (at) =>
      (agent.workHorizon as (this: unknown, now: number) => number | null).call(agent, at),
    setAlarm: (timestampMs) => scheduleEviction(timestampMs),
    setSandboxDeclaredClean: (clean) => agent.setSandboxDeclaredClean(clean),
  };
  return { agent, host, backend, store, service, scheduleEviction };
}

describe("sandbox compute alarm re-arm gate", () => {
  it("continues polling a watcher admitted before monitoring is disabled", async () => {
    const now = { value: 1_000 };
    const rows = [openRow({ lastAliveAt: 1_000 })];
    const first = setup({ now, rows, supportsProcessMonitor: true });
    const started = await first.service.execStart({ command: "sleep 600", label: "long" });
    await first.service.execWatch({ processId: started.processId });

    const disabled = setup({
      now,
      rows,
      supportsProcessMonitor: false,
      store: first.store,
      backend: first.backend,
    });
    const dueBeforeTick = await disabled.service.nextWatcherWakeAt();
    expect(dueBeforeTick).not.toBeNull();
    now.value += CONFIG.monitorPollIntervalMs;

    await disabled.service.runComputeTick();

    expect(await disabled.service.nextWatcherWakeAt()).toBeGreaterThan(dueBeforeTick!);
  });

  it("arms the fallback when the compute tick THROWS before arming", async () => {
    const now = { value: 1_000 };
    const rows = [openRow()];
    // The real shape: runComputeTick's keep-alive `quota.refresh()` is an
    // unguarded D1 write on an active container. A throw there propagates out
    // of the tick having armed nothing at all.
    const failRefresh = { value: false };
    const quota = {
      admit: async () => undefined,
      refresh: async () => {
        if (failRefresh.value) throw new Error("d1_write_failed");
        return true;
      },
      release: async () => undefined,
    };
    const { host, service, scheduleEviction } = setup({ now, rows, quota });

    await service.execStart({ command: "sleep 600", label: "long" });
    scheduleEviction.mockClear();
    failRefresh.value = true;
    now.value = 2_000;

    await runSandboxComputeAlarm(host);

    // Resolution SUCCEEDED here — gating on that fact leaves the thread with a
    // dead alarm until the next user turn, and the open row never sweeps again.
    expect(scheduleEviction).toHaveBeenCalledTimes(1);
    expect(scheduleEviction).toHaveBeenCalledWith(nextSweepAt(rows));
  });

  it("arms the fallback when the tick RETURNS without arming (status releasing)", async () => {
    const now = { value: 1_000 };
    const rows = [openRow()];
    const { host, store, service, scheduleEviction } = setup({ now, rows });

    await service.execStart({ command: "sleep 600", label: "long" });
    // `releaseIfIdle` early-returns on any status but `active` — reachable as
    // `acquiring` (alarm mid-provision), `releasing` and `discarding`. The tick
    // then falls through with no arm of its own, and this row has no watcher to
    // arm for it either.
    store.markReleasing(now.value);
    scheduleEviction.mockClear();
    now.value = 2_000;

    await runSandboxComputeAlarm(host);

    expect(scheduleEviction).toHaveBeenCalledTimes(1);
    expect(scheduleEviction).toHaveBeenCalledWith(nextSweepAt(rows));
  });

  it("does NOT arm again when the tick already armed (the 7s->21s regression)", async () => {
    const now = { value: 1_000 };
    // An open, healthy row whose sweep horizon (1_000 + 21s) is LATER than the
    // watcher's next poll (2_000 + 7s) — the everyday case, since the poll that
    // just stamped the row always leaves the horizon further out.
    const rows = [openRow({ lastAliveAt: 1_000 })];
    const { host, service, scheduleEviction } = setup({ now, rows });

    const started = await service.execStart({ command: "sleep 600", label: "long" });
    await service.execWatch({ processId: started.processId });
    scheduleEviction.mockClear();
    // The watcher is due.
    now.value = 2_000 + CONFIG.monitorPollIntervalMs;

    await runSandboxComputeAlarm(host);

    // Exactly ONE arm, at the watcher's next poll — not the ledger horizon. A
    // second arm here would not add an alarm, it would REPLACE this one.
    expect(scheduleEviction).toHaveBeenCalledTimes(1);
    expect(scheduleEviction).toHaveBeenCalledWith(now.value + CONFIG.monitorPollIntervalMs);
  });

  // REPLACES an earlier test that asserted the sweep runs BEFORE the tick so
  // the tick's arm folds a post-sweep horizon. That premise was wrong and is now
  // reverted: sweeping first classifies staleness from the PREVIOUS tick's
  // liveness stamps and false-faults healthy processes (see the late-alarm test
  // below). This pins what tick-first actually promises instead — ONE arm, and
  // the spurious wake accepted as its cost.
  it("pays at most ONE spurious wake for a stale row, and still arms exactly once", async () => {
    const now = { value: 1_000 };
    // A row whose horizon is already in the past: this pass's sweep closes it.
    const rows = [openRow({ deadlineAt: 5_000 })];
    const { agent, host, service, scheduleEviction } = setup({ now, rows });

    const started = await service.execStart({ command: "sleep 600", label: "long" });
    await service.execWatch({ processId: started.processId });
    agent.runWorkLedgerSweep = vi.fn(async () => {
      rows[0] = {
        ...(rows[0] as WorkRow),
        terminal: {
          outcome: "timeout",
          reason: "watch_timeout",
          at: now.value,
          detail: "deadline passed",
        },
      };
      return { classified: [], terminalized: [rows[0].id], redelivered: [] };
    }) as unknown as typeof agent.runWorkLedgerSweep;
    scheduleEviction.mockClear();
    now.value = 2_000 + CONFIG.monitorPollIntervalMs;

    await runSandboxComputeAlarm(host);

    // The tick armed folding a horizon (5_000) the sweep then closed — an alarm
    // in the past, i.e. one immediate wake that finds nothing. That is the
    // ACCEPTED, self-limiting cost of tick-first: this pass closed the row, so
    // the next arm is correct. What must NOT happen is a second arm: re-arming
    // after the sweep would CANCEL this alarm (the round-3 Critical).
    expect(scheduleEviction).toHaveBeenCalledTimes(1);
    expect(scheduleEviction).toHaveBeenCalledWith(5_000);
    // And the row really is closed, so the spurious wake cannot repeat.
    expect(rows[0]?.terminal).not.toBeNull();
  });

  it("never faults a healthy, still-running process when the alarm arrives LATE", async () => {
    // The alarm is not a clock: it can fire arbitrarily late, and
    // resolveComputeService (a GitHub token mint + several D1 reads) runs before
    // anything else. Poll interval is 7s but PROCESS_STALE_AFTER_MS is 21s, so
    // >=14s of lateness is enough to make the PREVIOUS tick's stamp look stale.
    const now = { value: 1_000 };
    const rows: WorkRow[] = [];
    const ledger = memoryLedger(rows);
    const { agent, host, service } = setup({ now, rows, ledger });

    const started = await service.execStart({ command: "sleep 600", label: "long" });
    await service.execWatch({ processId: started.processId });
    expect(ledger.listOpen()).toHaveLength(1);

    // The alarm fires 22s late — past the 21s stale window measured from the
    // stamp this tick is ABOUT to refresh. The process is still running.
    now.value = 1_000 + PROCESS_STALE_AFTER_MS + 1_000;
    const dateNow = vi.spyOn(Date, "now").mockReturnValue(now.value);

    // The REAL sweep, over the REAL rows the tick's poll stamps. Generation is
    // reported `unknown` so the sandbox_reset branch stays out of the way —
    // no_liveness is what is under test.
    //
    // The bind target must carry EVERY collaborator the real sweep touches.
    // `{...agent}` alone does not: an earlier version of this test spread a
    // plain object literal and the sweep died on its first line
    // (`ensureLegacySubagentBackfill is not a function`), was swallowed by
    // the alarm's sweep guard, and the assertions below passed for the
    // wrong reason — the ordering they exist to pin was never exercised.
    // `sweepResult`/`sweepError` are what keep that from silently recurring.
    const sweep = ThinkThreadAgent.prototype.runWorkLedgerSweep as (
      this: unknown,
      resolved?: unknown,
    ) => Promise<WorkSweepResult>;
    let sweepError: unknown;
    let sweepResult: WorkSweepResult | undefined;
    // Annotated, NOT cast to `never`: the annotation is what makes a wrong
    // generation shape (the old `async () => null`) a COMPILE error instead of
    // a runtime TypeError the guard eats.
    const getCurrentGeneration = async (): Promise<CurrentGeneration> => ({ kind: "unknown" });
    const sweepThis = {
      ...agent,
      getCurrentGeneration,
      ensureLegacySubagentBackfill: async () => undefined,
      // The real funnel is covered elsewhere; here it must only make the sweep's
      // classification OBSERVABLE, so a reverted ordering shows up as a terminal.
      terminalizeWork: async (id: string, terminal: WorkRow["terminal"]) =>
        ledger.terminalize(id, terminal),
    };
    agent.runWorkLedgerSweep = async function (this: unknown, resolved?: unknown) {
      try {
        sweepResult = await sweep.call(this, resolved);
        return sweepResult;
      } catch (error) {
        sweepError = error;
        throw error;
      }
    }.bind(sweepThis) as never;

    try {
      await runSandboxComputeAlarm(host);
    } finally {
      dateNow.mockRestore();
    }

    // The sweep genuinely RAN and genuinely classified. Without these two, every
    // assertion below is satisfied by a sweep that exploded and did nothing.
    expect(sweepError).toBeUndefined();
    expect(sweepResult).toEqual({ classified: [], terminalized: [], redelivered: [] });

    // The tick polled first and stamped liveness, so the sweep classified the
    // row `alive`. Sweep-first reads lastAliveAt = 1_000 against now = 23_000
    // and closes this row `no_liveness` — faulting a process that is running
    // fine. The reaper must never false-positive.
    expect(rows[0]?.lastAliveAt).toBe(now.value);
    expect(rows[0]?.terminal).toBeNull();
    expect(ledger.listOpen()).toHaveLength(1);
  });

  it("arms for a LIVE WATCHER whose ledger row is already CLOSED", async () => {
    // Reachable, and this code creates it: pollWatcher writes the terminal
    // FIRST (closing the row) and a deliverSystemReminder throw then skips
    // deleteWatcher — leaving a live watcher with a closed row. listOpen() is
    // empty, so a work-rows-only fallback horizon is null and arms NOTHING:
    // that watcher never polls again and the model never learns. Invariant B is
    // "never strand open WORK", not "never strand open rows".
    const now = { value: 1_000 };
    const rows = [
      openRow({
        terminal: { outcome: "exited", reason: "process_exit", at: 1_000, detail: "closed" },
      }),
    ];
    const failRefresh = { value: false };
    const quota = {
      admit: async () => undefined,
      refresh: async () => {
        if (failRefresh.value) throw new Error("d1_write_failed");
        return true;
      },
      release: async () => undefined,
    };
    const { host, service, scheduleEviction } = setup({ now, rows, quota });

    const started = await service.execStart({ command: "sleep 600", label: "long" });
    await service.execWatch({ processId: started.processId });
    expect(nextSweepAt(rows)).toBeNull();

    // A later tick throws before arming — the second independent throw. Two
    // throws, but that combination is exactly the original bug.
    scheduleEviction.mockClear();
    failRefresh.value = true;
    now.value = 2_000;

    await runSandboxComputeAlarm(host);

    // Armed at the live watcher's next poll, from the ledger-blind fallback.
    expect(scheduleEviction).toHaveBeenCalledTimes(1);
    expect(scheduleEviction).toHaveBeenCalledWith(1_000 + CONFIG.monitorPollIntervalMs);
  });

  it("floors a watcher whose nextPollAt is already PAST, instead of re-arming hot", async () => {
    // The real bug: a PERSISTENTLY failing D1 write (quota.refresh) means
    // `pollDueWatchers` never runs, so `nextPollAt` never advances. Every
    // fallback fold then re-reads the SAME past timestamp, schedules an alarm
    // in the past, fires immediately, and repeats forever — paying a full
    // `resolveComputeService` (GitHub token mint + D1 reads) each time, until
    // the write recovers. No ledger row is involved: isolate the watcher-only
    // fold by leaving the ledger empty.
    const now = { value: 1_000 };
    const rows: WorkRow[] = [];
    const failRefresh = { value: false };
    const quota = {
      admit: async () => undefined,
      refresh: async () => {
        if (failRefresh.value) throw new Error("d1_write_failed");
        return true;
      },
      release: async () => undefined,
    };
    const { host, service, scheduleEviction } = setup({ now, rows, quota });

    const started = await service.execStart({ command: "sleep 600", label: "long" });
    await service.execWatch({ processId: started.processId });
    // nextPollAt = 1_000 + monitorPollIntervalMs.

    scheduleEviction.mockClear();
    failRefresh.value = true;
    // The write has been failing for a while: nextPollAt is now well BEHIND
    // `now` — nothing ever advanced it. Must clear nextPollAt
    // (1_000 + monitorPollIntervalMs) by a wide margin.
    now.value = 1_000 + CONFIG.monitorPollIntervalMs * 2;

    await runSandboxComputeAlarm(host);

    // Must NOT re-arm at the past nextPollAt (immediate refire, forever, while
    // the write stays down) — floors to now + one poll interval instead.
    expect(scheduleEviction).toHaveBeenCalledTimes(1);
    expect(scheduleEviction).toHaveBeenCalledWith(now.value + CONFIG.monitorPollIntervalMs);
  });

  it("arms the fallback when compute never resolved at all", async () => {
    const now = { value: 1_000 };
    const rows = [openRow()];
    const { host, scheduleEviction } = setup({ now, rows });
    holder.resolved = undefined;

    await runSandboxComputeAlarm(host);

    expect(scheduleEviction).toHaveBeenCalledTimes(1);
    expect(scheduleEviction).toHaveBeenCalledWith(nextSweepAt(rows));
  });

  it("arms the fallback even when the SWEEP throws (compute disabled + sweep failure)", async () => {
    const now = { value: 1_000 };
    const rows = [openRow()];
    const { agent, host, scheduleEviction } = setup({ now, rows });
    holder.resolved = undefined;
    agent.runWorkLedgerSweep = vi.fn(async () => {
      throw new Error("sweep exploded");
    }) as unknown as typeof agent.runWorkLedgerSweep;

    await runSandboxComputeAlarm(host);

    expect(scheduleEviction).toHaveBeenCalledTimes(1);
  });

  /**
   * The retry pass had NO WAKE SOURCE, and was inert in exactly the case it
   * exists for.
   *
   * An OWED row (terminal written, `delivered_at` still NULL) is CLOSED, so
   * `listOpen()` cannot see it and `nextSweepAt` contributes nothing for it.
   * Every other test that exercises the retry has something ELSE keeping the
   * alarm alive — a watcher, another open row — and so cannot see this: it needs
   * a thread whose LAST wake source is the row that just went owed.
   *
   * A subagent-only thread is exactly that. Its last open row is classified
   * `no_liveness`, the terminal lands, `deliverInjection` throws, and the sweep's
   * per-row guard swallows it. `owed` was snapshotted BEFORE the classification
   * loop (deliberately), so this pass does not retry it. Now: `listOpen()` is
   * empty, no watcher exists, `hasBlockingWork` sees no open subagent run and
   * `releaseIfIdle` gives the compute back. Nothing arms — the DO is never woken
   * again, the row is owed FOREVER, and `prune` (which requires `delivered_at IS
   * NOT NULL`) can never even collect it. A permanent orphan.
   */
  it("arms a RETRY for a subagent-only thread whose delivery THROWS", async () => {
    const now = { value: 1_000 };
    const wall = 500_000;
    // Silent well past SUBAGENT_STALE_AFTER_MS but far inside its deadline, so
    // this sweep classifies it `no_liveness` — one open row, and nothing else.
    const rows: WorkRow[] = [
      openRow({
        id: "run_only",
        kind: "subagent",
        lastAliveAt: wall - SUBAGENT_STALE_AFTER_MS - 1_000,
        staleAfterMs: SUBAGENT_STALE_AFTER_MS,
        deadlineAt: wall + 10_000_000,
      }),
    ];
    const ledger = memoryLedger(rows);
    const { agent, host, scheduleEviction } = setup({ now, rows, ledger });
    // The thread has no compute at all: no tick, no watcher, no eviction
    // horizon. The ledger is the ONLY thing that could ever arm this alarm.
    holder.resolved = undefined;

    // The REAL sweep, the REAL funnel (terminal -> deliver -> teardown), over the
    // REAL rows — a fake terminalizeWork here would never leave a row owed, which
    // is the whole precondition.
    const sweepThis = {
      ...agent,
      workLedger: ledger,
      getCurrentGeneration: async (): Promise<CurrentGeneration> => ({ kind: "unknown" }),
      ensureLegacySubagentBackfill: async () => undefined,
      // Compute is gone, so the sweep's own resolve degrades to null — the
      // documented "compute unavailable" path, not a skipped sweep.
      resolveForSweep: async () => null,
      terminalizeWork: ThinkThreadAgent.prototype.terminalizeWork,
      deliverWorkTerminal: (
        ThinkThreadAgent.prototype as unknown as { deliverWorkTerminal: unknown }
      ).deliverWorkTerminal,
      workFacts: (ThinkThreadAgent.prototype as unknown as { workFacts: unknown }).workFacts,
      cancelSubagentRun: async () => undefined,
      // The failure under test: the injection-buffer write throws, so the row is
      // closed and OWED. Durable-on-return is why `markDelivered` is never
      // reached — nothing was queued, so the delivery is genuinely still owed.
      deliverInjection: () => {
        throw new Error("injection buffer write failed");
      },
    };
    agent.runWorkLedgerSweep = ThinkThreadAgent.prototype.runWorkLedgerSweep.bind(
      sweepThis,
    ) as never;

    const dateNow = vi.spyOn(Date, "now").mockReturnValue(wall);
    try {
      await runSandboxComputeAlarm(host);
    } finally {
      dateNow.mockRestore();
    }

    // The precondition really happened: closed, never told, invisible to listOpen.
    expect(rows[0]?.terminal).toMatchObject({ outcome: "fault", reason: "no_liveness" });
    expect(rows[0]?.deliveredAt).toBeNull();
    expect(ledger.listOpen()).toEqual([]);
    expect(nextSweepAt(rows)).toBeNull();

    // ...and the thread still wakes to retry it. Without the owed component this
    // is zero calls: the alarm is dead and the model is never told.
    expect(scheduleEviction).toHaveBeenCalledTimes(1);
    expect(scheduleEviction).toHaveBeenCalledWith(wall + WORK_DELIVERY_RETRY_MS);
  });

  it("arms nothing when there is no open work and nothing to wake for", async () => {
    const now = { value: 1_000 };
    const { host, scheduleEviction } = setup({ now, rows: [] });
    holder.resolved = undefined;

    await runSandboxComputeAlarm(host);

    expect(scheduleEviction).not.toHaveBeenCalled();
  });
});
