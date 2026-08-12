import { describe, expect, it } from "vitest";
import {
  PROCESS_STALE_AFTER_MS,
  classifyWork,
  nextSweepAt,
  type CurrentGeneration,
  type WorkRow,
} from "../../../src/agent/work-ledger";

function row(overrides?: Partial<WorkRow>): WorkRow {
  return {
    id: "p1",
    kind: "process",
    startedAt: 0,
    lastAliveAt: 1_000,
    staleAfterMs: PROCESS_STALE_AFTER_MS,
    // Comfortably past every default-deadline test's `now` even at the
    // widened PROCESS_STALE_AFTER_MS (3x a 60s poll, not the old 3x7s) — a
    // smaller default would let the deadline fire before the staleness path
    // these tests mean to exercise.
    deadlineAt: 10_000_000,
    generation: "gen-a",
    terminal: null,
    deliveredAt: null,
    ...overrides,
  };
}

/**
 * The sweep, extracted as the pure fold the agent method performs. This mirrors
 * `runWorkLedgerSweep` so the reaper's decision logic is provable without a DO.
 */
function sweep(rows: WorkRow[], currentGeneration: CurrentGeneration, now: number) {
  return rows
    .map((r) => ({ id: r.id, result: classifyWork({ row: r, currentGeneration, now }) }))
    .filter((r) => r.result.state !== "alive");
}

describe("work ledger sweep", () => {
  it("reaps every row sharing a stale generation in ONE pass", () => {
    const rows = [
      row({ id: "p1", generation: "gen-a" }),
      row({ id: "p2", generation: "gen-a" }),
      row({ id: "sub_1", kind: "subagent", generation: "gen-a" }),
    ];
    const reaped = sweep(rows, { kind: "known", nonce: "gen-b" }, 1_500);
    expect(reaped.map((r) => r.id)).toEqual(["p1", "p2", "sub_1"]);
    for (const r of reaped) expect(r.result).toMatchObject({ reason: "sandbox_reset" });
  });

  it("leaves rows from the current generation alone", () => {
    const rows = [row({ id: "p1", generation: "gen-b" }), row({ id: "p2", generation: "gen-a" })];
    expect(sweep(rows, { kind: "known", nonce: "gen-b" }, 1_500).map((r) => r.id)).toEqual(["p2"]);
  });

  it("does not reap a healthy long-running row (the dark-ship risk)", () => {
    const fortyMinutes = 40 * 60_000;
    const healthy = row({
      kind: "subagent",
      startedAt: 0,
      lastAliveAt: fortyMinutes - 1_000,
      staleAfterMs: 180_000,
      deadlineAt: 45 * 60_000,
    });
    expect(sweep([healthy], { kind: "known", nonce: "gen-a" }, fortyMinutes)).toEqual([]);
  });

  it("arms the next sweep at the earliest horizon", () => {
    expect(nextSweepAt([row({ lastAliveAt: 1_000 }), row({ id: "p2", lastAliveAt: 4_000 })])).toBe(
      1_000 + PROCESS_STALE_AFTER_MS,
    );
  });
});
