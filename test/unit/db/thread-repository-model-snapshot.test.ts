import { describe, expect, it } from "vitest";
import { ThreadRepository } from "../../../src/db/repositories/threads";
import { threadIndex } from "../../../src/db/schema";

/**
 * `ThreadRepository.updateModelSnapshot` is the ONLY thing standing between a
 * mid-thread model switch and silently un-dismissing every thread it touches
 * (dismissal is `recentDismissedAt >= updatedAt`). This mocks nothing but the
 * `.update().set().where()` chain itself — real `drizzle-orm` `eq`, real
 * `threadIndex` column descriptors — so the assertion is on the exact object
 * handed to `.set()`, not on a hand-rolled row-filtering engine. A regression
 * that adds `updatedAt` back to that object fails this test even though the
 * six model columns are still correct.
 */
describe("ThreadRepository.updateModelSnapshot", () => {
  it("sets exactly the six model columns, never updatedAt", async () => {
    const setCalls: Array<Record<string, unknown>> = [];
    const whereCalls: unknown[] = [];
    const fakeDb = {
      update: (table: unknown) => {
        expect(table).toBe(threadIndex);
        return {
          set: (fields: Record<string, unknown>) => {
            setCalls.push(fields);
            return {
              where: async (condition: unknown) => {
                whereCalls.push(condition);
              },
            };
          },
        };
      },
    };

    const repo = new ThreadRepository(fakeDb as never);
    await repo.updateModelSnapshot("thr_1", {
      provider: "openai",
      model: "gpt-5",
      modelInputModalities: ["text", "image"],
      reasoningEffort: "high",
      modelSupportsReasoning: true,
    });

    expect(setCalls).toHaveLength(1);
    expect(whereCalls).toHaveLength(1);
    const fields = setCalls[0]!;
    expect(fields).toEqual({
      modelProvider: "openai",
      model: "gpt-5",
      modelInputModalities: JSON.stringify(["text", "image"]),
      reasoningEffort: "high",
      modelSupportsReasoning: true,
    });
    // The load-bearing assertion: this key must never appear here. `toEqual`
    // above already proves it via exact object shape, but a future edit that
    // widens the `fields` object without updating the `toEqual` expectation
    // would slip past that — this makes the omission explicit and named.
    expect(fields).not.toHaveProperty("updatedAt");
  });

  it("round-trips a null modelSupportsReasoning (unknown capability, not false)", async () => {
    const setCalls: Array<Record<string, unknown>> = [];
    const fakeDb = {
      update: () => ({
        set: (fields: Record<string, unknown>) => {
          setCalls.push(fields);
          return { where: async () => {} };
        },
      }),
    };

    const repo = new ThreadRepository(fakeDb as never);
    await repo.updateModelSnapshot("thr_1", {
      provider: "anthropic",
      model: "claude-sonnet-5",
      modelInputModalities: ["text"],
      reasoningEffort: "medium",
      modelSupportsReasoning: null,
    });

    expect(setCalls[0]?.modelSupportsReasoning).toBeNull();
  });
});
