import { describe, expect, it } from "vitest";
import {
  SUBAGENT_DEADLINE_MS,
  SUBAGENT_STALE_AFTER_MS,
  classifyWork,
  type WorkRow,
} from "../../../src/agent/work-ledger";

function subagentRow(overrides?: Partial<WorkRow>): WorkRow {
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

/** Mirrors the derivations the agent performs over ledger rows. */
const activeLeases = (rows: WorkRow[]) =>
  rows.filter((r) => r.kind === "subagent" && !r.terminal).map((r) => r.id);
const runTimings = (rows: WorkRow[]) =>
  Object.fromEntries(
    rows
      .filter((r) => r.kind === "subagent")
      .map((r) => [r.id, { startedAt: r.startedAt, finishedAt: r.terminal?.at }]),
  );

describe("derived subagent views", () => {
  it("an open subagent row is an active lease", () => {
    expect(activeLeases([subagentRow()])).toEqual(["sub_1"]);
  });

  it("a terminal row releases the lease — including a reaped one", () => {
    const reaped = subagentRow({
      terminal: { outcome: "fault", reason: "sandbox_reset", at: 5_000, detail: "gone" },
    });
    expect(activeLeases([reaped])).toEqual([]);
  });

  it("process rows never appear as subagent leases", () => {
    expect(activeLeases([subagentRow({ id: "p1", kind: "process" })])).toEqual([]);
  });

  it("timings derive startedAt and finishedAt from the row", () => {
    const rows = [
      subagentRow({ id: "a" }),
      subagentRow({
        id: "b",
        startedAt: 2_000,
        terminal: { outcome: "exited", reason: "process_exit", at: 8_000, detail: "" },
      }),
    ];
    expect(runTimings(rows)).toEqual({
      a: { startedAt: 1_000, finishedAt: undefined },
      b: { startedAt: 2_000, finishedAt: 8_000 },
    });
  });

  it("uses the 45-min deadline and 3-min stale window for subagents", () => {
    const row = subagentRow();
    expect(row.deadlineAt - row.startedAt).toBe(45 * 60_000);
    expect(row.staleAfterMs).toBe(180_000);
  });
});

/**
 * The 3-minute stale window ships ENFORCING on day one — there is no dark-ship
 * observation period behind it. A false `fault` on a healthy 40-minute run is
 * worse than the hang this whole design replaces, so the property that keeps
 * that from happening (liveness is stamped by infrastructure while work is
 * IN FLIGHT, not reported by the model at step boundaries) is pinned here at
 * the classifier, and again at the wiring in subagent-liveness.test.ts.
 */
describe("the stale window vs. legitimately long silent work", () => {
  const stampedEvery = (ms: number, upTo: number): number[] =>
    Array.from({ length: Math.floor(upTo / ms) }, (_, i) => (i + 1) * ms);

  it("does NOT fault a 40-minute run that keeps heartbeating through silent work", () => {
    // A child inside one 40-minute model call / build: zero completed steps,
    // zero model-reported progress — but the run IS in flight, and the
    // heartbeat says so every 30s.
    const start = 0;
    const stamps = stampedEvery(30_000, 40 * 60_000);
    for (const lastAliveAt of stamps) {
      // Classified 30s after the most recent stamp, i.e. the worst moment
      // before the next one lands.
      const now = lastAliveAt + 30_000;
      const result = classifyWork({
        row: subagentRow({ startedAt: start, lastAliveAt, deadlineAt: SUBAGENT_DEADLINE_MS }),
        currentGeneration: { kind: "known", nonce: "gen-a" },
        now,
      });
      expect(result.state).toBe("alive");
    }
  });

  it("tolerates FIVE consecutive missed heartbeats before faulting", () => {
    // The margin that makes the above robust: 30s stamps against a 180s window.
    // A transient facet/RPC hiccup must not read as death.
    const row = subagentRow({ lastAliveAt: 1_000 });
    const missed = (n: number) =>
      classifyWork({
        row,
        currentGeneration: { kind: "known", nonce: "gen-a" },
        now: 1_000 + n * 30_000,
      }).state;
    expect(missed(5)).toBe("alive");
    expect(missed(7)).toBe("stale");
  });

  it("DOES fault a wedged run with no activity at all once the window passes", () => {
    const row = subagentRow({ startedAt: 0, lastAliveAt: 0 });
    const result = classifyWork({
      row,
      currentGeneration: { kind: "known", nonce: "gen-a" },
      now: SUBAGENT_STALE_AFTER_MS + 1,
    });
    expect(result).toEqual({ state: "stale", outcome: "fault", reason: "no_liveness" });
  });

  it("faults a wedged run as a RESET, not a timeout, when the sandbox generation moved", () => {
    // Both explain the silence; the reset is the one the model can act on.
    const row = subagentRow({ startedAt: 0, lastAliveAt: 0 });
    const result = classifyWork({
      row,
      currentGeneration: { kind: "known", nonce: "gen-b" },
      now: SUBAGENT_STALE_AFTER_MS + 1,
    });
    expect(result).toEqual({ state: "fault", outcome: "fault", reason: "sandbox_reset" });
  });
});
