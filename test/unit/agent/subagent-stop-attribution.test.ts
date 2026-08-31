import { describe, expect, it, vi } from "vitest";
import { ThinkThreadAgent } from "../../../src/agent/think-thread-agent";
import {
  SUBAGENT_DEADLINE_MS,
  SUBAGENT_STALE_AFTER_MS,
  type WorkRow,
  type WorkStopActor,
  type WorkTerminal,
} from "../../../src/agent/work-ledger";

/**
 * STOP ATTRIBUTION — who asked a subagent to stop.
 *
 * A human pressing stop in the sheet, the model calling `stop_subagent`, and
 * the SDK's own budget abort all reach `onAgentToolFinish` as the same
 * `status: "aborted"`. The row alone cannot tell them apart, so the actor has
 * to be captured at the cancel entry point and carried to the terminal — which
 * is what these tests pin. The distinction is not cosmetic: it decides whether
 * the model should leave the work alone (the user ended it) or re-spawn it (a
 * budget ran out).
 *
 * Drives the REAL prototype methods over a narrow duck-typed `this`, in the
 * style of work-terminal-funnel.test.ts.
 */

vi.mock("../../../src/db/client", () => ({ registryDb: () => ({}) }));

// Fully replaced, never importOriginal: the real module pulls in `cloudflare:`
// imports the node ESM loader cannot resolve.
vi.mock("../../../src/agent/compute-tools", () => ({
  resolveComputeService: async () => null,
  createComputeTools: () => ({}),
}));

function subagentRow(overrides?: Partial<WorkRow>): WorkRow {
  return {
    id: "sub_1",
    kind: "subagent",
    startedAt: 0,
    lastAliveAt: 1_000,
    staleAfterMs: SUBAGENT_STALE_AFTER_MS,
    deadlineAt: SUBAGENT_DEADLINE_MS,
    generation: "gen-a",
    terminal: null,
    deliveredAt: null,
    ...overrides,
  };
}

function memoryLedger(rows: WorkRow[]) {
  return {
    rows,
    get: (id: string) => rows.find((row) => row.id === id) ?? null,
    terminalize: (id: string, terminal: WorkTerminal) => {
      const index = rows.findIndex((row) => row.id === id);
      if (index === -1 || rows[index]?.terminal) return false;
      rows[index] = { ...(rows[index] as WorkRow), terminal };
      return true;
    },
    markDelivered: () => true,
  };
}

function setup(rows: WorkRow[] = [subagentRow()]) {
  const ledger = memoryLedger(rows);
  const cancelAgentTool = vi.fn(async (_runId: string) => undefined);
  const agent = {
    name: "thr_test",
    workLedger: ledger,
    cancelAgentTool,
    // The real serialize wrapper is a lease mutex; the ordering it protects is
    // not what these tests are about, so run the body straight through.
    serializeLeaseMutation: async (fn: () => Promise<boolean>) => fn(),
    backgroundWorkAdmitted: async () => ({}),
    // REAL methods — the attribution is precisely what they carry between them.
    cancelSubagentRun: proto("cancelSubagentRun"),
    stopSubagentRun: proto("stopSubagentRun"),
    onAgentToolFinish: proto("onAgentToolFinish"),
    stopActorFor: proto("stopActorFor"),
    // The pending-actor bookkeeping is part of what is under test — real, not
    // stubbed. `pendingStopActors` is created lazily by `stopActors`, so the
    // duck-typed `this` needs no field of its own.
    stopActors: proto("stopActors"),
    takeStopActor: proto("takeStopActor"),
  };
  return { agent, ledger, cancelAgentTool };
}

function proto(name: string): unknown {
  return (ThinkThreadAgent.prototype as unknown as Record<string, unknown>)[name];
}

type Agent = ReturnType<typeof setup>["agent"];

const cancel = (agent: Agent, runId: string, actor?: WorkStopActor) =>
  (agent.cancelSubagentRun as (this: Agent, id: string, a?: WorkStopActor) => Promise<void>).call(
    agent,
    runId,
    actor,
  );

const stopFromModel = (agent: Agent, runId: string) =>
  (
    agent.stopSubagentRun as (this: Agent, id: string) => Promise<{ ok: true } | { error: string }>
  ).call(agent, runId);

const finish = (agent: Agent, runId: string, status: string) =>
  (
    agent.onAgentToolFinish as (
      this: Agent,
      run: { runId: string },
      result: { status: string },
    ) => Promise<void>
  ).call(agent, { runId }, { status });

describe("cancelSubagentRun: attribution reaches the terminal", () => {
  it("records the user as the actor when the sheet's stop button cancels a run", async () => {
    const { agent, ledger, cancelAgentTool } = setup();
    await cancel(agent, "sub_1", "user");
    await finish(agent, "sub_1", "aborted");
    expect(cancelAgentTool).toHaveBeenCalledWith("sub_1");
    expect(ledger.rows[0]?.terminal).toMatchObject({ outcome: "stopped", actor: "user" });
  });

  it("records the model as the actor when it stops its own subagent", async () => {
    const { agent, ledger } = setup();
    expect(await stopFromModel(agent, "sub_1")).toEqual({ ok: true });
    await finish(agent, "sub_1", "aborted");
    expect(ledger.rows[0]?.terminal).toMatchObject({ actor: "agent" });
  });

  it("attributes an abort nobody claimed to the system, not to the last canceller", async () => {
    const { agent, ledger } = setup([subagentRow(), subagentRow({ id: "sub_2" })]);
    await cancel(agent, "sub_1", "user");
    // A DIFFERENT run aborts on its own (the SDK budget). Keying the pending
    // actor by runId is what stops sub_1's user cancel from being read as the
    // reason sub_2 died.
    await finish(agent, "sub_2", "aborted");
    expect(ledger.rows[1]?.terminal).toMatchObject({ actor: "system" });
  });

  it("leaves a clean completion unattributed — nobody stopped it", async () => {
    const { agent, ledger } = setup();
    await finish(agent, "sub_1", "completed");
    expect(ledger.rows[0]?.terminal).toEqual({
      outcome: "exited",
      reason: "process_exit",
      at: expect.any(Number),
      detail: "completed",
    });
  });
});

describe("stopSubagentRun: the model-facing guard", () => {
  it("refuses an unknown run id without cancelling anything", async () => {
    const { agent, cancelAgentTool } = setup();
    expect(await stopFromModel(agent, "sub_nope")).toEqual({ error: "unknown_run" });
    expect(cancelAgentTool).not.toHaveBeenCalled();
  });

  it("refuses a run that already finished", async () => {
    const rows = [
      subagentRow({
        terminal: { outcome: "exited", reason: "process_exit", at: 5, detail: "completed" },
      }),
    ];
    const { agent, cancelAgentTool } = setup(rows);
    expect(await stopFromModel(agent, "sub_1")).toEqual({ error: "already_terminal" });
    expect(cancelAgentTool).not.toHaveBeenCalled();
  });

  it("refuses a watched process — this tool is for subagents only", async () => {
    const { agent, cancelAgentTool } = setup([subagentRow({ id: "p1", kind: "process" })]);
    expect(await stopFromModel(agent, "p1")).toEqual({ error: "not_a_subagent" });
    expect(cancelAgentTool).not.toHaveBeenCalled();
  });
});

describe("stopActorFor: what the completion message is built from", () => {
  it("reads the actor recorded on the row, so delivery order cannot lose it", async () => {
    const { agent } = setup();
    await cancel(agent, "sub_1", "user");
    await finish(agent, "sub_1", "aborted");
    // The pending entry is consumed by the terminal write; the row is what a
    // later delivery (or a redelivery after a reconcile) has to read.
    const actor = (
      agent.stopActorFor as (this: Agent, id: string) => WorkStopActor | undefined
    ).call(agent, "sub_1");
    expect(actor).toBe("user");
  });

  it("returns undefined for a run with no recorded stop", async () => {
    const { agent } = setup();
    const actor = (
      agent.stopActorFor as (this: Agent, id: string) => WorkStopActor | undefined
    ).call(agent, "sub_1");
    expect(actor).toBeUndefined();
  });
});
