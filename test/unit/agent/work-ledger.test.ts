import { describe, expect, it } from "vitest";
import {
  PROCESS_STALE_AFTER_MS,
  UNKNOWN_GENERATION,
  classifyWork,
  nextSweepAt,
  type WorkRow,
} from "../../../src/agent/work-ledger";
import { DEFAULT_MONITOR_POLL_INTERVAL_MS } from "../../../src/compute/watchers";

describe("PROCESS_STALE_AFTER_MS", () => {
  // Tautological today by construction, and that is the point: this is the
  // guard that FAILS the moment someone re-inlines a literal (21_000, or a
  // literal matching whatever DEFAULT_MONITOR_POLL_INTERVAL_MS happens to be
  // today) instead of deriving it, letting the two drift apart again the way
  // they did once already (see compute/watchers.ts's doc on
  // DEFAULT_MONITOR_POLL_INTERVAL_MS).
  it("stays 3x the watcher poll interval", () => {
    expect(PROCESS_STALE_AFTER_MS).toBe(DEFAULT_MONITOR_POLL_INTERVAL_MS * 3);
  });
});

function row(overrides?: Partial<WorkRow>): WorkRow {
  return {
    id: "p1",
    kind: "process",
    startedAt: 0,
    lastAliveAt: 1_000,
    staleAfterMs: PROCESS_STALE_AFTER_MS,
    // Comfortably past every default-deadline test's `now` even at the widened
    // PROCESS_STALE_AFTER_MS (3x a 60s poll, not the old 3x7s) — otherwise the
    // deadline fires before the staleness path these tests mean to exercise.
    deadlineAt: 10_000_000,
    generation: "gen-a",
    terminal: null,
    deliveredAt: null,
    ...overrides,
  };
}

describe("classifyWork", () => {
  it("returns alive while fresh and before the deadline", () => {
    expect(
      classifyWork({
        row: row(),
        currentGeneration: { kind: "known", nonce: "gen-a" },
        now: 1_500,
      }),
    ).toEqual({
      state: "alive",
    });
  });

  it("returns fault/sandbox_reset when the generation no longer matches", () => {
    expect(
      classifyWork({
        row: row(),
        currentGeneration: { kind: "known", nonce: "gen-b" },
        now: 1_500,
      }),
    ).toEqual({
      state: "fault",
      outcome: "fault",
      reason: "sandbox_reset",
    });
  });

  /**
   * A row registered while nothing was known about the container carries the
   * `UNKNOWN_GENERATION` placeholder. It is the ABSENCE of evidence, so it can
   * never witness a MISMATCH — otherwise it "differs" from every real nonce.
   *
   * Load-bearing, not academic: `restoreGenerationAfterWipe` moves the store
   * from `absent` to `known`, and every row registered during the absence — the
   * work running on the healthy post-wipe filesystem, which the `absent` arm's
   * `observedAt` bound deliberately spares — carries this placeholder. Same for
   * rows predating the nonce entirely (`compute_state.generation = NULL`).
   */
  it("never treats the unknown-generation placeholder as a mismatch", () => {
    expect(
      classifyWork({
        row: row({ generation: UNKNOWN_GENERATION }),
        currentGeneration: { kind: "known", nonce: "gen-c" },
        now: 1_500,
      }),
    ).toEqual({ state: "alive" });
  });

  it("still faults an unknown-generation row on liveness — the placeholder exempts it from RESET only", () => {
    expect(
      classifyWork({
        row: row({ generation: UNKNOWN_GENERATION, lastAliveAt: 0 }),
        currentGeneration: { kind: "known", nonce: "gen-c" },
        now: PROCESS_STALE_AFTER_MS + 1_000,
      }),
    ).toEqual({ state: "stale", outcome: "fault", reason: "no_liveness" });
  });

  it("prefers sandbox_reset over deadline and staleness", () => {
    const stale = row({ lastAliveAt: 0, deadlineAt: 1 });
    expect(
      classifyWork({
        row: stale,
        currentGeneration: { kind: "known", nonce: "gen-b" },
        now: 999_999,
      }),
    ).toEqual({
      state: "fault",
      outcome: "fault",
      reason: "sandbox_reset",
    });
  });

  it("returns timeout past the deadline before considering staleness", () => {
    const stale = row({ lastAliveAt: 0, deadlineAt: 10 });
    expect(
      classifyWork({
        row: stale,
        currentGeneration: { kind: "known", nonce: "gen-a" },
        now: 999_999,
      }),
    ).toEqual({
      state: "expired",
      outcome: "timeout",
      reason: "watch_timeout",
    });
  });

  it("returns fault/no_liveness once silence exceeds staleAfterMs", () => {
    expect(
      classifyWork({
        row: row({ lastAliveAt: 1_000 }),
        currentGeneration: { kind: "known", nonce: "gen-a" },
        now: 1_000 + PROCESS_STALE_AFTER_MS + 1,
      }),
    ).toEqual({ state: "stale", outcome: "fault", reason: "no_liveness" });
  });

  it("treats exactly staleAfterMs of silence as still alive", () => {
    expect(
      classifyWork({
        row: row({ lastAliveAt: 1_000 }),
        currentGeneration: { kind: "known", nonce: "gen-a" },
        now: 1_000 + PROCESS_STALE_AFTER_MS,
      }),
    ).toEqual({ state: "alive" });
  });

  it("never reclassifies an already-terminal row", () => {
    const done = row({
      lastAliveAt: 0,
      terminal: { outcome: "exited", reason: "process_exit", at: 5, detail: "code 0" },
    });
    expect(
      classifyWork({
        row: done,
        currentGeneration: { kind: "known", nonce: "gen-b" },
        now: 999_999,
      }),
    ).toEqual({
      state: "alive",
    });
  });

  it("ignores an unknown currentGeneration (unknown sandbox state is not a reset)", () => {
    expect(
      classifyWork({ row: row(), currentGeneration: { kind: "unknown" }, now: 1_500 }),
    ).toEqual({ state: "alive" });
  });

  // The production case (2026-07-16): Cloudflare hands back a WORKING container
  // on the same sandbox id after a destroy/OOM, so nothing throws, the DO never
  // re-provisions and the nonce never diverges. A live container whose nonce
  // file is gone is the only evidence a reset leaves — and it must be enough.
  it("returns fault/sandbox_reset for an ABSENT nonce on a container that answered", () => {
    expect(
      classifyWork({
        row: row({ startedAt: 0 }),
        currentGeneration: { kind: "absent", observedAt: 1_000 },
        now: 1_500,
      }),
    ).toEqual({ state: "fault", outcome: "fault", reason: "sandbox_reset" });
  });

  it("prefers an ABSENT-driven sandbox_reset over deadline and staleness", () => {
    expect(
      classifyWork({
        row: row({ startedAt: 0, lastAliveAt: 0, deadlineAt: 1 }),
        currentGeneration: { kind: "absent", observedAt: 1_000 },
        now: 999_999,
      }),
    ).toEqual({ state: "fault", outcome: "fault", reason: "sandbox_reset" });
  });

  // Without this bound, one absent observation lingers in the store and faults
  // every row started AFTERWARDS — telling a model its work is lost when the
  // work never touched the wiped filesystem at all.
  it("never faults work that started at or after the absence was observed", () => {
    for (const startedAt of [1_000, 1_001]) {
      expect(
        classifyWork({
          row: row({ startedAt, lastAliveAt: startedAt }),
          currentGeneration: { kind: "absent", observedAt: 1_000 },
          now: startedAt + 1,
        }),
      ).toEqual({ state: "alive" });
    }
  });

  // The safe degradation. An unreadable probe is genuinely unknown, and a false
  // sandbox_reset ("your files are gone") is worse than the under-informative
  // no_liveness message — so unknown must fall through to liveness, never reset.
  it("degrades an UNREADABLE probe to the no_liveness path, never to a reset", () => {
    expect(
      classifyWork({
        row: row({ lastAliveAt: 1_000 }),
        currentGeneration: { kind: "unknown" },
        now: 1_000 + PROCESS_STALE_AFTER_MS + 1,
      }),
    ).toEqual({ state: "stale", outcome: "fault", reason: "no_liveness" });
  });

  it("never reclassifies an already-terminal row on an absent generation", () => {
    const done = row({
      lastAliveAt: 0,
      terminal: { outcome: "exited", reason: "process_exit", at: 5, detail: "code 0" },
    });
    expect(
      classifyWork({ row: done, currentGeneration: { kind: "absent", observedAt: 1_000 }, now: 9 }),
    ).toEqual({ state: "alive" });
  });
});

describe("nextSweepAt", () => {
  it("returns null when there is no open work", () => {
    expect(nextSweepAt([])).toBeNull();
  });

  it("returns the earliest of every open row's stale and deadline horizons", () => {
    const rows = [
      row({ id: "a", lastAliveAt: 1_000, deadlineAt: 10_000_000 }),
      row({ id: "b", lastAliveAt: 500, deadlineAt: 10_000_000 }),
    ];
    expect(nextSweepAt(rows)).toBe(500 + PROCESS_STALE_AFTER_MS);
  });

  it("uses the deadline when it lands before the stale horizon", () => {
    expect(nextSweepAt([row({ lastAliveAt: 1_000, deadlineAt: 1_100 })])).toBe(1_100);
  });

  it("skips terminal rows", () => {
    const rows = [
      row({
        id: "a",
        lastAliveAt: 0,
        deadlineAt: 5,
        terminal: { outcome: "exited", reason: "process_exit", at: 5, detail: "" },
      }),
      row({ id: "b", lastAliveAt: 1_000, deadlineAt: 10_000_000 }),
    ];
    expect(nextSweepAt(rows)).toBe(1_000 + PROCESS_STALE_AFTER_MS);
  });
});
