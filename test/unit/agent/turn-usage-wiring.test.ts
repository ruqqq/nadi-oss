import { describe, expect, it, vi } from "vitest";
import { SubAgent } from "../../../src/agent/subagent";
import { ThinkThreadAgent } from "../../../src/agent/think-thread-agent";
import { TurnUsageAccumulator } from "../../../src/agent/usage-recorder";

/**
 * The AGENT WIRING, not the accumulator.
 *
 * `usage-recorder.test.ts` proves `TurnUsageAccumulator` sums correctly and that
 * `flushThreadUsage` writes the right SQL. Neither would notice if
 * `onStepFinish` or `flushTurnUsage` were deleted outright — nothing else drives
 * them. These tests do: they call the real hooks on the real prototype (no DO, no
 * env, no Think) with D1 replaced by a fake whose `batch` we can hold open.
 *
 * Holding it open is the point. `flushTurnUsage` yields at that await, and the DO
 * delivers other events while it is parked — including the NEXT turn's steps. The
 * pre-fix code called `acc.reset()` on the SHARED accumulator after that await and
 * wiped them. The race test below is the regression test for that Critical.
 */

const h = vi.hoisted(() => ({ db: null as unknown as FakeDb }));
vi.mock("../../../src/db/client", () => ({ registryDb: () => h.db }));

interface Written {
  inserts: Record<string, unknown>[];
  updates: Record<string, unknown>[];
  batches: number;
}

interface FakeDb {
  written: Written;
  settle: (mode: "ok" | "fail") => void;
  pending: number;
  insert: (table: unknown) => unknown;
  update: (table: unknown) => unknown;
  batch: (statements: unknown[]) => Promise<unknown>;
}

/** A D1 stand-in whose writes only land when the test says so. */
function fakeDb(): FakeDb {
  const written: Written = { inserts: [], updates: [], batches: 0 };
  const gates: Array<(mode: "ok" | "fail") => void> = [];
  const db: FakeDb = {
    written,
    pending: 0,
    settle(mode) {
      const queued = gates.splice(0, gates.length);
      for (const gate of queued) gate(mode);
    },
    insert: () => ({
      values: (v: Record<string, unknown>) => {
        written.inserts.push(v);
        return { onConflictDoUpdate: () => ({ kind: "insert" }) };
      },
    }),
    update: () => ({
      set: (v: Record<string, unknown>) => {
        written.updates.push(v);
        return { where: () => ({ kind: "update" }) };
      },
    }),
    batch: (statements) => {
      written.batches += 1;
      db.pending += 1;
      return new Promise((resolve, reject) => {
        gates.push((mode) => {
          db.pending -= 1;
          if (mode === "ok") resolve(statements);
          else reject(new Error("d1 unavailable"));
        });
      });
    },
  };
  return db;
}

/** A D1 stand-in that settles every batch immediately — for tests that only
 * care what lands, not about a flush parked mid-await. */
function instantDb(): FakeDb {
  const db = fakeDb();
  const realBatch = db.batch;
  db.batch = (statements) => {
    const result = realBatch(statements);
    db.settle("ok");
    return result;
  };
  return db;
}

/** The seam under test: the protected hooks, reached without constructing a DO. */
interface AgentSeam {
  onStepFinish(ctx: unknown): void;
  flushTurnUsage(): Promise<void>;
  turnUsage: TurnUsageAccumulator;
}

function agent(): AgentSeam {
  const a = Object.create(ThinkThreadAgent.prototype) as Record<string, unknown>;
  a.turnUsage = new TurnUsageAccumulator();
  a.tracksContextGauge = true;
  a._usageFlush = null;
  a._currentContextWindow = 200_000;
  a._currentCompactAfterTokens = 118_400;
  a._turnRuntimeConfig = {
    workspaceId: "ws_1",
    agentId: "agent_1",
    modelConfig: { provider: "anthropic", model: "claude-sonnet-5" },
  };
  a.env = {};
  // `name` is a getter on the Agent base; shadow it with an own property so the
  // REAL `usageAttribution()` runs.
  Object.defineProperty(a, "name", { value: "thr_1", configurable: true });
  return a as unknown as AgentSeam;
}

/** Wait until the flush is actually parked on D1 (it awaits attribution first). */
async function parked(db: FakeDb): Promise<void> {
  for (let i = 0; i < 100 && db.pending === 0; i++) {
    await new Promise((resolve) => setTimeout(resolve, 0));
  }
  if (db.pending === 0) throw new Error("flush never reached D1");
}

const step = (inputTokens: number, outputTokens: number) => ({
  usage: { inputTokens, outputTokens },
});

describe("ThinkThreadAgent turn-usage wiring", () => {
  it("onStepFinish accumulates usage and the gauge with NO I/O — it runs between model steps", () => {
    h.db = fakeDb();
    const a = agent();

    a.onStepFinish(step(1_000, 50));
    a.onStepFinish(step(2_500, 120));

    // Not one statement built, let alone awaited: the hot path must not touch D1.
    expect(h.db.written).toEqual({ inserts: [], updates: [], batches: 0 });
    expect(a.turnUsage.entries()).toEqual([
      expect.objectContaining({
        provider: "anthropic",
        model: "claude-sonnet-5",
        source: "chat",
        inputTokens: 3_500,
        outputTokens: 170,
        calls: 2,
      }),
    ]);
    // The gauge overwrites: the LAST step describes the context that now exists.
    expect(a.turnUsage.context()).toEqual({
      contextTokens: 2_500,
      contextWindow: 200_000,
      compactAfterTokens: 118_400,
    });
  });

  it("flushTurnUsage drains the turn into D1 — the ledger row and the gauge, with the real trigger", async () => {
    h.db = fakeDb();
    const a = agent();
    a.onStepFinish(step(1_000, 50));

    const flush = a.flushTurnUsage();
    await parked(h.db);
    h.db.settle("ok");
    await flush;

    expect(h.db.written.inserts).toEqual([
      expect.objectContaining({
        threadId: "thr_1",
        workspaceId: "ws_1",
        agentId: "agent_1",
        provider: "anthropic",
        model: "claude-sonnet-5",
        source: "chat",
        inputTokens: 1_000,
        outputTokens: 50,
        calls: 1,
      }),
    ]);
    expect(h.db.written.updates).toEqual([
      {
        lastContextTokens: 1_000,
        lastContextWindow: 200_000,
        lastCompactAfterTokens: 118_400,
      },
    ]);
    // Drained: a second flush has nothing to write.
    expect(a.turnUsage.isEmpty()).toBe(true);
    await a.flushTurnUsage();
    expect(h.db.written.batches).toBe(1);
  });

  // REGRESSION (Critical): a flush parked on D1 must not discard usage recorded
  // while it was parked. Pre-fix this cleared the shared accumulator AFTER the
  // await and turn B's entire spend — plus its gauge — vanished.
  it("does not lose usage recorded DURING an in-flight flush", async () => {
    h.db = fakeDb();
    const a = agent();

    // Turn A dies; its flush is fired and parks on D1.
    a.onStepFinish(step(1_000, 50));
    const flushA = a.flushTurnUsage();
    await parked(h.db);
    expect(h.db.pending).toBe(1);

    // Turn B starts while that batch is still in flight.
    a.onStepFinish(step(9_000, 400));

    h.db.settle("ok");
    await flushA;

    // Turn A's spend is written...
    expect(h.db.written.inserts).toEqual([expect.objectContaining({ inputTokens: 1_000 })]);
    // ...and turn B's is still in memory, not wiped.
    expect(a.turnUsage.entries()).toEqual([
      expect.objectContaining({ inputTokens: 9_000, outputTokens: 400, calls: 1 }),
    ]);
    expect(a.turnUsage.context()?.contextTokens).toBe(9_000);

    // And it reaches D1 on turn B's own flush, with the gauge it recorded.
    const flushB = a.flushTurnUsage();
    await parked(h.db);
    h.db.settle("ok");
    await flushB;
    expect(h.db.written.inserts[1]).toMatchObject({ inputTokens: 9_000, calls: 1 });
    expect(h.db.written.updates[1]).toMatchObject({ lastContextTokens: 9_000 });
  });

  it("puts a FAILED flush's snapshot back, and retries it exactly once — no double count", async () => {
    h.db = fakeDb();
    const a = agent();

    a.onStepFinish(step(1_000, 50));
    const flushA = a.flushTurnUsage();
    await parked(h.db);
    h.db.settle("fail");
    await flushA;

    // Nothing was written (a failed batch is a failed transaction), so the spend
    // is back in the live accumulator awaiting a retry.
    expect(a.turnUsage.entries()).toEqual([
      expect.objectContaining({ inputTokens: 1_000, calls: 1 }),
    ]);

    a.onStepFinish(step(500, 10));
    const flushB = a.flushTurnUsage();
    await parked(h.db);
    h.db.settle("ok");
    await flushB;

    // Retried once, summed with the new step — not twice.
    expect(h.db.written.inserts).toHaveLength(2);
    expect(h.db.written.inserts[1]).toMatchObject({
      inputTokens: 1_500,
      outputTokens: 60,
      calls: 2,
    });
    expect(a.turnUsage.isEmpty()).toBe(true);

    // A third flush writes nothing: the retried snapshot was dropped, not re-merged.
    await a.flushTurnUsage();
    expect(h.db.written.inserts).toHaveLength(2);
  });

  it("onChatResponse — the turn-end hook — is what actually drives the flush", async () => {
    h.db = fakeDb();
    const a = agent();
    const instance = a as unknown as Record<string, unknown>;
    // The rest of the turn-end hook needs a DO; stub only what it reaches.
    instance.processMonitorEnabled = () => false;
    instance.injectionBuffer = () => ({ isEmpty: () => true });
    instance.turnHasPendingApproval = async () => false;
    instance.resolveRuntimeConfigForThink = async () => {
      throw new Error("no registry in the unit env");
    };

    a.onStepFinish(step(2_000, 90));
    const done = (ThinkThreadAgent.prototype.onChatResponse as () => Promise<void>).call(a);
    await parked(h.db);
    h.db.settle("ok");
    await done;

    expect(h.db.written.inserts).toEqual([
      expect.objectContaining({ threadId: "thr_1", inputTokens: 2_000, calls: 1 }),
    ]);
  });

  // REGRESSION: manual /compact runs OUTSIDE any turn — `onChatResponse` and
  // `onChatError` (the only two flush call sites) never fire for it. Before the
  // fix, the summarizer's usage sat in `turnUsage` until some unrelated later
  // turn flushed it (or the DO evicted first and it vanished). This drives the
  // REAL `compactThread()`, not the accumulator in isolation, and — because
  // `compactThread` runs outside a turn — `_turnRuntimeConfig` is deliberately
  // left unpinned so the test also proves `usageAttribution()`'s fallback.
  describe("compactThread — manual compaction banks its own spend", () => {
    function manualCompactionAgent(): AgentSeam & Record<string, unknown> {
      const a = agent() as unknown as Record<string, unknown>;
      // Manual compaction never goes through `beforeTurn`, so nothing pins this.
      a._turnRuntimeConfig = null;
      a.assertThreadWritable = async () => {};
      a.waitUntilStable = async () => true;
      a.resolveRuntimeConfigForThink = async () => ({
        workspaceId: "ws_1",
        agentId: "agent_1",
        modelConfig: { provider: "anthropic", model: "claude-sonnet-5" },
      });
      return a as unknown as AgentSeam & Record<string, unknown>;
    }

    it("flushes the summarizer's usage on a successful manual compaction", async () => {
      h.db = instantDb();
      const a = manualCompactionAgent();
      a.session = {
        compact: async () => {
          // What the real `onCompaction` callback in `configureSession` does:
          // records the summarizer's spend straight onto `turnUsage`, tagged
          // "compaction" — not through `onStepFinish`.
          (a.turnUsage as InstanceType<typeof TurnUsageAccumulator>).add(
            { provider: "anthropic", model: "claude-sonnet-5", source: "compaction" },
            { inputTokens: 4_000, outputTokens: 200 },
          );
          return { summarizedMessages: 10, summaryTokens: 200 };
        },
      };

      const result = await (
        ThinkThreadAgent.prototype.compactThread as unknown as (
          this: unknown,
        ) => Promise<{ compacted: boolean; message: string }>
      ).call(a);

      expect(result).toEqual({ compacted: true, message: "Thread compacted." });
      expect(h.db.written.inserts).toEqual([
        expect.objectContaining({
          threadId: "thr_1",
          workspaceId: "ws_1",
          agentId: "agent_1",
          source: "compaction",
          inputTokens: 4_000,
          outputTokens: 200,
          calls: 1,
        }),
      ]);
    });

    it("still flushes when the summarizer blows up", async () => {
      h.db = instantDb();
      const a = manualCompactionAgent();
      a.session = {
        compact: async () => {
          (a.turnUsage as InstanceType<typeof TurnUsageAccumulator>).add(
            { provider: "anthropic", model: "claude-sonnet-5", source: "compaction" },
            { inputTokens: 900, outputTokens: 30 },
          );
          throw new Error("summarizer exploded");
        },
      };

      const done = (
        ThinkThreadAgent.prototype.compactThread as unknown as (
          this: unknown,
        ) => Promise<{ compacted: boolean; message: string }>
      ).call(a);
      await expect(done).rejects.toThrow();

      expect(h.db.written.inserts).toEqual([
        expect.objectContaining({ inputTokens: 900, outputTokens: 30, calls: 1 }),
      ]);
    });

    it("writes nothing when there was nothing to compact", async () => {
      h.db = instantDb();
      const a = manualCompactionAgent();
      a.session = { compact: async () => null };

      const result = await (
        ThinkThreadAgent.prototype.compactThread as unknown as (
          this: unknown,
        ) => Promise<{ compacted: boolean; message: string; reason?: string }>
      ).call(a);

      expect(result).toEqual({
        compacted: false,
        message: "Nothing to compact yet.",
        reason: "not-needed",
      });
      expect(h.db.written.inserts).toEqual([]);
      expect(h.db.written.batches).toBe(0);
    });
  });
});

/**
 * `SubAgent` OVERRIDES `onStepFinish` to count the run's tool calls, and a
 * subagent's tokens are the parent thread's. So its override must still run the
 * base one, and nothing else in the suite proves that: dropping the `super`
 * call silently loses a subagent's entire billing while 1076 tests stay green
 * (measured). This is that guard.
 */
describe("SubAgent.onStepFinish keeps the parent's usage accounting", () => {
  interface SubSeam {
    onStepFinish(ctx: unknown): void;
    turnUsage: TurnUsageAccumulator;
    _progress?: { message: string | null };
  }

  function sub(): SubSeam {
    const a = Object.create(SubAgent.prototype) as Record<string, unknown>;
    a.turnUsage = new TurnUsageAccumulator();
    a.tracksContextGauge = false;
    a._usageFlush = null;
    a._turnRuntimeConfig = {
      workspaceId: "ws_1",
      agentId: "agent_1",
      modelConfig: { provider: "anthropic", model: "claude-sonnet-5" },
    };
    a.env = {};
    a._toolCalls = 0;
    a._lastProgressPushAt = 0;
    // The override's two publication side effects, stubbed: this test is about
    // the accounting, and both are fire-and-forget in production.
    a.reportProgress = async () => {};
    a.parentAgent = async () => ({ stampSubagentAlive: async () => {} });
    Object.defineProperty(a, "name", { value: "sub_1", configurable: true });
    return a as unknown as SubSeam;
  }

  it("records the step's usage AND counts the tool call", () => {
    const a = sub();
    a.onStepFinish({ usage: { inputTokens: 1_000, outputTokens: 50 }, toolCalls: [{}] });

    expect(a.turnUsage.entries()).toEqual([
      expect.objectContaining({
        provider: "anthropic",
        model: "claude-sonnet-5",
        // Tagged as the subagent's spend, still billed to the parent thread.
        source: "subagent",
        inputTokens: 1_000,
        outputTokens: 50,
        calls: 1,
      }),
    ]);
    expect(a._progress?.message).toBe("1 tool call");
  });

  it("still records usage for a step that made no tool calls", () => {
    const a = sub();
    // The early return for a tool-less step must come AFTER the super call —
    // the model's closing text step carries real tokens.
    a.onStepFinish({ usage: { inputTokens: 400, outputTokens: 20 }, toolCalls: [] });

    expect(a.turnUsage.isEmpty()).toBe(false);
    expect(a.turnUsage.entries()[0]).toMatchObject({ inputTokens: 400, outputTokens: 20 });
    expect(a._progress).toBeUndefined();
  });
});
