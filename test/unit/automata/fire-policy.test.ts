import { describe, expect, it } from "vitest";
import {
  AUTOMATON_GRACE_MS,
  decideDueAction,
  isUniqueConstraintError,
} from "../../../src/automata/fire-policy";

const now = 1_800_000_000_000;

describe("decideDueAction", () => {
  it("fires a due automaton with no run in flight", () => {
    expect(decideDueAction({ dueAt: now - 1000, now, hasUnfinishedRun: false })).toBe("fire");
  });

  it("skips when a previous run is still unfinished, rather than piling on", () => {
    expect(decideDueAction({ dueAt: now - 1000, now, hasUnfinishedRun: true })).toBe(
      "skip_overlap",
    );
  });

  it("skips a due that has fallen outside the grace window instead of firing a backlog", () => {
    const stale = now - AUTOMATON_GRACE_MS - 1;
    expect(decideDueAction({ dueAt: stale, now, hasUnfinishedRun: false })).toBe("skip_stale");
  });

  it("still fires a due sitting exactly on the grace boundary", () => {
    const boundary = now - AUTOMATON_GRACE_MS;
    expect(decideDueAction({ dueAt: boundary, now, hasUnfinishedRun: false })).toBe("fire");
  });

  it("checks overlap before staleness, so a stuck run is never masked by a stale due", () => {
    const stale = now - AUTOMATON_GRACE_MS - 1;
    expect(decideDueAction({ dueAt: stale, now, hasUnfinishedRun: true })).toBe("skip_overlap");
  });
});

describe("isUniqueConstraintError", () => {
  const D1_MESSAGE =
    "UNIQUE constraint failed: automaton_runs.automaton_id, automaton_runs.due_at: SQLITE_CONSTRAINT (extended: SQLITE_CONSTRAINT_UNIQUE)";

  it("is true for a bare Error with the real D1 message", () => {
    expect(isUniqueConstraintError(new Error(D1_MESSAGE))).toBe(true);
  });

  it("is true when the message is nested one level deep under cause", () => {
    const wrapped = new Error("Failed query: insert into automaton_runs...", {
      cause: new Error(D1_MESSAGE),
    });
    expect(isUniqueConstraintError(wrapped)).toBe(true);
  });

  it("is true when the message is nested two levels deep under cause", () => {
    const wrapped = new Error("outer", {
      cause: new Error("middle", { cause: new Error(D1_MESSAGE) }),
    });
    expect(isUniqueConstraintError(wrapped)).toBe(true);
  });

  it("is false for an unrelated error", () => {
    expect(isUniqueConstraintError(new Error("automaton_agent_missing:agnt_123"))).toBe(false);
  });

  it("is false for null", () => {
    expect(isUniqueConstraintError(null)).toBe(false);
  });

  it("is false for undefined", () => {
    expect(isUniqueConstraintError(undefined)).toBe(false);
  });

  it("is false for an unrelated string", () => {
    expect(isUniqueConstraintError("something went wrong")).toBe(false);
  });

  it("is false for exotic non-error values", () => {
    expect(isUniqueConstraintError(42)).toBe(false);
    expect(isUniqueConstraintError({ message: D1_MESSAGE })).toBe(false);
  });

  it("stops walking causes after the bounded depth", () => {
    let error: Error = new Error(D1_MESSAGE);
    for (let i = 0; i < 11; i++) {
      error = new Error(`wrapper ${i}`, { cause: error });
    }
    expect(isUniqueConstraintError(error)).toBe(false);
  });

  it("does not throw on a circular cause chain", () => {
    const a: Error & { cause?: unknown } = new Error("a");
    const b: Error & { cause?: unknown } = new Error("b");
    a.cause = b;
    b.cause = a;
    expect(() => isUniqueConstraintError(a)).not.toThrow();
    expect(isUniqueConstraintError(a)).toBe(false);
  });
});
