import { env } from "cloudflare:test";
import { beforeAll, beforeEach, describe, expect, it } from "vitest";
import { applyRegistryTestSchema, seedRegistryThread } from "./helpers/registry";
import { resetRegistryState } from "./helpers/reset";

async function matchingMessageIds(term: string) {
  const rows = await env.REGISTRY_DB.prepare(
    `
      SELECT message_id
      FROM thread_search_fts
      JOIN thread_search_messages ON thread_search_messages.id = thread_search_fts.rowid
      WHERE thread_search_fts MATCH ?
    `,
  )
    .bind(term)
    .all<{ message_id: string }>();

  return rows.results.map((row) => row.message_id);
}

describe("thread knowledge FTS projection", () => {
  beforeAll(async () => {
    await applyRegistryTestSchema(env.REGISTRY_DB);
  });

  beforeEach(async () => {
    await resetRegistryState(env.REGISTRY_DB);
  });

  it("keeps the FTS index synchronized with projected message content", async () => {
    const { workspaceId, threadId } = await seedRegistryThread(env.REGISTRY_DB, {
      workspaceId: "workspace-fts",
      threadId: "thread-fts",
      createdAt: 1_800_000_000_000,
      updatedAt: 1_800_000_000_000,
    });

    await env.REGISTRY_DB.prepare(
      `
        INSERT INTO thread_search_messages (
          workspace_id,
          thread_id,
          message_id,
          role,
          created_at,
          content,
          content_hash,
          source_hash,
          indexed_revision
        )
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
      `,
    )
      .bind(
        workspaceId,
        threadId,
        "msg_unicode",
        "user",
        1_800_000_000_001,
        "Please remember the café rendezvous.",
        "content-hash-1",
        "source-hash-1",
        1,
      )
      .run();

    await expect(matchingMessageIds("café")).resolves.toEqual(["msg_unicode"]);

    await env.REGISTRY_DB.prepare(
      "UPDATE thread_search_messages SET content = ?, content_hash = ?, source_hash = ?, indexed_revision = ? WHERE message_id = ?",
    )
      .bind(
        "Please remember the library rendezvous.",
        "content-hash-2",
        "source-hash-2",
        2,
        "msg_unicode",
      )
      .run();

    await expect(matchingMessageIds("café")).resolves.toEqual([]);
    await expect(matchingMessageIds("library")).resolves.toEqual(["msg_unicode"]);

    await env.REGISTRY_DB.prepare("DELETE FROM thread_search_messages WHERE message_id = ?")
      .bind("msg_unicode")
      .run();

    await expect(matchingMessageIds("library")).resolves.toEqual([]);
  });
});
