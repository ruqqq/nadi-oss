import { env, runInDurableObject } from "cloudflare:test";
import { beforeAll, describe, expect, it } from "vitest";
import { drizzle } from "drizzle-orm/d1";
import { eq } from "drizzle-orm";
import * as schema from "../../src/db/schema";
import { applyRegistryTestSchema, seedRegistryThread } from "./helpers/registry";
import { archiveThreadCore } from "../../src/agent/archive-thread";
import { ArchivedMessageRepository } from "../../src/db/repositories/archived-messages";
import { ArchivedCompactionRepository } from "../../src/db/repositories/archived-compactions";

const runInThinkDo = runInDurableObject as any;
const baseTime = 1_800_000_000_000;

function db() {
  return drizzle(env.REGISTRY_DB, { schema });
}

async function projectionRows(
  threadId: string,
): Promise<Array<{ messageId: string; content: string; indexedRevision: number }>> {
  const rows = await env.REGISTRY_DB.prepare(
    "SELECT message_id AS messageId, content, indexed_revision AS indexedRevision FROM thread_search_messages WHERE thread_id = ? ORDER BY message_id",
  )
    .bind(threadId)
    .all<{ messageId: string; content: string; indexedRevision: number }>();
  return rows.results;
}

async function searchCheckpoint(threadId: string): Promise<number | null> {
  const row = await env.REGISTRY_DB.prepare(
    "SELECT search_indexed_through AS searchIndexedThrough FROM thread_index WHERE id = ?",
  )
    .bind(threadId)
    .first<{ searchIndexedThrough: number | null }>();
  return row?.searchIndexedThrough ?? null;
}

/**
 * Throw the warm DO instance away so the next access must reconstruct it from
 * storage — the in-process stand-in for production eviction. `ctx.abort()` kills
 * the isolate mid-RPC, so this call always rejects; that rejection IS the eviction.
 */
async function evict(threadId: string) {
  const stub = env.THINK_THREAD_AGENT.get(env.THINK_THREAD_AGENT.idFromName(threadId));
  try {
    await runInThinkDo(stub, (instance: any) => {
      instance.ctx.abort("test eviction");
    });
  } catch {
    // expected: aborting the instance rejects the in-flight call
  }
}

describe("archiveThreadCore", () => {
  beforeAll(async () => {
    await applyRegistryTestSchema(env.REGISTRY_DB);
  });

  it("snapshots messages, sets archivedAt, and reports 'archived'", async () => {
    const { threadId } = await seedRegistryThread(env.REGISTRY_DB, {
      threadId: "thr_core",
      runtime: "think",
    });
    const stub = env.THINK_THREAD_AGENT.get(env.THINK_THREAD_AGENT.idFromName(threadId));
    const messages = [{ id: "m1", role: "user", parts: [{ type: "text", text: "hi" }] }];
    await runInThinkDo(stub, async (instance: any) => {
      await instance.__unsafe_ensureInitialized();
      await instance.addMessages(messages);
    });

    const outcome = await archiveThreadCore(env, threadId);
    expect(outcome).toBe("archived");

    const snapshot = await new ArchivedMessageRepository(db()).listForThread(threadId);
    expect(snapshot).toEqual(messages);

    const row = await db()
      .select({ archivedAt: schema.threadIndex.archivedAt })
      .from(schema.threadIndex)
      .where(eq(schema.threadIndex.id, threadId))
      .get();
    expect(row?.archivedAt).not.toBeNull();
  });

  /**
   * The regression that mattered: the auto-archive cron reaches *idle* threads,
   * whose DO has been evicted. Think hydrates its transcript in onStart(), which
   * a raw `idFromName` RPC stub skips, so a cold DO exported [] — and the
   * archive then destroyed the real transcript. `ctx.abort()` throws the warm
   * instance away, which is exactly the eviction production sees; the next
   * access must reconstruct and re-hydrate from DO storage.
   */
  it("archives a COLD (evicted) DO with its real messages, not an empty snapshot", async () => {
    const { threadId } = await seedRegistryThread(env.REGISTRY_DB, {
      threadId: "thr_core_cold",
      runtime: "think",
      updatedAt: baseTime + 72,
    });
    await env.REGISTRY_DB.prepare("UPDATE thread_index SET search_indexed_through = ? WHERE id = ?")
      .bind(baseTime + 999, threadId)
      .run();
    const messages = [
      { id: "c1", role: "user", parts: [{ type: "text", text: "cold projection hello" }] },
      { id: "c2", role: "assistant", parts: [{ type: "text", text: "cold projection reply" }] },
    ];
    const stub = env.THINK_THREAD_AGENT.get(env.THINK_THREAD_AGENT.idFromName(threadId));
    await runInThinkDo(stub, async (instance: any) => {
      await instance.__unsafe_ensureInitialized();
      await instance.addMessages(messages);
    });
    await evict(threadId);

    const outcome = await archiveThreadCore(env, threadId);
    expect(outcome).toBe("archived");

    const snapshot = await new ArchivedMessageRepository(db()).listForThread(threadId);
    expect(snapshot).toEqual(messages);
    expect(await projectionRows(threadId)).toEqual([
      { messageId: "c1", content: "cold projection hello", indexedRevision: baseTime + 72 },
      { messageId: "c2", content: "cold projection reply", indexedRevision: baseTime + 72 },
    ]);
    expect(await searchCheckpoint(threadId)).toBe(baseTime + 72);
  });

  it("refuses to archive+destroy when the snapshot comes back empty", async () => {
    const { threadId } = await seedRegistryThread(env.REGISTRY_DB, {
      threadId: "thr_core_empty",
      runtime: "think",
    });

    expect(await archiveThreadCore(env, threadId)).toBe("empty_snapshot");

    expect(await new ArchivedMessageRepository(db()).listForThread(threadId)).toEqual([]);
    const row = await db()
      .select({ archivedAt: schema.threadIndex.archivedAt })
      .from(schema.threadIndex)
      .where(eq(schema.threadIndex.id, threadId))
      .get();
    expect(row?.archivedAt).toBeNull();
  });

  /**
   * `this.messages` is a hydration cache bounded by `hydrationByteBudget`: on a
   * transcript larger than the budget it holds only a recent window. Archiving
   * snapshots and then DESTROYS, so exporting that window would drop everything
   * older. Shrinking the budget reproduces the oversized-transcript state without
   * building a 24 MiB thread.
   */
  it("archives the FULL transcript when the hydration cache is only a window", async () => {
    const { threadId } = await seedRegistryThread(env.REGISTRY_DB, {
      threadId: "thr_core_windowed",
      runtime: "think",
    });
    const messages = Array.from({ length: 10 }, (_, i) => ({
      id: `w${i}`,
      role: i % 2 === 0 ? "user" : "assistant",
      parts: [{ type: "text", text: `message ${i} ${"x".repeat(200)}` }],
    }));
    const stub = env.THINK_THREAD_AGENT.get(env.THINK_THREAD_AGENT.idFromName(threadId));
    await runInThinkDo(stub, async (instance: any) => {
      await instance.__unsafe_ensureInitialized();
      await instance.addMessages(messages);
      instance.hydrationByteBudget = 100;
      await instance._syncMessages();
      // Guard the premise: the cache really is a truncated window now.
      expect(instance._lastHydration?.truncated).toBe(true);
      expect(instance.messages.length).toBeLessThan(messages.length);
      expect(await instance.exportHistory()).toHaveLength(messages.length);
    });

    expect(await archiveThreadCore(env, threadId)).toBe("archived");
    expect(await new ArchivedMessageRepository(db()).listForThread(threadId)).toEqual(messages);
  });

  /**
   * Archiving snapshots and then DESTROYS the DO. `exportHistory()` returns the
   * COMPACTED view — each summarized span replaced by one synthetic summary — so
   * archiving that view would delete every message a summary hid, permanently. The
   * archive is the record: it must hold the raw transcript. The summaries are kept
   * too, separately, so a long archived thread can still be read as its digest.
   */
  it("archives the RAW transcript of a compacted thread, plus its summaries", async () => {
    const { threadId } = await seedRegistryThread(env.REGISTRY_DB, {
      threadId: "thr_core_compacted",
      runtime: "think",
    });
    const stub = env.THINK_THREAD_AGENT.get(env.THINK_THREAD_AGENT.idFromName(threadId));

    const seeded = await runInThinkDo(stub, async (instance: any) => {
      await instance.__unsafe_ensureInitialized();
      for (let i = 0; i < 12; i++) {
        await instance.session.appendMessage({
          id: `m${i}`,
          role: i % 2 === 0 ? "user" : "assistant",
          parts: [{ type: "text", text: `message ${i}` }],
        });
      }
      // A real overlay row, exactly as compaction writes one.
      await instance.session.addCompaction("## Topic\nthe digest", "m3", "m8");

      const compactedView = await instance.session.getHistory();
      const rawView = await instance.exportRawHistory();
      return { compacted: compactedView.length, raw: rawView.length };
    });

    // Premise: the compacted view really does hide messages.
    expect(seeded.compacted).toBeLessThan(seeded.raw);
    expect(seeded.raw).toBe(12);

    expect(await archiveThreadCore(env, threadId)).toBe("archived");

    // The archive holds every message, including the six the summary replaced.
    const archived = await new ArchivedMessageRepository(db()).listForThread(threadId);
    expect(archived).toHaveLength(12);
    expect((archived as Array<{ id: string }>).map((m) => m.id)).toContain("m5");
    // ...and no summary masquerading as a message.
    expect((archived as Array<{ id: string }>).every((m) => !m.id.startsWith("compaction_"))).toBe(
      true,
    );

    // The digest survives alongside it.
    const summaries = await new ArchivedCompactionRepository(db()).listForThread(threadId);
    expect(summaries).toHaveLength(1);
    expect(summaries[0]).toMatchObject({ fromMessageId: "m3", toMessageId: "m8" });
    expect(summaries[0]?.summary).toContain("the digest");
  });

  /**
   * D1 caps bound parameters per query, and the snapshot binds 3 per message. A
   * single multi-row INSERT throws once a thread is long enough — and the raw
   * transcript is by definition longer than the compacted one, so this bites sooner
   * than it used to. 120 messages is well past any plausible cap.
   */
  it("archives a long thread without blowing D1's bound-parameter cap", async () => {
    const { threadId } = await seedRegistryThread(env.REGISTRY_DB, {
      threadId: "thr_core_long",
      runtime: "think",
    });
    const stub = env.THINK_THREAD_AGENT.get(env.THINK_THREAD_AGENT.idFromName(threadId));
    await runInThinkDo(stub, async (instance: any) => {
      await instance.__unsafe_ensureInitialized();
      for (let i = 0; i < 120; i++) {
        await instance.session.appendMessage({
          id: `L${i}`,
          role: i % 2 === 0 ? "user" : "assistant",
          parts: [{ type: "text", text: `long ${i}` }],
        });
      }
    });

    expect(await archiveThreadCore(env, threadId)).toBe("archived");
    const archived = await new ArchivedMessageRepository(db()).listForThread(threadId);
    expect(archived).toHaveLength(120);
    // Order must survive the chunking.
    expect((archived as Array<{ id: string }>).map((m) => m.id)).toEqual(
      Array.from({ length: 120 }, (_, i) => `L${i}`),
    );
  });

  it("repairs an active index row that already has an archive snapshot", async () => {
    const { threadId } = await seedRegistryThread(env.REGISTRY_DB, {
      threadId: "thr_core_orphaned_snapshot",
      runtime: "think",
      updatedAt: baseTime + 230,
    });
    await env.REGISTRY_DB.prepare("UPDATE thread_index SET search_indexed_through = ? WHERE id = ?")
      .bind(baseTime + 999, threadId)
      .run();
    await new ArchivedMessageRepository(db()).replaceForThread(threadId, [
      {
        id: "orphaned",
        role: "user",
        parts: [{ type: "text", text: "orphaned snapshot recovery projection" }],
      },
    ]);

    expect(await archiveThreadCore(env, threadId)).toBe("archived");
    const row = await db()
      .select({ archivedAt: schema.threadIndex.archivedAt })
      .from(schema.threadIndex)
      .where(eq(schema.threadIndex.id, threadId))
      .get();
    expect(row?.archivedAt).not.toBeNull();
    expect(await projectionRows(threadId)).toEqual([
      {
        messageId: "orphaned",
        content: "orphaned snapshot recovery projection",
        indexedRevision: baseTime + 230,
      },
    ]);
    expect(await searchCheckpoint(threadId)).toBe(baseTime + 230);
  });

  it("is a no-op on an already-archived thread", async () => {
    const { threadId } = await seedRegistryThread(env.REGISTRY_DB, {
      threadId: "thr_core_arch",
      runtime: "think",
      archivedAt: 1,
    });
    expect(await archiveThreadCore(env, threadId)).toBe("already_archived");
  });
});
