import { env, runInDurableObject } from "cloudflare:test";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ThinkThreadAgent } from "../../../src/agent/think-thread-agent";
import { SubAgent } from "../../../src/agent/subagent";
import { WorkLedgerStore } from "../../../src/agent/work-ledger-store";
import {
  SUBAGENT_DEADLINE_MS,
  SUBAGENT_STALE_AFTER_MS,
  type CurrentGeneration,
  type WorkRow,
} from "../../../src/agent/work-ledger";

/**
 * The SUBAGENT SIDE of the work ledger — the wiring `derived-views.test.ts`
 * asserts the pure contract of.
 *
 * Four things are load-bearing and each is pinned below:
 *
 *   1. A subagent's lease and timings are the ROW. An open row is a live lease;
 *      closing the row (by the SDK terminal hook OR by the reaper) releases the
 *      eviction hold with no second write to forget.
 *   2. A soft interrupt leaves the row OPEN. The child is still on the shared
 *      machine; dropping the hold there lets the parent delete the sandbox out
 *      from under a running child.
 *   3. Liveness is stamped by infrastructure WHILE WORK IS IN FLIGHT, not
 *      reported by the model at step boundaries. This is what keeps a healthy
 *      40-minute silent run from being faulted at the 3-minute window — the
 *      exact failure mode that made the SDK's `noProgressBudgetMs` timer wrong.
 *   4. A run in flight ACROSS THE DEPLOY that made the row the lease keeps its
 *      hold, via the one-shot legacy backfill.
 *
 * These drive the REAL prototype methods over a narrow duck-typed `this`, in the
 * same style as work-terminal-funnel.test.ts, against the REAL `WorkLedgerStore`
 * on real DO SQLite — the store's exactly-once gate, its `listOpen` index and
 * its no-resurrect UPDATEs are precisely what is under test here, so a
 * hand-rolled in-memory stand-in would only assert this file's own assumptions.
 */

// Fully replaced, never importOriginal: the real module reaches for bindings
// this duck-typed harness does not stand up.
vi.mock("../../../src/agent/compute-tools", () => ({
  resolveComputeService: async () => null,
  createComputeTools: () => ({}),
  scheduleComputeEviction: async () => undefined,
  cancelComputeEviction: async () => undefined,
}));

const LEGACY_LEASE_KEY = "subagent:active-runs";
const LEGACY_TIMING_KEY = "subagent:run-timing";

function openSubagentRow(overrides?: Partial<WorkRow>): WorkRow {
  return {
    id: "sub_1",
    kind: "subagent",
    startedAt: 1_000,
    lastAliveAt: 1_000,
    staleAfterMs: SUBAGENT_STALE_AFTER_MS,
    deadlineAt: 1_000 + SUBAGENT_DEADLINE_MS,
    generation: "gen-a",
    terminal: null,
    deliveredAt: null,
    ...overrides,
  };
}

const proto = ThinkThreadAgent.prototype as unknown as Record<string, any>;

interface Harness {
  self: any;
  ledger: WorkLedgerStore;
  storage: DurableObjectStorage;
}

/**
 * A duck-typed parent over a REAL `WorkLedgerStore` on a real DO's storage.
 * `blockConcurrencyWhile` is a passthrough: we are already inside
 * `runInDurableObject`, and re-entering the real one would deadlock.
 */
async function withParent(
  rows: WorkRow[],
  fn: (harness: Harness) => Promise<void> | void,
  options?: { generation?: string | null },
): Promise<void> {
  const id = env.THINK_THREAD_AGENT.idFromName(`wiring-${crypto.randomUUID()}`);
  const stub = env.THINK_THREAD_AGENT.get(id);
  await runInDurableObject(stub, async (_instance, state) => {
    const ledger = new WorkLedgerStore(state.storage);
    ledger.migrate();
    for (const row of rows) ledger.register(row);
    const self: any = {
      name: "thr_test",
      env: {},
      ctx: {
        storage: state.storage,
        blockConcurrencyWhile: <T>(f: () => Promise<T>) => f(),
      },
      workLedger: ledger,
      deliverInjection: vi.fn(),
      cancelSubagentRun: vi.fn(async () => undefined),
      getCurrentGeneration: async (): Promise<CurrentGeneration> => {
        const nonce = options && "generation" in options ? options.generation : "gen-a";
        return nonce == null ? { kind: "unknown" } : { kind: "known", nonce };
      },
      attachedRuntimeForThisAgent: () => undefined,
      processMonitorEnabled: () => true,
      // The REAL derivations + hooks under test.
      subagentRows: proto.subagentRows,
      openSubagentRows: proto.openSubagentRows,
      openSubagentRunIds: proto.openSubagentRunIds,
      subagentRunTimings: proto.subagentRunTimings,
      onAgentToolFinish: proto.onAgentToolFinish,
      serializeLeaseMutation: proto.serializeLeaseMutation,
      stampSubagentAlive: proto.stampSubagentAlive,
      hasBlockingWorkForSandbox: proto.hasBlockingWorkForSandbox,
      workFacts: proto.workFacts,
      deliverWorkTerminal: proto.deliverWorkTerminal,
      terminalizeWork: proto.terminalizeWork,
      reaperAlreadyReported: proto.reaperAlreadyReported,
      // Stop attribution — `onAgentToolFinish` consumes a pending actor, and the
      // detached-terminal delivery reads the recorded one back off the row
      // (see subagent-stop-attribution.test.ts for what they carry).
      stopActors: proto.stopActors,
      takeStopActor: proto.takeStopActor,
      stopActorFor: proto.stopActorFor,
      ensureLegacySubagentBackfill: proto.ensureLegacySubagentBackfill,
      backfillLegacySubagentRuns: proto.backfillLegacySubagentRuns,
    };
    await fn({ self, ledger, storage: state.storage });
  });
}

const finish = (self: any, runId: string, result: Record<string, unknown>) =>
  (proto.onAgentToolFinish as any).call(
    self,
    { runId, agentType: "SubAgent", status: result.status, displayOrder: 0, startedAt: 0 },
    result,
  );

/** The eviction hold, read the way the compute layer actually reads it. */
const hasBlockingWork = async (self: any): Promise<boolean> =>
  (await (proto.hasBlockingWorkForSandbox as any).call(self)) === true;

describe("a subagent's lease IS its ledger row", () => {
  it("an open row holds the eviction hold; the terminal hook releases it", async () => {
    await withParent([openSubagentRow()], async ({ self, ledger }) => {
      expect(await hasBlockingWork(self)).toBe(true);

      await finish(self, "sub_1", { status: "completed" });

      expect(self.openSubagentRunIds()).toEqual([]);
      expect(await hasBlockingWork(self)).toBe(false);
      // Closed, not deleted: the row is still what `finishedAt` derives from.
      expect(ledger.get("sub_1")?.terminal?.outcome).toBe("exited");
    });
  });

  it("a REAPED run releases the eviction hold too — no second write to forget", async () => {
    await withParent([openSubagentRow()], async ({ self, ledger }) => {
      expect(await hasBlockingWork(self)).toBe(true);

      // The reaper's funnel, closing a run whose sandbox went away.
      const closed = await (proto.terminalizeWork as any).call(
        self,
        "sub_1",
        { outcome: "fault", reason: "sandbox_reset", at: 5_000, detail: "gone" },
        "subagent",
      );

      expect(closed).toBe(true);
      expect(await hasBlockingWork(self)).toBe(false);
      // The hold is gone AND the model was told — the pair the old lease set
      // could get wrong independently of each other.
      expect(self.deliverInjection).toHaveBeenCalledTimes(1);
      expect(ledger.get("sub_1")?.terminal?.reason).toBe("sandbox_reset");
    });
  });

  it("finish() on an open row stamps deliveredAt — it owns this row's delivery", async () => {
    await withParent([openSubagentRow()], async ({ self, ledger }) => {
      await finish(self, "sub_1", { status: "completed" });

      expect(ledger.get("sub_1")?.deliveredAt).not.toBeNull();
      expect(ledger.listUndelivered()).toEqual([]);
    });
  });

  it("a reaped row whose OWN delivery threw stays owed after finish() — never stamped", async () => {
    await withParent([openSubagentRow()], async ({ self, ledger }) => {
      // The reaper's funnel closes the row first, but its own delivery throws
      // (a real failure mode: `deliverInjection` is synchronous and can fail) —
      // so the row is terminal with `deliveredAt: null`, genuinely owed.
      self.deliverInjection = vi.fn(() => {
        throw new Error("delivery failed");
      });
      await expect(
        (proto.terminalizeWork as any).call(
          self,
          "sub_1",
          { outcome: "fault", reason: "sandbox_reset", at: 5_000, detail: "gone" },
          "subagent",
        ),
      ).rejects.toThrow("delivery failed");
      expect(ledger.get("sub_1")?.terminal).not.toBeNull();
      expect(ledger.get("sub_1")?.deliveredAt).toBeNull();

      // The SDK's own `finish` still arrives after. `onAgentToolFinish`'s
      // `terminalize` now returns false (someone else already closed the
      // row), so its `if (closed)` guard must NOT stamp delivery here — the
      // obligation the reaper's throw left behind must stay retryable, not be
      // swallowed by a hook that closed nothing.
      await finish(self, "sub_1", { status: "completed" });

      expect(ledger.get("sub_1")?.deliveredAt).toBeNull();
      expect(ledger.listUndelivered().map((row) => row.id)).toEqual(["sub_1"]);
    });
  });

  it("timings derive from the row, so a run cannot be 'finished' yet still hold a lease", async () => {
    await withParent([openSubagentRow({ startedAt: 7_000 })], async ({ self }) => {
      expect(self.subagentRunTimings()).toEqual({ sub_1: { startedAt: 7_000 } });

      await finish(self, "sub_1", { status: "completed" });

      const timings = self.subagentRunTimings();
      expect(timings.sub_1.startedAt).toBe(7_000);
      expect(typeof timings.sub_1.finishedAt).toBe("number");
      expect(self.openSubagentRunIds()).toEqual([]);
    });
  });

  it("only SUBAGENT rows hold the subagent eviction hold — a watched process does not", async () => {
    // Process rows are already deferred by `countWatchers()` upstream of
    // `releaseIfIdle`; counting them HERE would instead make `execShutdown`
    // throw `compute_children_active` before its own confirm flow, breaking
    // thread destroy. See the gate's comment.
    await withParent([openSubagentRow({ id: "p1", kind: "process" })], async ({ self }) => {
      expect(self.openSubagentRunIds()).toEqual([]);
      expect(await hasBlockingWork(self)).toBe(false);
    });
  });

  it("the live-lease read ignores closed rows without scanning history", async () => {
    // `openSubagentRows` goes through `listOpen` (filtered on
    // `terminal_outcome IS NULL`) rather than `listAll`: `hasBlockingWork` runs
    // on every alarm tick and answers a boolean, and the ledger has no prune.
    const history: WorkRow[] = Array.from({ length: 20 }, (_, i) =>
      openSubagentRow({
        id: `sub_old_${i}`,
        startedAt: i,
        terminal: { outcome: "exited", reason: "process_exit", at: i + 1, detail: "completed" },
      }),
    );
    await withParent([...history, openSubagentRow({ id: "sub_live" })], async ({ self }) => {
      expect(self.openSubagentRows().map((row: WorkRow) => row.id)).toEqual(["sub_live"]);
      expect(await hasBlockingWork(self)).toBe(true);
      // The full history stays available to the views that actually want it.
      expect(self.subagentRows()).toHaveLength(21);
    });
  });
});

describe("the soft interrupt must not release the machine", () => {
  it("keeps the row OPEN while the child is still running, and closes it on the real terminal", async () => {
    await withParent([openSubagentRow()], async ({ self, ledger }) => {
      await finish(self, "sub_1", { status: "interrupted", childStillRunning: true });

      // The child is STILL on the shared machine. Releasing here lets the parent
      // evict (and DELETE) the sandbox out from under it.
      expect(self.openSubagentRunIds()).toEqual(["sub_1"]);
      expect(await hasBlockingWork(self)).toBe(true);
      expect(ledger.get("sub_1")?.terminal).toBeNull();

      // The later hard terminal is what closes it.
      await finish(self, "sub_1", { status: "completed" });
      expect(self.openSubagentRunIds()).toEqual([]);
    });
  });

  it("a hard interrupt (maxBudgetMs teardown) DOES close the row", async () => {
    await withParent([openSubagentRow()], async ({ self }) => {
      await finish(self, "sub_1", { status: "interrupted" });
      expect(self.openSubagentRunIds()).toEqual([]);
    });
  });

  it("a cancelled run is reported as stopped, never as exited", async () => {
    await withParent([openSubagentRow()], async ({ self, ledger }) => {
      await finish(self, "sub_1", { status: "aborted" });
      expect(ledger.get("sub_1")?.terminal?.outcome).toBe("stopped");
      expect(ledger.get("sub_1")?.terminal?.reason).toBe("process_stopped");
    });
  });
});

describe("liveness is activity-backed, not model-reported", () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  const subProto = SubAgent.prototype as unknown as Record<string, any>;

  function child(parent: { stampSubagentAlive: (runId: string) => Promise<void> }) {
    return {
      name: "sub_1",
      parentAgent: async () => parent,
      stampParentAlive: subProto.stampParentAlive,
      startLiveness: subProto.startLiveness,
      stopLiveness: subProto.stopLiveness,
    };
  }

  it("a child in one long SILENT model call keeps its row alive and is NOT faulted", async () => {
    await withParent(
      [openSubagentRow({ lastAliveAt: 1_000 })],
      async ({ self: parent, ledger }) => {
        vi.useFakeTimers();
        vi.setSystemTime(1_000);
        const sub = child(parent);

        // A turn starts: the child then does 40 minutes of ZERO reported progress —
        // one silent model call, or a build inside a synchronous exec. Only the
        // in-flight heartbeat says it is alive, which is the whole design.
        (subProto.startLiveness as any).call(sub);
        await vi.advanceTimersByTimeAsync(40 * 60_000);

        // The row tracked the whole run, never falling more than a heartbeat behind.
        const row = ledger.get("sub_1") as WorkRow;
        expect(row.terminal).toBeNull();
        expect(Date.now() - row.lastAliveAt).toBeLessThan(SUBAGENT_STALE_AFTER_MS);

        (subProto.stopLiveness as any).call(sub);
      },
    );
  });

  it("stops stamping once the turn settles, so a genuinely wedged child goes stale", async () => {
    await withParent(
      [openSubagentRow({ lastAliveAt: 1_000 })],
      async ({ self: parent, ledger }) => {
        vi.useFakeTimers();
        vi.setSystemTime(1_000);
        const sub = child(parent);

        (subProto.startLiveness as any).call(sub);
        await vi.advanceTimersByTimeAsync(60_000);
        (subProto.stopLiveness as any).call(sub);

        const stampedUntil = (ledger.get("sub_1") as WorkRow).lastAliveAt;
        await vi.advanceTimersByTimeAsync(10 * 60_000);

        // Nothing kept it alive after the timer stopped — no phantom liveness.
        expect((ledger.get("sub_1") as WorkRow).lastAliveAt).toBe(stampedUntil);
        expect(Date.now() - stampedUntil).toBeGreaterThan(SUBAGENT_STALE_AFTER_MS);
      },
    );
  });

  it("a stamp can never resurrect a row the reaper already closed", async () => {
    await withParent(
      [
        openSubagentRow({
          lastAliveAt: 1_000,
          terminal: { outcome: "fault", reason: "no_liveness", at: 200_000, detail: "torn down" },
        }),
      ],
      async ({ self: parent, ledger }) => {
        const sub = child(parent);

        await (subProto.stampParentAlive as any).call(sub);

        expect((ledger.get("sub_1") as WorkRow).lastAliveAt).toBe(1_000);
        expect((ledger.get("sub_1") as WorkRow).terminal?.reason).toBe("no_liveness");
      },
    );
  });

  it("a facet/RPC failure degrades to a missed stamp, never a thrown turn", async () => {
    const sub = child({
      stampSubagentAlive: async () => {
        throw new Error("parent facet unreachable");
      },
    });
    await expect((subProto.stampParentAlive as any).call(sub)).resolves.toBeUndefined();
  });
});

/**
 * C1: a subagent dispatched BEFORE the deploy that made the ledger row the lease
 * has no row after it — `hasBlockingWork()` answers false and `releaseIfIdle`
 * destroys the shared container out from under a live child. The old lease set
 * survived restarts; the ledger row has to be materialized from it once.
 */
describe("the legacy lease backfill (in-flight across the deploy)", () => {
  const backfill = (self: any) => (proto.ensureLegacySubagentBackfill as any).call(self);

  it("materializes a row for a legacy lease id and RESTORES the eviction hold", async () => {
    await withParent([], async ({ self, storage, ledger }) => {
      // Pre-deploy state: the lease set holds a live run; no ledger row exists.
      await storage.put(LEGACY_LEASE_KEY, ["sub_legacy"]);
      await storage.put(LEGACY_TIMING_KEY, { sub_legacy: { startedAt: 500_000 } });
      expect(ledger.get("sub_legacy")).toBeNull();

      // This is C1's actual failure: without the backfill this is `false` and
      // the container is deleted under a live child.
      expect(await hasBlockingWork(self)).toBe(true);

      const row = ledger.get("sub_legacy") as WorkRow;
      expect(row.kind).toBe("subagent");
      expect(row.terminal).toBeNull();
      expect(row.generation).toBe("gen-a");
      expect(row.staleAfterMs).toBe(SUBAGENT_STALE_AFTER_MS);
    });
  });

  it("keeps the run's REAL age: startedAt is the legacy value, not a fresh budget", async () => {
    await withParent([], async ({ self, ledger }) => {
      await self.ctx.storage.put(LEGACY_LEASE_KEY, ["sub_legacy"]);
      await self.ctx.storage.put(LEGACY_TIMING_KEY, { sub_legacy: { startedAt: 500_000 } });

      await backfill(self);

      const row = ledger.get("sub_legacy") as WorkRow;
      expect(row.startedAt).toBe(500_000);
      // The deadline derives from the LEGACY start. Deriving it from `now` would
      // silently hand a pre-deploy run a fresh full budget.
      expect(row.deadlineAt).toBe(500_000 + SUBAGENT_DEADLINE_MS);
      // Liveness is NOT back-dated: we have no history for it, and back-dating
      // would fault it `no_liveness` on the first sweep — releasing the very
      // hold this exists to preserve.
      expect(row.lastAliveAt).toBeGreaterThan(row.startedAt);
    });
  });

  it("a run already past its budget lands expired rather than renewed", async () => {
    await withParent([], async ({ self, ledger }) => {
      const longAgo = Date.now() - (SUBAGENT_DEADLINE_MS + 60_000);
      await self.ctx.storage.put(LEGACY_LEASE_KEY, ["sub_old"]);
      await self.ctx.storage.put(LEGACY_TIMING_KEY, { sub_old: { startedAt: longAgo } });

      await backfill(self);

      expect((ledger.get("sub_old") as WorkRow).deadlineAt).toBeLessThan(Date.now());
    });
  });

  it("deletes BOTH legacy keys, so it is genuinely one-shot", async () => {
    await withParent([], async ({ self, storage }) => {
      await storage.put(LEGACY_LEASE_KEY, ["sub_legacy"]);
      await storage.put(LEGACY_TIMING_KEY, { sub_legacy: { startedAt: 500_000 } });

      await backfill(self);

      expect(await storage.get(LEGACY_LEASE_KEY)).toBeUndefined();
      expect(await storage.get(LEGACY_TIMING_KEY)).toBeUndefined();
    });
  });

  it("is idempotent: a second pass neither duplicates nor rewinds a row", async () => {
    await withParent([], async ({ self, ledger }) => {
      await self.ctx.storage.put(LEGACY_LEASE_KEY, ["sub_legacy"]);
      await self.ctx.storage.put(LEGACY_TIMING_KEY, { sub_legacy: { startedAt: 500_000 } });

      await backfill(self);
      const first = ledger.get("sub_legacy") as WorkRow;

      // Re-arm the memo and re-run against the now-empty keys, and also run the
      // raw pass a third time to prove it is the DATA, not the memo, that makes
      // this one-shot.
      self.legacyBackfillPromise = undefined;
      await backfill(self);
      await (proto.backfillLegacySubagentRuns as any).call(self);

      expect(ledger.listAll()).toHaveLength(1);
      expect(ledger.get("sub_legacy")).toEqual(first);
    });
  });

  it("never re-opens a run that already has a row (migrated, or already terminal)", async () => {
    const terminal = openSubagentRow({
      id: "sub_done",
      terminal: { outcome: "exited", reason: "process_exit", at: 9_000, detail: "completed" },
    });
    await withParent([terminal], async ({ self, ledger }) => {
      await self.ctx.storage.put(LEGACY_LEASE_KEY, ["sub_done"]);

      await backfill(self);

      // Still terminal: a stale lease entry must not resurrect a finished run
      // into a permanent eviction hold.
      expect(ledger.get("sub_done")?.terminal?.reason).toBe("process_exit");
      expect(await hasBlockingWork(self)).toBe(false);
    });
  });

  it("skips a run the legacy timing map already finished", async () => {
    await withParent([], async ({ self, ledger }) => {
      await self.ctx.storage.put(LEGACY_LEASE_KEY, ["sub_done"]);
      await self.ctx.storage.put(LEGACY_TIMING_KEY, {
        sub_done: { startedAt: 500_000, finishedAt: 600_000 },
      });

      await backfill(self);

      expect(ledger.get("sub_done")).toBeNull();
      expect(await hasBlockingWork(self)).toBe(false);
    });
  });

  it("never throws on a malformed or missing legacy value", async () => {
    // This runs on the alarm path: a throw here breaks the reaper for the whole
    // thread, so every legacy shape must degrade, not explode.
    const malformed: unknown[] = [
      "not-an-array",
      42,
      null,
      [1, 2, 3],
      [{ nested: "object" }],
      ["sub_a", "", "sub_b"],
    ];
    for (const lease of malformed) {
      await withParent([], async ({ self }) => {
        await self.ctx.storage.put(LEGACY_LEASE_KEY, lease);
        await self.ctx.storage.put(LEGACY_TIMING_KEY, "garbage");
        await expect(backfill(self)).resolves.toBeUndefined();
      });
    }
  });

  it("falls back to now when the timing map is missing entirely", async () => {
    await withParent([], async ({ self, ledger }) => {
      await self.ctx.storage.put(LEGACY_LEASE_KEY, ["sub_legacy"]);
      // No timing key at all — the lease set alone is enough to hold the machine.
      await backfill(self);

      const row = ledger.get("sub_legacy") as WorkRow;
      expect(row.terminal).toBeNull();
      expect(row.deadlineAt).toBe(row.startedAt + SUBAGENT_DEADLINE_MS);
    });
  });

  it("does nothing at all when there is no legacy state", async () => {
    await withParent([], async ({ self, ledger }) => {
      await backfill(self);
      expect(ledger.listAll()).toEqual([]);
      expect(await hasBlockingWork(self)).toBe(false);
    });
  });
});

/**
 * I4: `terminalizeWork` delivers the fault, then calls `cancelSubagentRun` ->
 * `cancelAgentTool`, which makes the SDK fire `_deliverDetachedTerminal(runId,
 * "finish", { status: "aborted" })` — a SECOND injection under a different
 * dedupe key. The model would read "the sandbox was reset, all files are lost"
 * followed by a card saying the subagent was cancelled.
 */
describe("the reaper must not double-notify", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  // `Think.prototype` is exactly `Object.getPrototypeOf(ThinkThreadAgent.prototype)`
  // — what the override calls through to (and what
  // subagent-detached-injection.test.ts pins the shape of). Stub it so the real
  // override can run over a duck-typed `this`.
  const stubSdkBase = () =>
    vi
      .spyOn(Object.getPrototypeOf(ThinkThreadAgent.prototype), "_deliverDetachedTerminal")
      .mockResolvedValue(undefined);

  const deliverDetached = (self: any, runId: string, result: Record<string, unknown>) =>
    (proto._deliverDetachedTerminal as any).call(self, runId, "finish", result);

  it("delivers ONE message when the reaper faults and then kills a run", async () => {
    stubSdkBase();
    await withParent([openSubagentRow()], async ({ self }) => {
      // The real chain: the reaper's cancel is what re-enters the SDK.
      self.cancelSubagentRun = vi.fn(async (runId: string) => {
        await deliverDetached(self, runId, { status: "aborted" });
      });

      await (proto.terminalizeWork as any).call(
        self,
        "sub_1",
        { outcome: "fault", reason: "sandbox_reset", at: 5_000, detail: "gone" },
        "subagent",
      );

      expect(self.cancelSubagentRun).toHaveBeenCalledWith("sub_1");
      // Exactly one: the fault. The SDK's redundant "cancelled" finish is
      // suppressed, and the fault is the message that survives.
      expect(self.deliverInjection).toHaveBeenCalledTimes(1);
      expect(self.deliverInjection.mock.calls[0][0].dedupeKey).toBe("subagent:sub_1:fault");
    });
  });

  it("still delivers a NORMAL completion — the finish carries the run summary", async () => {
    stubSdkBase();
    await withParent([openSubagentRow()], async ({ self }) => {
      // A clean completion closes the row as `process_exit`, which is NOT a
      // reaper reason, so the finish injection must survive. Regressing this
      // would silence every subagent completion.
      await finish(self, "sub_1", { status: "completed" });
      await deliverDetached(self, "sub_1", { status: "completed", summary: "done" });

      expect(self.deliverInjection).toHaveBeenCalledTimes(1);
      expect(self.deliverInjection.mock.calls[0][0].dedupeKey).toBe("subagent:sub_1:finish");
    });
  });

  it("still delivers when the row is not closed yet (either interleaving)", async () => {
    stubSdkBase();
    await withParent([openSubagentRow()], async ({ self }) => {
      await deliverDetached(self, "sub_1", { status: "completed", summary: "done" });
      expect(self.deliverInjection).toHaveBeenCalledTimes(1);
    });
  });

  it("still delivers for a USER cancel — only the reaper's own kill is redundant", async () => {
    stubSdkBase();
    await withParent([openSubagentRow()], async ({ self }) => {
      await finish(self, "sub_1", { status: "aborted" });
      await deliverDetached(self, "sub_1", { status: "aborted" });

      expect(self.reaperAlreadyReported("sub_1")).toBe(false);
      expect(self.deliverInjection).toHaveBeenCalledTimes(1);
    });
  });

  it("a soft interrupt still injects nothing and keeps the hold", async () => {
    stubSdkBase();
    await withParent([openSubagentRow()], async ({ self }) => {
      await deliverDetached(self, "sub_1", { status: "interrupted", childStillRunning: true });
      expect(self.deliverInjection).not.toHaveBeenCalled();
      expect(await hasBlockingWork(self)).toBe(true);
    });
  });
});
