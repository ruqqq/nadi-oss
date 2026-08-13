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
      terminal: { outcome: WorkOutcome; reason: WorkReason } | null;
    }>
  >;
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
      expect(rows[0]?.terminal).toEqual({ outcome: "fault", reason: "no_liveness" });
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
