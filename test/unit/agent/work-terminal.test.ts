import { describe, expect, it } from "vitest";
import type { WorkReason } from "../../../src/agent/work-ledger";
import { buildFaultMessage } from "../../../src/agent/work-ledger";

describe("buildFaultMessage", () => {
  it("tells the model its FILES are gone on a sandbox reset, not just the process", () => {
    const text = buildFaultMessage({
      reason: "sandbox_reset",
      kind: "process",
      id: "proc_1",
      label: "read channels",
      silentMs: 0,
    });
    expect(text).toContain("sandbox was reset");
    expect(text).toMatch(/files|filesystem|state/i);
    expect(text).toContain("read channels");
  });

  it("reports the silence duration for a no_liveness fault", () => {
    const text = buildFaultMessage({
      reason: "no_liveness",
      kind: "subagent",
      id: "sub_1",
      label: "qa",
      silentMs: 200_000,
    });
    expect(text).toMatch(/no liveness|no signal/i);
    expect(text).toContain("qa");
  });

  it("produces a distinct message per reason", () => {
    const reasons: WorkReason[] = [
      "sandbox_reset",
      "no_liveness",
      "watch_timeout",
      "process_exit",
      "process_stopped",
    ];
    const texts = reasons.map((reason) =>
      buildFaultMessage({ reason, kind: "process", id: "p", label: "cmd", silentMs: 0 }),
    );
    expect(new Set(texts).size).toBe(reasons.length);
  });

  // A subagent's watch_timeout is NOT an edge case: the row's `deadlineAt` is
  // stamped at register, a beat before the SDK's `maxBudgetMs` clock starts at
  // dispatch, so the ledger fires FIRST and this is the text the model gets for
  // every subagent that hits its budget. The process sentence is wrong for it
  // twice over — a subagent was never watched, and `terminalizeWork` KILLS it
  // via `cancelSubagentRun` rather than walking away.
  it("tells a subagent the truth at its time budget: stopped, not un-watched", () => {
    const text = buildFaultMessage({
      reason: "watch_timeout",
      kind: "subagent",
      id: "sub_1",
      label: "qa",
      silentMs: 0,
    });
    expect(text).toContain("qa");
    expect(text).toMatch(/time budget/i);
    expect(text).toMatch(/stopped/i);
    // The two lies the process wording tells about a subagent.
    expect(text).not.toMatch(/no longer being watched/i);
    expect(text).not.toMatch(/still running/i);
  });

  it("keeps the process watch_timeout wording: it really is still running, unwatched", () => {
    const text = buildFaultMessage({
      reason: "watch_timeout",
      kind: "process",
      id: "p1",
      label: "npm test",
      silentMs: 0,
    });
    expect(text).toContain("no longer being watched");
    expect(text).toMatch(/still running/i);
  });

  // Enum honesty: a deliberately killed process must never be described to the
  // model as a clean exit. `execStop` records `stopped`/`process_stopped`, so
  // the text has to match the fact.
  it("says a stopped process was stopped, not exited", () => {
    const text = buildFaultMessage({
      reason: "process_stopped",
      kind: "process",
      id: "p1",
      label: "npm test",
      silentMs: 0,
    });
    expect(text).toMatch(/stopped/i);
    expect(text).not.toMatch(/exited/i);
  });
});
