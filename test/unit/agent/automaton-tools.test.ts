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
  it("exposes the CRUD tools plus list_agents", () => {
    expect(Object.keys(tools()).sort()).toEqual([
      "create_automaton",
      "get_automaton",
      "list_agents",
      "list_automata",
      "update_automaton",
    ]);
  });

  it("marks mutations needsApproval and leaves reads auto-allow", () => {
    const t = tools() as Record<string, { needsApproval?: boolean }>;
    expect(t.create_automaton!.needsApproval).toBe(true);
    expect(t.update_automaton!.needsApproval).toBe(true);
    expect(t.list_automata!.needsApproval ?? false).toBe(false);
    expect(t.get_automaton!.needsApproval ?? false).toBe(false);
    expect(t.list_agents!.needsApproval ?? false).toBe(false);
  });

  it("the schedule schema accepts every preset, once, and a cron expression", () => {
    for (const schedule of [
      { kind: "hourly", minute: 0 },
      { kind: "daily", hour: 8, minute: 0 },
      { kind: "weekdays", hour: 8, minute: 30 },
      { kind: "weekly", weekday: 1, hour: 8, minute: 0 },
      { kind: "cron", expr: "0 8 * * 1-5" },
      { kind: "once", runAt: Date.now() + 60_000 },
    ]) {
      expect(() => automatonScheduleSchema.parse(schedule)).not.toThrow();
    }
  });

  it("mutation tool descriptions mention once schedules", () => {
    const t = tools() as Record<string, { description?: string }>;
    expect(t.create_automaton!.description).toMatch(/once/i);
    expect(t.update_automaton!.description).toMatch(/once/i);
  });

  it("the schedule schema rejects an out-of-range minute", () => {
    expect(() => automatonScheduleSchema.parse({ kind: "hourly", minute: 99 })).toThrow();
  });
});
