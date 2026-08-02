/**
 * The scheduler's dedupe lease is a partial unique index, and the whole firing
 * path depends on `isUniqueConstraintError` recognising the error Drizzle throws
 * when that constraint trips. Every unit test for that helper feeds it a
 * hand-built Error, so the real wrapper shape has never been proven. If Drizzle
 * wraps the D1 failure such that neither the message nor the `cause` chain
 * carries "UNIQUE constraint failed", the firing path misclassifies a benign
 * concurrent claim as a pre-claim failure — and the automaton wedges.
 *
 * These tests throw the genuine article at the genuine helper.
 */
import { env } from "cloudflare:test";
import { drizzle } from "drizzle-orm/d1";
import { beforeEach, describe, expect, it } from "vitest";
import { isUniqueConstraintError } from "../../src/automata/fire-due";
import { AutomatonRepository } from "../../src/db/repositories/automata";
import * as schema from "../../src/db/schema";
import { applyRegistryTestSchema } from "./helpers/registry";

const WORKSPACE_ID = "ws_lease";
const USER_ID = "usr_lease";
const AGENT_ID = "agt_lease";
const AUTOMATON_ID = "auto_lease";
const DUE_AT = 1_800_000_000_000;

function db() {
  return drizzle(env.REGISTRY_DB, { schema });
}

async function seed() {
  const now = Date.now();
  await env.REGISTRY_DB.prepare(
    "INSERT OR IGNORE INTO workspaces (id, name, created_at) VALUES (?, ?, ?)",
  )
    .bind(WORKSPACE_ID, "Lease", now)
    .run();
  await env.REGISTRY_DB.prepare(
    "INSERT OR IGNORE INTO users (id, email, email_verified, created_at, updated_at) VALUES (?, ?, ?, ?, ?)",
  )
    .bind(USER_ID, "lease@example.com", 1, now, now)
    .run();
  await env.REGISTRY_DB.prepare(
    "INSERT OR IGNORE INTO agents (id, workspace_id, name, system_prompt, provider, model, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)",
  )
    .bind(AGENT_ID, WORKSPACE_ID, "Agent", "", "anthropic", "claude-opus-4-8", now)
    .run();
  await env.REGISTRY_DB.prepare(
    "INSERT OR IGNORE INTO automata (id, workspace_id, owner_user_id, agent_id, name, prompt, schedule_json, timezone, enabled, next_due_at, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, 1, ?, ?, ?)",
  )
    .bind(
      AUTOMATON_ID,
      WORKSPACE_ID,
      USER_ID,
      AGENT_ID,
      "Daily briefing",
      "Give me my briefing.",
      '{"kind":"daily","hour":8,"minute":0}',
      "Asia/Singapore",
      DUE_AT,
      now,
      now,
    )
    .run();
}

const runRow = (id: string, dueAt: number | null, trigger: "scheduled" | "manual") => ({
  id,
  automatonId: AUTOMATON_ID,
  workspaceId: WORKSPACE_ID,
  dueAt,
  trigger,
  threadId: null,
  status: "queued" as const,
  createdAt: 1,
  updatedAt: 1,
});

describe("automaton claim lease (real D1)", () => {
  // The shared setup.ts beforeEach truncates every registry table, so the seed
  // has to be re-laid for each test rather than once up front.
  beforeEach(async () => {
    await applyRegistryTestSchema(env.REGISTRY_DB);
    await seed();
  });

  it("rejects a second claim on the same scheduled due", async () => {
    const repo = new AutomatonRepository(db());
    await repo.createRun(runRow("arun_1", DUE_AT, "scheduled"));
    await expect(repo.createRun(runRow("arun_2", DUE_AT, "scheduled"))).rejects.toThrow();
  });

  it("the error Drizzle throws is recognised by isUniqueConstraintError", async () => {
    const repo = new AutomatonRepository(db());
    await repo.createRun(runRow("arun_1", DUE_AT, "scheduled"));

    let caught: unknown;
    try {
      await repo.createRun(runRow("arun_2", DUE_AT, "scheduled"));
    } catch (error) {
      caught = error;
    }

    expect(caught).toBeDefined();
    // The assertion the whole firing path rests on.
    expect(isUniqueConstraintError(caught)).toBe(true);
  });

  it("permits the next due instant", async () => {
    const repo = new AutomatonRepository(db());
    await repo.createRun(runRow("arun_1", DUE_AT, "scheduled"));
    await expect(
      repo.createRun(runRow("arun_2", DUE_AT + 86_400_000, "scheduled")),
    ).resolves.toBeDefined();
  });

  it("permits two manual runs, which carry no due instant", async () => {
    const repo = new AutomatonRepository(db());
    await repo.createRun(runRow("arun_1", null, "manual"));
    await expect(repo.createRun(runRow("arun_2", null, "manual"))).resolves.toBeDefined();
  });

  it("does not let a manual run block a scheduled claim", async () => {
    const repo = new AutomatonRepository(db());
    await repo.createRun(runRow("arun_1", null, "manual"));
    await expect(repo.createRun(runRow("arun_2", DUE_AT, "scheduled"))).resolves.toBeDefined();
  });
});
