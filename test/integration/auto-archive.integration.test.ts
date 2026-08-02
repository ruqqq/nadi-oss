import { env, runInDurableObject } from "cloudflare:test";
import { beforeAll, describe, expect, it } from "vitest";
import { drizzle } from "drizzle-orm/d1";
import { eq } from "drizzle-orm";
import * as schema from "../../src/db/schema";
import { applyRegistryTestSchema, seedRegistryThread } from "./helpers/registry";
import {
  AUTO_ARCHIVE_BATCH,
  AUTO_ARCHIVE_IDLE_DAYS,
  autoArchiveIdleThreads,
} from "../../src/agent/auto-archive";
import { ArchivedMessageRepository } from "../../src/db/repositories/archived-messages";

const DAY_MS = 86_400_000;

/** Archiving refuses to snapshot-and-destroy an empty transcript, so give the
 * thread real history before the cron sees it. */
async function seedThreadMessages(threadId: string, messages: unknown[]) {
  const stub = env.THINK_THREAD_AGENT.get(env.THINK_THREAD_AGENT.idFromName(threadId));
  await (runInDurableObject as any)(stub, async (instance: any) => {
    await instance.__unsafe_ensureInitialized();
    await instance.addMessages(messages);
  });
}

async function seedEmptyThreads(threadIds: string[], oldest: number) {
  const workspaceId = "workspace-test";
  const agentId = `agent-${workspaceId}`;
  const createdAt = 1_800_000_000_000;

  await env.REGISTRY_DB.batch([
    env.REGISTRY_DB.prepare("INSERT INTO workspaces (id, name, created_at) VALUES (?, ?, ?)").bind(
      workspaceId,
      workspaceId,
      createdAt,
    ),
    env.REGISTRY_DB.prepare(
      "INSERT INTO agents (id, workspace_id, name, system_prompt, provider, model, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)",
    ).bind(agentId, workspaceId, "Default", "You are Nadi.", "mock", "mock", createdAt),
    ...threadIds.map((threadId, index) =>
      env.REGISTRY_DB.prepare(
        "INSERT INTO thread_index (id, workspace_id, agent_id, project_id, title, title_set, runtime, source, automaton_id, automaton_run_id, last_event_id, last_message_preview, archived_at, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
      ).bind(
        threadId,
        workspaceId,
        agentId,
        null,
        "Test Thread",
        0,
        "think",
        "manual",
        null,
        null,
        null,
        "",
        null,
        createdAt,
        oldest + index,
      ),
    ),
  ]);
}

describe("autoArchiveIdleThreads", () => {
  beforeAll(async () => {
    await applyRegistryTestSchema(env.REGISTRY_DB);
  });

  it("archives only threads idle beyond the threshold", async () => {
    const nowTs = 2_000_000_000_000;
    const stale = await seedRegistryThread(env.REGISTRY_DB, {
      threadId: "thr_stale",
      runtime: "think",
      updatedAt: nowTs - (AUTO_ARCHIVE_IDLE_DAYS + 1) * DAY_MS,
    });
    const fresh = await seedRegistryThread(env.REGISTRY_DB, {
      threadId: "thr_fresh",
      runtime: "think",
      updatedAt: nowTs - 1 * DAY_MS,
    });

    const messages = [{ id: "s1", role: "user", parts: [{ type: "text", text: "stale" }] }];
    await seedThreadMessages(stale.threadId, messages);

    const result = await autoArchiveIdleThreads(env, nowTs);
    expect(result.archived).toBe(1);

    // The cron's whole reason to exist is idle threads, whose DOs are cold —
    // the snapshot must carry the real transcript, never [].
    expect(
      await new ArchivedMessageRepository(drizzle(env.REGISTRY_DB, { schema })).listForThread(
        stale.threadId,
      ),
    ).toEqual(messages);

    const db = drizzle(env.REGISTRY_DB, { schema });
    const staleRow = await db
      .select({ archivedAt: schema.threadIndex.archivedAt })
      .from(schema.threadIndex)
      .where(eq(schema.threadIndex.id, stale.threadId))
      .get();
    const freshRow = await db
      .select({ archivedAt: schema.threadIndex.archivedAt })
      .from(schema.threadIndex)
      .where(eq(schema.threadIndex.id, fresh.threadId))
      .get();
    expect(staleRow?.archivedAt).not.toBeNull();
    expect(freshRow?.archivedAt).toBeNull();
  });

  it("skips (does not destroy) an idle thread whose snapshot is empty", async () => {
    const nowTs = 2_000_000_000_000;
    const empty = await seedRegistryThread(env.REGISTRY_DB, {
      threadId: "thr_stale_empty",
      runtime: "think",
      updatedAt: nowTs - (AUTO_ARCHIVE_IDLE_DAYS + 1) * DAY_MS,
    });

    const result = await autoArchiveIdleThreads(env, nowTs);
    // A benign skip, not a failure: the empty-snapshot refusal is the guard working,
    // not the archive breaking. The counters are separate so a thread that fails on
    // every run is distinguishable from one that was merely busy or empty.
    expect(result).toEqual({ archived: 0, skipped: 1, failed: 0 });

    const row = await drizzle(env.REGISTRY_DB, { schema })
      .select({
        archivedAt: schema.threadIndex.archivedAt,
        archiveSkippedUpdatedAt: schema.threadIndex.archiveSkippedUpdatedAt,
      })
      .from(schema.threadIndex)
      .where(eq(schema.threadIndex.id, empty.threadId))
      .get();
    expect(row?.archivedAt).toBeNull();
    expect(row?.archiveSkippedUpdatedAt).not.toBeNull();
  });

  /**
   * The batch is oldest-first and an empty thread is never archivable, so without
   * a skip marker a full batch of empties (created-but-never-messaged threads are
   * common) pins the head of the queue forever and NOTHING else is ever archived.
   */
  it("a full batch of unarchivable empty threads does not starve the queue", async () => {
    const nowTs = 2_000_000_000_000;
    const oldest = nowTs - (AUTO_ARCHIVE_IDLE_DAYS + 30) * DAY_MS;
    await seedEmptyThreads(
      Array.from({ length: AUTO_ARCHIVE_BATCH }, (_, index) => `thr_wedge_empty_${index}`),
      oldest,
    );
    // Newer than every empty, so it sits BEHIND them in the oldest-first batch.
    const real = await seedRegistryThread(env.REGISTRY_DB, {
      threadId: "thr_wedge_real",
      runtime: "think",
      updatedAt: nowTs - (AUTO_ARCHIVE_IDLE_DAYS + 1) * DAY_MS,
    });
    await seedThreadMessages(real.threadId, [
      { id: "r1", role: "user", parts: [{ type: "text", text: "real" }] },
    ]);

    // Run 1 hits the wall of empties and archives nothing, but marks them.
    const first = await autoArchiveIdleThreads(env, nowTs);
    expect(first.archived).toBe(0);
    // Run 2 must get past them. Under the un-marked behavior it re-picks the
    // same empties forever and this stays 0.
    const second = await autoArchiveIdleThreads(env, nowTs);
    expect(second.archived).toBeGreaterThanOrEqual(1);

    const row = await drizzle(env.REGISTRY_DB, { schema })
      .select({ archivedAt: schema.threadIndex.archivedAt })
      .from(schema.threadIndex)
      .where(eq(schema.threadIndex.id, real.threadId))
      .get();
    expect(row?.archivedAt).not.toBeNull();
  });
});
