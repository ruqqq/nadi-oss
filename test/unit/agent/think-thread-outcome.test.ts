import { describe, expect, it } from "vitest";
import {
  AUTOMATON_OUTCOME_TOOL_NAME,
  createAutomatonOutcomeTools,
} from "../../../src/agent/automaton-outcome-tool";

describe("automaton outcome storage round-trip", () => {
  it("tool → state → take is a one-shot read-and-clear", async () => {
    const store = new Map<string, unknown>();
    const KEY = "automaton-outcome:pending";
    const state = { recordOutcome: async (o: unknown) => void store.set(KEY, o) };
    const take = async () => {
      const v = store.get(KEY) ?? null;
      if (v) store.delete(KEY);
      return v;
    };

    const tools = createAutomatonOutcomeTools(state);
    await tools[AUTOMATON_OUTCOME_TOOL_NAME]!.execute!(
      { status: "blocked", reason: "x" },
      {} as never,
    );
    expect(await take()).toEqual({ status: "blocked", reason: "x" });
    expect(await take()).toBeNull();
  });
});
