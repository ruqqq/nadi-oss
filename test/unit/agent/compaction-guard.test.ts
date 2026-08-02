import { describe, expect, it } from "vitest";
import { createInFlightGuard } from "../../../src/agent/compaction";

/**
 * A DO is single-threaded but NOT atomic across awaits: the input gate only
 * defers events while a STORAGE op is outstanding, and Session uses the
 * synchronous SQLite API. So while compact() awaits the summarizer LLM call
 * (seconds), the runtime can deliver a watcher/subagent RPC or a steering
 * message whose append re-checks the threshold, sees nothing written yet, and
 * compacts again — two LLM calls, two overlay rows.
 */
describe("createInFlightGuard", () => {
  it("collapses concurrent compactions into one run", async () => {
    let runs = 0;
    const guard = createInFlightGuard();
    const work = async () => {
      runs++;
      await new Promise((r) => setTimeout(r, 10));
      return "done";
    };

    const [a, b, c] = await Promise.all([guard(work), guard(work), guard(work)]);

    expect(runs).toBe(1);
    expect([a, b, c]).toEqual(["done", "done", "done"]);
  });

  it("allows a fresh run after the first settles", async () => {
    let runs = 0;
    const guard = createInFlightGuard();
    const work = async () => {
      runs++;
      return runs;
    };

    await guard(work);
    await guard(work);

    expect(runs).toBe(2);
  });

  it("releases the slot after a rejection so the next call can run", async () => {
    let runs = 0;
    const guard = createInFlightGuard();
    const boom = async () => {
      runs++;
      throw new Error("summarizer exploded");
    };

    await expect(guard(boom)).rejects.toThrow("summarizer exploded");
    await expect(guard(boom)).rejects.toThrow("summarizer exploded");

    expect(runs).toBe(2);
  });
});
