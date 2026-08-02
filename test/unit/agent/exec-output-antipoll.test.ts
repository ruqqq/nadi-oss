import { describe, expect, it } from "vitest";
import {
  buildComputeToolDefs,
  EXEC_OUTPUT_PEEK_LIMIT,
  shouldRefusePeek,
} from "../../../src/agent/compute-tools";

describe("exec_output anti-poll", () => {
  it("allows the first two peeks at a watched, running process", () => {
    for (let n = 0; n < EXEC_OUTPUT_PEEK_LIMIT; n++)
      expect(shouldRefusePeek({ peeksThisTurn: n, isWatched: true, isRunning: true })).toBe(false);
  });

  it("refuses the third and every later peek", () => {
    expect(shouldRefusePeek({ peeksThisTurn: 2, isWatched: true, isRunning: true })).toBe(true);
    expect(shouldRefusePeek({ peeksThisTurn: 99, isWatched: true, isRunning: true })).toBe(true);
  });

  it("never refuses an unwatched process — no notification is coming for it", () => {
    expect(shouldRefusePeek({ peeksThisTurn: 99, isWatched: false, isRunning: true })).toBe(false);
  });

  it("never refuses an already-exited process — reading final output is not polling", () => {
    expect(shouldRefusePeek({ peeksThisTurn: 99, isWatched: true, isRunning: false })).toBe(false);
  });
});

/**
 * Builds a fake ThreadComputeService exposing just what buildComputeToolDefs'
 * exec_output execute() needs: listActiveWatchersView() (the read-only watcher
 * registry) and execOutput() (the actual backend-touching read). Records calls
 * so tests can assert the refusal path never reaches execOutput.
 */
function makeFakeService(watched: Array<{ processId: string; status: string }>) {
  const execOutputCalls: string[] = [];
  const service = {
    listActiveWatchersView: () =>
      watched.map((w) => ({
        processId: w.processId,
        label: null,
        command: "sleep 999",
        createdAt: 0,
        deadlineAt: 0,
        status: w.status,
        outputTail: "",
      })),
    execOutput: async (input: { processId: string }) => {
      execOutputCalls.push(input.processId);
      return { processId: input.processId, status: "running", ok: true };
    },
  };
  return { service, execOutputCalls };
}

describe("exec_output tool wiring: per-turn, per-process peek counter", () => {
  it("resets between turns — a 3rd peek in a NEW tool instance (new turn) reads freely", async () => {
    const { service, execOutputCalls } = makeFakeService([{ processId: "p1", status: "running" }]);
    // Simulate one turn: buildComputeToolDefs is called once per beforeTurn,
    // so a fresh call is a fresh turn with a fresh closure-scoped counter.
    const turn1 = buildComputeToolDefs(
      async () => service as any,
      async () => ({}) as any,
    );
    const execOutput1 = (turn1.exec_output as any).execute as (input: unknown) => Promise<any>;
    await execOutput1({ processId: "p1" });
    await execOutput1({ processId: "p1" });
    const third = await execOutput1({ processId: "p1" });
    expect(third.refused).toBe(true);
    expect(execOutputCalls).toEqual(["p1", "p1"]);

    // New turn: brand new buildComputeToolDefs call, brand new counter.
    const turn2 = buildComputeToolDefs(
      async () => service as any,
      async () => ({}) as any,
    );
    const execOutput2 = (turn2.exec_output as any).execute as (input: unknown) => Promise<any>;
    const freshPeek = await execOutput2({ processId: "p1" });
    expect(freshPeek.refused).toBeUndefined();
    expect(execOutputCalls).toEqual(["p1", "p1", "p1"]);
  });

  it("is per-process, not per-thread — peeking process A twice does not refuse process B", async () => {
    const { service, execOutputCalls } = makeFakeService([
      { processId: "a", status: "running" },
      { processId: "b", status: "running" },
    ]);
    const tools = buildComputeToolDefs(
      async () => service as any,
      async () => ({}) as any,
    );
    const execOutput = (tools.exec_output as any).execute as (input: unknown) => Promise<any>;
    await execOutput({ processId: "a" });
    await execOutput({ processId: "a" });
    const aRefused = await execOutput({ processId: "a" });
    expect(aRefused.refused).toBe(true);

    const bResult = await execOutput({ processId: "b" });
    expect(bResult.refused).toBeUndefined();
    expect(execOutputCalls).toEqual(["a", "a", "b"]);
  });

  it("does not leak across threads — no module-global state", async () => {
    const fakeA = makeFakeService([{ processId: "p1", status: "running" }]);
    const fakeB = makeFakeService([{ processId: "p1", status: "running" }]);
    // Two separate threads each get their own buildComputeToolDefs call (their
    // own DO instance resolving its own tool set), just like production.
    const threadATools = buildComputeToolDefs(
      async () => fakeA.service as any,
      async () => ({}) as any,
    );
    const threadBTools = buildComputeToolDefs(
      async () => fakeB.service as any,
      async () => ({}) as any,
    );
    const execA = (threadATools.exec_output as any).execute as (input: unknown) => Promise<any>;
    const execB = (threadBTools.exec_output as any).execute as (input: unknown) => Promise<any>;
    await execA({ processId: "p1" });
    await execA({ processId: "p1" });
    // Thread A has now peeked twice; thread B has peeked zero times on the same
    // processId. If state were module-global, this next call on B would refuse.
    const bResult = await execB({ processId: "p1" });
    expect(bResult.refused).toBeUndefined();
    expect(fakeB.execOutputCalls).toEqual(["p1"]);
  });

  it("the refusal path does not call the backend", async () => {
    const { service, execOutputCalls } = makeFakeService([{ processId: "p1", status: "running" }]);
    const tools = buildComputeToolDefs(
      async () => service as any,
      async () => ({}) as any,
    );
    const execOutput = (tools.exec_output as any).execute as (input: unknown) => Promise<any>;
    await execOutput({ processId: "p1" });
    await execOutput({ processId: "p1" });
    execOutputCalls.length = 0;
    const refused = await execOutput({ processId: "p1" });
    expect(refused.refused).toBe(true);
    expect(execOutputCalls).toEqual([]);
  });

  it("never refuses an unwatched process even after many peeks", async () => {
    const { service, execOutputCalls } = makeFakeService([]);
    const tools = buildComputeToolDefs(
      async () => service as any,
      async () => ({}) as any,
    );
    const execOutput = (tools.exec_output as any).execute as (input: unknown) => Promise<any>;
    for (let i = 0; i < 5; i++) await execOutput({ processId: "p1" });
    expect(execOutputCalls).toEqual(["p1", "p1", "p1", "p1", "p1"]);
  });
});
