import { env, runInDurableObject } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import {
  TOOL_CALL_TIMING_RETENTION,
  ToolCallTimingStore,
} from "../../../src/agent/tool-call-timing-store";

async function withStore(fn: (store: ToolCallTimingStore) => void | Promise<void>) {
  const id = env.THINK_THREAD_AGENT.idFromName(`tool-timing-${crypto.randomUUID()}`);
  const stub = env.THINK_THREAD_AGENT.get(id);
  await runInDurableObject(stub, async (_instance, state) => {
    const store = new ToolCallTimingStore(state.storage);
    store.migrate();
    await fn(store);
  });
}

describe("ToolCallTimingStore", () => {
  it("is idempotent across repeated migrations", async () => {
    await withStore((store) => {
      store.migrate();
      store.migrate();
      store.start({ toolCallId: "c1", toolName: "exec", startedAt: 10 });
      expect(store.list()).toHaveLength(1);
    });
  });

  // The reason this store exists: a call that never returns is invisible
  // everywhere else, and must be readable here with its start time intact.
  it("keeps an open row readable while the call is still running", async () => {
    await withStore((store) => {
      store.start({ toolCallId: "c1", toolName: "exec", startedAt: 1_000 });
      expect(store.list()).toEqual([
        {
          toolCallId: "c1",
          toolName: "exec",
          startedAt: 1_000,
          finishedAt: null,
          ok: null,
          durationMs: null,
        },
      ]);
    });
  });

  it("stamps a completed call with its duration", async () => {
    await withStore((store) => {
      store.start({ toolCallId: "c1", toolName: "exec", startedAt: 1_000 });
      store.finish({ toolCallId: "c1", finishedAt: 3_500, ok: true });
      expect(store.list()[0]).toMatchObject({ finishedAt: 3_500, ok: true, durationMs: 2_500 });
    });
  });

  it("records a throwing call as finished but not ok", async () => {
    await withStore((store) => {
      store.start({ toolCallId: "c1", toolName: "web_fetch", startedAt: 0 });
      store.finish({ toolCallId: "c1", finishedAt: 40, ok: false });
      expect(store.list()[0]).toMatchObject({ ok: false, durationMs: 40 });
    });
  });

  // `finish` guards on `finished_at IS NULL`, so a late duplicate cannot
  // rewrite a terminal that was already recorded.
  it("ignores a second finish for the same call", async () => {
    await withStore((store) => {
      store.start({ toolCallId: "c1", toolName: "exec", startedAt: 0 });
      store.finish({ toolCallId: "c1", finishedAt: 100, ok: true });
      store.finish({ toolCallId: "c1", finishedAt: 9_999, ok: false });
      expect(store.list()[0]).toMatchObject({ finishedAt: 100, ok: true });
    });
  });

  // A retried call reusing its id must be timed from the new start, and must
  // not read as already finished.
  it("reopens a row when the same call id starts again", async () => {
    await withStore((store) => {
      store.start({ toolCallId: "c1", toolName: "exec", startedAt: 0 });
      store.finish({ toolCallId: "c1", finishedAt: 100, ok: true });
      store.start({ toolCallId: "c1", toolName: "exec", startedAt: 500 });
      expect(store.list()[0]).toMatchObject({
        startedAt: 500,
        finishedAt: null,
        ok: null,
        durationMs: null,
      });
    });
  });

  it("returns durations only for finished calls", async () => {
    await withStore((store) => {
      store.start({ toolCallId: "done", toolName: "exec", startedAt: 0 });
      store.finish({ toolCallId: "done", finishedAt: 250, ok: true });
      store.start({ toolCallId: "open", toolName: "exec", startedAt: 0 });

      const durations = store.durationsFor(["done", "open", "absent"]);
      expect(durations.get("done")).toBe(250);
      // Open must be ABSENT, not zero: "not finished" and "finished instantly"
      // must never render the same.
      expect(durations.has("open")).toBe(false);
      expect(durations.has("absent")).toBe(false);
    });
  });

  it("returns an empty map without querying when asked for nothing", async () => {
    await withStore((store) => {
      expect(store.durationsFor([]).size).toBe(0);
    });
  });

  it("trims to the retention bound, keeping the newest starts", async () => {
    await withStore((store) => {
      const total = TOOL_CALL_TIMING_RETENTION + 25;
      for (let i = 0; i < total; i++) {
        store.start({ toolCallId: `c${i}`, toolName: "exec", startedAt: i });
      }
      const rows = store.list(total);
      expect(rows).toHaveLength(TOOL_CALL_TIMING_RETENTION);
      expect(rows[0]?.toolCallId).toBe(`c${total - 1}`);
      expect(rows.some((row) => row.toolCallId === "c0")).toBe(false);
    });
  });

  it("lists newest start first", async () => {
    await withStore((store) => {
      store.start({ toolCallId: "old", toolName: "exec", startedAt: 10 });
      store.start({ toolCallId: "new", toolName: "exec", startedAt: 20 });
      expect(store.list().map((row) => row.toolCallId)).toEqual(["new", "old"]);
    });
  });
});
