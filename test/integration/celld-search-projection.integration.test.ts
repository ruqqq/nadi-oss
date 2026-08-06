import { env } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import { hasRegistry } from "../../src/db/client";
import { RegistryD1 } from "../../src/db/registry-d1";
import { ThreadSearchProjectionRepository } from "../../src/db/repositories/thread-search-projection";
import type { Env } from "../../src/env";
import { seedRegistryThread } from "./helpers/registry";

// TEST-ONLY binding (see vitest.config.ts): REGISTRY_DO exists in the pool so
// the celld registry path can be exercised on the Cloudflare side.
const poolEnv = env as unknown as Env;

/** An env shaped like celld's: no D1 binding, the registry DO present. */
function celldEnv(): Env {
  return { ...poolEnv, REGISTRY_DB: undefined, REGISTRY_DO: poolEnv.REGISTRY_DO } as unknown as Env;
}

function facade(): D1Database {
  return new RegistryD1(poolEnv.REGISTRY_DO!) as unknown as D1Database;
}

describe("search projection on celld", () => {
  it("sees a registry when only the Durable Object is bound", () => {
    // The bug this replaces: `env.REGISTRY_DB` answers "is this Cloudflare?",
    // so search projection turned itself off on celld with no error and no log.
    expect(hasRegistry(celldEnv())).toBe(true);
    expect(hasRegistry(poolEnv)).toBe(true);
    expect(hasRegistry({})).toBe(false);
  });

  it("projects message rows through the registry facade", async () => {
    const db = facade();
    const { workspaceId, threadId } = await seedRegistryThread(db, {
      workspaceId: "ws-celld-projection",
      threadId: `thr-celld-projection-${crypto.randomUUID()}`,
      createdAt: 1_800_000_000_000,
      updatedAt: 1_800_000_000_000,
    });

    await new ThreadSearchProjectionRepository(db).reconcile({
      workspaceId,
      threadId,
      observedUpdatedAt: 1_800_000_000_000,
      currentMessageIds: ["m-celld-1"],
      changedDocuments: [
        {
          messageId: "m-celld-1",
          role: "user",
          createdAt: 1_800_000_000_000,
          content: "pelican survey notes for the estuary",
          contentHash: "hash-celld-1",
          sourceHash: "src-celld-1",
        },
      ],
      lastMessagePreview: "pelican survey notes",
    });

    const rows = await db
      .prepare("SELECT message_id FROM thread_search_messages WHERE thread_id = ?")
      .bind(threadId)
      .all<{ message_id: string }>();

    expect(rows.results.map((row) => row.message_id)).toEqual(["m-celld-1"]);
  });

  it("answers an FTS MATCH against rows projected through the facade", async () => {
    // The storage half of "search works on celld": the FTS5 virtual table comes
    // from the bundled migrations, and this is the only test that actually runs
    // a MATCH against it through the Durable Object rather than real D1.
    const db = facade();
    const threadId = `thr-celld-fts-${crypto.randomUUID()}`;
    const { workspaceId } = await seedRegistryThread(db, {
      workspaceId: "ws-celld-fts",
      threadId,
      createdAt: 1_800_000_000_000,
      updatedAt: 1_800_000_000_000,
    });

    await new ThreadSearchProjectionRepository(db).reconcile({
      workspaceId,
      threadId,
      observedUpdatedAt: 1_800_000_000_000,
      currentMessageIds: ["m-celld-fts-1"],
      changedDocuments: [
        {
          messageId: "m-celld-fts-1",
          role: "assistant",
          createdAt: 1_800_000_000_000,
          content: "the capybara paddled across the reservoir at dusk",
          contentHash: "hash-celld-fts-1",
          sourceHash: "src-celld-fts-1",
        },
      ],
      lastMessagePreview: "the capybara paddled",
    });

    const hit = await db
      .prepare(
        `SELECT thread_search_messages.message_id AS message_id
           FROM thread_search_fts
           JOIN thread_search_messages ON thread_search_messages.id = thread_search_fts.rowid
          WHERE thread_search_fts MATCH ?
            AND thread_search_messages.thread_id = ?`,
      )
      .bind("capybara", threadId)
      .all<{ message_id: string }>();

    expect(hit.results.map((row) => row.message_id)).toEqual(["m-celld-fts-1"]);

    const miss = await db
      .prepare(
        `SELECT COUNT(*) AS n
           FROM thread_search_fts
           JOIN thread_search_messages ON thread_search_messages.id = thread_search_fts.rowid
          WHERE thread_search_fts MATCH ?
            AND thread_search_messages.thread_id = ?`,
      )
      .bind("wombat", threadId)
      .all<{ n: number }>();

    expect(miss.results[0]?.n).toBe(0);
  });
});
