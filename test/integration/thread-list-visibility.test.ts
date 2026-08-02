import { env } from "cloudflare:test";
import { afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { drizzle } from "drizzle-orm/d1";
import * as schema from "../../src/db/schema";
import { applyRegistryTestSchema } from "./helpers/registry";
import { clearRegistry, seedUserWorkspace } from "./helpers/thread-seed";
import { selectThreadSummariesForUser } from "../../src/http/thread-routes";
import type { Env } from "../../src/env";

const now = 1_800_000_000_000;

async function insertAutomaton(input: {
  id: string;
  workspaceId: string;
  ownerUserId: string;
  agentId: string;
  notifyMode: "all" | "failures_only";
}) {
  const db = drizzle(env.REGISTRY_DB, { schema });
  await db.insert(schema.automata).values({
    id: input.id,
    workspaceId: input.workspaceId,
    ownerUserId: input.ownerUserId,
    agentId: input.agentId,
    name: input.id,
    prompt: "Do the thing",
    scheduleJson: JSON.stringify({ kind: "manual" }),
    timezone: "UTC",
    enabled: true,
    notifyMode: input.notifyMode,
    createdAt: now,
    updatedAt: now,
  });
}

async function insertThread(input: {
  id: string;
  workspaceId: string;
  agentId: string;
  automatonId?: string | null;
  activityStatus?: "idle" | "running" | "attention_required" | "failed";
  attentionRequiredAt?: number | null;
  outcomeDismissedAt?: number | null;
  updatedAt: number;
}) {
  const db = drizzle(env.REGISTRY_DB, { schema });
  await db.insert(schema.threadIndex).values({
    id: input.id,
    workspaceId: input.workspaceId,
    agentId: input.agentId,
    title: input.id,
    runtime: "think",
    source: input.automatonId ? "automaton" : "manual",
    automatonId: input.automatonId ?? null,
    automatonRunId: null,
    lastEventId: null,
    lastMessagePreview: "",
    activityStatus: input.activityStatus ?? "idle",
    attentionRequiredAt: input.attentionRequiredAt ?? null,
    outcomeDismissedAt: input.outcomeDismissedAt ?? null,
    createdAt: input.updatedAt,
    updatedAt: input.updatedAt,
  });
}

describe("thread list visibility (notify_mode)", () => {
  beforeAll(async () => {
    await applyRegistryTestSchema(env.REGISTRY_DB);
  });

  beforeEach(async () => {
    await clearRegistry();
  });

  afterEach(async () => {
    await clearRegistry();
  });

  it("hides quiet-success failures-only automaton threads, keeps attention/failed", async () => {
    const { userId, workspaceId, agentId } = await seedUserWorkspace("visibility");
    await insertAutomaton({
      id: "automaton-failures-only",
      workspaceId,
      ownerUserId: userId,
      agentId,
      notifyMode: "failures_only",
    });
    await insertAutomaton({
      id: "automaton-all",
      workspaceId,
      ownerUserId: userId,
      agentId,
      notifyMode: "all",
    });

    const failuresOnlyCompleted = "thr_failures_only_completed";
    const failuresOnlyFailed = "thr_failures_only_failed";
    const failuresOnlyAttention = "thr_failures_only_attention";
    const failuresOnlyFailedDismissed = "thr_failures_only_failed_dismissed";
    const allCompleted = "thr_all_completed";

    await insertThread({
      id: failuresOnlyCompleted,
      workspaceId,
      agentId,
      automatonId: "automaton-failures-only",
      activityStatus: "idle",
      updatedAt: now + 1,
    });
    await insertThread({
      id: failuresOnlyFailed,
      workspaceId,
      agentId,
      automatonId: "automaton-failures-only",
      activityStatus: "failed",
      updatedAt: now + 2,
    });
    await insertThread({
      id: failuresOnlyAttention,
      workspaceId,
      agentId,
      automatonId: "automaton-failures-only",
      activityStatus: "attention_required",
      attentionRequiredAt: now + 3,
      updatedAt: now + 3,
    });
    await insertThread({
      id: failuresOnlyFailedDismissed,
      workspaceId,
      agentId,
      automatonId: "automaton-failures-only",
      activityStatus: "failed",
      outcomeDismissedAt: now + 4,
      updatedAt: now + 4,
    });
    await insertThread({
      id: allCompleted,
      workspaceId,
      agentId,
      automatonId: "automaton-all",
      activityStatus: "idle",
      updatedAt: now + 5,
    });

    const page = await selectThreadSummariesForUser(env as unknown as Env, userId);
    const ids = new Set(page.threads.map((r) => r.threadId));
    expect(ids.has(failuresOnlyCompleted)).toBe(false);
    expect(ids.has(failuresOnlyFailed)).toBe(true);
    expect(ids.has(failuresOnlyAttention)).toBe(true);
    expect(ids.has(failuresOnlyFailedDismissed)).toBe(false);
    expect(ids.has(allCompleted)).toBe(true);
  });
});
