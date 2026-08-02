import { env } from "cloudflare:test";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { drizzle } from "drizzle-orm/d1";
import * as schema from "../../src/db/schema";
import { applyRegistryTestSchema } from "./helpers/registry";
import { clearRegistry, seedUserWorkspace } from "./helpers/thread-seed";
import { selectThreadSummariesForUser } from "../../src/http/thread-routes";
import type { Env } from "../../src/env";

const now = 1_800_000_000_000;

async function seedThreads(
  workspaceId: string,
  agentId: string,
  rows: Array<{
    id: string;
    updatedAt: number;
    title?: string;
    preview?: string;
    projectId?: string | null;
    archivedAt?: number | null;
  }>,
) {
  const db = drizzle(env.REGISTRY_DB, { schema });
  for (const row of rows) {
    await db.insert(schema.threadIndex).values({
      id: row.id,
      workspaceId,
      agentId,
      projectId: row.projectId ?? null,
      workbenchId: null,
      modelProvider: "mock",
      model: "mock",
      modelInputModalities: JSON.stringify(["text"]),
      showReasoning: true,
      title: row.title ?? row.id,
      runtime: "legacy",
      source: "manual",
      automatonId: null,
      automatonRunId: null,
      lastEventId: null,
      lastMessagePreview: row.preview ?? "",
      archivedAt: row.archivedAt ?? null,
      createdAt: row.updatedAt,
      updatedAt: row.updatedAt,
    });
  }
}

/** Walk every page, as the client does, and return the ids in order. */
async function walk(userId: string, limit: number, q?: string): Promise<string[]> {
  const ids: string[] = [];
  let cursor: string | undefined;
  for (let guard = 0; guard < 50; guard++) {
    const page = await selectThreadSummariesForUser(env as Env, userId, "active", "all", {
      limit,
      ...(cursor ? { cursor } : {}),
      ...(q ? { q } : {}),
    });
    ids.push(...page.threads.map((t) => t.threadId));
    if (!page.nextCursor) return ids;
    cursor = page.nextCursor;
  }
  throw new Error("cursor never terminated");
}

describe("thread list pagination", () => {
  beforeEach(async () => {
    await applyRegistryTestSchema(env.REGISTRY_DB);
    await clearRegistry();
  });

  afterEach(async () => {
    // integration-fast shares one D1 across every file (isolate: false,
    // fileParallelism: false) — without this, this suite's rows leak into
    // whichever file runs next.
    await clearRegistry();
  });

  it("returns everything, unpaged, when no limit is given", async () => {
    // The deployed client sends no limit. It must keep getting the whole list.
    const seeded = await seedUserWorkspace("pagination");
    await seedThreads(seeded.workspaceId, seeded.agentId, [
      { id: "thr_1", updatedAt: now },
      { id: "thr_2", updatedAt: now - 1 },
    ]);
    const page = await selectThreadSummariesForUser(env as Env, seeded.userId);
    expect(page.threads).toHaveLength(2);
    expect(page.nextCursor).toBeNull();
  });

  it("walks the whole list in order with no gaps or repeats", async () => {
    const seeded = await seedUserWorkspace("pagination");
    await seedThreads(
      seeded.workspaceId,
      seeded.agentId,
      Array.from({ length: 25 }, (_, i) => ({ id: `thr_${i}`, updatedAt: now - i })),
    );
    const walked = await walk(seeded.userId, 10);
    expect(walked).toHaveLength(25);
    expect(new Set(walked).size).toBe(25);
    expect(walked).toEqual(Array.from({ length: 25 }, (_, i) => `thr_${i}`));
  });

  it("does not lose rows that share an updatedAt", async () => {
    // THE bug this cursor exists to avoid. Every thread has the same stamp, so a
    // cursor of "updatedAt < T" returns nothing on page 2 and the list ends
    // early — silently, and only for users whose threads were touched together
    // (a bulk move, a migration, a fast automaton).
    const seeded = await seedUserWorkspace("pagination");
    await seedThreads(
      seeded.workspaceId,
      seeded.agentId,
      Array.from({ length: 12 }, (_, i) => ({
        id: `thr_${String(i).padStart(2, "0")}`,
        updatedAt: now,
      })),
    );
    const walked = await walk(seeded.userId, 5);
    expect(walked).toHaveLength(12);
    expect(new Set(walked).size).toBe(12);
  });

  it("clamps an oversized limit to MAX_THREAD_PAGE", async () => {
    // 120 rows so an unclamped limit:5000 would return more than MAX_THREAD_PAGE
    // (100) rows — with only 1 seeded row (the prior version of this test),
    // deleting the clamp entirely still passed.
    const seeded = await seedUserWorkspace("pagination");
    await seedThreads(
      seeded.workspaceId,
      seeded.agentId,
      Array.from({ length: 120 }, (_, i) => ({
        id: `thr_${String(i).padStart(3, "0")}`,
        updatedAt: now - i,
      })),
    );
    const page = await selectThreadSummariesForUser(env as Env, seeded.userId, "active", "all", {
      limit: 5000,
    });
    expect(page.threads).toHaveLength(100);
  });

  it("rejects a junk cursor", async () => {
    const seeded = await seedUserWorkspace("pagination");
    await seedThreads(seeded.workspaceId, seeded.agentId, [{ id: "thr_1", updatedAt: now }]);
    await expect(
      selectThreadSummariesForUser(env as Env, seeded.userId, "active", "all", { cursor: "junk!" }),
    ).rejects.toThrow(/cursor/i);
  });

  it("rejects a cursor from status:archived replayed against status:active", async () => {
    // The failure scenario this guards: All Chats fetches ?status=archived,
    // gets a nextCursor encoding an archivedAt value, then the user flips to
    // Active and the client reuses that cursor. Without a fingerprint check,
    // the server compares an archivedAt (~1.7e12) against updatedAt
    // (~1.8e12) and returns a silently wrong slice — no 400, no gap/repeat
    // detection possible from the client's side.
    const seeded = await seedUserWorkspace("pagination");
    await seedThreads(
      seeded.workspaceId,
      seeded.agentId,
      Array.from({ length: 5 }, (_, i) => ({
        id: `thr_active_${i}`,
        updatedAt: now - i,
      })),
    );
    await seedThreads(
      seeded.workspaceId,
      seeded.agentId,
      Array.from({ length: 5 }, (_, i) => ({
        id: `thr_archived_${i}`,
        updatedAt: now - i,
        archivedAt: now - i,
      })),
    );

    const archivedPage1 = await selectThreadSummariesForUser(
      env as Env,
      seeded.userId,
      "archived",
      "all",
      { limit: 2 },
    );
    expect(archivedPage1.nextCursor).not.toBeNull();
    if (archivedPage1.nextCursor === null) throw new Error("expected a nextCursor");

    await expect(
      selectThreadSummariesForUser(env as Env, seeded.userId, "active", "all", {
        limit: 2,
        cursor: archivedPage1.nextCursor,
      }),
    ).rejects.toThrow(/cursor/i);
  });

  it("rejects a cursor from one q replayed against a different q", async () => {
    const seeded = await seedUserWorkspace("pagination");
    await seedThreads(
      seeded.workspaceId,
      seeded.agentId,
      Array.from({ length: 5 }, (_, i) => ({
        id: `thr_deploy_${i}`,
        updatedAt: now - i,
        title: `deploy the worker ${i}`,
      })),
    );
    await seedThreads(
      seeded.workspaceId,
      seeded.agentId,
      Array.from({ length: 5 }, (_, i) => ({
        id: `thr_worker_${i}`,
        updatedAt: now - i - 100,
        title: `restart worker ${i}`,
      })),
    );

    const deployPage1 = await selectThreadSummariesForUser(
      env as Env,
      seeded.userId,
      "active",
      "all",
      { limit: 2, q: "deploy" },
    );
    expect(deployPage1.nextCursor).not.toBeNull();
    if (deployPage1.nextCursor === null) throw new Error("expected a nextCursor");

    await expect(
      selectThreadSummariesForUser(env as Env, seeded.userId, "active", "all", {
        limit: 2,
        q: "worker",
        cursor: deployPage1.nextCursor,
      }),
    ).rejects.toThrow(/cursor/i);
  });

  it("returns nextCursor:null on the last page when the count is an exact multiple of the limit", async () => {
    // If `rows.length > limit` ever became `>=`, an exact-multiple list would
    // return a nextCursor pointing at an empty page: the UI shows "Load more",
    // the user taps it, and nothing arrives. 10 rows / limit 5 = exactly 2 pages.
    const seeded = await seedUserWorkspace("pagination");
    await seedThreads(
      seeded.workspaceId,
      seeded.agentId,
      Array.from({ length: 10 }, (_, i) => ({
        id: `thr_${String(i).padStart(2, "0")}`,
        updatedAt: now - i,
      })),
    );
    const page1 = await selectThreadSummariesForUser(env as Env, seeded.userId, "active", "all", {
      limit: 5,
    });
    expect(page1.threads).toHaveLength(5);
    expect(page1.nextCursor).not.toBeNull();

    if (page1.nextCursor === null) throw new Error("expected a nextCursor");
    const page2 = await selectThreadSummariesForUser(env as Env, seeded.userId, "active", "all", {
      limit: 5,
      cursor: page1.nextCursor,
    });
    expect(page2.threads).toHaveLength(5);
    expect(page2.nextCursor).toBeNull();
  });

  it("walks the archived list in archivedAt-descending order, independent of updatedAt order", async () => {
    // The ORDER BY column and the cursor's sortValue are decided by two
    // independent-looking sites; if they ever disagreed, this is what would
    // catch it. updatedAt order is REVERSED from archivedAt order on purpose:
    // a walk that accidentally reads updatedAt would come back in the wrong
    // order or drop/repeat rows.
    const seeded = await seedUserWorkspace("pagination");
    const rows = Array.from({ length: 8 }, (_, i) => ({
      id: `thr_${String(i).padStart(2, "0")}`,
      // archivedAt descending: thr_00 is most-recently-archived.
      archivedAt: now - i,
      // updatedAt ascending: the opposite order.
      updatedAt: now + i,
    }));
    await seedThreads(seeded.workspaceId, seeded.agentId, rows);

    const ids: string[] = [];
    let cursor: string | undefined;
    for (let guard = 0; guard < 50; guard++) {
      const page = await selectThreadSummariesForUser(
        env as Env,
        seeded.userId,
        "archived",
        "all",
        cursor === undefined ? { limit: 3 } : { limit: 3, cursor },
      );
      ids.push(...page.threads.map((t) => t.threadId));
      if (!page.nextCursor) break;
      cursor = page.nextCursor;
      if (guard === 49) throw new Error("cursor never terminated");
    }

    expect(ids).toHaveLength(8);
    expect(new Set(ids).size).toBe(8);
    expect(ids).toEqual(rows.map((r) => r.id));
  });

  it("searches title, preview and project name", async () => {
    const seeded = await seedUserWorkspace("pagination");
    const db = drizzle(env.REGISTRY_DB, { schema });
    await db.insert(schema.projects).values({
      id: "proj_1",
      workspaceId: seeded.workspaceId,
      name: "Marketing",
      description: "",
      customInstructions: "",
      defaultWorkbenchId: null,
      archivedAt: null,
      createdAt: now,
      updatedAt: now,
    });
    await seedThreads(seeded.workspaceId, seeded.agentId, [
      { id: "thr_title", updatedAt: now, title: "Deploy the worker" },
      { id: "thr_preview", updatedAt: now - 1, title: "Untitled", preview: "the worker crashed" },
      { id: "thr_project", updatedAt: now - 2, title: "Untitled", projectId: "proj_1" },
      { id: "thr_none", updatedAt: now - 3, title: "Untitled" },
    ]);

    const byTitle = await selectThreadSummariesForUser(env as Env, seeded.userId, "active", "all", {
      q: "worker",
    });
    expect(byTitle.threads.map((t) => t.threadId).sort()).toEqual(["thr_preview", "thr_title"]);

    const byProject = await selectThreadSummariesForUser(
      env as Env,
      seeded.userId,
      "active",
      "all",
      {
        q: "marketing",
      },
    );
    expect(byProject.threads.map((t) => t.threadId)).toEqual(["thr_project"]);
  });

  it("is case-insensitive, matching what the client does today", async () => {
    const seeded = await seedUserWorkspace("pagination");
    await seedThreads(seeded.workspaceId, seeded.agentId, [
      { id: "thr_1", updatedAt: now, title: "Deploy" },
    ]);
    const page = await selectThreadSummariesForUser(env as Env, seeded.userId, "active", "all", {
      q: "DEPLOY",
    });
    expect(page.threads).toHaveLength(1);
  });

  it("treats % as a literal, not a wildcard", async () => {
    // Fixtures chosen so an unescaped "%" (which becomes a real SQL wildcard,
    // matching "a" then anything then "b") would ALSO match thr_wildcard_only
    // — a title containing "50" and "%" nowhere adjacent, but with other text
    // in between that a wildcard would happily skip over. A naive "search
    // still finds the % row" assertion (as in the seeded 50%/unrelated pair)
    // passes even with escaping deleted, because "%" degenerates to a no-op
    // suffix wildcard; this fixture forces the middle wildcard to matter.
    const seeded = await seedUserWorkspace("pagination");
    await seedThreads(seeded.workspaceId, seeded.agentId, [
      { id: "thr_literal", updatedAt: now, title: "Use 50%off syntax" },
      { id: "thr_wildcard_only", updatedAt: now - 1, title: "50 percent off deal" },
    ]);
    const page = await selectThreadSummariesForUser(env as Env, seeded.userId, "active", "all", {
      q: "50%off",
    });
    expect(page.threads.map((t) => t.threadId)).toEqual(["thr_literal"]);
  });

  it("treats _ as a literal, not a single-char wildcard", async () => {
    // Unescaped, "a_b" becomes a SQL wildcard matching any 3-char run "a?b" —
    // it would quietly match "axb" too. Only thr_literal contains the exact
    // substring "a_b".
    const seeded = await seedUserWorkspace("pagination");
    await seedThreads(seeded.workspaceId, seeded.agentId, [
      { id: "thr_literal", updatedAt: now, title: "Set a_b as the variable" },
      { id: "thr_onechar", updatedAt: now - 1, title: "axb is unrelated" },
    ]);
    const page = await selectThreadSummariesForUser(env as Env, seeded.userId, "active", "all", {
      q: "a_b",
    });
    expect(page.threads.map((t) => t.threadId)).toEqual(["thr_literal"]);
  });

  it("paginates search results", async () => {
    // Interleave hits and misses by updatedAt (rather than seeding all hits
    // newer than all misses) so a page boundary genuinely falls between a hit
    // and a miss — otherwise a dropped `q` filter on page 2 could still
    // coincidentally return only hits.
    const seeded = await seedUserWorkspace("pagination");
    await seedThreads(
      seeded.workspaceId,
      seeded.agentId,
      Array.from({ length: 16 }, (_, i) =>
        i % 2 === 0
          ? { id: `thr_hit_${i / 2}`, updatedAt: now - i, title: `deploy ${i}` }
          : { id: `thr_miss_${(i - 1) / 2}`, updatedAt: now - i, title: `unrelated ${i}` },
      ),
    );
    const walked = await walk(seeded.userId, 3, "deploy");
    expect(walked).toEqual(Array.from({ length: 8 }, (_, i) => `thr_hit_${i}`));
  });
});
