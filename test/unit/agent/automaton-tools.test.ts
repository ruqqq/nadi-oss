import { describe, expect, it } from "vitest";
import type { Env } from "../../../src/env";
import {
  createAutomatonManagementTools,
  automatonScheduleSchema,
} from "../../../src/agent/automaton-tools";

function tools() {
  return createAutomatonManagementTools({ env: {} as Env, threadId: "th_test" });
}

describe("createAutomatonManagementTools", () => {
  it("exposes the CRUD tools plus list_workbenches", () => {
    expect(Object.keys(tools()).sort()).toEqual([
      "create_automaton",
      "get_automaton",
      "list_automata",
      "list_workbenches",
      "update_automaton",
    ]);
  });

  it("marks mutations needsApproval and leaves reads auto-allow", () => {
    const t = tools() as Record<string, { needsApproval?: boolean }>;
    expect(t.create_automaton!.needsApproval).toBe(true);
    expect(t.update_automaton!.needsApproval).toBe(true);
    expect(t.list_automata!.needsApproval ?? false).toBe(false);
    expect(t.get_automaton!.needsApproval ?? false).toBe(false);
    expect(t.list_workbenches!.needsApproval ?? false).toBe(false);
  });

  it("the schedule schema accepts every preset and a cron expression", () => {
    for (const schedule of [
      { kind: "hourly", minute: 0 },
      { kind: "daily", hour: 8, minute: 0 },
      { kind: "weekdays", hour: 8, minute: 30 },
      { kind: "weekly", weekday: 1, hour: 8, minute: 0 },
      { kind: "cron", expr: "0 8 * * 1-5" },
    ]) {
      expect(() => automatonScheduleSchema.parse(schedule)).not.toThrow();
    }
  });

  it("the schedule schema rejects an out-of-range minute", () => {
    expect(() => automatonScheduleSchema.parse({ kind: "hourly", minute: 99 })).toThrow();
  });
});
