import { describe, expect, it, vi } from "vitest";
import { ThinkThreadAgent } from "../../../src/agent/think-thread-agent";
import {
  PROCESS_STALE_AFTER_MS,
  type WorkKind,
  type WorkRow,
  type WorkTerminal,
} from "../../../src/agent/work-ledger";

/**
 * The TERMINAL FUNNEL — `ThinkThreadAgent.terminalizeWork`.
 *
 * Every terminal the model has not already been told about flows through here.
 * Three properties are load-bearing and each is pinned below:
 *
 *   1. Delivery is gated on `terminalize`'s exactly-once boolean, so a repeat
 *      sweep (or a race with the compute layer's own close) cannot re-notify.
 *   2. Teardown runs AFTER delivery and is best-effort — a teardown failure
 *      must never suppress the model's only signal about work that is gone.
 *   3. The `sandbox_reset` message says the FILESYSTEM is gone, not merely that
 *      a process died. That is what lets the model adapt instead of hang.
 *
 * These drive the REAL prototype method over a narrow duck-typed `this`, in the
 * same style as alarm-rearm.test.ts — the DO storage and compute resolution are
 * the only fakes.
 */

vi.mock("../../../src/db/client", () => ({ registryDb: () => ({}) }));

const holder = vi.hoisted(() => ({
  resolved: undefined as { service: unknown } | undefined,
  resolveThrows: false,
}));

// Fully replaced, never importOriginal: the real module pulls in `cloudflare:`
// imports the node ESM loader cannot resolve.
vi.mock("../../../src/agent/compute-tools", () => ({
  resolveComputeService: async () => {
    if (holder.resolveThrows) throw new Error("resolve failed");
    return holder.resolved;
  },
  createComputeTools: () => ({}),
  scheduleComputeEviction: async () => undefined,
  cancelComputeEviction: async () => undefined,
}));

function openRow(overrides?: Partial<WorkRow>): WorkRow {
  return {
    id: "p1",
    kind: "process",
    startedAt: 0,
    lastAliveAt: 1_000,
    staleAfterMs: PROCESS_STALE_AFTER_MS,
    deadlineAt: 10_000_000,
    generation: "gen-a",
    terminal: null,
    deliveredAt: null,
    ...overrides,
  };
}

/** The real `terminalize` exactly-once gate over a map. */
function memoryLedger(rows: WorkRow[]) {
  return {
    rows,
    get: (id: string) => rows.find((row) => row.id === id) ?? null,
    listOpen: () => rows.filter((row) => !row.terminal),
    terminalize: (id: string, terminal: WorkTerminal) => {
      const index = rows.findIndex((row) => row.id === id);
      if (index === -1 || rows[index]?.terminal) return false;
      rows[index] = { ...(rows[index] as WorkRow), terminal };
      return true;
    },
    /** The real DELIVERY gate: a terminal row, not yet delivered, exactly once. */
    markDelivered: (id: string, at: number) => {
      const index = rows.findIndex((row) => row.id === id);
      const row = rows[index];
      if (!row?.terminal || row.deliveredAt !== null) return false;
      rows[index] = { ...row, deliveredAt: at };
      return true;
    },
    listUndelivered: () => rows.filter((row) => row.terminal && row.deliveredAt === null),
  };
}

type Injection = {
  dedupeKey: string;
  kind: string;
  message: { parts: { text: string }[]; metadata: { nadiKind: string; watcher?: unknown } };
};

/** The text the model actually reads out of a delivered injection. */
const bodyOf = (entry: Injection | undefined): string => entry?.message.parts[0]?.text ?? "";

function setup(input: {
  rows: WorkRow[];
  reapProcess?: (id: string, options: { kill: boolean }) => Promise<void>;
  processView?: { label: string; command: string; running: boolean } | null;
  cancelSubagentRun?: (runId: string) => Promise<void>;
}) {
  const injections: Injection[] = [];
  const reapProcess = vi.fn(input.reapProcess ?? (async () => undefined));
  const service = {
    processReapView: () =>
      input.processView === undefined
        ? { label: "read channels", command: "node read.js", running: true }
        : input.processView,
    reapProcess,
  };
  holder.resolved = { service };
  holder.resolveThrows = false;

  const ledger = memoryLedger(input.rows);
  const agent = {
    name: "thr_test",
    env: {},
    openSandbox: async () => {
      if (holder.resolveThrows) throw new Error("resolve failed");
      return holder.resolved ?? null;
    },
    workLedger: ledger,
    deliverInjection: (entry: Injection) => void injections.push(entry),
    cancelSubagentRun: vi.fn(input.cancelSubagentRun ?? (async () => undefined)),
    // The REAL label/teardown resolution, not a stub — it is the part that runs
    // between the terminal and the delivery, so its failure modes are exactly
    // what these tests care about.
    workFacts: (ThinkThreadAgent.prototype as unknown as Record<string, unknown>).workFacts,
    // The REAL delivery step (build message -> deliver -> close the delivery
    // gate). Stubbing it would hide the very ordering these tests pin.
    deliverWorkTerminal: (ThinkThreadAgent.prototype as unknown as Record<string, unknown>)
      .deliverWorkTerminal,
  };
  return { agent, ledger, injections, reapProcess, service };
}

const terminalizeWork = ThinkThreadAgent.prototype.terminalizeWork as (
  this: unknown,
  id: string,
  terminal: WorkTerminal,
  kind: WorkKind,
  resolved?: unknown,
) => Promise<boolean>;

const fault = (at = 30_000): WorkTerminal => ({
  outcome: "fault",
  reason: "no_liveness",
  at,
  detail: "process stale: no_liveness",
});

describe("terminalizeWork: the exactly-once delivery gate", () => {
  it("delivers once and reports true for the call that closed the row", async () => {
    const rows = [openRow()];
    const { agent, injections } = setup({ rows });

    expect(await terminalizeWork.call(agent, "p1", fault(), "process")).toBe(true);
    expect(injections).toHaveLength(1);
    expect(injections[0]?.dedupeKey).toBe("watcher:p1:fault");
    expect(injections[0]?.kind).toBe("watcher-completion");
  });

  it("a REPEAT terminalize delivers nothing and reports false", async () => {
    const rows = [openRow()];
    const { agent, injections } = setup({ rows });

    await terminalizeWork.call(agent, "p1", fault(), "process");
    // The next sweep sees the same row, or the compute layer closes it first.
    // Either way the model has already been told; telling it twice is a bug.
    expect(await terminalizeWork.call(agent, "p1", fault(31_000), "process")).toBe(false);
    expect(injections).toHaveLength(1);
  });

  it("never delivers for a row the compute layer already closed", async () => {
    const rows = [
      openRow({
        terminal: { outcome: "exited", reason: "process_exit", at: 2_000, detail: "exited" },
      }),
    ];
    const { agent, injections } = setup({ rows });

    expect(await terminalizeWork.call(agent, "p1", fault(), "process")).toBe(false);
    expect(injections).toEqual([]);
  });

  it("does not deliver for an unknown row", async () => {
    const { agent, injections } = setup({ rows: [] });
    expect(await terminalizeWork.call(agent, "ghost", fault(), "process")).toBe(false);
    expect(injections).toEqual([]);
  });
});

/**
 * The DELIVERY gate, split from the terminal write. `terminalize`'s boolean
 * closed the row; `markDelivered` owns the notification. The split exists so the
 * one can succeed while the other stays owed and retryable.
 */
describe("terminalizeWork: the delivery gate is not the terminal gate", () => {
  it("marks delivered only AFTER the injection lands", async () => {
    const rows = [openRow()];
    const order: string[] = [];
    const { agent, ledger } = setup({ rows });
    const realMark = ledger.markDelivered;
    ledger.markDelivered = (id: string, at: number) => {
      order.push("mark");
      return realMark(id, at);
    };
    agent.deliverInjection = () => void order.push("deliver");

    await terminalizeWork.call(agent, "p1", fault(), "process");
    // Order is load-bearing. `deliverInjection` is synchronous and durable on
    // return, so marking first would mean a throw leaves a row that reads as
    // told when nothing was ever queued — this task's hole, just moved.
    expect(order).toEqual(["deliver", "mark"]);
    expect(rows[0]?.deliveredAt).not.toBeNull();
  });

  it("leaves the terminal CLOSED but UNDELIVERED when delivery throws", async () => {
    const rows = [openRow()];
    const { agent, ledger } = setup({ rows });
    agent.deliverInjection = () => {
      throw new Error("injection buffer write failed");
    };

    await expect(terminalizeWork.call(agent, "p1", fault(), "process")).rejects.toThrow();
    // The terminal stands — it is what advances the alarm horizon, and a row
    // left open re-arms the alarm hot forever.
    expect(rows[0]?.terminal?.reason).toBe("no_liveness");
    // But the model was never told, so the delivery stays owed. This row is
    // invisible to `listOpen`; only `listUndelivered` can find it again.
    expect(rows[0]?.deliveredAt).toBeNull();
    expect(ledger.listUndelivered().map((r) => r.id)).toEqual(["p1"]);
  });
});

describe("terminalizeWork: teardown cannot suppress the notification", () => {
  it("delivers even when teardown THROWS, and still reports true", async () => {
    const rows = [openRow()];
    const { agent, injections } = setup({
      rows,
      reapProcess: async () => {
        throw new Error("container is gone");
      },
    });

    // The whole point of terminal-first: the row is written and the model told
    // BEFORE anything that can fail. This is the shape that produced the
    // original hang — a throw on the way out swallowing the only notification.
    await expect(terminalizeWork.call(agent, "p1", fault(), "process")).resolves.toBe(true);
    expect(injections).toHaveLength(1);
    expect(rows[0]?.terminal?.outcome).toBe("fault");
  });

  it("delivers even when the compute service cannot be resolved at all", async () => {
    const rows = [openRow()];
    const { agent, injections } = setup({ rows });
    holder.resolveThrows = true;

    expect(await terminalizeWork.call(agent, "p1", fault(), "process", undefined)).toBe(true);
    expect(injections).toHaveLength(1);
    // No label available, so the message falls back to the id — never silence.
    expect(bodyOf(injections[0])).toContain("p1");
  });

  it("tears down AFTER delivering, never before", async () => {
    const rows = [openRow()];
    const order: string[] = [];
    const { agent } = setup({
      rows,
      reapProcess: async () => void order.push("teardown"),
    });
    agent.deliverInjection = () => void order.push("deliver");

    await terminalizeWork.call(agent, "p1", fault(), "process");
    expect(order).toEqual(["deliver", "teardown"]);
  });
});

describe("terminalizeWork: teardown is honest about what it kills", () => {
  it("KILLS a faulted process — the message says it was torn down", async () => {
    const rows = [openRow()];
    const { agent, reapProcess } = setup({ rows });
    await terminalizeWork.call(agent, "p1", fault(), "process");
    expect(reapProcess).toHaveBeenCalledWith("p1", { kill: true });
  });

  it("does NOT kill a timed-out process — it is still running, just unwatched", async () => {
    const rows = [openRow()];
    const { agent, reapProcess } = setup({ rows });
    await terminalizeWork.call(
      agent,
      "p1",
      { outcome: "timeout", reason: "watch_timeout", at: 30_000, detail: "expired" },
      "process",
    );
    // The taxonomy's promise for a timeout is "still running, no longer
    // watched". Killing it here would make that message a lie.
    expect(reapProcess).toHaveBeenCalledWith("p1", { kill: false });
  });

  it("does NOT kill on a sandbox reset — there is no container left to kill", async () => {
    const rows = [openRow()];
    const { agent, reapProcess } = setup({ rows });
    await terminalizeWork.call(
      agent,
      "p1",
      { outcome: "fault", reason: "sandbox_reset", at: 30_000, detail: "reset" },
      "process",
    );
    expect(reapProcess).toHaveBeenCalledWith("p1", { kill: false });
  });

  it("cancels a faulted subagent run", async () => {
    const rows = [openRow({ id: "run_1", kind: "subagent" })];
    const { agent } = setup({ rows });
    expect(await terminalizeWork.call(agent, "run_1", fault(), "subagent")).toBe(true);
    expect(agent.cancelSubagentRun).toHaveBeenCalledWith("run_1");
  });
});

describe("terminalizeWork: the message the model actually gets", () => {
  it("renders a sandbox reset as a lost FILESYSTEM, on a card the transcript shows", async () => {
    const rows = [openRow()];
    const { agent, injections } = setup({ rows });

    await terminalizeWork.call(
      agent,
      "p1",
      { outcome: "fault", reason: "sandbox_reset", at: 30_000, detail: "reset" },
      "process",
    );
    expect(bodyOf(injections[0])).toContain("sandbox was reset");
    expect(bodyOf(injections[0])).toMatch(/filesystem/i);
    expect(bodyOf(injections[0])).toContain("read channels");
    // A watcher-completion variant, so the card renders it instead of leaking
    // raw <system-reminder> text into the transcript.
    expect(injections[0]?.message.metadata.nadiKind).toBe("watcher-completion");
    expect(injections[0]?.message.metadata.watcher).toMatchObject({
      outcome: "fault",
      processId: "p1",
    });
  });

  it("reports the real silence duration, measured from the row's last stamp", async () => {
    const rows = [openRow({ lastAliveAt: 5_000 })];
    const { agent, injections } = setup({ rows });

    await terminalizeWork.call(agent, "p1", fault(35_000), "process");
    expect(bodyOf(injections[0])).toContain("30s");
  });

  it("delivers a subagent fault as a hidden reminder under its own dedupe namespace", async () => {
    const rows = [openRow({ id: "run_1", kind: "subagent" })];
    const { agent, injections } = setup({ rows });

    await terminalizeWork.call(agent, "run_1", fault(), "subagent");
    expect(injections[0]?.dedupeKey).toBe("subagent:run_1:fault");
    expect(injections[0]?.kind).toBe("subagent-completion");
    expect(injections[0]?.message.metadata.nadiKind).toBe("system-reminder");
  });
});
