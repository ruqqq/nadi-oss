import { env } from "cloudflare:test";
import { eq } from "drizzle-orm";
import { drizzle } from "drizzle-orm/d1";
import { simulateReadableStream } from "ai";
import type { LanguageModel } from "ai";
import { beforeAll, beforeEach, describe, expect, it } from "vitest";
import * as schema from "../../src/db/schema";
import { autoNameThread } from "../../src/agent/auto-name-thread";
import { applyRegistryTestSchema, seedRegistryThread } from "./helpers/registry";

/**
 * A hand-rolled fake rather than `ai/test`'s MockLanguageModelV3: importing
 * `ai/test` at test-file level inside a miniflare worker crashes the worker (see
 * the header of test/unit/mcp/needsapproval.test.ts).
 */
function fakeModel(answer: string | Error): LanguageModel {
  return {
    specificationVersion: "v3",
    provider: "fake",
    modelId: "fake",
    supportedUrls: {},
    // Naming STREAMS. It used to call `generateText`, which is not served by
    // every provider — openai-oauth/codex returns "Invalid JSON response" — so
    // naming silently degraded to the word-slice fallback on those models. See
    // src/agent/internal-llm.ts.
    doStream: async () => {
      if (answer instanceof Error) throw answer;
      return {
        stream: simulateReadableStream({
          initialDelayInMs: null,
          chunkDelayInMs: null,
          chunks: [
            { type: "text-start" as const, id: "t" },
            { type: "text-delta" as const, id: "t", delta: answer },
            { type: "text-end" as const, id: "t" },
            {
              type: "finish" as const,
              finishReason: { unified: "stop" as const, raw: "stop" },
              usage: {
                inputTokens: { total: 1, noCache: 1, cacheRead: 0, cacheWrite: 0 },
                outputTokens: { total: 1, text: 1, reasoning: 0 },
              },
            },
          ],
        }),
        rawCall: { rawPrompt: null, rawSettings: {} },
      };
    },
  } as unknown as LanguageModel;
}

function readThread(threadId: string) {
  return drizzle(env.REGISTRY_DB, { schema })
    .select()
    .from(schema.threadIndex)
    .where(eq(schema.threadIndex.id, threadId))
    .get();
}

async function name(threadId: string, answer: string | Error, firstUserText = "how do I add D1?") {
  await autoNameThread({
    env,
    threadId,
    workspaceId: "ws_1",
    model: fakeModel(answer),
    modelProvider: "openrouter",
    modelName: "test-model",
    firstUserText,
  });
}

describe("autoNameThread", () => {
  beforeAll(async () => {
    await applyRegistryTestSchema(env.REGISTRY_DB);
  });
  beforeEach(async () => {
    await drizzle(env.REGISTRY_DB, { schema }).delete(schema.threadIndex);
  });

  it("names an untitled thread from the model's answer", async () => {
    await seedRegistryThread(env.REGISTRY_DB, { threadId: "thr_a", title: "New thread" });

    await name("thr_a", "Adding D1 To The Worker");

    expect(await readThread("thr_a")).toMatchObject({
      title: "Adding D1 To The Worker",
      titleSet: true,
    });
  });

  // The whole point of moving naming off the model: a thread must never be left
  // unnamed just because the model was unhelpful.
  it("falls back to the user's own words when the model fails", async () => {
    await seedRegistryThread(env.REGISTRY_DB, { threadId: "thr_b", title: "New thread" });

    await name("thr_b", new Error("provider exploded"), "how do I add D1 to this worker anyway");

    expect(await readThread("thr_b")).toMatchObject({
      title: "how do I add D1 to",
      titleSet: true,
    });
  });

  it("falls back when the model answers with nothing usable", async () => {
    await seedRegistryThread(env.REGISTRY_DB, { threadId: "thr_c", title: "New thread" });

    await name("thr_c", "   ", "fix the flaky login test");

    expect(await readThread("thr_c")).toMatchObject({
      title: "fix the flaky login test",
      titleSet: true,
    });
  });

  // The bug this guards: a thread shipped titled "I can't access past
  // conversations, but here's general guidance:" — the model answered the
  // message instead of naming it, and nothing downstream noticed.
  it("falls back when the model answers the message instead of naming it", async () => {
    await seedRegistryThread(env.REGISTRY_DB, { threadId: "thr_f", title: "New thread" });

    await name(
      "thr_f",
      "I can't access past conversations, but here's general guidance:",
      "what did we talk about last time",
    );

    expect(await readThread("thr_f")).toMatchObject({
      title: "what did we talk about last",
      titleSet: true,
    });
  });

  it("leaves an already-titled thread alone", async () => {
    await seedRegistryThread(env.REGISTRY_DB, { threadId: "thr_d", title: "Named by hand" });
    await drizzle(env.REGISTRY_DB, { schema })
      .update(schema.threadIndex)
      .set({ titleSet: true })
      .where(eq(schema.threadIndex.id, "thr_d"));

    await name("thr_d", "Something Else Entirely");

    expect((await readThread("thr_d"))?.title).toBe("Named by hand");
  });

  it("does not name a thread whose first message has no text", async () => {
    await seedRegistryThread(env.REGISTRY_DB, { threadId: "thr_e", title: "New thread" });

    await name("thr_e", "A Title", "   ");

    expect(await readThread("thr_e")).toMatchObject({ title: "New thread", titleSet: false });
  });
});
