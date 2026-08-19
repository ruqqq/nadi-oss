import { env, runInDurableObject } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import { WorkLedgerStore } from "../../../src/agent/work-ledger-store";
import { PROCESS_STALE_AFTER_MS, nextSweepAt, type WorkRow } from "../../../src/agent/work-ledger";

function row(overrides?: Partial<WorkRow>): WorkRow {
  return {
    id: "p1",
    kind: "process",
    startedAt: 0,
    lastAliveAt: 1_000,
    staleAfterMs: PROCESS_STALE_AFTER_MS,
    deadlineAt: 100_000,
    generation: "gen-a",
    terminal: null,
    deliveredAt: null,
    ...overrides,
  };
}

async function withStore(fn: (store: WorkLedgerStore) => void | Promise<void>) {
  const id = env.THINK_THREAD_AGENT.idFromName(`ledger-${crypto.randomUUID()}`);
  const stub = env.THINK_THREAD_AGENT.get(id);
  await runInDurableObject(stub, async (_instance, state) => {
    const store = new WorkLedgerStore(state.storage);
    store.migrate();
    await fn(store);
  });
}

describe("WorkLedgerStore", () => {
  it("round-trips a registered row", async () => {
    await withStore((store) => {
      store.register(row());
      expect(store.get("p1")).toEqual(row());
    });
  });

  it("returns null for an unknown id", async () => {
    await withStore((store) => {
      expect(store.get("nope")).toBeNull();
    });
  });

  it("is idempotent on re-register and never rewinds startedAt", async () => {
    await withStore((store) => {
      store.register(row({ startedAt: 100 }));
      store.register(row({ startedAt: 999, lastAliveAt: 5_000 }));
      const got = store.get("p1");
      expect(got?.startedAt).toBe(100);
      expect(got?.lastAliveAt).toBe(5_000);
    });
  });

  it("stampAlive advances lastAliveAt but never moves it backwards", async () => {
    await withStore((store) => {
      store.register(row({ lastAliveAt: 1_000 }));
      store.stampAlive("p1", 2_000);
      expect(store.get("p1")?.lastAliveAt).toBe(2_000);
      store.stampAlive("p1", 500);
      expect(store.get("p1")?.lastAliveAt).toBe(2_000);
    });
  });

  it("stampAlive on an unknown or terminal row is a no-op, not a throw", async () => {
    await withStore((store) => {
      expect(() => store.stampAlive("ghost", 5_000)).not.toThrow();
      store.register(row());
      store.terminalize("p1", {
        outcome: "exited",
        reason: "process_exit",
        at: 3_000,
        detail: "code 0",
      });
      store.stampAlive("p1", 9_000);
      expect(store.get("p1")?.lastAliveAt).toBe(1_000);
    });
  });

  it("listOpen excludes terminal rows; listAll includes them", async () => {
    await withStore((store) => {
      store.register(row({ id: "a" }));
      store.register(row({ id: "b" }));
      store.terminalize("b", {
        outcome: "fault",
        reason: "sandbox_reset",
        at: 2_000,
        detail: "gone",
      });
      expect(store.listOpen().map((r) => r.id)).toEqual(["a"]);
      expect(
        store
          .listAll()
          .map((r) => r.id)
          .sort(),
      ).toEqual(["a", "b"]);
    });
  });

  it("terminalize returns true once and false on every repeat (exactly-once gate)", async () => {
    await withStore((store) => {
      store.register(row());
      const first = {
        outcome: "exited",
        reason: "process_exit",
        at: 2_000,
        detail: "code 0",
      } as const;
      expect(store.terminalize("p1", first)).toBe(true);
      expect(
        store.terminalize("p1", {
          outcome: "fault",
          reason: "no_liveness",
          at: 9_000,
          detail: "late",
        }),
      ).toBe(false);
      expect(store.get("p1")?.terminal).toEqual(first);
    });
  });

  it("terminalize on an unknown id returns false", async () => {
    await withStore((store) => {
      expect(
        store.terminalize("ghost", {
          outcome: "timeout",
          reason: "watch_timeout",
          at: 1,
          detail: "",
        }),
      ).toBe(false);
    });
  });

  it("survives a second migrate() without losing rows", async () => {
    await withStore((store) => {
      store.register(row());
      store.migrate();
      expect(store.get("p1")).toEqual(row());
    });
  });
});

/**
 * The DELIVERY gate, split from the terminal write. `terminalize`'s boolean used
 * to mean both "I closed this row" AND "I own delivery for it", so a throw on
 * the way to the model left the row closed and the model never told — a terminal
 * that reached no one, which is the one hole the reaper could not see.
 */
describe("WorkLedgerStore: the delivery gate", () => {
  const terminal = {
    outcome: "fault",
    reason: "no_liveness",
    at: 3_000,
    detail: "stale",
  } as const;

  it("markDelivered returns true exactly once", async () => {
    await withStore((store) => {
      store.register(row());
      store.terminalize("p1", terminal);
      expect(store.markDelivered("p1", 1_000)).toBe(true);
      expect(store.markDelivered("p1", 2_000)).toBe(false);
      // The first writer's stamp stands, exactly like `terminalize`.
      expect(store.get("p1")?.deliveredAt).toBe(1_000);
    });
  });

  it("markDelivered on an OPEN row does nothing — there is no terminal to deliver", async () => {
    await withStore((store) => {
      store.register(row());
      expect(store.markDelivered("p1", 1_000)).toBe(false);
      expect(store.get("p1")?.deliveredAt).toBeNull();
    });
  });

  it("markDelivered on an unknown id returns false", async () => {
    await withStore((store) => {
      expect(store.markDelivered("ghost", 1_000)).toBe(false);
    });
  });

  it("lists a terminalized row whose delivery never landed", async () => {
    await withStore((store) => {
      store.register(row());
      store.terminalize("p1", terminal);
      expect(store.listUndelivered().map((r) => r.id)).toEqual(["p1"]);
      store.markDelivered("p1", 1_000);
      expect(store.listUndelivered()).toEqual([]);
    });
  });

  it("does not list an open row as undelivered", async () => {
    await withStore((store) => {
      store.register(row());
      expect(store.listUndelivered()).toEqual([]);
    });
  });

  /**
   * DEPLOY HAZARD. Rows written by the previous schema version have no
   * `delivered_at`, so a terminal one reads as "owed a delivery" — but the old
   * code already delivered it. Without this backfill, deploying the new sweep
   * replays a stale completion into every pre-existing live thread.
   */
  it("backfills pre-existing terminal rows as already delivered", async () => {
    const id = env.THINK_THREAD_AGENT.idFromName(`ledger-${crypto.randomUUID()}`);
    const stub = env.THINK_THREAD_AGENT.get(id);
    await runInDurableObject(stub, async (_instance, state) => {
      // The v1 table, verbatim: no `delivered_at` column at all.
      state.storage.sql.exec(`
        CREATE TABLE background_work (
          id text primary key,
          kind text not null,
          started_at integer not null,
          last_alive_at integer not null,
          stale_after_ms integer not null,
          deadline_at integer not null,
          generation text not null,
          terminal_outcome text,
          terminal_reason text,
          terminal_at integer,
          terminal_detail text
        )
      `);
      state.storage.sql.exec(
        `INSERT INTO background_work VALUES
           ('closed', 'process', 0, 1000, 21000, 100000, 'gen-a', 'fault', 'no_liveness', 4000, 'told'),
           ('open', 'process', 0, 1000, 21000, 100000, 'gen-a', NULL, NULL, NULL, NULL)`,
      );

      const store = new WorkLedgerStore(state.storage);
      store.migrate();

      // Already told about, back when the old code delivered it: never replay.
      expect(store.get("closed")?.deliveredAt).toBe(4_000);
      expect(store.listUndelivered()).toEqual([]);
      // The open row is untouched — it has no terminal to have delivered.
      expect(store.get("open")?.deliveredAt).toBeNull();
      expect(store.listOpen().map((r) => r.id)).toEqual(["open"]);
    });
  });

  it("the backfill is one-shot — a later migrate() cannot swallow a real pending delivery", async () => {
    await withStore((store) => {
      store.register(row());
      store.terminalize("p1", terminal);
      // A terminal genuinely owed a delivery. `migrate()` runs on every DO
      // start, so a backfill outside the ALTER branch would mark it delivered
      // here and the sweep would never retry it.
      store.migrate();
      expect(store.get("p1")?.deliveredAt).toBeNull();
      expect(store.listUndelivered().map((r) => r.id)).toEqual(["p1"]);
    });
  });
});

/**
 * Retention. The predicate is a CORRECTNESS constraint, not a preference: a
 * pruned id that is later re-registered comes back as a fresh OPEN row and
 * gets faulted `no_liveness` ~21s later — a false fault on work that already
 * ended cleanly. See PLAN HISTORY in the task-3 brief for why the predicate
 * reads `delivered_at` directly rather than filtering on `terminal_reason`.
 */
describe("WorkLedgerStore: prune", () => {
  const RETENTION_MS = 24 * 60 * 60_000;

  it("keeps a delivered terminal row inside the retention window", async () => {
    await withStore((store) => {
      const now = Date.now();
      const terminalAt = now - (RETENTION_MS - 1);
      store.register(row());
      store.terminalize("p1", {
        outcome: "exited",
        reason: "process_exit",
        at: terminalAt,
        detail: "code 0",
      });
      store.markDelivered("p1", terminalAt);
      store.prune(now - RETENTION_MS);
      expect(store.get("p1")).not.toBeNull();
    });
  });

  it("prunes a delivered terminal row past the retention window", async () => {
    await withStore((store) => {
      const now = Date.now();
      const terminalAt = now - (RETENTION_MS + 1);
      store.register(row());
      store.terminalize("p1", {
        outcome: "exited",
        reason: "process_exit",
        at: terminalAt,
        detail: "code 0",
      });
      store.markDelivered("p1", terminalAt);
      store.prune(now - RETENTION_MS);
      expect(store.get("p1")).toBeNull();
    });
  });

  it("never prunes an open row", async () => {
    await withStore((store) => {
      const now = Date.now();
      store.register(row({ startedAt: now - 10 * RETENTION_MS }));
      store.prune(now);
      expect(store.get("p1")).not.toBeNull();
    });
  });

  it("never prunes a terminal row that is still owed a delivery", async () => {
    await withStore((store) => {
      const now = Date.now();
      const terminalAt = now - (RETENTION_MS + 1);
      store.register(row());
      store.terminalize("p1", {
        outcome: "fault",
        reason: "no_liveness",
        at: terminalAt,
        detail: "stale",
      });
      // delivered_at NULL. Pruning it drops the retry and reintroduces the
      // delivery hole the delivered_at split closed.
      store.prune(now - RETENTION_MS);
      expect(store.get("p1")).not.toBeNull();
    });
  });

  it("prunes an aged clean exit", async () => {
    // A process_exit row IS stamped now (its writer discharges the obligation
    // at terminalize time). If this test ever fails, a writer stopped
    // stamping and the prune has gone inert against the most common row
    // class -- which is the exact unbounded growth this task exists to fix.
    await withStore((store) => {
      const now = Date.now();
      const terminalAt = now - (RETENTION_MS + 1);
      store.register(row());
      store.terminalize("p1", {
        outcome: "exited",
        reason: "process_exit",
        at: terminalAt,
        detail: "code 0",
      });
      store.markDelivered("p1", terminalAt);
      store.prune(now - RETENTION_MS);
      expect(store.get("p1")).toBeNull();
    });
  });

  it("keeps listUndelivered and prune in lockstep", async () => {
    // The property: anything listUndelivered() returns must survive prune()
    // at any age, and vice versa. Both read delivered_at, so they cannot
    // drift -- this test is what proves that stays true.
    await withStore((store) => {
      const now = Date.now();
      const terminalAt = now - (RETENTION_MS + 1);
      store.register(row());
      store.terminalize("p1", {
        outcome: "fault",
        reason: "no_liveness",
        at: terminalAt,
        detail: "stale",
      });
      expect(store.listUndelivered().map((r) => r.id)).toEqual(["p1"]);
      store.prune(now - RETENTION_MS);
      // Still owed, so prune must have spared it, and listUndelivered must
      // still report it.
      expect(store.get("p1")).not.toBeNull();
      expect(store.listUndelivered().map((r) => r.id)).toEqual(["p1"]);
    });
  });
});

/**
 * `stampProgress` — the receiving end of a subagent child's progress push. The
 * guards mirror `stampAlive`'s, and for the same reasons.
 */
describe("WorkLedgerStore: stampProgress", () => {
  it("stores a progress signal and round-trips it", async () => {
    await withStore((store) => {
      store.register(row({ id: "s1", kind: "subagent" }));
      store.stampProgress("s1", { phase: "working", message: "step 2", at: 5_000 });
      expect(store.get("s1")!.progress).toEqual({
        phase: "working",
        message: "step 2",
        at: 5_000,
      });
    });
  });

  it("omits progress entirely for a row that never reported one", async () => {
    await withStore((store) => {
      store.register(row({ id: "s1", kind: "subagent" }));
      expect(store.get("s1")!.progress).toBeUndefined();
    });
  });

  it("keeps a phase-only signal, which a message-keyed read would drop", async () => {
    await withStore((store) => {
      store.register(row({ id: "s1", kind: "subagent" }));
      store.stampProgress("s1", { phase: "compiling", message: null, at: 5_000 });
      expect(store.get("s1")!.progress).toEqual({ phase: "compiling", message: null, at: 5_000 });
    });
  });

  it("never moves progress backwards", async () => {
    await withStore((store) => {
      store.register(row({ id: "s1", kind: "subagent" }));
      store.stampProgress("s1", { phase: "working", message: "step 9", at: 9_000 });
      // A stamp that arrives late (the child's 30s timer racing a newer turn's
      // stamp) must not replace a newer signal with an older one.
      store.stampProgress("s1", { phase: "working", message: "step 4", at: 4_000 });
      expect(store.get("s1")!.progress).toMatchObject({ message: "step 9", at: 9_000 });
    });
  });

  it("is a no-op on a terminal row", async () => {
    await withStore((store) => {
      store.register(row({ id: "s1", kind: "subagent" }));
      store.terminalize("s1", {
        outcome: "exited",
        reason: "process_exit",
        at: 8_000,
        detail: "completed",
      });
      store.stampProgress("s1", { phase: "working", message: "step 5", at: 9_000 });
      // A push racing the terminal must not decorate a closed run.
      expect(store.get("s1")!.progress).toBeUndefined();
    });
  });

  it("is a no-op for an unknown id", async () => {
    await withStore((store) => {
      expect(() =>
        store.stampProgress("nope", { phase: "working", message: "step 1", at: 1_000 }),
      ).not.toThrow();
      expect(store.get("nope")).toBeNull();
    });
  });
});

/**
 * `listRecent` — the background-work dock's read path. Deliberately not
 * `listOpen()`: the dock's whole gain over the two views it replaces is
 * showing a TERMINAL outcome.
 */
describe("WorkLedgerStore: listRecent", () => {
  it("includes open rows", async () => {
    await withStore((store) => {
      store.register(row({ id: "open1" }));
      expect(store.listRecent().map((r) => r.id)).toEqual(["open1"]);
    });
  });

  it("includes a terminal row delivered inside the window", async () => {
    await withStore((store) => {
      const now = Date.now();
      store.register(row({ id: "done", startedAt: now - 1_000 }));
      store.terminalize("done", {
        outcome: "exited",
        reason: "process_exit",
        at: now - 1_000,
        detail: "code 0",
      });
      store.markDelivered("done", now - 1_000);
      expect(store.listRecent(now).map((r) => r.id)).toEqual(["done"]);
    });
  });

  it("excludes a terminal row delivered outside the window", async () => {
    await withStore((store) => {
      const now = Date.now();
      store.register(row({ id: "old", startedAt: now - 20 * 60_000 }));
      store.terminalize("old", {
        outcome: "exited",
        reason: "process_exit",
        at: now - 20 * 60_000,
        detail: "code 0",
      });
      store.markDelivered("old", now - 20 * 60_000);
      expect(store.listRecent(now).map((r) => r.id)).toEqual([]);
    });
  });

  /**
   * The window keys on `deliveredAt`, not `startedAt` or the terminal time: a
   * row started and terminalized long ago but delivered just now (a retried
   * delivery landing late) must still count as recent.
   */
  it("keys the window on deliveredAt, not startedAt or the terminal time", async () => {
    await withStore((store) => {
      const now = Date.now();
      const longAgo = now - 20 * 60_000;
      store.register(row({ id: "late", startedAt: longAgo }));
      store.terminalize("late", {
        outcome: "fault",
        reason: "no_liveness",
        at: longAgo,
        detail: "stale",
      });
      // Delivered just now, well after both startedAt and the terminal time.
      store.markDelivered("late", now);
      expect(store.listRecent(now).map((r) => r.id)).toEqual(["late"]);
    });
  });

  /**
   * I1: a row that is terminal with `delivered_at IS NULL` is not a
   * hypothetical — it is `listUndelivered()`'s exact set, the state the
   * `terminalize`/`markDelivered` split exists to model (delivery owed and
   * retryable, see `WORK_DELIVERY_RETRY_MS`). Precisely when a delivery
   * throws, this is the row a status dock most needs to keep showing.
   */
  it("includes an owed row — terminal with delivered_at still NULL", async () => {
    await withStore((store) => {
      const now = Date.now();
      store.register(row({ id: "owed", startedAt: now - 20 * 60_000 }));
      store.terminalize("owed", {
        outcome: "fault",
        reason: "no_liveness",
        at: now - 20 * 60_000,
        detail: "delivery threw",
      });
      // No markDelivered call: the delivery attempt threw, exactly like
      // `deliverWorkTerminal` when `deliverInjection` fails.
      expect(store.listRecent(now).map((r) => r.id)).toEqual(["owed"]);
    });
  });

  it("orders newest-started first", async () => {
    await withStore((store) => {
      store.register(row({ id: "older", startedAt: 100 }));
      store.register(row({ id: "newer", startedAt: 200 }));
      expect(store.listRecent().map((r) => r.id)).toEqual(["newer", "older"]);
    });
  });
});

describe("runWorkLedgerSweep (the reaper closes rows)", () => {
  /**
   * REGRESSION (C3): the dark ship left `terminalize` with ZERO call sites, so
   * no row ever closed. `nextSweepAt` over a settled-but-open row returns
   * `lastAliveAt + staleAfterMs` — permanently in the PAST — and
   * `Agent.schedule` accepts a past Date, so the alarm re-fires immediately,
   * sweeps, re-arms in the past, forever: a hot loop for the DO's life, each
   * iteration paying a full resolveComputeService. Closing the row is what
   * advances the horizon and makes the loop impossible.
   */
  it("terminalizes a stale row so the horizon advances instead of staying in the past", async () => {
    const id = env.THINK_THREAD_AGENT.idFromName(`sweep-${crypto.randomUUID()}`);
    const stub = env.THINK_THREAD_AGENT.get(id);
    await runInDurableObject(stub, async (instance, state) => {
      const store = new WorkLedgerStore(state.storage);
      store.migrate();

      // A row that has been silent well past its staleness threshold: its
      // horizon is already behind us.
      const now = Date.now();
      const stale = row({
        id: "stuck",
        startedAt: now - 10 * 60_000,
        lastAliveAt: now - 10 * 60_000,
        deadlineAt: now + 60 * 60_000,
      });
      store.register(stale);
      expect(nextSweepAt(store.listOpen())).toBeLessThan(now);

      const result = await (
        instance as unknown as {
          runWorkLedgerSweep: () => Promise<{
            classified: Array<{ id: string; state: string; reason: string }>;
            terminalized: string[];
          }>;
        }
      ).runWorkLedgerSweep();

      // No live compute here, so the generation is unknown — never a reset.
      // The row must still close, on the staleness path.
      expect(result.classified).toEqual([{ id: "stuck", state: "stale", reason: "no_liveness" }]);
      expect(result.terminalized).toEqual(["stuck"]);

      // The row is closed, so it no longer pins the horizon in the past.
      expect(store.get("stuck")?.terminal).toMatchObject({
        outcome: "fault",
        reason: "no_liveness",
      });
      expect(store.listOpen()).toEqual([]);
      expect(nextSweepAt(store.listOpen())).toBeNull();
    });
  });

  it("reports terminalized exactly once — a second sweep re-closes nothing", async () => {
    const id = env.THINK_THREAD_AGENT.idFromName(`sweep-${crypto.randomUUID()}`);
    const stub = env.THINK_THREAD_AGENT.get(id);
    await runInDurableObject(stub, async (instance, state) => {
      const store = new WorkLedgerStore(state.storage);
      store.migrate();
      const now = Date.now();
      store.register(
        row({
          id: "stuck",
          startedAt: now - 600_000,
          lastAliveAt: now - 600_000,
          deadlineAt: now + 600_000,
        }),
      );

      const agent = instance as unknown as {
        runWorkLedgerSweep: () => Promise<{ terminalized: string[] }>;
      };
      expect((await agent.runWorkLedgerSweep()).terminalized).toEqual(["stuck"]);
      // The row is terminal now, so listOpen skips it entirely — the delivery
      // funnel Task 6 hangs off `terminalized` can never double-fire.
      expect((await agent.runWorkLedgerSweep()).terminalized).toEqual([]);
    });
  });
});

/**
 * The sweep RETRIES a terminal the model was never told about.
 *
 * `terminalizeWork` writes the terminal and then delivers. A throw in between
 * left the row closed — invisible to `listOpen`, so the classification pass can
 * never revisit it — with the model never told. That was the one surviving path
 * where work reached a terminal and nobody heard about it.
 */
describe("runWorkLedgerSweep (the reaper retries an undelivered terminal)", () => {
  type SweepAgent = {
    runWorkLedgerSweep: () => Promise<{ terminalized: string[]; redelivered: string[] }>;
    deliverInjection: (entry: { dedupeKey: string }) => void;
    cancelSubagentRun: (runId: string) => Promise<void>;
  };

  async function withSweep(
    fn: (input: {
      store: WorkLedgerStore;
      agent: SweepAgent;
      delivered: string[];
      cancelled: string[];
      failDelivery: (fail: boolean) => void;
    }) => Promise<void>,
  ) {
    const id = env.THINK_THREAD_AGENT.idFromName(`retry-${crypto.randomUUID()}`);
    const stub = env.THINK_THREAD_AGENT.get(id);
    await runInDurableObject(stub, async (instance, state) => {
      const store = new WorkLedgerStore(state.storage);
      store.migrate();
      const delivered: string[] = [];
      const cancelled: string[] = [];
      let fail = false;
      const agent = instance as unknown as SweepAgent;
      agent.deliverInjection = (entry) => {
        if (fail) throw new Error("injection buffer write failed");
        delivered.push(entry.dedupeKey);
      };
      agent.cancelSubagentRun = async (runId) => void cancelled.push(runId);
      await fn({ store, agent, delivered, cancelled, failDelivery: (f) => void (fail = f) });
    });
  }

  const staleRow = (overrides?: Partial<WorkRow>): WorkRow => {
    const now = Date.now();
    return row({
      id: "stuck",
      startedAt: now - 600_000,
      lastAliveAt: now - 600_000,
      deadlineAt: now + 600_000,
      ...overrides,
    });
  };

  it("retries delivery on the next sweep when deliverInjection throws", async () => {
    await withSweep(async ({ store, agent, delivered, failDelivery }) => {
      store.register(staleRow());

      failDelivery(true);
      await agent.runWorkLedgerSweep();
      // The row is CLOSED — the terminal write stands, so the horizon advances
      // and the alarm cannot spin. But the model was never told.
      expect(store.get("stuck")?.terminal).toMatchObject({ reason: "no_liveness" });
      expect(store.get("stuck")?.deliveredAt).toBeNull();
      expect(delivered).toEqual([]);

      failDelivery(false);
      const second = await agent.runWorkLedgerSweep();
      expect(delivered).toEqual(["watcher:stuck:fault"]);
      expect(second.redelivered).toEqual(["stuck"]);
      expect(store.get("stuck")?.deliveredAt).not.toBeNull();

      // Told once, and only once: the gate is closed now.
      const third = await agent.runWorkLedgerSweep();
      expect(third.redelivered).toEqual([]);
      expect(delivered).toEqual(["watcher:stuck:fault"]);
    });
  });

  it("a retry delivers only — it never re-runs teardown", async () => {
    await withSweep(async ({ store, agent, delivered, cancelled, failDelivery }) => {
      store.register(staleRow({ id: "run_1", kind: "subagent", staleAfterMs: 180_000 }));

      failDelivery(true);
      await agent.runWorkLedgerSweep();
      // Delivery threw before teardown, so the run was never cancelled here.
      expect(cancelled).toEqual([]);

      failDelivery(false);
      await agent.runWorkLedgerSweep();
      expect(delivered).toEqual(["subagent:run_1:fault"]);
      // Delivery only. Teardown belongs to the funnel; the retry must not
      // re-enter `cancelSubagentRun` on a run the SDK may already have settled.
      expect(cancelled).toEqual([]);
      expect(store.get("run_1")?.deliveredAt).not.toBeNull();
    });
  });

  /**
   * The scope guard, keyed on the GATE rather than on the terminal's reason.
   *
   * It used to be keyed on `REAPER_WORK_REASONS`, to keep the sweep off the
   * clean `process_exit`/`process_stopped` completions that whatever OBSERVED
   * the work settle reports itself. That guard was unsound — `watch_timeout` is
   * written by `pollWatcher` too, so a reminder it had already delivered passed
   * the filter and the model read the same event twice (see
   * work-delivery-ownership.test.ts, which drives the real writers).
   *
   * Those writers now DECLARE their ownership by stamping `delivered_at`, so
   * this pins the property that actually matters: a discharged row is never
   * retried, whatever its reason says.
   */
  it("never retries a terminal whose delivery is already discharged", async () => {
    await withSweep(async ({ store, agent, delivered }) => {
      const at = Date.now();
      store.register(row({ id: "clean" }));
      store.terminalize("clean", {
        outcome: "exited",
        reason: "process_exit",
        at,
        detail: "code 0",
      });
      // What `onAgentToolFinish` / the compute layer do at terminalize time.
      expect(store.markDelivered("clean", at)).toBe(true);

      const result = await agent.runWorkLedgerSweep();
      expect(result.redelivered).toEqual([]);
      expect(delivered).toEqual([]);
    });
  });

  /**
   * Anti-vacuity for the test above, and the I1 half made explicit: the reason
   * is NOT what spares a row. An unstamped `process_exit` is a terminal nobody
   * told the model about, so the sweep owes it — the old filter would have
   * skipped it forever on the strength of its reason alone.
   */
  it("retries an undelivered terminal regardless of its reason", async () => {
    await withSweep(async ({ store, agent, delivered }) => {
      store.register(row({ id: "orphan" }));
      store.terminalize("orphan", {
        outcome: "exited",
        reason: "process_exit",
        at: Date.now(),
        detail: "code 0",
      });

      const result = await agent.runWorkLedgerSweep();
      expect(result.redelivered).toEqual(["orphan"]);
      expect(delivered).toEqual(["watcher:orphan:exited"]);
      expect(store.get("orphan")?.deliveredAt).not.toBeNull();
    });
  });
});

describe("WorkLedgerStore: stop attribution", () => {
  it("round-trips who asked for a stop", async () => {
    await withStore((store) => {
      store.register(row());
      store.terminalize("p1", {
        outcome: "stopped",
        reason: "process_stopped",
        at: 7_000,
        detail: "aborted",
        actor: "user",
      });
      expect(store.get("p1")?.terminal?.actor).toBe("user");
    });
  });

  it("omits the actor for a stop nobody claimed, so legacy rows compare equal", async () => {
    await withStore((store) => {
      store.register(row());
      store.terminalize("p1", {
        outcome: "stopped",
        reason: "process_stopped",
        at: 7_000,
        detail: "aborted",
      });
      expect(store.get("p1")?.terminal).toEqual({
        outcome: "stopped",
        reason: "process_stopped",
        at: 7_000,
        detail: "aborted",
      });
    });
  });
});
