import { env, runInDurableObject } from "cloudflare:test";
import { drizzle } from "drizzle-orm/d1";
import { beforeAll, beforeEach, describe, expect, it } from "vitest";
import * as schema from "../../src/db/schema";
import { ArchivedMessageRepository } from "../../src/db/repositories/archived-messages";
import { activeTranscriptRpc } from "../../src/thread-knowledge/adapters/active-transcript";
import { hasLiveTranscript } from "../../src/agent/thread-runtime";
import { ArchivedTranscriptAdapter } from "../../src/thread-knowledge/adapters/archived-transcript";
import { readTranscriptPage } from "../../src/thread-knowledge/transcript-reader";
import { applyRegistryTestSchema, seedRegistryThread } from "./helpers/registry";
import { resetRegistryState } from "./helpers/reset";

const runInThinkDo = runInDurableObject as any;

function archivedRepo() {
  return new ArchivedMessageRepository(drizzle(env.REGISTRY_DB, { schema }));
}

function archivedMessage(input: {
  id: string;
  role?: "user" | "assistant";
  text: string;
  createdAt?: string | number | null;
  extraParts?: unknown[];
}) {
  return {
    id: input.id,
    role: input.role ?? "user",
    createdAt: input.createdAt,
    parts: [{ type: "text", text: input.text }, ...(input.extraParts ?? [])],
  };
}

describe("archived transcript adapter", () => {
  beforeAll(async () => {
    await applyRegistryTestSchema(env.REGISTRY_DB);
  });

  beforeEach(async () => {
    await resetRegistryState(env.REGISTRY_DB);
  });

  it("pages archived rows by seq and preserves the normalized prose contract", async () => {
    const { threadId } = await seedRegistryThread(env.REGISTRY_DB, {
      threadId: "thread-archived-adapter",
      archivedAt: 1_800_000_010_000,
    });
    const repo = archivedRepo();
    await repo.replaceForThread(threadId, [
      archivedMessage({
        id: "m1",
        text: "first",
        createdAt: "2026-07-10T00:00:00.000Z",
      }),
      archivedMessage({
        id: "m2",
        role: "assistant",
        text: "second",
        createdAt: "2026-07-11T00:00:00.000Z",
        extraParts: [{ type: "tool-result", output: "hidden" }],
      }),
    ]);

    const first = await readTranscriptPage(new ArchivedTranscriptAdapter(repo, threadId), {
      threadId,
      limit: 1,
    });
    expect(first.messages).toEqual([
      {
        id: "m1",
        role: "user",
        text: "first",
        createdAt: Date.parse("2026-07-10T00:00:00.000Z"),
      },
    ]);
    expect(first.nextCursor).toEqual(expect.any(String));
    const cursor = first.nextCursor;
    if (cursor === undefined) throw new Error("missing archive cursor");

    const second = await readTranscriptPage(new ArchivedTranscriptAdapter(repo, threadId), {
      threadId,
      limit: 1,
      cursor,
    });
    expect(second.messages).toEqual([
      {
        id: "m2",
        role: "assistant",
        text: "second",
        createdAt: Date.parse("2026-07-11T00:00:00.000Z"),
      },
    ]);
    expect(second.omittedPartCount).toBe(1);
  });

  it("honors date bounds and reports malformed archive payloads as omissions", async () => {
    const { threadId } = await seedRegistryThread(env.REGISTRY_DB, {
      threadId: "thread-archived-malformed",
      archivedAt: 1_800_000_010_000,
    });
    const repo = archivedRepo();
    await repo.replaceForThread(threadId, [
      archivedMessage({
        id: "in-window",
        text: "visible",
        createdAt: "2026-07-10T00:00:00.000Z",
      }),
      archivedMessage({
        id: "malformed",
        role: "assistant",
        text: "broken",
        createdAt: "2026-07-11T00:00:00.000Z",
      }),
      archivedMessage({
        id: "out-window",
        text: "too late",
        createdAt: "2026-08-01T00:00:00.000Z",
      }),
    ]);
    await env.REGISTRY_DB.prepare(
      "UPDATE archived_message SET payload = ? WHERE thread_id = ? AND seq = ?",
    )
      .bind("{not-json", threadId, 1)
      .run();

    await expect(
      repo.listStatsForThread({
        threadId,
        order: "chronological",
        limit: 3,
      }),
    ).resolves.toMatchObject({
      stats: [
        { id: "in-window", position: 0 },
        { id: "archived:1", position: 1 },
        { id: "out-window", position: 2 },
      ],
    });
    await expect(repo.getBySeq(threadId, 1)).resolves.toBeNull();

    const result = await readTranscriptPage(new ArchivedTranscriptAdapter(repo, threadId), {
      threadId,
      since: "2026-07-01T00:00:00.000Z",
      until: "2026-07-20T00:00:00.000Z",
    });

    expect(result.messages.map((message) => message.id)).toEqual(["in-window"]);
    expect(result.omittedPartCount).toBe(2);
  });
});

async function evictThinkThread(threadId: string) {
  const stub = env.THINK_THREAD_AGENT.get(env.THINK_THREAD_AGENT.idFromName(threadId));
  try {
    await runInThinkDo(stub, (instance: any) => {
      instance.ctx.abort("test eviction");
    });
  } catch {
    // Expected: aborting the instance rejects the in-flight call.
  }
}

function expectSha256Hex(value: string) {
  expect(value).toMatch(/^[a-f0-9]{64}$/);
}

describe("active transcript adapter", () => {
  beforeAll(async () => {
    await applyRegistryTestSchema(env.REGISTRY_DB);
  });

  beforeEach(async () => {
    await resetRegistryState(env.REGISTRY_DB);
  });

  it("reads and greps a cold Think thread while preserving Session-created timestamps", async () => {
    const { threadId } = await seedRegistryThread(env.REGISTRY_DB, {
      threadId: "thread-active-think",
      runtime: "think",
    });
    const beforeSeed = Date.now();
    const stub = env.THINK_THREAD_AGENT.get(env.THINK_THREAD_AGENT.idFromName(threadId));
    await runInThinkDo(stub, async (instance: any) => {
      await instance.__unsafe_ensureInitialized();
      await instance.addMessages([
        {
          id: "think-user",
          role: "user",
          parts: [{ type: "text", text: "cold visible user" }],
        },
        {
          id: "think-assistant",
          role: "assistant",
          parts: [{ type: "text", text: "cold needle assistant" }],
        },
      ]);
      await instance.session.appendMessage({
        id: "compaction_skip_me",
        role: "assistant",
        parts: [{ type: "text", text: "synthetic summary" }],
      });
    });
    await evictThinkThread(threadId);

    const rpc = await activeTranscriptRpc(env, { id: threadId });
    const first = await rpc.readThreadProsePage({ threadId, limit: 1 });
    expect(first.messages).toHaveLength(1);
    expect(first.messages[0]).toMatchObject({
      id: "think-user",
      role: "user",
      text: "cold visible user",
    });
    expect(first.messages[0]?.createdAt).toEqual(expect.any(Number));
    expect(first.messages[0]?.createdAt).toBeGreaterThanOrEqual(beforeSeed - 60_000);
    expect(first.omittedPartCount).toBe(0);
    expect(first.nextCursor).toEqual(expect.any(String));

    const grep = await rpc.grepThreadProse({ threadId, pattern: "needle" });
    expect(grep.matches).toEqual([
      expect.objectContaining({
        messageId: "think-assistant",
        role: "assistant",
        text: "cold needle assistant",
        createdAt: expect.any(Number),
      }),
    ]);

    const digestPage = await rpc.listThreadSearchDigests({ limit: 1 });
    expect(digestPage.digests).toEqual([
      { messageId: "think-user", indexable: true, sourceHash: expect.any(String) },
    ]);
    expectSha256Hex(digestPage.digests[0]?.sourceHash ?? "");
    expect(digestPage.nextPosition).toEqual(expect.any(Number));
    expect(digestPage.lastMessagePreview).toBe("cold visible user");

    const documents = await rpc.getThreadSearchDocuments(["think-user", "compaction_skip_me"]);
    expect(documents).toEqual([
      {
        message: first.messages[0],
        sourceHash: digestPage.digests[0]?.sourceHash,
      },
    ]);
  });

  // The retired runtime has no DO to read from. `hasLiveTranscript` is the gate
  // that keeps such a thread off `activeTranscriptRpc` and on the D1 archive
  // adapter instead — without it the Think namespace would mint an empty phantom
  // DO under a name that never belonged to it, and persist it.
  it("does not treat a retired-runtime thread as having a live transcript", async () => {
    const { threadId } = await seedRegistryThread(env.REGISTRY_DB, {
      threadId: "thread-active-legacy",
      runtime: "legacy",
    });

    expect(hasLiveTranscript({ runtime: "legacy", archivedAt: null })).toBe(false);
    expect(hasLiveTranscript({ runtime: "think", archivedAt: null })).toBe(true);
    expect(hasLiveTranscript({ runtime: "think", archivedAt: 1 })).toBe(false);
    expect(threadId).toBe("thread-active-legacy");
  });
});
