import { env, runInDurableObject } from "cloudflare:test";
import { describe, expect, it, vi } from "vitest";
import { FakeComputeBackend } from "../../../src/compute/backends/fake";
import { DEFAULT_COMPUTE_LIMITS } from "../../../src/compute/config";
import { WATCH_ABSOLUTE_TIMEOUT_MS } from "../../../src/compute/watchers";
import { ThreadComputeService } from "../../../src/compute/thread-service";
import type { EffectiveComputeConfig } from "../../../src/compute/types";
import { WorkLedgerStore } from "../../../src/agent/work-ledger-store";
import { createMemoryComputeStore } from "../compute/helpers/memory-store";

const CONFIG: EffectiveComputeConfig = {
  provider: "fake",
  providerConfig: { kind: "cloudflare" },
  resourceProfile: "small",
  idleTimeoutMs: 1_000,
  recoveryTtlMs: 5_000,
  maxProcessRuntimeMs: 10_000,
  monitorPollIntervalMs: 100,
  limits: DEFAULT_COMPUTE_LIMITS,
  allowedHosts: null,
  editableEnv: {},
  agentEditableEnv: {},
  secretEnvNames: [],
  environmentEditableEnv: {},
  environmentSecretEnvNames: [],
};

type SweepAgent = {
  runWorkLedgerSweep: (resolved?: {
    service: ThreadComputeService;
  }) => Promise<{ terminalized: string[]; redelivered: string[] }>;
  deliverInjection: (entry: { dedupeKey: string }) => void;
};

/**
 * The REAL compute service, the REAL `WorkLedgerStore` (over the DO's own
 * storage, so the agent's sweep reads the very same rows), and the REAL sweep.
 *
 * The composition is the point. Every earlier test drove one side or the other:
 * the compute tests used a hand-rolled ledger spy, and the sweep tests used
 * `store.terminalize` directly. C1 lives in the SEAM between them — a terminal
 * `pollWatcher` wrote and delivered, that the sweep then delivered again — so a
 * test that fakes either half cannot see it.
 */
async function withRealWatcher(
  fn: (input: {
    service: ThreadComputeService;
    ledger: WorkLedgerStore;
    agent: SweepAgent;
    now: { value: number };
    reminders: string[];
    injected: string[];
    failReminder: (fail: boolean) => void;
  }) => Promise<void>,
) {
  const id = env.THINK_THREAD_AGENT.idFromName(`ownership-${crypto.randomUUID()}`);
  const stub = env.THINK_THREAD_AGENT.get(id);
  await runInDurableObject(stub, async (instance, state) => {
    const ledger = new WorkLedgerStore(state.storage);
    ledger.migrate();
    const now = { value: 1_000 };
    const reminders: string[] = [];
    const injected: string[] = [];
    let fail = false;
    const service = new ThreadComputeService({
      backend: new FakeComputeBackend(),
      store: createMemoryComputeStore(),
      config: CONFIG,
      environmentId: "thread_test",
      env: {},
      setAlarm: async () => {},
      now: () => now.value,
      supportsProcessMonitor: true,
      workLedger: ledger,
      deliverSystemReminder: async (body) => {
        if (fail) throw new Error("injection buffer write failed");
        reminders.push(body);
      },
    });
    const agent = instance as unknown as SweepAgent;
    agent.deliverInjection = (entry) => void injected.push(entry.dedupeKey);
    await fn({
      service,
      ledger,
      agent,
      now,
      reminders,
      injected,
      failReminder: (f) => void (fail = f),
    });
  });
}

/**
 * Run the sweep on the SAME clock the service uses. The sweep reads `Date.now()`
 * directly (for classification and for `prune`), while the service runs on the
 * injected `now` — so an unaligned sweep prunes every delivered row on sight:
 * `terminal_at` sits near zero on the fake clock, which is trivially older than
 * the real wall clock's 24h retention window. Harmless for a test that never
 * looks at the row again; fatal for one that drives a later poll, which then
 * finds no row, cannot see the delivery gate, and speaks twice.
 */
async function sweepAtServiceClock(
  agent: SweepAgent,
  now: { value: number },
  resolved?: { service: ThreadComputeService },
) {
  const dateNow = vi.spyOn(Date, "now").mockReturnValue(now.value);
  try {
    return await agent.runWorkLedgerSweep(resolved);
  } finally {
    dateNow.mockRestore();
  }
}

/** Start a watched process and drive it to `pollWatcher`'s TIMEOUT branch. */
async function watchedProcess(service: ThreadComputeService) {
  const started = await service.execStart({ command: "sleep 99999", label: "server" });
  await service.execWatch({ processId: started.processId });
  return started.processId;
}

describe("delivery ownership is DECLARED, not inferred from the terminal's reason (C1)", () => {
  /**
   * C1, the direct regression. A backgrounded process outliving its watch
   * timeout on a HEALTHY sandbox is the ordinary path, not an edge case:
   * `pollWatcher` writes a `watch_timeout` terminal and delivers its own
   * reminder. The sweep's old guard scoped the retry to `REAPER_WORK_REASONS`
   * on the rationale that those are "exactly the terminals `terminalizeWork`
   * owns delivery for" — but `watch_timeout` has TWO writers, so the row passed
   * the filter and the model was told the same thing twice.
   *
   * It was a RACE, not a deterministic bug: both sites build the key
   * `watcher:<pid>:timeout`, so the duplicate was suppressed only while the
   * fire-and-forget drain had not yet run. The buffer's dedupe is a
   * same-key-still-queued guard, not lifetime idempotence — so it landed
   * sometimes. `reason` was never a proxy for who owns delivery.
   */
  it("does NOT re-deliver a watch_timeout that pollWatcher already delivered", async () => {
    await withRealWatcher(async ({ service, ledger, agent, now, reminders, injected }) => {
      const processId = await watchedProcess(service);

      now.value += WATCH_ABSOLUTE_TIMEOUT_MS + 1_000;
      await service.runComputeTick();

      // pollWatcher closed the row and told the model — once.
      expect(ledger.get(processId)?.terminal).toMatchObject({
        outcome: "timeout",
        reason: "watch_timeout",
      });
      expect(reminders).toHaveLength(1);
      expect(reminders[0]).toContain("no longer watching it");

      // The obligation is discharged, so the sweep owes nothing. Before the fix
      // the row sat `delivered_at = NULL` with a reason that PASSED the filter,
      // and this sweep injected a second, near-identical message.
      expect(ledger.get(processId)?.deliveredAt).not.toBeNull();
      const sweep = await agent.runWorkLedgerSweep();
      expect(sweep.redelivered).toEqual([]);
      expect(injected).toEqual([]);
    });
  });

  /**
   * The bonus the ownership rule buys, and a spec requirement the reason filter
   * could not meet: a `deliverSystemReminder` THROW used to leave the row closed
   * and silent while the watcher re-polled to its deadline — the model got
   * nothing at all. Now the row stays owed and the sweep says it.
   *
   * The retry's `buildFaultMessage` text is poorer than `pollWatcher`'s own (no
   * output tail), but poorer beats silence.
   */
  it("re-delivers exactly once when pollWatcher's delivery THROWS", async () => {
    await withRealWatcher(
      async ({ service, ledger, agent, now, reminders, injected, failReminder }) => {
        const processId = await watchedProcess(service);

        failReminder(true);
        now.value += WATCH_ABSOLUTE_TIMEOUT_MS + 1_000;
        await service.runComputeTick();

        // The terminal STANDS (that is what advances the alarm horizon), but
        // nothing reached the model — so the delivery is still owed.
        expect(ledger.get(processId)?.terminal).toMatchObject({ reason: "watch_timeout" });
        expect(ledger.get(processId)?.deliveredAt).toBeNull();
        expect(reminders).toEqual([]);

        const first = await agent.runWorkLedgerSweep();
        expect(first.redelivered).toEqual([processId]);
        expect(injected).toEqual([`watcher:${processId}:timeout`]);
        expect(ledger.get(processId)?.deliveredAt).not.toBeNull();

        // Told once, and only once.
        const second = await agent.runWorkLedgerSweep();
        expect(second.redelivered).toEqual([]);
        expect(injected).toHaveLength(1);
      },
    );
  });

  /**
   * The retry could deliver TWICE for a process whose watcher is STILL ARMED.
   *
   * `pollWatcher`'s terminal path is terminalize -> refreshProcessOutput ->
   * deliverSystemReminder -> markDelivered -> deleteWatcher. A throw anywhere in
   * the middle (`refreshProcessOutput` re-throws non-runtime-missing backend
   * errors; the reminder write can fail) leaves the row CLOSED and OWED with the
   * watcher still armed and its `nextPollAt` never advanced. The sweep then sees
   * an owed row and delivers it. On the next alarm the watcher polls again,
   * ignores `terminalize`'s `false`, and delivers the SAME event a second time.
   *
   * The dedupe key masks it only while the first copy is still queued — a race,
   * not a gate — which is why a green suite never saw it. Here the sweep's copy
   * is drained (the fake `deliverInjection` records and returns) before the poll,
   * exactly as a turn drains the buffer in production.
   */
  it("does NOT deliver twice when the sweep retries a row whose watcher is still armed", async () => {
    await withRealWatcher(
      async ({ service, ledger, agent, now, reminders, injected, failReminder }) => {
        const processId = await watchedProcess(service);
        const listed = await service.execList({ status: "all", limit: 10 });
        const ref = listed.processes.find((p) => p.id === processId)?.backendProcessRef;
        if (!ref) throw new Error("expected a backend process reference");
        (
          service as unknown as { deps: { backend: FakeComputeBackend } }
        ).deps.backend.finishProcess(ref, "exited", 0);

        // Alarm N: the process exited, the terminal lands, and the delivery
        // throws. Row closed + owed; watcher STILL ARMED (deleteWatcher is
        // unreachable behind the throw).
        failReminder(true);
        now.value += CONFIG.monitorPollIntervalMs;
        await service.runComputeTick();
        expect(ledger.get(processId)?.terminal).toMatchObject({ reason: "process_exit" });
        expect(ledger.get(processId)?.deliveredAt).toBeNull();
        expect(service.hasWatcher(processId)).toBe(true);

        // Same alarm: the sweep sees an owed row. It must YIELD — the watcher
        // owes this row too, delivers a strictly better message (with the output
        // tail), and is the only writer that can tear the watcher down.
        const sweep = await sweepAtServiceClock(agent, now, { service });
        expect(sweep.redelivered).toEqual([]);
        expect(injected).toEqual([]);

        // Alarm N+1: the transient failure has cleared and the watcher polls.
        failReminder(false);
        now.value += CONFIG.monitorPollIntervalMs;
        await service.runComputeTick();

        // Exactly ONE message about this process, and it is the good one.
        expect(reminders).toHaveLength(1);
        expect(reminders[0]).toContain("exited with code 0");
        expect(injected).toEqual([]);
        expect(ledger.get(processId)?.deliveredAt).not.toBeNull();
        // ...and the watcher is finally torn down, so it cannot speak again.
        expect(service.hasWatcher(processId)).toBe(false);
      },
    );
  });

  /**
   * The other half of the same hole, and the one the skip above cannot close:
   * when the sweep CANNOT see the watcher (compute unresolved — `service` is
   * null, so no `pollWatcher` can run and the sweep must speak or the row is
   * stranded), it delivers. If compute later resolves, that still-armed watcher
   * polls and would add a second copy on top.
   *
   * `markDelivered` is claim-AFTER-success — a receipt, not a lock — so it
   * cannot arbitrate this. The delivery gate must be READ before speaking.
   * Note the comment this replaces reasoned about only one direction ("the
   * reaper closed the row first and its own delivery threw"); the reaper's
   * delivery may equally have SUCCEEDED.
   */
  it("stays silent on a later poll when someone else already told the model", async () => {
    await withRealWatcher(
      async ({ service, ledger, agent, now, reminders, injected, failReminder }) => {
        const processId = await watchedProcess(service);

        failReminder(true);
        now.value += WATCH_ABSOLUTE_TIMEOUT_MS + 1_000;
        await service.runComputeTick();
        expect(ledger.get(processId)?.deliveredAt).toBeNull();
        expect(service.hasWatcher(processId)).toBe(true);

        // No resolved service: the sweep cannot see the watcher, so it delivers
        // — correctly, since with compute gone it is the row's only voice.
        const sweep = await sweepAtServiceClock(agent, now);
        expect(sweep.redelivered).toEqual([processId]);
        expect(injected).toEqual([`watcher:${processId}:timeout`]);
        expect(ledger.get(processId)?.deliveredAt).not.toBeNull();

        // Compute is back and the still-armed watcher polls. The row is already
        // discharged, so this must add NOTHING — just tear the watcher down.
        failReminder(false);
        now.value += CONFIG.monitorPollIntervalMs;
        await service.runComputeTick();

        expect(reminders).toEqual([]);
        expect(injected).toHaveLength(1);
        expect(service.hasWatcher(processId)).toBe(false);
      },
    );
  });

  /**
   * I1. `process_exit` rows never claimed the gate, so a whole row class sat
   * `delivered_at IS NULL` FOREVER. A prune predicate requiring
   * `delivered_at IS NOT NULL` would then prune only reaper-faulted rows and
   * leave every clean completion resident — appearing to work while doing
   * almost nothing. It also made `listUndelivered()` (an unindexed scan on the
   * path that must stay cheap) grow with the thread's lifetime process count.
   */
  it("stamps a cleanly exited process, so the row is prunable and never re-delivered", async () => {
    await withRealWatcher(async ({ service, ledger, agent, now, reminders, injected }) => {
      const processId = await watchedProcess(service);
      const listed = await service.execList({ status: "all", limit: 10 });
      const ref = listed.processes.find((p) => p.id === processId)?.backendProcessRef;
      if (!ref) throw new Error("expected a backend process reference");
      (service as unknown as { deps: { backend: FakeComputeBackend } }).deps.backend.finishProcess(
        ref,
        "exited",
        0,
      );

      now.value += CONFIG.monitorPollIntervalMs;
      await service.runComputeTick();

      expect(ledger.get(processId)?.terminal).toMatchObject({ reason: "process_exit" });
      expect(reminders).toHaveLength(1);
      expect(reminders[0]).toContain("exited with code 0");
      expect(ledger.get(processId)?.deliveredAt).not.toBeNull();
      expect(ledger.listUndelivered()).toEqual([]);

      const sweep = await agent.runWorkLedgerSweep();
      expect(sweep.redelivered).toEqual([]);
      expect(injected).toEqual([]);
    });
  });

  /**
   * `execStop` delivers NOTHING by design — a user-initiated stop needs no card.
   * It is the one writer that discharges the obligation at terminalize time
   * rather than after a delivery. Without that stamp, dropping the reason filter
   * would have the sweep start injecting a "stopped" card that never existed
   * before: a behavior change, and exactly the duplicate-class bug in reverse.
   */
  it("never delivers a card for a user-initiated stop", async () => {
    await withRealWatcher(async ({ service, ledger, agent, now, reminders, injected }) => {
      const processId = await watchedProcess(service);

      now.value += 500;
      await service.execStop({ processId });

      expect(ledger.get(processId)?.terminal).toMatchObject({
        outcome: "stopped",
        reason: "process_stopped",
      });
      // No card, ever — not from the stop, and not from the sweep behind it.
      expect(reminders).toEqual([]);
      expect(ledger.get(processId)?.deliveredAt).not.toBeNull();

      const sweep = await agent.runWorkLedgerSweep();
      expect(sweep.redelivered).toEqual([]);
      expect(injected).toEqual([]);
    });
  });
});
