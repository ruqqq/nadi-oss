import { env, runInDurableObject } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import { WorkLedgerStore } from "../../../src/agent/work-ledger-store";
import {
  PROCESS_STALE_AFTER_MS,
  type WorkKind,
  type WorkOutcome,
  type WorkReason,
  type WorkRow,
} from "../../../src/agent/work-ledger";

/**
 * `listBackgroundWork` — the background-work dock's one RPC over the ledger.
 * These exercises drive the REAL DO/RPC method (not just the store), because
 * Important 1's bug (an owed row silently dropping out of the dock) lives in
 * `WorkLedgerStore.listRecent`, which `listBackgroundWork` calls with no
 * filtering of its own — coverage at the store level alone would not have
 * proven the RPC surfaces what the store returns.
 *
 * `_turnRuntimeConfig` is set directly (bypassing `resolveRuntimeConfigForThink`,
 * which requires a D1-registered thread) because `backgroundWorkAdmissionEnabled`
 * reads it before ever touching D1 when it is set — the same escape hatch a
 * real turn uses via `beforeTurn`. Only `backgroundWorkEnabled` is read off it
 * here, so a minimal cast is enough.
 */

// A standalone shape, deliberately NOT `ThinkThreadAgent & {...}` — intersecting
// with the real class collapses `_turnRuntimeConfig` to `never` under strict
// typecheck (it exists on the class as a PRIVATE member, and TS refuses to
// widen a private field via intersection). Same standalone-cast pattern
// `work-ledger-store.test.ts`'s `SweepAgent` uses for the same reason.
type TestableAgent = {
  _turnRuntimeConfig: { backgroundWorkEnabled: boolean } | null;
  listBackgroundWork(): Promise<
    Array<{
      id: string;
      kind: WorkKind;
      label: string | null;
      startedAt: number;
      terminal: { outcome: WorkOutcome; reason: WorkReason; exitCode: number | null } | null;
    }>
  >;
  readBackgroundWorkOutput(processId: string): Promise<{
    head: string[];
    tail: string[];
    hiddenLines: number;
    truncated: boolean;
  } | null>;
  cancelBackgroundWork(id: string): Promise<{ ok: boolean; reason?: string }>;
  clearFinishedBackgroundWork(): Promise<{ cleared: number }>;
};

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

async function withAgent(
  fn: (input: { instance: TestableAgent; store: WorkLedgerStore }) => void | Promise<void>,
) {
  const id = env.THINK_THREAD_AGENT.idFromName(`bgwork-${crypto.randomUUID()}`);
  const stub = env.THINK_THREAD_AGENT.get(id);
  await runInDurableObject(stub, async (instance, state) => {
    const store = new WorkLedgerStore(state.storage);
    store.migrate();
    await fn({ instance: instance as unknown as TestableAgent, store });
  });
}

describe("ThinkThreadAgent.listBackgroundWork", () => {
  it("returns [] when background work is disabled, even with open rows", async () => {
    await withAgent(async ({ instance, store }) => {
      store.register(row({ id: "p1" }));
      instance._turnRuntimeConfig = { backgroundWorkEnabled: false };
      expect(await instance.listBackgroundWork()).toEqual([]);
    });
  });

  it("returns open rows and terminal rows with their outcome, newest first", async () => {
    await withAgent(async ({ instance, store }) => {
      instance._turnRuntimeConfig = { backgroundWorkEnabled: true };
      const now = Date.now();
      store.register(row({ id: "p1", kind: "process", startedAt: now - 2_000 }));
      store.register(row({ id: "s1", kind: "subagent", startedAt: now - 1_000 }));
      store.terminalize("s1", {
        outcome: "exited",
        reason: "process_exit",
        at: now - 500,
        detail: "code 0",
      });
      store.markDelivered("s1", now - 500);

      const rows = await instance.listBackgroundWork();
      expect(rows.map((r) => r.id)).toEqual(["s1", "p1"]);
      const byId = Object.fromEntries(rows.map((r) => [r.id, r]));
      expect(byId.p1).toMatchObject({ kind: "process", terminal: null });
      expect(byId.s1).toMatchObject({
        kind: "subagent",
        terminal: { outcome: "exited", reason: "process_exit" },
      });
    });
  });

  /**
   * I1 at the RPC boundary: a delivery that threw leaves the row terminal
   * with `deliveredAt` still null. The dock must keep showing it, not drop
   * it — this is the same case `listRecent`'s own test proves at the store
   * level, asserted again here because the RPC is a second place a filter
   * could have been (re)introduced.
   */
  it("includes an owed row — terminal with no delivery yet", async () => {
    await withAgent(async ({ instance, store }) => {
      instance._turnRuntimeConfig = { backgroundWorkEnabled: true };
      store.register(row({ id: "owed", startedAt: Date.now() - 20 * 60_000 }));
      store.terminalize("owed", {
        outcome: "fault",
        reason: "no_liveness",
        at: Date.now() - 20 * 60_000,
        detail: "delivery threw",
      });
      const rows = await instance.listBackgroundWork();
      expect(rows.map((r) => r.id)).toEqual(["owed"]);
      expect(rows[0]?.terminal).toEqual({
        outcome: "fault",
        reason: "no_liveness",
        exitCode: null,
      });
    });
  });

  /**
   * The green-✓-on-exit-7 bug at its source: `outcome` alone cannot tone a
   * chip on failure ("exited" covers every exit code identically), so the
   * dock needs the code itself.
   */
  it("reports the exit code so the client can tone on failure", async () => {
    await withAgent(async ({ instance, store }) => {
      instance._turnRuntimeConfig = { backgroundWorkEnabled: true };
      store.register(row({ id: "p1", kind: "process" }));
      store.terminalize("p1", {
        outcome: "exited",
        reason: "process_exit",
        at: Date.now(),
        detail: "exit code 7",
        exitCode: 7,
      });
      const rows = await instance.listBackgroundWork();
      expect(rows[0]!.terminal).toMatchObject({ outcome: "exited", exitCode: 7 });
    });
  });

  it("falls back to parsing `detail` for a row terminalized before the structured exitCode field existed", async () => {
    await withAgent(async ({ instance, store }) => {
      instance._turnRuntimeConfig = { backgroundWorkEnabled: true };
      store.register(row({ id: "p1", kind: "process" }));
      // No `exitCode` on this terminal — the legacy shape.
      store.terminalize("p1", {
        outcome: "exited",
        reason: "process_exit",
        at: Date.now(),
        detail: "exit code 7",
      });
      const rows = await instance.listBackgroundWork();
      expect(rows[0]!.terminal).toMatchObject({ outcome: "exited", exitCode: 7 });
    });
  });

  it("reports a null exit code for a fault, which has none", async () => {
    await withAgent(async ({ instance, store }) => {
      instance._turnRuntimeConfig = { backgroundWorkEnabled: true };
      store.register(row({ id: "p1", kind: "process" }));
      store.terminalize("p1", {
        outcome: "fault",
        reason: "no_liveness",
        at: Date.now(),
        detail: "delivery threw",
      });
      const rows = await instance.listBackgroundWork();
      expect(rows[0]!.terminal).toMatchObject({ outcome: "fault", exitCode: null });
    });
  });

  it("labels fall back to the row id when no richer label can be resolved", async () => {
    await withAgent(async ({ instance, store }) => {
      instance._turnRuntimeConfig = { backgroundWorkEnabled: true };
      // Neither a real compute backend nor a real SDK run is wired up in this
      // DO, so `workFacts` for both kinds falls back to the id — proving the
      // RPC never throws (never rejects) even when its label lookup fails.
      store.register(row({ id: "p1", kind: "process" }));
      store.register(row({ id: "s1", kind: "subagent" }));
      const rows = await instance.listBackgroundWork();
      expect(rows.find((r) => r.id === "p1")?.label).toBe("p1");
      expect(rows.find((r) => r.id === "s1")?.label).toBe("s1");
    });
  });
});

describe("ThinkThreadAgent.readBackgroundWorkOutput", () => {
  it("returns null when background work is disabled", async () => {
    await withAgent(async ({ instance, store }) => {
      store.register(row({ id: "p1", kind: "process" }));
      instance._turnRuntimeConfig = { backgroundWorkEnabled: false };
      expect(await instance.readBackgroundWorkOutput("p1")).toBeNull();
    });
  });

  it("returns null for a subagent id — a subagent has no process output", async () => {
    await withAgent(async ({ instance, store }) => {
      instance._turnRuntimeConfig = { backgroundWorkEnabled: true };
      store.register(row({ id: "s1", kind: "subagent" }));
      expect(await instance.readBackgroundWorkOutput("s1")).toBeNull();
    });
  });

  it("returns null for an unknown id, never throws", async () => {
    await withAgent(async ({ instance }) => {
      instance._turnRuntimeConfig = { backgroundWorkEnabled: true };
      await expect(instance.readBackgroundWorkOutput("nope")).resolves.toBeNull();
    });
  });

  it("returns null for a process id when no compute service resolves (no sandbox wired up in this DO)", async () => {
    await withAgent(async ({ instance, store }) => {
      instance._turnRuntimeConfig = { backgroundWorkEnabled: true };
      store.register(row({ id: "p1", kind: "process" }));
      await expect(instance.readBackgroundWorkOutput("p1")).resolves.toBeNull();
    });
  });
});

describe("ThinkThreadAgent.cancelBackgroundWork", () => {
  it("returns ok:false when background work is disabled", async () => {
    await withAgent(async ({ instance, store }) => {
      store.register(row({ id: "p1", kind: "process" }));
      instance._turnRuntimeConfig = { backgroundWorkEnabled: false };
      expect(await instance.cancelBackgroundWork("p1")).toEqual({
        ok: false,
        reason: "background_work_disabled",
      });
    });
  });

  it("returns ok:false for an unknown id, never throws", async () => {
    await withAgent(async ({ instance }) => {
      instance._turnRuntimeConfig = { backgroundWorkEnabled: true };
      expect(await instance.cancelBackgroundWork("nope")).toEqual({
        ok: false,
        reason: "unknown_id",
      });
    });
  });

  it("returns ok:false for a row that is already terminal", async () => {
    await withAgent(async ({ instance, store }) => {
      instance._turnRuntimeConfig = { backgroundWorkEnabled: true };
      store.register(row({ id: "p1", kind: "process" }));
      store.terminalize("p1", {
        outcome: "exited",
        reason: "process_exit",
        at: Date.now(),
        detail: "exit code 0",
        exitCode: 0,
      });
      expect(await instance.cancelBackgroundWork("p1")).toEqual({
        ok: false,
        reason: "already_terminal",
      });
    });
  });

  it("cancels an open subagent row via cancelSubagentRun (idempotent, no-op for an unknown run)", async () => {
    await withAgent(async ({ instance, store }) => {
      instance._turnRuntimeConfig = { backgroundWorkEnabled: true };
      store.register(row({ id: "s1", kind: "subagent" }));
      expect(await instance.cancelBackgroundWork("s1")).toEqual({ ok: true });
    });
  });

  it("returns ok:false for an open process row when no compute service resolves", async () => {
    await withAgent(async ({ instance, store }) => {
      instance._turnRuntimeConfig = { backgroundWorkEnabled: true };
      store.register(row({ id: "p1", kind: "process" }));
      const result = await instance.cancelBackgroundWork("p1");
      expect(result.ok).toBe(false);
    });
  });
});

describe("ThinkThreadAgent.clearFinishedBackgroundWork", () => {
  it("returns cleared:0 when background work is disabled", async () => {
    await withAgent(async ({ instance }) => {
      instance._turnRuntimeConfig = { backgroundWorkEnabled: false };
      expect(await instance.clearFinishedBackgroundWork()).toEqual({ cleared: 0 });
    });
  });

  /**
   * Non-destructive by construction: the row must survive as a row (just
   * excluded from `listRecent`), because deleting it would reintroduce the
   * false `no_liveness` fault `WORK_ROW_RETENTION_MS` exists to prevent (a
   * pruned id, re-registered later, comes back as a fresh OPEN row).
   */
  it("marks delivered terminal rows so listBackgroundWork stops returning them, without deleting them", async () => {
    await withAgent(async ({ instance, store }) => {
      instance._turnRuntimeConfig = { backgroundWorkEnabled: true };
      store.register(row({ id: "p1", kind: "process" }));
      store.terminalize("p1", {
        outcome: "exited",
        reason: "process_exit",
        at: Date.now(),
        detail: "exit code 0",
        exitCode: 0,
      });
      store.markDelivered("p1", Date.now());

      expect(await instance.clearFinishedBackgroundWork()).toEqual({ cleared: 1 });
      expect(await instance.listBackgroundWork()).toEqual([]);
      // Still a real row in the store — cleared, not deleted.
      expect(store.get("p1")).not.toBeNull();

      // A repeat call finds nothing left to clear.
      expect(await instance.clearFinishedBackgroundWork()).toEqual({ cleared: 0 });
    });
  });

  it("leaves an open row and an owed (undelivered terminal) row alone", async () => {
    await withAgent(async ({ instance, store }) => {
      instance._turnRuntimeConfig = { backgroundWorkEnabled: true };
      store.register(row({ id: "open", kind: "process" }));
      store.register(row({ id: "owed", kind: "process" }));
      store.terminalize("owed", {
        outcome: "fault",
        reason: "no_liveness",
        at: Date.now(),
        detail: "delivery threw",
      });

      expect(await instance.clearFinishedBackgroundWork()).toEqual({ cleared: 0 });
      const rows = await instance.listBackgroundWork();
      expect(rows.map((r) => r.id).sort()).toEqual(["open", "owed"]);
    });
  });
});
