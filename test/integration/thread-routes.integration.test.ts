import { SELF, env, runInDurableObject } from "cloudflare:test";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { eq } from "drizzle-orm";
import { drizzle } from "drizzle-orm/d1";
import * as schema from "../../src/db/schema";
import { authorizeAgentRequest } from "../../src/agent-routing/authorize";
import { applyRegistryTestSchema } from "./helpers/registry";
import { MAX_THREAD_PAGE, routeThreads } from "../../src/http/thread-routes";
import { serializeThread } from "../../src/http/thread-serialize";
import { ArchivedMessageRepository } from "../../src/db/repositories/archived-messages";
import { ThinkThreadAgent } from "../../src/agent/think-thread-agent";
import { ThreadComputeStore } from "../../src/compute/thread-store";
import { saveDaytonaApiKey } from "../../src/compute/settings";
import type { Env } from "../../src/env";

// compactThread()/getCompactionStatus() go through getAgentByName (not a raw
// idFromName stub — see thread-routes.ts), so these route tests exercise the
// real DO lifecycle rather than a hand-rolled binding mock (a raw idFromName
// mock can't reproduce partyserver's fetch-based bootstrap protocol, and
// vi.mock("agents") does not intercept imports inside the workers pool
// runtime). Where a test needs a specific outcome (e.g. "unstable"), it spies
// on the real ThinkThreadAgent.prototype method for that one call instead of
// faking the binding. Cold-DO coverage for the bug itself lives in
// thread-message-route.integration.test.ts.

const now = 1_800_000_000_000;
const defaultThreadActivityFields = {
  kind: "regular" as const,
  activityStatus: "idle" as const,
  currentTurnStartedAt: null,
  attentionRequiredAt: null,
  unreadOutcome: null,
  unreadOutcomeAt: null,
  lastSeenAt: null,
  workbenchId: null,
  workbenchName: null,
  workbenchSwitchPending: false,
  resourceProfile: "small" as const,
  // A thread a human started carries no automaton provenance.
  automatonId: null,
  automatonName: null,
  automatonNotifyMode: null,
  outcomeDismissedAt: null,
  recentDismissedAt: null,
};

async function ensureThreadNotificationSchema() {
  const statements = [
    "CREATE TABLE IF NOT EXISTS push_subscriptions (id text PRIMARY KEY NOT NULL, user_id text NOT NULL, endpoint text NOT NULL, p256dh text NOT NULL, auth text NOT NULL, user_agent text, created_at integer NOT NULL, updated_at integer NOT NULL, last_seen_at integer NOT NULL, FOREIGN KEY (user_id) REFERENCES users(id))",
    "CREATE INDEX IF NOT EXISTS idx_push_subscriptions_user ON push_subscriptions (user_id)",
    "CREATE UNIQUE INDEX IF NOT EXISTS idx_push_subscriptions_endpoint ON push_subscriptions (endpoint)",
    "CREATE TABLE IF NOT EXISTS user_notification_settings (user_id text PRIMARY KEY NOT NULL, browser_push_enabled integer DEFAULT false NOT NULL, created_at integer NOT NULL, updated_at integer NOT NULL, FOREIGN KEY (user_id) REFERENCES users(id))",
  ];
  for (const statement of statements) {
    await env.REGISTRY_DB.prepare(statement).run();
  }

  const threadColumns = await env.REGISTRY_DB.prepare("PRAGMA table_info(thread_index)").all<{
    name: string;
  }>();
  const threadColumnNames = new Set(threadColumns.results.map((column) => column.name));
  if (!threadColumnNames.has("activity_status")) {
    await env.REGISTRY_DB.prepare(
      "ALTER TABLE thread_index ADD COLUMN activity_status text DEFAULT 'idle' NOT NULL",
    ).run();
  }
  if (!threadColumnNames.has("current_turn_started_at")) {
    await env.REGISTRY_DB.prepare(
      "ALTER TABLE thread_index ADD COLUMN current_turn_started_at integer",
    ).run();
  }
  if (!threadColumnNames.has("attention_required_at")) {
    await env.REGISTRY_DB.prepare(
      "ALTER TABLE thread_index ADD COLUMN attention_required_at integer",
    ).run();
  }
  if (!threadColumnNames.has("unread_outcome")) {
    await env.REGISTRY_DB.prepare("ALTER TABLE thread_index ADD COLUMN unread_outcome text").run();
  }
  if (!threadColumnNames.has("unread_outcome_at")) {
    await env.REGISTRY_DB.prepare(
      "ALTER TABLE thread_index ADD COLUMN unread_outcome_at integer",
    ).run();
  }
  if (!threadColumnNames.has("last_seen_at")) {
    await env.REGISTRY_DB.prepare("ALTER TABLE thread_index ADD COLUMN last_seen_at integer").run();
  }
}

async function clearRegistry() {
  const db = drizzle(env.REGISTRY_DB, { schema });
  await db.delete(schema.threadRepositorySnapshots);
  await db.delete(schema.threadWorkbenchSnapshots);
  await db.delete(schema.threadIndex);
  // Referenced by workspaces(id); the "live sandbox" workbench-switch tests
  // seed a row here and it must not survive to block the workspaces delete
  // below (FK constraint) on the next test's cleanup.
  await db.delete(schema.workspaceSandboxSettings);
  await db.delete(schema.workbenchRepositories);
  await db.delete(schema.projects);
  await db.delete(schema.workbenches);
  await db.delete(schema.agents);
  await db.delete(schema.workspaceMembers);
  await db.delete(schema.workspaces);
  await db.delete(schema.sessions);
  await db.delete(schema.users);
}

async function seedUserWorkspace(input?: {
  userId?: string;
  token?: string;
  workspaceId?: string;
  memberCreatedAt?: number;
  agentCreatedAt?: number;
  modelInputModalities?: string[];
  archivedAt?: number | null;
}) {
  const db = drizzle(env.REGISTRY_DB, { schema });
  const userId = input?.userId ?? "user-threads";
  const token = input?.token ?? "threads-token";
  const workspaceId = input?.workspaceId ?? "workspace-threads";
  const agentId = `agent-${workspaceId}`;

  await db.insert(schema.users).values({
    id: userId,
    email: `${userId}@example.com`,
    name: null,
    createdAt: new Date(now),
    emailVerified: true,
    image: null,
    updatedAt: new Date(now),
  });
  await db.insert(schema.sessions).values({
    id: `session-${userId}`,
    userId,
    token,
    expiresAt: new Date(now + 60_000),
    createdAt: new Date(now),
    updatedAt: new Date(now),
    ipAddress: null,
    userAgent: null,
  });
  await db.insert(schema.workspaces).values({
    id: workspaceId,
    name: workspaceId,
    createdAt: now,
  });
  await db.insert(schema.workspaceMembers).values({
    workspaceId,
    userId,
    role: "owner",
    createdAt: input?.memberCreatedAt ?? now,
  });
  await db.insert(schema.agents).values({
    id: agentId,
    workspaceId,
    name: "Default",
    systemPrompt: "You are Nadi.",
    provider: "mock",
    model: "mock",
    modelInputModalities: JSON.stringify(input?.modelInputModalities ?? ["text"]),
    createdAt: input?.agentCreatedAt ?? now,
  });

  return { userId, token, workspaceId, agentId };
}

async function insertThread(input: {
  id: string;
  workspaceId: string;
  agentId: string;
  title: string;
  updatedAt: number;
  createdAt?: number;
  lastMessagePreview?: string;
  runtime?: "legacy" | "think";
  modelProvider?: string;
  model?: string;
  modelInputModalities?: string[];
  reasoningEffort?: string;
  archivedAt?: number | null;
  projectId?: string | null;
  workbenchId?: string | null;
}) {
  const db = drizzle(env.REGISTRY_DB, { schema });
  await db.insert(schema.threadIndex).values({
    id: input.id,
    workspaceId: input.workspaceId,
    agentId: input.agentId,
    projectId: input.projectId ?? null,
    workbenchId: input.workbenchId ?? null,
    modelProvider: input.modelProvider ?? "mock",
    model: input.model ?? "mock",
    modelInputModalities: JSON.stringify(input.modelInputModalities ?? ["text"]),
    reasoningEffort: input.reasoningEffort ?? null,
    title: input.title,
    runtime: input.runtime ?? "legacy",
    source: "manual",
    automatonId: null,
    automatonRunId: null,
    lastEventId: null,
    lastMessagePreview: input.lastMessagePreview ?? "",
    archivedAt: input.archivedAt ?? null,
    createdAt: input.createdAt ?? input.updatedAt,
    updatedAt: input.updatedAt,
  });
}

async function insertEnvironment(input: {
  id: string;
  workspaceId: string;
  name: string;
  setupScript?: string;
  createdAt: number;
  archivedAt?: number | null;
}) {
  const db = drizzle(env.REGISTRY_DB, { schema });
  await db.insert(schema.workbenches).values({
    id: input.id,
    workspaceId: input.workspaceId,
    name: input.name,
    description: "",
    setupScript: input.setupScript ?? "",
    sandboxEnvVarsJson: "{}",
    createdAt: input.createdAt,
    updatedAt: input.createdAt,
    archivedAt: input.archivedAt ?? null,
  });
}

async function assignRepositoryToEnvironment(input: {
  workbenchId: string;
  repositoryId: string;
  createdAt: number;
}) {
  const db = drizzle(env.REGISTRY_DB, { schema });
  await db.insert(schema.workbenchRepositories).values({
    id: input.repositoryId,
    workbenchId: input.workbenchId,
    source: "url",
    name: input.repositoryId,
    url: `https://github.com/acme/${input.repositoryId}.git`,
    defaultBranch: "main",
    checkoutPathName: input.repositoryId,
    rootDirectory: "",
    setupCommand: "",
    packageManager: "",
    createdAt: input.createdAt,
  });
}

async function insertProject(input: {
  id: string;
  workspaceId: string;
  name: string;
  defaultWorkbenchId?: string | null;
  createdAt: number;
  archivedAt?: number | null;
}) {
  const db = drizzle(env.REGISTRY_DB, { schema });
  await db
    .insert(schema.workspaces)
    .values({
      id: input.workspaceId,
      name: input.workspaceId,
      createdAt: input.createdAt,
    })
    .onConflictDoNothing();
  await db.insert(schema.projects).values({
    id: input.id,
    workspaceId: input.workspaceId,
    name: input.name,
    description: "",
    customInstructions: "",
    defaultWorkbenchId: input.defaultWorkbenchId ?? null,
    archivedAt: input.archivedAt ?? null,
    createdAt: input.createdAt,
    updatedAt: input.createdAt,
  });
}

// The workspace-level repository catalog was removed; workbench repositories are
// now self-contained and seeded directly via assignRepositoryToEnvironment.
async function insertRepository(_input: { id: string; workspaceId: string; createdAt: number }) {}

async function insertThreadSnapshot(input: {
  threadId: string;
  workspaceId: string;
  projectId: string;
  repositoryId: string;
  createdAt: number;
}) {
  const db = drizzle(env.REGISTRY_DB, { schema });
  await db.insert(schema.threadRepositorySnapshots).values({
    id: `${input.threadId}:${input.repositoryId}`,
    threadId: input.threadId,
    workspaceId: input.workspaceId,
    projectId: input.projectId,
    workbenchId: null,
    name: input.repositoryId,
    url: `https://github.com/acme/${input.repositoryId}.git`,
    defaultBranch: "main",
    checkoutPathName: input.repositoryId,
    rootDirectory: "",
    setupCommand: "",
    packageManager: "",
    createdAt: input.createdAt,
  });
}

async function listThreadSnapshots(threadId: string) {
  const db = drizzle(env.REGISTRY_DB, { schema });
  return db
    .select()
    .from(schema.threadRepositorySnapshots)
    .where(eq(schema.threadRepositorySnapshots.threadId, threadId));
}

async function patchThread(threadId: string, patch: Record<string, unknown>, token: string) {
  return SELF.fetch(`https://nadi.test/api/threads/${threadId}`, {
    method: "PATCH",
    headers: {
      cookie: `better-auth.session_token=${token}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify(patch),
  });
}

async function readThread(threadId: string) {
  const db = drizzle(env.REGISTRY_DB, { schema });
  return db.select().from(schema.threadIndex).where(eq(schema.threadIndex.id, threadId)).get();
}

async function readWorkbenchSnapshot(threadId: string) {
  const db = drizzle(env.REGISTRY_DB, { schema });
  return db
    .select()
    .from(schema.threadWorkbenchSnapshots)
    .where(eq(schema.threadWorkbenchSnapshots.threadId, threadId))
    .get();
}

/**
 * Marks the thread's `ThinkThreadAgent` DO as having a genuinely live
 * sandbox, the same way a real `acquire()` would: a daytona-enabled
 * workspace (so `resolveComputeService` doesn't bail out early on
 * `missing_workspace_settings`) plus an `active` compute state written
 * through the real durable store. `DaytonaComputeBackend`'s constructor only
 * stores config (no network call), so this reaches `isComputeLive()` without
 * a fake/overridden backend.
 */
async function makeComputeLive(threadId: string, workspaceId: string): Promise<void> {
  const providerConfigJson = JSON.stringify({
    kind: "daytona",
    apiKeySecretName: "sandbox:daytona",
    apiUrl: null,
    target: null,
    profiles: {
      small: { kind: "image", value: "node:22" },
      medium: { kind: "image", value: "node:22" },
    },
  });
  await env.REGISTRY_DB.prepare(
    "INSERT OR IGNORE INTO workspace_sandbox_settings (workspace_id, enabled, provider, provider_config_json, image, idle_timeout_ms, max_process_runtime_ms, limits_json) VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
  )
    .bind(workspaceId, 1, "daytona", providerConfigJson, "node:22", 900_000, 600_000, "{}")
    .run();
  await saveDaytonaApiKey({
    env: env as unknown as Env,
    workspaceId,
    secretName: "sandbox:daytona",
    value: "dt_test_secret",
  });

  const stub = env.THINK_THREAD_AGENT.get(env.THINK_THREAD_AGENT.idFromName(threadId));
  await runInDurableObject(stub, async (_instance: ThinkThreadAgent, state) => {
    const store = new ThreadComputeStore(state.storage);
    store.migrate();
    store.markActive({ provider: "daytona", version: 1, payload: { sandboxId: "sbx-live" } }, now);
  });
}

/**
 * Same seeding as {@link makeComputeLive}, but leaves the compute state in
 * `acquiring` — a sandbox mid-provision, which on Daytona lasts seconds to a
 * minute. Written through the real store via the same `markAcquiring` call the
 * production acquire path makes.
 */
async function makeComputeAcquiring(threadId: string, workspaceId: string): Promise<void> {
  await makeComputeLive(threadId, workspaceId);
  const stub = env.THINK_THREAD_AGENT.get(env.THINK_THREAD_AGENT.idFromName(threadId));
  await runInDurableObject(stub, async (_instance: ThinkThreadAgent, state) => {
    const store = new ThreadComputeStore(state.storage);
    store.migrate();
    store.markAcquiring({ provider: "daytona", resourceProfile: "small", now });
  });
}

const FAKE_HISTORY = [{ id: "fake1", role: "user", parts: [{ type: "text", text: "hi" }] }];

function makeDeleteRouteEnv(input: {
  thinkActive: boolean;
  calls: string[];
  /** Archiving aborts on an empty snapshot, so the default stub has history. */
  history?: unknown[];
}): Env {
  const fakeBinding = (label: "think", active: boolean) => ({
    idFromName(name: string) {
      input.calls.push(`${label}:idFromName:${name}`);
      return name;
    },
    get(name: string) {
      input.calls.push(`${label}:get:${name}`);
      return {
        // getAgentByName calls setName() on the stub before returning it — that
        // handshake is what runs onStart() and hydrates the transcript.
        async setName(name: string) {
          input.calls.push(`${label}:setName:${name}`);
        },
        async hasActiveTurn() {
          input.calls.push(`${label}:hasActiveTurn`);
          return active;
        },
        async exportHistory() {
          input.calls.push(`${label}:exportHistory`);
          return input.history ?? FAKE_HISTORY;
        },
        // Archiving reads the RAW transcript, not the compacted view — the archive
        // is the record, and archiving destroys the DO.
        async exportRawHistory() {
          input.calls.push(`${label}:exportRawHistory`);
          return input.history ?? FAKE_HISTORY;
        },
        async exportCompactions() {
          input.calls.push(`${label}:exportCompactions`);
          return [];
        },
        async destroy() {
          input.calls.push(`${label}:destroy`);
          throw new Error(`${label}:destroy-abort`);
        },
      };
    },
  });

  // Spread into a fresh plain object rather than `Object.create(env)`: the
  // workerd `env` is a host object whose property writes ignore the receiver,
  // so assigning a binding onto an `Object.create(env)` child writes THROUGH to
  // the shared global `env`, permanently replacing the real DO binding with this
  // mock for every later test in the `isolate:false` pool.
  return {
    ...env,
    THINK_THREAD_AGENT: fakeBinding("think", input.thinkActive),
  } as unknown as Env;
}

/**
 * A THINK_THREAD_AGENT stub that reports the sandbox as live (so the PATCH
 * workbench arm takes the deferred `beginWorkbenchSwitch` path) and then
 * throws from `requestWorkbenchSwitch` — simulating the reminder injection
 * failing after the pending marker has already landed.
 */
function makeWorkbenchSwitchInjectionFailureEnv(calls: string[]): Env {
  const binding = {
    idFromName(name: string) {
      calls.push(`think:idFromName:${name}`);
      return name;
    },
    get(name: string) {
      calls.push(`think:get:${name}`);
      return {
        async setName(setName: string) {
          calls.push(`think:setName:${setName}`);
        },
        async isComputeLive() {
          calls.push("think:isComputeLive");
          return true;
        },
        async requestWorkbenchSwitch() {
          calls.push("think:requestWorkbenchSwitch");
          throw new Error("injection-failed");
        },
      };
    },
  };
  return {
    ...env,
    THINK_THREAD_AGENT: binding,
  } as unknown as Env;
}

function makeMessagesRouteEnv(input: {
  runtime: "legacy" | "think";
  history: unknown[];
  calls: string[];
  throwOnExport?: boolean;
}): Env {
  const label = input.runtime === "think" ? "think" : "legacy";
  const binding = {
    idFromName(name: string) {
      input.calls.push(`${label}:idFromName:${name}`);
      return name;
    },
    get(name: string) {
      input.calls.push(`${label}:get:${name}`);
      return {
        async setName(name: string) {
          input.calls.push(`${label}:setName:${name}`);
        },
        async exportHistory() {
          input.calls.push(`${label}:exportHistory`);
          if (input.throwOnExport) throw new Error(`${label}:exportHistory-should-not-be-called`);
          return input.history;
        },
      };
    },
  };
  // See makeDeleteRouteEnv: spread into a fresh object so the mock binding stays
  // local and never writes through to the shared global `env`.
  return {
    ...env,
    ...(input.runtime === "think" ? { THINK_THREAD_AGENT: binding } : { THREAD_AGENT: binding }),
  } as unknown as Env;
}

function makeExecutionContext(): ExecutionContext {
  return {
    waitUntil(_promise: Promise<unknown>) {},
    passThroughOnException() {},
  } as ExecutionContext;
}

describe("thread routes", () => {
  beforeAll(async () => {
    await applyRegistryTestSchema(env.REGISTRY_DB);
    await ensureThreadNotificationSchema();
  });

  beforeEach(async () => {
    await clearRegistry();
  });

  afterEach(async () => {
    await clearRegistry();
    vi.restoreAllMocks();
  });

  it("serializes project fields and repository snapshot counts", () => {
    const baseThread = {
      id: "thr-serialize",
      workspaceId: "workspace-serialize",
      agentId: "agent-serialize",
      modelProvider: "mock",
      model: "mock",
      modelInputModalities: JSON.stringify(["text"]),
      runtime: "legacy" as const,
      title: "Serialize",
      source: "manual" as const,
      lastMessagePreview: "",
      createdAt: now,
      updatedAt: now,
    };

    expect(serializeThread({ ...baseThread, projectId: null })).toMatchObject({
      projectId: null,
      projectName: null,
      repositorySnapshotCount: 0,
    });
    expect(
      serializeThread({
        ...baseThread,
        projectId: "project-1",
        projectName: "Nadi",
        repositorySnapshotCount: 2,
      }),
    ).toMatchObject({
      projectId: "project-1",
      projectName: "Nadi",
      repositorySnapshotCount: 2,
    });
    expect(
      serializeThread({
        ...baseThread,
        activityStatus: "attention_required",
        currentTurnStartedAt: 1_800_000_000_100,
        attentionRequiredAt: 1_800_000_000_200,
        unreadOutcome: "failed",
        unreadOutcomeAt: 1_800_000_000_300,
        lastSeenAt: 1_800_000_000_000,
      }),
    ).toMatchObject({
      activityStatus: "attention_required",
      currentTurnStartedAt: 1_800_000_000_100,
      attentionRequiredAt: 1_800_000_000_200,
      unreadOutcome: "failed",
      unreadOutcomeAt: 1_800_000_000_300,
      lastSeenAt: 1_800_000_000_000,
    });
  });

  it("lists only threads visible to the authenticated user ordered by newest update", async () => {
    const seeded = await seedUserWorkspace();
    const other = await seedUserWorkspace({
      userId: "other-user",
      token: "other-token",
      workspaceId: "workspace-other",
    });
    await insertThread({
      id: "thr_old",
      workspaceId: seeded.workspaceId,
      agentId: seeded.agentId,
      title: "Old",
      updatedAt: now + 1,
      lastMessagePreview: "older preview",
    });
    await insertThread({
      id: "thr_new",
      workspaceId: seeded.workspaceId,
      agentId: seeded.agentId,
      title: "New",
      updatedAt: now + 2,
      lastMessagePreview: "newer preview",
    });
    await insertThread({
      id: "thr_other",
      workspaceId: other.workspaceId,
      agentId: other.agentId,
      title: "Other",
      updatedAt: now + 3,
    });

    const res = await SELF.fetch("https://nadi.test/api/threads", {
      headers: {
        cookie: `better-auth.session_token=${seeded.token}`,
      },
    });

    expect(res.status).toBe(200);
    await expect(res.json()).resolves.toEqual({
      nextCursor: null,
      threads: [
        {
          threadId: "thr_new",
          workspaceId: seeded.workspaceId,
          agentId: seeded.agentId,
          provider: "mock",
          model: "mock",
          modelInputModalities: ["text"],
          reasoningEffort: "medium",
          modelSupportsReasoning: null,
          runtime: "legacy",
          ...defaultThreadActivityFields,
          title: "New",
          source: "manual",
          lastMessagePreview: "newer preview",
          archivedAt: null,
          readOnly: true,
          status: "active",
          projectId: null,
          projectName: null,
          repositorySnapshotCount: 0,
          lastContextTokens: null,
          lastContextWindow: null,
          lastCompactAfterTokens: null,
          createdAt: now + 2,
          updatedAt: now + 2,
        },
        {
          threadId: "thr_old",
          workspaceId: seeded.workspaceId,
          agentId: seeded.agentId,
          provider: "mock",
          model: "mock",
          modelInputModalities: ["text"],
          reasoningEffort: "medium",
          modelSupportsReasoning: null,
          runtime: "legacy",
          ...defaultThreadActivityFields,
          title: "Old",
          source: "manual",
          lastMessagePreview: "older preview",
          archivedAt: null,
          readOnly: true,
          status: "active",
          projectId: null,
          projectName: null,
          repositorySnapshotCount: 0,
          lastContextTokens: null,
          lastContextWindow: null,
          lastCompactAfterTokens: null,
          createdAt: now + 1,
          updatedAt: now + 1,
        },
      ],
    });
  });

  it("keeps GET /api/threads unchanged without project filters", async () => {
    const seeded = await seedUserWorkspace({
      userId: "user-thread-list-default",
      token: "thread-list-default-token",
      workspaceId: "workspace-thread-list-default",
    });
    await insertProject({
      id: "project-default",
      workspaceId: seeded.workspaceId,
      name: "Default project",
      createdAt: now,
    });
    await insertThread({
      id: "thr_projected_default",
      workspaceId: seeded.workspaceId,
      agentId: seeded.agentId,
      title: "Projected",
      projectId: "project-default",
      updatedAt: now + 1,
    });
    await insertThread({
      id: "thr_unassigned_default",
      workspaceId: seeded.workspaceId,
      agentId: seeded.agentId,
      title: "Unassigned",
      updatedAt: now + 2,
    });

    const res = await SELF.fetch("https://nadi.test/api/threads", {
      headers: { cookie: `better-auth.session_token=${seeded.token}` },
    });

    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      threads: Array<{
        threadId: string;
        projectId: string | null;
        repositorySnapshotCount: number;
      }>;
    };
    expect(body.threads.map((thread) => thread.threadId)).toEqual([
      "thr_unassigned_default",
      "thr_projected_default",
    ]);
  });

  it("filters GET /api/threads by projectId", async () => {
    const seeded = await seedUserWorkspace({
      userId: "user-thread-list-project",
      token: "thread-list-project-token",
      workspaceId: "workspace-thread-list-project",
    });
    await insertProject({
      id: "project-a",
      workspaceId: seeded.workspaceId,
      name: "Project A",
      createdAt: now,
    });
    await insertProject({
      id: "project-b",
      workspaceId: seeded.workspaceId,
      name: "Project B",
      createdAt: now + 1,
    });
    await insertThread({
      id: "thr_project_a",
      workspaceId: seeded.workspaceId,
      agentId: seeded.agentId,
      title: "Project A",
      projectId: "project-a",
      updatedAt: now + 1,
    });
    await insertThread({
      id: "thr_project_b",
      workspaceId: seeded.workspaceId,
      agentId: seeded.agentId,
      title: "Project B",
      projectId: "project-b",
      updatedAt: now + 2,
    });

    const res = await SELF.fetch("https://nadi.test/api/threads?projectId=project-a", {
      headers: { cookie: `better-auth.session_token=${seeded.token}` },
    });

    expect(res.status).toBe(200);
    await expect(res.json()).resolves.toMatchObject({
      threads: [
        {
          threadId: "thr_project_a",
          projectId: "project-a",
          projectName: "Project A",
          repositorySnapshotCount: 0,
        },
      ],
    });
  });

  it("treats GET /api/threads?projectId=null as the unassigned filter", async () => {
    const seeded = await seedUserWorkspace({
      userId: "user-thread-list-project-null",
      token: "thread-list-project-null-token",
      workspaceId: "workspace-thread-list-project-null",
    });
    await insertProject({
      id: "project-assigned",
      workspaceId: seeded.workspaceId,
      name: "Assigned",
      createdAt: now,
    });
    await insertThread({
      id: "thr_project_assigned",
      workspaceId: seeded.workspaceId,
      agentId: seeded.agentId,
      title: "Assigned",
      projectId: "project-assigned",
      updatedAt: now + 1,
    });
    await insertThread({
      id: "thr_project_unassigned",
      workspaceId: seeded.workspaceId,
      agentId: seeded.agentId,
      title: "Unassigned",
      updatedAt: now + 2,
    });

    const res = await SELF.fetch("https://nadi.test/api/threads?projectId=null", {
      headers: { cookie: `better-auth.session_token=${seeded.token}` },
    });

    expect(res.status).toBe(200);
    await expect(res.json()).resolves.toMatchObject({
      threads: [
        {
          threadId: "thr_project_unassigned",
          projectId: null,
          projectName: null,
          repositorySnapshotCount: 0,
        },
      ],
    });
  });

  it("filters GET /api/threads?project=unassigned", async () => {
    const seeded = await seedUserWorkspace({
      userId: "user-thread-list-project-unassigned",
      token: "thread-list-project-unassigned-token",
      workspaceId: "workspace-thread-list-project-unassigned",
    });
    await insertProject({
      id: "project-unassigned-filter",
      workspaceId: seeded.workspaceId,
      name: "Assigned",
      createdAt: now,
    });
    await insertThread({
      id: "thr_filter_assigned",
      workspaceId: seeded.workspaceId,
      agentId: seeded.agentId,
      title: "Assigned",
      projectId: "project-unassigned-filter",
      updatedAt: now + 1,
    });
    await insertThread({
      id: "thr_filter_unassigned",
      workspaceId: seeded.workspaceId,
      agentId: seeded.agentId,
      title: "Unassigned",
      updatedAt: now + 2,
    });

    const res = await SELF.fetch("https://nadi.test/api/threads?project=unassigned", {
      headers: { cookie: `better-auth.session_token=${seeded.token}` },
    });

    expect(res.status).toBe(200);
    await expect(res.json()).resolves.toMatchObject({
      threads: [{ threadId: "thr_filter_unassigned", projectId: null }],
    });
  });

  it("returns 401 when listing threads without a valid session", async () => {
    const res = await SELF.fetch("https://nadi.test/api/threads");

    expect(res.status).toBe(401);
  });

  it("opens a registered thread for a workspace member", async () => {
    const seeded = await seedUserWorkspace();
    await insertThread({
      id: "default",
      workspaceId: seeded.workspaceId,
      agentId: seeded.agentId,
      title: "Default",
      updatedAt: now + 1,
    });

    const res = await SELF.fetch("https://nadi.test/api/threads/default", {
      headers: {
        cookie: `better-auth.session_token=${seeded.token}`,
      },
    });

    expect(res.status).toBe(200);
    await expect(res.json()).resolves.toMatchObject({
      thread: {
        threadId: "default",
        workspaceId: seeded.workspaceId,
        agentId: seeded.agentId,
        title: "Default",
      },
    });
  });

  it("returns 404 when opening missing or non-member threads", async () => {
    const seeded = await seedUserWorkspace();
    const other = await seedUserWorkspace({
      userId: "other-user",
      token: "other-token",
      workspaceId: "workspace-other",
    });
    await insertThread({
      id: "thr_other",
      workspaceId: other.workspaceId,
      agentId: other.agentId,
      title: "Other",
      updatedAt: now + 1,
    });

    const missing = await SELF.fetch("https://nadi.test/api/threads/thr_missing", {
      headers: {
        cookie: `better-auth.session_token=${seeded.token}`,
      },
    });
    const nonMember = await SELF.fetch("https://nadi.test/api/threads/thr_other", {
      headers: {
        cookie: `better-auth.session_token=${seeded.token}`,
      },
    });

    expect(missing.status).toBe(404);
    expect(nonMember.status).toBe(404);
  });

  it("creates a server-generated thread for the authenticated user's first workspace agent", async () => {
    const seeded = await seedUserWorkspace();

    const res = await SELF.fetch("https://nadi.test/api/threads", {
      method: "POST",
      headers: {
        cookie: `better-auth.session_token=${seeded.token}`,
      },
    });

    expect(res.status).toBe(201);
    const body = (await res.json()) as {
      thread: {
        threadId: string;
        workspaceId: string;
        agentId: string;
        title: string;
        source: string;
        lastMessagePreview: string;
        createdAt: number;
        updatedAt: number;
      };
    };
    expect(body.thread).toMatchObject({
      workspaceId: seeded.workspaceId,
      agentId: seeded.agentId,
      title: "New thread",
      source: "manual",
      lastMessagePreview: "",
    });
    expect(body.thread.threadId).toMatch(/^thr_[0-9a-f-]{36}$/);
    expect(body.thread.createdAt).toBeGreaterThan(0);
    expect(body.thread.updatedAt).toBe(body.thread.createdAt);

    const db = drizzle(env.REGISTRY_DB, { schema });
    const row = await db
      .select()
      .from(schema.threadIndex)
      .where(eq(schema.threadIndex.id, body.thread.threadId))
      .get();
    expect(row).toMatchObject({
      id: body.thread.threadId,
      workspaceId: seeded.workspaceId,
      agentId: seeded.agentId,
      title: "New thread",
      source: "manual",
      lastMessagePreview: "",
    });

    await expect(
      authorizeAgentRequest(
        new Request(`https://nadi.test/think-agents/think-thread-agent/${body.thread.threadId}`, {
          headers: { cookie: `better-auth.session_token=${seeded.token}` },
        }),
        env,
      ),
    ).resolves.toMatchObject({
      authorized: true,
      threadId: body.thread.threadId,
      workspaceId: seeded.workspaceId,
      userId: seeded.userId,
    });
  });

  it("ignores a showReasoning member in the create body and never serializes one", async () => {
    // Showing reasoning is a per-user preference now, not thread state. A stale
    // client may still post the field; it must not be stored or echoed back.
    const seeded = await seedUserWorkspace({
      userId: "user-thread-create-show-reasoning",
      token: "thread-create-show-reasoning-token",
      workspaceId: "workspace-thread-create-show-reasoning",
    });

    const res = await SELF.fetch("https://nadi.test/api/threads", {
      method: "POST",
      headers: {
        cookie: `better-auth.session_token=${seeded.token}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ showReasoning: false }),
    });

    expect(res.status).toBe(201);
    const created = (await res.json()) as { thread: Record<string, unknown> };
    expect(created.thread).not.toHaveProperty("showReasoning");

    const threadId = created.thread.threadId as string;
    const fetched = await SELF.fetch(`https://nadi.test/api/threads/${threadId}`, {
      headers: { cookie: `better-auth.session_token=${seeded.token}` },
    });
    expect(fetched.status).toBe(200);
    const body = (await fetched.json()) as { thread: Record<string, unknown> };
    expect(body.thread).not.toHaveProperty("showReasoning");
  });

  it("creates a thread with the default agent model snapshot", async () => {
    const seeded = await seedUserWorkspace({
      userId: "user-default-snapshot",
      token: "default-snapshot-token",
      modelInputModalities: ["text", "image"],
    });

    const res = await routeThreads(
      new Request("https://nadi.test/api/threads", {
        method: "POST",
        headers: { cookie: `better-auth.session_token=${seeded.token}` },
      }),
      env,
      makeExecutionContext(),
    );

    expect(res?.status).toBe(201);
    const body = (await res?.json()) as {
      thread: {
        threadId: string;
        provider: string;
        model: string;
        modelInputModalities: string[];
      };
    };
    expect(body.thread).toMatchObject({
      provider: "mock",
      model: "mock",
      modelInputModalities: ["text", "image"],
    });

    const db = drizzle(env.REGISTRY_DB, { schema });
    const row = await db
      .select()
      .from(schema.threadIndex)
      .where(eq(schema.threadIndex.id, body.thread.threadId))
      .get();
    expect(row).toMatchObject({
      modelProvider: "mock",
      model: "mock",
      modelInputModalities: '["text","image"]',
    });
  });

  it("creates a thread with a valid project and snapshots the project's default environment repositories", async () => {
    const seeded = await seedUserWorkspace({
      userId: "user-thread-create-project",
      token: "thread-create-project-token",
      workspaceId: "workspace-thread-create-project",
    });
    await insertEnvironment({
      id: "env-create",
      workspaceId: seeded.workspaceId,
      name: "Create Env",
      createdAt: now,
    });
    await insertProject({
      id: "project-create",
      workspaceId: seeded.workspaceId,
      name: "Create Project",
      defaultWorkbenchId: "env-create",
      createdAt: now,
    });
    await insertRepository({
      id: "repo-create-1",
      workspaceId: seeded.workspaceId,
      createdAt: now,
    });
    await insertRepository({
      id: "repo-create-2",
      workspaceId: seeded.workspaceId,
      createdAt: now + 1,
    });
    await assignRepositoryToEnvironment({
      workbenchId: "env-create",
      repositoryId: "repo-create-1",
      createdAt: now,
    });
    await assignRepositoryToEnvironment({
      workbenchId: "env-create",
      repositoryId: "repo-create-2",
      createdAt: now + 1,
    });

    const res = await SELF.fetch("https://nadi.test/api/threads", {
      method: "POST",
      headers: {
        cookie: `better-auth.session_token=${seeded.token}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ projectId: "project-create" }),
    });

    expect(res.status).toBe(201);
    const body = (await res.json()) as {
      thread: {
        threadId: string;
        projectId: string | null;
        projectName: string | null;
        repositorySnapshotCount: number;
      };
    };
    expect(body.thread).toMatchObject({
      projectId: "project-create",
      projectName: "Create Project",
      repositorySnapshotCount: 2,
    });

    const db = drizzle(env.REGISTRY_DB, { schema });
    const row = await db
      .select()
      .from(schema.threadIndex)
      .where(eq(schema.threadIndex.id, body.thread.threadId))
      .get();
    expect(row?.projectId).toBe("project-create");
    expect(row?.workbenchId).toBe("env-create");
    await expect(listThreadSnapshots(body.thread.threadId)).resolves.toHaveLength(2);
  });

  it("an explicit workbenchId overrides the project's defaultWorkbenchId", async () => {
    const seeded = await seedUserWorkspace({
      userId: "user-thread-create-env-explicit",
      token: "thread-create-env-explicit-token",
      workspaceId: "workspace-thread-create-env-explicit",
    });
    await insertEnvironment({
      id: "env-explicit-a",
      workspaceId: seeded.workspaceId,
      name: "Env A (project default)",
      createdAt: now,
    });
    await insertEnvironment({
      id: "env-explicit-b",
      workspaceId: seeded.workspaceId,
      name: "Env B (explicit)",
      createdAt: now,
    });
    await insertProject({
      id: "project-env-explicit",
      workspaceId: seeded.workspaceId,
      name: "Explicit Env Project",
      defaultWorkbenchId: "env-explicit-a",
      createdAt: now,
    });

    const res = await SELF.fetch("https://nadi.test/api/threads", {
      method: "POST",
      headers: {
        cookie: `better-auth.session_token=${seeded.token}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ projectId: "project-env-explicit", workbenchId: "env-explicit-b" }),
    });

    expect(res.status).toBe(201);
    const body = (await res.json()) as { thread: { threadId: string } };

    const db = drizzle(env.REGISTRY_DB, { schema });
    const row = await db
      .select()
      .from(schema.threadIndex)
      .where(eq(schema.threadIndex.id, body.thread.threadId))
      .get();
    expect(row?.workbenchId).toBe("env-explicit-b");
  });

  it("seeds the project's defaultWorkbenchId when workbenchId is omitted", async () => {
    const seeded = await seedUserWorkspace({
      userId: "user-thread-create-env-default",
      token: "thread-create-env-default-token",
      workspaceId: "workspace-thread-create-env-default",
    });
    await insertEnvironment({
      id: "env-default-a",
      workspaceId: seeded.workspaceId,
      name: "Env A (project default)",
      createdAt: now,
    });
    await insertProject({
      id: "project-env-default",
      workspaceId: seeded.workspaceId,
      name: "Default Env Project",
      defaultWorkbenchId: "env-default-a",
      createdAt: now,
    });

    const res = await SELF.fetch("https://nadi.test/api/threads", {
      method: "POST",
      headers: {
        cookie: `better-auth.session_token=${seeded.token}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ projectId: "project-env-default" }),
    });

    expect(res.status).toBe(201);
    const body = (await res.json()) as { thread: { threadId: string } };

    const db = drizzle(env.REGISTRY_DB, { schema });
    const row = await db
      .select()
      .from(schema.threadIndex)
      .where(eq(schema.threadIndex.id, body.thread.threadId))
      .get();
    expect(row?.workbenchId).toBe("env-default-a");
  });

  it("leaves workbenchId null when neither an explicit id nor a project default is given", async () => {
    const seeded = await seedUserWorkspace({
      userId: "user-thread-create-env-none",
      token: "thread-create-env-none-token",
      workspaceId: "workspace-thread-create-env-none",
    });

    const res = await SELF.fetch("https://nadi.test/api/threads", {
      method: "POST",
      headers: {
        cookie: `better-auth.session_token=${seeded.token}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({}),
    });

    expect(res.status).toBe(201);
    const body = (await res.json()) as { thread: { threadId: string } };

    const db = drizzle(env.REGISTRY_DB, { schema });
    const row = await db
      .select()
      .from(schema.threadIndex)
      .where(eq(schema.threadIndex.id, body.thread.threadId))
      .get();
    expect(row?.workbenchId).toBeNull();
  });

  it("falls back to null (not the archived env) when the project's defaultWorkbenchId is archived", async () => {
    const seeded = await seedUserWorkspace({
      userId: "user-thread-create-env-default-archived",
      token: "thread-create-env-default-archived-token",
      workspaceId: "workspace-thread-create-env-default-archived",
    });
    await insertEnvironment({
      id: "env-default-archived",
      workspaceId: seeded.workspaceId,
      name: "Env A (archived project default)",
      createdAt: now,
      archivedAt: now + 1,
    });
    await insertProject({
      id: "project-env-default-archived",
      workspaceId: seeded.workspaceId,
      name: "Default Archived Env Project",
      defaultWorkbenchId: "env-default-archived",
      createdAt: now,
    });

    const res = await SELF.fetch("https://nadi.test/api/threads", {
      method: "POST",
      headers: {
        cookie: `better-auth.session_token=${seeded.token}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ projectId: "project-env-default-archived" }),
    });

    expect(res.status).toBe(201);
    const body = (await res.json()) as { thread: { threadId: string } };

    const db = drizzle(env.REGISTRY_DB, { schema });
    const row = await db
      .select()
      .from(schema.threadIndex)
      .where(eq(schema.threadIndex.id, body.thread.threadId))
      .get();
    expect(row?.workbenchId).toBeNull();

    const snapshot = await db
      .select()
      .from(schema.threadRepositorySnapshots)
      .where(eq(schema.threadRepositorySnapshots.threadId, body.thread.threadId))
      .get();
    expect(snapshot).toBeUndefined();
  });

  it("returns 404 when creating a thread against an archived or cross-workspace project", async () => {
    const seeded = await seedUserWorkspace({
      userId: "user-thread-create-project-errors",
      token: "thread-create-project-errors-token",
      workspaceId: "workspace-thread-create-project-errors",
    });
    await insertProject({
      id: "project-archived",
      workspaceId: seeded.workspaceId,
      name: "Archived Project",
      createdAt: now,
      archivedAt: now + 1,
    });
    await insertProject({
      id: "project-other-workspace",
      workspaceId: "workspace-other-thread-create-project-errors",
      name: "Other Workspace Project",
      createdAt: now,
    });

    const archived = await SELF.fetch("https://nadi.test/api/threads", {
      method: "POST",
      headers: {
        cookie: `better-auth.session_token=${seeded.token}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ projectId: "project-archived" }),
    });
    const crossWorkspace = await SELF.fetch("https://nadi.test/api/threads", {
      method: "POST",
      headers: {
        cookie: `better-auth.session_token=${seeded.token}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ projectId: "project-other-workspace" }),
    });

    expect(archived.status).toBe(404);
    expect(crossWorkspace.status).toBe(404);
  });

  it("creates a thread with an explicit usable provider model snapshot", async () => {
    const seeded = await seedUserWorkspace({
      userId: "user-override-snapshot",
      token: "override-snapshot-token",
    });

    const res = await routeThreads(
      new Request("https://nadi.test/api/threads", {
        method: "POST",
        headers: {
          cookie: `better-auth.session_token=${seeded.token}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          provider: "mock-tool-call",
          model: "mock-tool-call",
          modelInputModalities: ["text", "image"],
        }),
      }),
      env,
      makeExecutionContext(),
    );

    expect(res?.status).toBe(201);
    const body = (await res?.json()) as {
      thread: {
        threadId: string;
        provider: string;
        model: string;
        modelInputModalities: string[];
      };
    };
    expect(body.thread).toMatchObject({
      provider: "mock-tool-call",
      model: "mock-tool-call",
      modelInputModalities: ["text", "image"],
    });

    const db = drizzle(env.REGISTRY_DB, { schema });
    const row = await db
      .select()
      .from(schema.threadIndex)
      .where(eq(schema.threadIndex.id, body.thread.threadId))
      .get();
    expect(row).toMatchObject({
      modelProvider: "mock-tool-call",
      model: "mock-tool-call",
      modelInputModalities: '["text","image"]',
    });
  });

  it("rejects an unusable provider override", async () => {
    const seeded = await seedUserWorkspace({
      userId: "user-unusable-snapshot",
      token: "unusable-snapshot-token",
    });

    const res = await routeThreads(
      new Request("https://nadi.test/api/threads", {
        method: "POST",
        headers: {
          cookie: `better-auth.session_token=${seeded.token}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          provider: "openai",
          model: "gpt-5.5",
          modelInputModalities: ["text"],
        }),
      }),
      env,
      makeExecutionContext(),
    );

    expect(res?.status).toBe(400);
  });

  it("creates Think threads when THREAD_RUNTIME_DEFAULT is think", async () => {
    const seeded = await seedUserWorkspace({
      userId: "user-runtime-think",
      token: "runtime-think-token",
    });

    const runtimeEnv = env as unknown as { THREAD_RUNTIME_DEFAULT?: string };
    const original = runtimeEnv.THREAD_RUNTIME_DEFAULT;
    runtimeEnv.THREAD_RUNTIME_DEFAULT = "think";
    try {
      const res = await SELF.fetch("https://nadi.test/api/threads", {
        method: "POST",
        headers: {
          cookie: `better-auth.session_token=${seeded.token}`,
        },
      });

      expect(res.status).toBe(201);
      const body = (await res.json()) as { thread: { threadId: string; runtime: string } };
      expect(body.thread.runtime).toBe("think");

      const db = drizzle(env.REGISTRY_DB, { schema });
      const row = await db
        .select({ runtime: schema.threadIndex.runtime })
        .from(schema.threadIndex)
        .where(eq(schema.threadIndex.id, body.thread.threadId))
        .get();
      expect(row?.runtime).toBe("think");
    } finally {
      if (original === undefined) delete runtimeEnv.THREAD_RUNTIME_DEFAULT;
      else runtimeEnv.THREAD_RUNTIME_DEFAULT = original;
    }
  });

  it("creates Think threads even when THREAD_RUNTIME_DEFAULT is legacy", async () => {
    const seeded = await seedUserWorkspace({
      userId: "user-runtime-legacy",
      token: "runtime-legacy-token",
    });

    const runtimeEnv = env as unknown as { THREAD_RUNTIME_DEFAULT?: string };
    const original = runtimeEnv.THREAD_RUNTIME_DEFAULT;
    runtimeEnv.THREAD_RUNTIME_DEFAULT = "legacy";
    try {
      const res = await SELF.fetch("https://nadi.test/api/threads", {
        method: "POST",
        headers: {
          cookie: `better-auth.session_token=${seeded.token}`,
        },
      });

      expect(res.status).toBe(201);
      const body = (await res.json()) as { thread: { runtime: string } };
      expect(body.thread.runtime).toBe("think");
    } finally {
      if (original === undefined) delete runtimeEnv.THREAD_RUNTIME_DEFAULT;
      else runtimeEnv.THREAD_RUNTIME_DEFAULT = original;
    }
  });

  it("authorizes agent message history hydration for registered threads", async () => {
    const seeded = await seedUserWorkspace();
    await insertThread({
      id: "thr_history",
      workspaceId: seeded.workspaceId,
      agentId: seeded.agentId,
      title: "History",
      updatedAt: now + 1,
    });

    await expect(
      authorizeAgentRequest(
        new Request("https://nadi.test/think-agents/think-thread-agent/thr_history/get-messages", {
          headers: { cookie: `better-auth.session_token=${seeded.token}` },
        }),
        env,
      ),
    ).resolves.toMatchObject({
      authorized: true,
      threadId: "thr_history",
      workspaceId: seeded.workspaceId,
      userId: seeded.userId,
    });

    const res = await SELF.fetch(
      "https://nadi.test/think-agents/think-thread-agent/thr_history/get-messages",
      {
        headers: {
          cookie: `better-auth.session_token=${seeded.token}`,
        },
      },
    );

    expect(res.status).toBe(200);
    await expect(res.json()).resolves.toEqual([]);
  });

  it("archives a thread by snapshotting and evicting its Durable Object, hiding it from active lists", async () => {
    const seeded = await seedUserWorkspace({ userId: "archive-user", token: "archive-token" });
    await insertThread({
      id: "thr_archive",
      workspaceId: seeded.workspaceId,
      agentId: seeded.agentId,
      title: "Archive me",
      runtime: "think",
      updatedAt: now + 1,
    });
    const calls: string[] = [];

    const res = await routeThreads(
      new Request("https://nadi.test/api/threads/thr_archive/archive", {
        method: "POST",
        headers: { cookie: `better-auth.session_token=${seeded.token}` },
      }),
      makeDeleteRouteEnv({ thinkActive: false, calls }),
      makeExecutionContext(),
    );

    expect(res?.status).toBe(200);
    await expect(res?.json()).resolves.toMatchObject({
      thread: {
        threadId: "thr_archive",
        archivedAt: expect.any(Number),
        readOnly: true,
        status: "archived",
      },
    });
    // getAgentByName = idFromName -> get -> setName -> get (the setName round
    // trip is what forces onStart(), i.e. transcript hydration, before the read).
    expect(calls).toEqual([
      "think:idFromName:thr_archive",
      "think:get:thr_archive",
      "think:setName:thr_archive",
      "think:get:thr_archive",
      "think:hasActiveTurn",
      // The RAW transcript, not the compacted view: archiving destroys the DO, so
      // the archive must hold the messages a summary would have hidden.
      "think:exportRawHistory",
      "think:exportCompactions",
      "think:destroy",
    ]);

    const active = await SELF.fetch("https://nadi.test/api/threads", {
      headers: { cookie: `better-auth.session_token=${seeded.token}` },
    });
    await expect(active.json()).resolves.toEqual({ threads: [], nextCursor: null });

    const archived = await SELF.fetch("https://nadi.test/api/threads?status=archived", {
      headers: { cookie: `better-auth.session_token=${seeded.token}` },
    });
    await expect(archived.json()).resolves.toMatchObject({
      threads: [{ threadId: "thr_archive", status: "archived", readOnly: true }],
    });
  });

  it("archiving via the endpoint evicts the DO and marks the thread archived", async () => {
    const { workspaceId, agentId, token } = await seedUserWorkspace();
    await insertThread({
      id: "thr_arch",
      workspaceId,
      agentId,
      title: "Arch",
      updatedAt: now,
      runtime: "think",
    });
    // Archiving refuses an empty snapshot (it would destroy the DO on the
    // strength of a read that may simply be unhydrated), so give it history.
    await (runInDurableObject as any)(
      env.THINK_THREAD_AGENT.get(env.THINK_THREAD_AGENT.idFromName("thr_arch")),
      async (instance: any) => {
        await instance.__unsafe_ensureInitialized();
        await instance.addMessages([{ id: "a1", role: "user", parts: [] }]);
      },
    );

    const res = await routeThreads(
      new Request("https://nadi.test/api/threads/thr_arch/archive", {
        method: "POST",
        headers: { cookie: `better-auth.session_token=${token}` },
      }),
      env,
      { waitUntil() {}, passThroughOnException() {} } as unknown as ExecutionContext,
    );
    expect(res?.status).toBe(200);
    const body = (await res?.json()) as { thread: { archivedAt: number | null } };
    expect(body.thread.archivedAt).not.toBeNull();

    const row = await drizzle(env.REGISTRY_DB, { schema })
      .select({ archivedAt: schema.threadIndex.archivedAt })
      .from(schema.threadIndex)
      .where(eq(schema.threadIndex.id, "thr_arch"))
      .get();
    expect(row?.archivedAt).not.toBeNull();
  });

  it("treats archiving an already-archived D1 row as an idempotent success", async () => {
    const seeded = await seedUserWorkspace({
      userId: "archive-already-user",
      token: "archive-already-token",
    });
    await insertThread({
      id: "thr_already_archived",
      workspaceId: seeded.workspaceId,
      agentId: seeded.agentId,
      title: "Already archived",
      runtime: "think",
      updatedAt: now,
      archivedAt: now - 1,
    });

    const res = await routeThreads(
      new Request("https://nadi.test/api/threads/thr_already_archived/archive", {
        method: "POST",
        headers: { cookie: `better-auth.session_token=${seeded.token}` },
      }),
      makeDeleteRouteEnv({ thinkActive: false, calls: [] }),
      makeExecutionContext(),
    );

    expect(res?.status).toBe(200);
    await expect(res?.json()).resolves.toMatchObject({
      thread: {
        threadId: "thr_already_archived",
        archivedAt: now - 1,
        status: "archived",
        readOnly: true,
      },
    });
  });

  it("archives an empty stale row when the user explicitly retries archive", async () => {
    const seeded = await seedUserWorkspace({
      userId: "archive-empty-user",
      token: "archive-empty-token",
    });
    await insertThread({
      id: "thr_empty_stale",
      workspaceId: seeded.workspaceId,
      agentId: seeded.agentId,
      title: "Empty stale thread",
      runtime: "think",
      updatedAt: now,
    });

    const res = await routeThreads(
      new Request("https://nadi.test/api/threads/thr_empty_stale/archive", {
        method: "POST",
        headers: { cookie: `better-auth.session_token=${seeded.token}` },
      }),
      makeDeleteRouteEnv({ thinkActive: false, calls: [] }),
      makeExecutionContext(),
    );

    expect(res?.status).toBe(200);
    await expect(res?.json()).resolves.toMatchObject({
      thread: {
        threadId: "thr_empty_stale",
        archivedAt: expect.any(Number),
        status: "archived",
        readOnly: true,
      },
    });
  });

  it("rejects writes to archived threads", async () => {
    const seeded = await seedUserWorkspace({
      userId: "archived-write-user",
      token: "archived-write-token",
    });
    await insertThread({
      id: "thr_readonly",
      workspaceId: seeded.workspaceId,
      agentId: seeded.agentId,
      title: "Read only",
      runtime: "think",
      archivedAt: now + 10,
      updatedAt: now + 1,
    });

    const rename = await SELF.fetch("https://nadi.test/api/threads/thr_readonly", {
      method: "PATCH",
      headers: {
        "content-type": "application/json",
        cookie: `better-auth.session_token=${seeded.token}`,
      },
      body: JSON.stringify({ title: "Nope" }),
    });
    expect(rename.status).toBe(409);

    const compact = await routeThreads(
      new Request("https://nadi.test/api/threads/thr_readonly/compact", {
        method: "POST",
        headers: { cookie: `better-auth.session_token=${seeded.token}` },
      }),
      env,
      makeExecutionContext(),
    );
    expect(compact?.status).toBe(409);
  });

  it("clears environment snapshots when PATCH /api/threads/:id sets workbenchId to null", async () => {
    const seeded = await seedUserWorkspace({
      userId: "user-thread-patch-clear-project",
      token: "thread-patch-clear-project-token",
      workspaceId: "workspace-thread-patch-clear-project",
    });
    await insertEnvironment({
      id: "env-clear",
      workspaceId: seeded.workspaceId,
      name: "Clear Env",
      createdAt: now,
    });
    await insertRepository({
      id: "repo-clear-1",
      workspaceId: seeded.workspaceId,
      createdAt: now,
    });
    await assignRepositoryToEnvironment({
      workbenchId: "env-clear",
      repositoryId: "repo-clear-1",
      createdAt: now,
    });
    await insertThread({
      id: "thr_clear_project",
      workspaceId: seeded.workspaceId,
      agentId: seeded.agentId,
      title: "Clear Project",
      workbenchId: "env-clear",
      updatedAt: now,
    });
    await drizzle(env.REGISTRY_DB, { schema }).insert(schema.threadRepositorySnapshots).values({
      id: "thr_clear_project:repo-clear-1",
      threadId: "thr_clear_project",
      workspaceId: seeded.workspaceId,
      workbenchId: "env-clear",
      name: "repo-clear-1",
      url: "https://github.com/acme/repo-clear-1.git",
      defaultBranch: "main",
      checkoutPathName: "repo-clear-1",
      rootDirectory: "",
      setupCommand: "",
      packageManager: "",
      createdAt: now,
    });

    const res = await SELF.fetch("https://nadi.test/api/threads/thr_clear_project", {
      method: "PATCH",
      headers: {
        cookie: `better-auth.session_token=${seeded.token}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ workbenchId: null }),
    });

    expect(res.status).toBe(200);
    await expect(res.json()).resolves.toMatchObject({
      thread: {
        threadId: "thr_clear_project",
        repositorySnapshotCount: 0,
      },
    });
    await expect(listThreadSnapshots("thr_clear_project")).resolves.toEqual([]);
  });

  it("switches immediately when no sandbox is live", async () => {
    const seeded = await seedUserWorkspace({
      userId: "user-thread-patch-workbench-no-sandbox",
      token: "thread-patch-workbench-no-sandbox-token",
      workspaceId: "workspace-thread-patch-workbench-no-sandbox",
    });
    await insertEnvironment({
      id: "wb_new_no_sandbox",
      workspaceId: seeded.workspaceId,
      name: "New Bench",
      createdAt: now,
    });
    const threadId = "thr_patch_workbench_no_sandbox";
    await insertThread({
      id: threadId,
      workspaceId: seeded.workspaceId,
      agentId: seeded.agentId,
      title: "No Sandbox Switch",
      updatedAt: now,
      runtime: "think",
    });

    const res = await patchThread(threadId, { workbenchId: "wb_new_no_sandbox" }, seeded.token);
    expect(res.status).toBe(200);

    const snapshot = await readWorkbenchSnapshot(threadId);
    expect(snapshot?.workbenchId).toBe("wb_new_no_sandbox");

    const thread = await readThread(threadId);
    expect(thread?.workbenchSwitchPendingAt).toBeNull();
  });

  it("defers the snapshot and marks pending when a sandbox is live", async () => {
    const seeded = await seedUserWorkspace({
      userId: "user-thread-patch-workbench-live-sandbox",
      token: "thread-patch-workbench-live-sandbox-token",
      workspaceId: "workspace-thread-patch-workbench-live-sandbox",
    });
    await insertEnvironment({
      id: "wb_old_live_sandbox",
      workspaceId: seeded.workspaceId,
      name: "Old Bench",
      createdAt: now,
    });
    await insertEnvironment({
      id: "wb_new_live_sandbox",
      workspaceId: seeded.workspaceId,
      name: "New Bench",
      createdAt: now,
    });
    const threadId = "thr_patch_workbench_live_sandbox";
    await insertThread({
      id: threadId,
      workspaceId: seeded.workspaceId,
      agentId: seeded.agentId,
      title: "Live Sandbox Switch",
      updatedAt: now,
      runtime: "think",
      workbenchId: "wb_old_live_sandbox",
    });
    // Seed the pre-switch snapshot directly (insertThread only writes the
    // `thread_index` row) so the "stays on the old workbench" assertion below
    // is observing a real change, not an absent row that happens to compare
    // unequal to "wb_new_live_sandbox".
    await drizzle(env.REGISTRY_DB, { schema }).insert(schema.threadWorkbenchSnapshots).values({
      threadId,
      workspaceId: seeded.workspaceId,
      workbenchId: "wb_old_live_sandbox",
      name: "Old Bench",
      setupScript: "",
      resourceProfile: "small",
      createdAt: now,
    });

    await makeComputeLive(threadId, seeded.workspaceId);

    const res = await patchThread(threadId, { workbenchId: "wb_new_live_sandbox" }, seeded.token);
    expect(res.status).toBe(200);

    const thread = await readThread(threadId);
    expect(thread?.workbenchId).toBe("wb_new_live_sandbox");
    expect(thread?.workbenchSwitchPendingAt).not.toBeNull();

    const snapshot = await readWorkbenchSnapshot(threadId);
    expect(snapshot?.workbenchId).toBe("wb_old_live_sandbox");

    // The save-work injection actually reached the agent — checked via the
    // real transcript (the messages route → the DO's exportHistory()), not
    // by peeking the injection buffer: `deliverInjection` fire-and-forgets
    // `_kickInjectionTurn` when idle (the case here, a fresh thread with no
    // running turn), which drains and submits the message durably before
    // this assertion runs, so the buffer itself is expected to already be
    // empty by now — a "still buffered" check would be racing the kick, not
    // proving delivery.
    const historyRes = await SELF.fetch(`https://nadi.test/api/threads/${threadId}/messages`, {
      headers: { cookie: `better-auth.session_token=${seeded.token}` },
    });
    expect(historyRes.status).toBe(200);
    const history = (await historyRes.json()) as Array<{
      role: string;
      parts?: Array<{ type: string; text?: string }>;
    }>;
    const allText = history
      .flatMap((m) => m.parts ?? [])
      .map((p) => p.text ?? "")
      .join("\n");
    expect(allText).toContain("New Bench");
    expect(allText).toContain("confirm_workbench_switch");
  });

  /**
   * Regression: `isComputeLive()` covered only `active`+runtimeRef and
   * `recoverable`+recoveryRef, so a sandbox still `acquiring` reported NOT live
   * and the PATCH took the IMMEDIATE path. The container then came up with the
   * old workbench's repos and setup script while the snapshot already claimed
   * the new one — and because no marker was set, nothing ever tore it down or
   * re-cloned it. Permanent divergence, from a natural moment: switching just
   * after starting work.
   */
  it("defers the switch while a sandbox is still acquiring", async () => {
    const seeded = await seedUserWorkspace({
      userId: "user-thread-patch-workbench-acquiring",
      token: "thread-patch-workbench-acquiring-token",
      workspaceId: "workspace-thread-patch-workbench-acquiring",
    });
    await insertEnvironment({
      id: "wb_old_acquiring",
      workspaceId: seeded.workspaceId,
      name: "Old Bench Acquiring",
      createdAt: now,
    });
    await insertEnvironment({
      id: "wb_new_acquiring",
      workspaceId: seeded.workspaceId,
      name: "New Bench Acquiring",
      createdAt: now,
    });
    const threadId = "thr_patch_workbench_acquiring";
    await insertThread({
      id: threadId,
      workspaceId: seeded.workspaceId,
      agentId: seeded.agentId,
      title: "Acquiring Switch",
      updatedAt: now,
      runtime: "think",
      workbenchId: "wb_old_acquiring",
    });
    await drizzle(env.REGISTRY_DB, { schema }).insert(schema.threadWorkbenchSnapshots).values({
      threadId,
      workspaceId: seeded.workspaceId,
      workbenchId: "wb_old_acquiring",
      name: "Old Bench Acquiring",
      setupScript: "",
      resourceProfile: "small",
      createdAt: now,
    });

    await makeComputeAcquiring(threadId, seeded.workspaceId);

    const res = await patchThread(threadId, { workbenchId: "wb_new_acquiring" }, seeded.token);
    expect(res.status).toBe(200);

    // Deferred: the column carries the intent, the marker is armed...
    const thread = await readThread(threadId);
    expect(thread?.workbenchId).toBe("wb_new_acquiring");
    expect(thread?.workbenchSwitchPendingAt).not.toBeNull();

    // ...and the snapshot has NOT moved, so the container coming up still
    // matches the workbench it was provisioned from.
    const snapshot = await readWorkbenchSnapshot(threadId);
    expect(snapshot?.workbenchId).toBe("wb_old_acquiring");
  });

  it("switches immediately for legacy runtime threads without dialing a Think DO", async () => {
    const seeded = await seedUserWorkspace({
      userId: "user-thread-patch-workbench-legacy-runtime",
      token: "thread-patch-workbench-legacy-runtime-token",
      workspaceId: "workspace-thread-patch-workbench-legacy-runtime",
    });
    await insertEnvironment({
      id: "wb_new_legacy",
      workspaceId: seeded.workspaceId,
      name: "New Bench Legacy",
      createdAt: now,
    });
    const threadId = "thr_patch_workbench_legacy_runtime";
    await insertThread({
      id: threadId,
      workspaceId: seeded.workspaceId,
      agentId: seeded.agentId,
      title: "Legacy Runtime Switch",
      updatedAt: now,
      runtime: "legacy",
    });

    const res = await patchThread(threadId, { workbenchId: "wb_new_legacy" }, seeded.token);
    expect(res.status).toBe(200);

    const snapshot = await readWorkbenchSnapshot(threadId);
    expect(snapshot?.workbenchId).toBe("wb_new_legacy");

    const thread = await readThread(threadId);
    expect(thread?.workbenchSwitchPendingAt).toBeNull();
  });

  /**
   * The test above ("switches immediately for legacy runtime threads...")
   * cannot detect the `runtime !== "think"` guard's absence: a fresh
   * THINK_THREAD_AGENT DO reports `isComputeLive() === false` regardless of
   * whether the guard skipped dialing it or dialed it and got a not-live
   * answer back — the observable business outcome (immediate switch, no
   * pending marker) is identical either way. This test drives `routeThreads`
   * directly with a spy THINK_THREAD_AGENT binding instead, so it can assert
   * on the thing the guard actually controls: whether the binding was
   * touched at all.
   */
  it("never dials THINK_THREAD_AGENT for a legacy thread's workbench PATCH", async () => {
    const seeded = await seedUserWorkspace({
      userId: "user-thread-patch-workbench-legacy-no-dial",
      token: "thread-patch-workbench-legacy-no-dial-token",
      workspaceId: "workspace-thread-patch-workbench-legacy-no-dial",
    });
    await insertEnvironment({
      id: "wb_new_legacy_no_dial",
      workspaceId: seeded.workspaceId,
      name: "New Bench Legacy No Dial",
      createdAt: now,
    });
    const threadId = "thr_patch_workbench_legacy_no_dial";
    await insertThread({
      id: threadId,
      workspaceId: seeded.workspaceId,
      agentId: seeded.agentId,
      title: "Legacy Runtime No Dial",
      updatedAt: now,
      runtime: "legacy",
    });

    const calls: string[] = [];
    const thinkBinding = {
      idFromName(name: string) {
        calls.push(`think:idFromName:${name}`);
        return name;
      },
      get(name: string) {
        calls.push(`think:get:${name}`);
        return {
          async setName(setName: string) {
            calls.push(`think:setName:${setName}`);
          },
          async isComputeLive() {
            calls.push("think:isComputeLive");
            return false;
          },
        };
      },
    };
    const envWithSpy = { ...env, THINK_THREAD_AGENT: thinkBinding } as unknown as Env;

    const res = await routeThreads(
      new Request(`https://nadi.test/api/threads/${threadId}`, {
        method: "PATCH",
        headers: {
          cookie: `better-auth.session_token=${seeded.token}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({ workbenchId: "wb_new_legacy_no_dial" }),
      }),
      envWithSpy,
      makeExecutionContext(),
    );

    expect(res?.status).toBe(200);
    // The load-bearing assertion: the guard means the binding is never
    // touched for a legacy thread. Mutate away `runtime !== "think"` and
    // this fails — `getAgentByName` calls `idFromName`/`get`/`setName`
    // before `isComputeLive()`, so any of those landing in `calls` proves
    // the DO was dialed.
    expect(calls).toEqual([]);

    const snapshot = await readWorkbenchSnapshot(threadId);
    expect(snapshot?.workbenchId).toBe("wb_new_legacy_no_dial");
  });

  it("rolls back the pending marker when the switch reminder injection fails", async () => {
    const seeded = await seedUserWorkspace({
      userId: "user-thread-patch-workbench-injection-failure",
      token: "thread-patch-workbench-injection-failure-token",
      workspaceId: "workspace-thread-patch-workbench-injection-failure",
    });
    await insertEnvironment({
      id: "wb_old_injection_failure",
      workspaceId: seeded.workspaceId,
      name: "Old Bench Injection Failure",
      createdAt: now,
    });
    await insertEnvironment({
      id: "wb_new_injection_failure",
      workspaceId: seeded.workspaceId,
      name: "New Bench Injection Failure",
      createdAt: now,
    });
    const threadId = "thr_patch_workbench_injection_failure";
    await insertThread({
      id: threadId,
      workspaceId: seeded.workspaceId,
      agentId: seeded.agentId,
      title: "Injection Failure Switch",
      updatedAt: now,
      runtime: "think",
      workbenchId: "wb_old_injection_failure",
    });
    await drizzle(env.REGISTRY_DB, { schema }).insert(schema.threadWorkbenchSnapshots).values({
      threadId,
      workspaceId: seeded.workspaceId,
      workbenchId: "wb_old_injection_failure",
      name: "Old Bench Injection Failure",
      setupScript: "",
      resourceProfile: "small",
      createdAt: now,
    });
    const before = await readThread(threadId);

    const calls: string[] = [];
    const res = await routeThreads(
      new Request(`https://nadi.test/api/threads/${threadId}`, {
        method: "PATCH",
        headers: {
          cookie: `better-auth.session_token=${seeded.token}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({ workbenchId: "wb_new_injection_failure" }),
      }),
      makeWorkbenchSwitchInjectionFailureEnv(calls),
      makeExecutionContext(),
    );

    expect(res?.status).toBe(500);
    expect(calls).toContain("think:requestWorkbenchSwitch");

    // Left exactly as it was pre-switch: the intent column back to the OLD
    // workbench and the pending marker cleared — not left pointing at the
    // new workbench with the marker armed and no reminder ever delivered.
    // (updatedAt legitimately advances on the rollback write itself.)
    const after = await readThread(threadId);
    expect(after?.workbenchId).toBe(before?.workbenchId);
    expect(after?.workbenchSwitchPendingAt).toBeNull();

    // The snapshot never moved (beginWorkbenchSwitch doesn't touch it), so
    // it should still read the pre-switch workbench too.
    const snapshot = await readWorkbenchSnapshot(threadId);
    expect(snapshot?.workbenchId).toBe("wb_old_injection_failure");
  });

  it("returns 409 when changing the project on an archived thread", async () => {
    const seeded = await seedUserWorkspace({
      userId: "user-thread-patch-archived-project",
      token: "thread-patch-archived-project-token",
      workspaceId: "workspace-thread-patch-archived-project",
    });
    await insertProject({
      id: "project-archived-thread-move",
      workspaceId: seeded.workspaceId,
      name: "Archived Thread Move",
      createdAt: now,
    });
    await insertThread({
      id: "thr_archived_project_move",
      workspaceId: seeded.workspaceId,
      agentId: seeded.agentId,
      title: "Archived Project Move",
      updatedAt: now,
      archivedAt: now + 10,
    });

    const res = await SELF.fetch("https://nadi.test/api/threads/thr_archived_project_move", {
      method: "PATCH",
      headers: {
        cookie: `better-auth.session_token=${seeded.token}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ projectId: "project-archived-thread-move" }),
    });

    expect(res.status).toBe(409);
  });

  it("returns 404 when moving an active thread to an archived project", async () => {
    const seeded = await seedUserWorkspace({
      userId: "user-thread-patch-active-archived-project",
      token: "thread-patch-active-archived-project-token",
      workspaceId: "workspace-thread-patch-active-archived-project",
    });
    await insertProject({
      id: "project-active-move-archived",
      workspaceId: seeded.workspaceId,
      name: "Archived Destination",
      createdAt: now,
      archivedAt: now + 10,
    });
    await insertThread({
      id: "thr_active_project_move_archived",
      workspaceId: seeded.workspaceId,
      agentId: seeded.agentId,
      title: "Active Project Move",
      updatedAt: now,
    });

    const res = await SELF.fetch("https://nadi.test/api/threads/thr_active_project_move_archived", {
      method: "PATCH",
      headers: {
        cookie: `better-auth.session_token=${seeded.token}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ projectId: "project-active-move-archived" }),
    });

    expect(res.status).toBe(404);
  });

  it("returns 404 when moving an active thread to a non-member project", async () => {
    const seeded = await seedUserWorkspace({
      userId: "user-thread-patch-active-other-project",
      token: "thread-patch-active-other-project-token",
      workspaceId: "workspace-thread-patch-active-other-project",
    });
    const other = await seedUserWorkspace({
      userId: "user-thread-patch-active-other-project-owner",
      token: "thread-patch-active-other-project-owner-token",
      workspaceId: "workspace-thread-patch-active-other-project-other",
    });
    await insertProject({
      id: "project-active-move-other-workspace",
      workspaceId: other.workspaceId,
      name: "Other Workspace Project",
      createdAt: now,
    });
    await insertThread({
      id: "thr_active_project_move_other_workspace",
      workspaceId: seeded.workspaceId,
      agentId: seeded.agentId,
      title: "Active Project Move Other Workspace",
      updatedAt: now,
    });

    const res = await SELF.fetch(
      "https://nadi.test/api/threads/thr_active_project_move_other_workspace",
      {
        method: "PATCH",
        headers: {
          cookie: `better-auth.session_token=${seeded.token}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({ projectId: "project-active-move-other-workspace" }),
      },
    );

    expect(res.status).toBe(404);
  });

  it("GET /messages returns the snapshot for an archived thread", async () => {
    const { workspaceId, agentId, token } = await seedUserWorkspace();
    await insertThread({
      id: "thr_read",
      workspaceId,
      agentId,
      title: "Read",
      updatedAt: now,
      runtime: "think",
      archivedAt: now,
    });
    const messages = [{ id: "m1", role: "user", parts: [{ type: "text", text: "archived" }] }];
    await new ArchivedMessageRepository(drizzle(env.REGISTRY_DB, { schema })).replaceForThread(
      "thr_read",
      messages,
    );

    const res = await routeThreads(
      new Request("https://x/api/threads/thr_read/messages", {
        headers: { cookie: `better-auth.session_token=${token}` },
      }),
      env,
      { waitUntil() {}, passThroughOnException() {} } as unknown as ExecutionContext,
    );
    expect(res?.status).toBe(200);
    expect(await res?.json()).toEqual(messages);
  });

  it("GET /messages serves the snapshot without rehydrating the DO", async () => {
    const { workspaceId, agentId, token } = await seedUserWorkspace();
    await insertThread({
      id: "thr_snap_only",
      workspaceId,
      agentId,
      title: "Snapshot only",
      updatedAt: now,
      runtime: "think",
      archivedAt: now,
    });
    const messages = [{ id: "m1", role: "user", parts: [{ type: "text", text: "kept" }] }];
    await new ArchivedMessageRepository(drizzle(env.REGISTRY_DB, { schema })).replaceForThread(
      "thr_snap_only",
      messages,
    );
    const calls: string[] = [];

    const res = await routeThreads(
      new Request("https://x/api/threads/thr_snap_only/messages", {
        headers: { cookie: `better-auth.session_token=${token}` },
      }),
      makeMessagesRouteEnv({ runtime: "think", history: [], calls, throwOnExport: true }),
      makeExecutionContext(),
    );

    expect(res?.status).toBe(200);
    expect(await res?.json()).toEqual(messages);
    // A snapshotted thread must be served from D1 without touching the evicted DO.
    expect(calls).not.toContain("think:exportHistory");
  });

  it("GET /messages returns an empty snapshot for an archived thread with no rows, never touching a DO", async () => {
    const { workspaceId, agentId, token } = await seedUserWorkspace();
    await insertThread({
      id: "thr_no_snap",
      workspaceId,
      agentId,
      title: "No snapshot",
      updatedAt: now,
      runtime: "think",
      archivedAt: now,
    });
    const calls: string[] = [];

    const res = await routeThreads(
      new Request("https://x/api/threads/thr_no_snap/messages", {
        headers: { cookie: `better-auth.session_token=${token}` },
      }),
      // throwOnExport guarantees the test fails loudly if the DO is ever read.
      makeMessagesRouteEnv({ runtime: "think", history: [], calls, throwOnExport: true }),
      makeExecutionContext(),
    );

    expect(res?.status).toBe(200);
    expect(await res?.json()).toEqual([]);
    // archivedAt is the switch: no backfill, no DO fallback — the DO is untouched.
    expect(calls).toEqual([]);
  });

  it("GET /messages returns 401 without a valid session", async () => {
    const res = await SELF.fetch("https://nadi.test/api/threads/thr_any/messages");

    expect(res.status).toBe(401);
  });

  it("GET /messages returns 404 for missing or non-member threads", async () => {
    const seeded = await seedUserWorkspace();
    const other = await seedUserWorkspace({
      userId: "other-user",
      token: "other-token",
      workspaceId: "workspace-other",
    });
    await insertThread({
      id: "thr_other_msgs",
      workspaceId: other.workspaceId,
      agentId: other.agentId,
      title: "Other",
      updatedAt: now,
      runtime: "think",
      archivedAt: now,
    });

    const missing = await SELF.fetch("https://nadi.test/api/threads/thr_missing_msgs/messages", {
      headers: { cookie: `better-auth.session_token=${seeded.token}` },
    });
    const nonMember = await SELF.fetch("https://nadi.test/api/threads/thr_other_msgs/messages", {
      headers: { cookie: `better-auth.session_token=${seeded.token}` },
    });

    expect(missing.status).toBe(404);
    expect(nonMember.status).toBe(404);
  });

  it("returns 401 when creating a thread without a valid session", async () => {
    const res = await SELF.fetch("https://nadi.test/api/threads", {
      method: "POST",
    });

    expect(res.status).toBe(401);
  });

  it("returns 404 and does not create a row for the removed ensure endpoint", async () => {
    const seeded = await seedUserWorkspace();

    const res = await SELF.fetch("https://nadi.test/api/threads/ensure", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        cookie: `better-auth.session_token=${seeded.token}`,
      },
      body: JSON.stringify({ threadId: "thr_removed_ensure" }),
    });

    expect(res.status).toBe(404);
    const db = drizzle(env.REGISTRY_DB, { schema });
    await expect(
      db.select().from(schema.threadIndex).where(eq(schema.threadIndex.id, "thr_removed_ensure")),
    ).resolves.toEqual([]);
  });

  it("deletes a member's thread and removes its index row", async () => {
    const seeded = await seedUserWorkspace();
    await insertThread({
      id: "thr_delete",
      workspaceId: seeded.workspaceId,
      agentId: seeded.agentId,
      title: "Delete me",
      updatedAt: now + 1,
    });

    const res = await SELF.fetch("https://nadi.test/api/threads/thr_delete", {
      method: "DELETE",
      headers: {
        cookie: `better-auth.session_token=${seeded.token}`,
      },
    });

    expect(res.status).toBe(204);

    const db = drizzle(env.REGISTRY_DB, { schema });
    await expect(
      db.select().from(schema.threadIndex).where(eq(schema.threadIndex.id, "thr_delete")),
    ).resolves.toEqual([]);

    // The thread is no longer authorizable for agent access.
    await expect(
      authorizeAgentRequest(
        new Request("https://nadi.test/think-agents/think-thread-agent/thr_delete", {
          headers: { cookie: `better-auth.session_token=${seeded.token}` },
        }),
        env,
      ),
    ).resolves.toMatchObject({ authorized: false });
  });

  // A retired-runtime row has no DO of any kind: its class is deleted, and the
  // Think namespace must NOT be dialed in its place — that would mint (and
  // persist) an empty phantom under a name that was never a Think thread. The
  // D1 rows are still deleted, so the row does disappear.
  it("deletes a retired-runtime thread without touching any Durable Object", async () => {
    const seeded = await seedUserWorkspace({
      userId: "delete-runtime-legacy-user",
      token: "delete-runtime-legacy-token",
    });
    await insertThread({
      id: "delete-runtime-legacy",
      workspaceId: seeded.workspaceId,
      agentId: seeded.agentId,
      title: "Delete legacy",
      runtime: "legacy",
      updatedAt: now + 1,
    });
    const calls: string[] = [];

    const res = await routeThreads(
      new Request("https://nadi.test/api/threads/delete-runtime-legacy", {
        method: "DELETE",
        headers: {
          cookie: `better-auth.session_token=${seeded.token}`,
        },
      }),
      makeDeleteRouteEnv({ thinkActive: true, calls }),
      makeExecutionContext(),
    );

    expect(res?.status).toBe(204);
    expect(calls).toEqual([]);
    await expect(
      drizzle(env.REGISTRY_DB, { schema })
        .select()
        .from(schema.threadIndex)
        .where(eq(schema.threadIndex.id, "delete-runtime-legacy")),
    ).resolves.toEqual([]);
  });

  it("deletes Think runtime threads through THINK_THREAD_AGENT", async () => {
    const seeded = await seedUserWorkspace({
      userId: "delete-runtime-think-user",
      token: "delete-runtime-think-token",
    });
    await insertThread({
      id: "delete-runtime-think",
      workspaceId: seeded.workspaceId,
      agentId: seeded.agentId,
      title: "Delete Think",
      runtime: "think",
      updatedAt: now + 1,
    });
    const calls: string[] = [];

    const res = await routeThreads(
      new Request("https://nadi.test/api/threads/delete-runtime-think", {
        method: "DELETE",
        headers: {
          cookie: `better-auth.session_token=${seeded.token}`,
        },
      }),
      makeDeleteRouteEnv({ thinkActive: false, calls }),
      makeExecutionContext(),
    );

    expect(res?.status).toBe(204);
    expect(calls).toContain("think:hasActiveTurn");
    expect(calls).toContain("think:destroy");
  });

  it("deleting an archived thread drops its snapshot rows", async () => {
    const { workspaceId, agentId, token } = await seedUserWorkspace();
    await insertThread({
      id: "thr_del",
      workspaceId,
      agentId,
      title: "Del",
      updatedAt: now,
      runtime: "think",
      archivedAt: now,
    });
    const archivedRepo = new ArchivedMessageRepository(drizzle(env.REGISTRY_DB, { schema }));
    await archivedRepo.replaceForThread("thr_del", [{ id: "m1", role: "user", parts: [] }]);

    const res = await routeThreads(
      new Request("https://x/api/threads/thr_del", {
        method: "DELETE",
        headers: { cookie: `better-auth.session_token=${token}` },
      }),
      env,
      { waitUntil() {}, passThroughOnException() {} } as unknown as ExecutionContext,
    );
    expect(res?.status).toBe(204);
    expect(await archivedRepo.listForThread("thr_del")).toEqual([]);
  });

  it("deleting a project-assigned active thread drops its snapshot rows", async () => {
    const { workspaceId, agentId, token } = await seedUserWorkspace();
    await insertProject({
      id: "project-active-delete",
      workspaceId,
      name: "Active Delete",
      createdAt: now,
    });
    await insertRepository({
      id: "repo-active-delete",
      workspaceId,
      createdAt: now,
    });
    await insertThread({
      id: "thr_active_project_delete",
      workspaceId,
      agentId,
      projectId: "project-active-delete",
      title: "Active project delete",
      updatedAt: now,
      runtime: "think",
    });
    await insertThreadSnapshot({
      threadId: "thr_active_project_delete",
      workspaceId,
      projectId: "project-active-delete",
      repositoryId: "repo-active-delete",
      createdAt: now,
    });

    const res = await routeThreads(
      new Request("https://x/api/threads/thr_active_project_delete", {
        method: "DELETE",
        headers: { cookie: `better-auth.session_token=${token}` },
      }),
      makeDeleteRouteEnv({ thinkActive: false, calls: [] }),
      makeExecutionContext(),
    );

    expect(res?.status).toBe(204);
    await expect(listThreadSnapshots("thr_active_project_delete")).resolves.toEqual([]);
  });

  it("deleting an archived thread never rehydrates the evicted DO", async () => {
    const { workspaceId, agentId, token } = await seedUserWorkspace();
    await insertThread({
      id: "thr_arch_del",
      workspaceId,
      agentId,
      title: "Archived delete",
      updatedAt: now,
      runtime: "think",
      archivedAt: now,
    });
    const calls: string[] = [];

    const res = await routeThreads(
      new Request("https://x/api/threads/thr_arch_del", {
        method: "DELETE",
        headers: { cookie: `better-auth.session_token=${token}` },
      }),
      makeDeleteRouteEnv({ thinkActive: true, calls }),
      makeExecutionContext(),
    );

    expect(res?.status).toBe(204);
    // Archived => DO already destroyed at archive time; delete touches no DO at
    // all (no active-turn guard, no second destroy).
    expect(calls).toEqual([]);
  });

  it("compacts Think runtime threads through THINK_THREAD_AGENT", async () => {
    const seeded = await seedUserWorkspace({
      userId: "compact-runtime-think-user",
      token: "compact-runtime-think-token",
    });
    await insertThread({
      id: "compact-runtime-think",
      workspaceId: seeded.workspaceId,
      agentId: seeded.agentId,
      title: "Compact Think",
      runtime: "think",
      updatedAt: now + 1,
    });
    // Route through getAgentByName against the real (never-touched) DO. An
    // empty thread has nothing to summarize, so compaction is a real no-op
    // rather than a fabricated "compacted: true" — the point of this test is
    // that the route reaches a genuinely initialized agent and gets a 200,
    // not a 500 from an uninitialized `this.session`.
    const res = await routeThreads(
      new Request("https://nadi.test/api/threads/compact-runtime-think/compact", {
        method: "POST",
        headers: {
          cookie: `better-auth.session_token=${seeded.token}`,
        },
      }),
      env,
      makeExecutionContext(),
    );

    expect(res?.status).toBe(200);
    await expect(res?.json()).resolves.toEqual({
      compacted: false,
      message: "Nothing to compact yet.",
      reason: "not-needed",
    });
  });

  it("returns Think compaction status through THINK_THREAD_AGENT", async () => {
    const seeded = await seedUserWorkspace({
      userId: "compact-status-user",
      token: "compact-status-token",
    });
    await insertThread({
      id: "compact-status-think",
      workspaceId: seeded.workspaceId,
      agentId: seeded.agentId,
      title: "Compact status",
      runtime: "think",
      updatedAt: now + 1,
    });
    // Same reasoning as the compact test above: a never-touched DO's status
    // read must succeed (200 "idle") rather than 500 on an uninitialized agent.
    const res = await routeThreads(
      new Request("https://nadi.test/api/threads/compact-status-think/compact/status", {
        headers: {
          cookie: `better-auth.session_token=${seeded.token}`,
        },
      }),
      env,
      makeExecutionContext(),
    );

    expect(res?.status).toBe(200);
    await expect(res?.json()).resolves.toEqual({ phase: "idle" });
  });

  it("returns 400 for legacy runtime compaction status", async () => {
    const seeded = await seedUserWorkspace({
      userId: "compact-status-legacy-user",
      token: "compact-status-legacy-token",
    });
    await insertThread({
      id: "compact-status-legacy",
      workspaceId: seeded.workspaceId,
      agentId: seeded.agentId,
      title: "Compact legacy",
      runtime: "legacy",
      updatedAt: now + 1,
    });

    const res = await routeThreads(
      new Request("https://nadi.test/api/threads/compact-status-legacy/compact/status", {
        headers: {
          cookie: `better-auth.session_token=${seeded.token}`,
        },
      }),
      env,
      makeExecutionContext(),
    );

    expect(res?.status).toBe(400);
    await expect(res?.text()).resolves.toBe(
      "Thread compaction is only available for Think threads",
    );
  });

  it("returns 409 when a Think thread cannot compact while unstable", async () => {
    const seeded = await seedUserWorkspace({
      userId: "compact-unstable-user",
      token: "compact-unstable-token",
    });
    await insertThread({
      id: "compact-unstable",
      workspaceId: seeded.workspaceId,
      agentId: seeded.agentId,
      title: "Compact unstable",
      runtime: "think",
      updatedAt: now + 1,
    });
    // Route-level mapping test for the "not stable" catch branch: spy on the
    // real DO class rather than faking the binding, since the route now
    // resolves the agent through getAgentByName (real fetch-based bootstrap),
    // which a hand-rolled idFromName/get mock can no longer stand in for.
    vi.spyOn(ThinkThreadAgent.prototype, "compactThread").mockRejectedValueOnce(
      new Error("thread_compaction_not_stable"),
    );

    const res = await routeThreads(
      new Request("https://nadi.test/api/threads/compact-unstable/compact", {
        method: "POST",
        headers: {
          cookie: `better-auth.session_token=${seeded.token}`,
        },
      }),
      env,
      makeExecutionContext(),
    );

    expect(res?.status).toBe(409);
    await expect(res?.text()).resolves.toBe("Thread is responding; try again once it finishes");
  });

  it("returns 404 and preserves the row for missing or non-member delete targets", async () => {
    const seeded = await seedUserWorkspace();
    const other = await seedUserWorkspace({
      userId: "other-user",
      token: "other-token",
      workspaceId: "workspace-other",
    });
    await insertThread({
      id: "thr_other",
      workspaceId: other.workspaceId,
      agentId: other.agentId,
      title: "Other",
      updatedAt: now + 1,
    });

    const missing = await SELF.fetch("https://nadi.test/api/threads/thr_missing", {
      method: "DELETE",
      headers: { cookie: `better-auth.session_token=${seeded.token}` },
    });
    const nonMember = await SELF.fetch("https://nadi.test/api/threads/thr_other", {
      method: "DELETE",
      headers: { cookie: `better-auth.session_token=${seeded.token}` },
    });

    expect(missing.status).toBe(404);
    expect(nonMember.status).toBe(404);

    // A non-member delete must not remove the other workspace's thread.
    const db = drizzle(env.REGISTRY_DB, { schema });
    await expect(
      db.select().from(schema.threadIndex).where(eq(schema.threadIndex.id, "thr_other")),
    ).resolves.toHaveLength(1);
  });

  it("returns 401 when deleting a thread without a valid session", async () => {
    const res = await SELF.fetch("https://nadi.test/api/threads/thr_delete", {
      method: "DELETE",
    });

    expect(res.status).toBe(401);
  });

  it("returns 405 for unsupported methods on a thread resource", async () => {
    const seeded = await seedUserWorkspace();

    const res = await SELF.fetch("https://nadi.test/api/threads/thr_delete", {
      method: "PUT",
      headers: { cookie: `better-auth.session_token=${seeded.token}` },
    });

    expect(res.status).toBe(405);
  });

  it("clears completed and failed unread state when a thread is seen", async () => {
    const seeded = await seedUserWorkspace();
    await insertThread({
      id: "thr_seen",
      workspaceId: seeded.workspaceId,
      agentId: seeded.agentId,
      title: "Seen",
      updatedAt: now,
    });
    const db = drizzle(env.REGISTRY_DB, { schema });
    await db
      .update(schema.threadIndex)
      .set({ unreadOutcome: "completed", unreadOutcomeAt: now + 1 })
      .where(eq(schema.threadIndex.id, "thr_seen"));

    const res = await SELF.fetch("https://nadi.test/api/threads/thr_seen/seen", {
      method: "POST",
      headers: { cookie: `better-auth.session_token=${seeded.token}` },
    });

    expect(res.status).toBe(200);
    await expect(res.json()).resolves.toMatchObject({
      thread: {
        threadId: "thr_seen",
        unreadOutcome: null,
        unreadOutcomeAt: null,
        lastSeenAt: expect.any(Number),
      },
    });
  });

  it("creates threads with titleSet false", async () => {
    const seeded = await seedUserWorkspace();
    const res = await SELF.fetch("https://nadi.test/api/threads", {
      method: "POST",
      headers: { cookie: `better-auth.session_token=${seeded.token}` },
    });
    expect(res.status).toBe(201);
    const body = (await res.json()) as { thread: { threadId: string } };
    const db = drizzle(env.REGISTRY_DB, { schema });
    const row = await db
      .select()
      .from(schema.threadIndex)
      .where(eq(schema.threadIndex.id, body.thread.threadId))
      .get();
    expect(row?.titleSet).toBe(false);
  });

  it("renames a member's thread and sets titleSet", async () => {
    const seeded = await seedUserWorkspace();
    await insertThread({
      id: "thr_rename",
      workspaceId: seeded.workspaceId,
      agentId: seeded.agentId,
      title: "New thread",
      updatedAt: now + 1,
    });

    const res = await SELF.fetch("https://nadi.test/api/threads/thr_rename", {
      method: "PATCH",
      headers: {
        "content-type": "application/json",
        cookie: `better-auth.session_token=${seeded.token}`,
      },
      body: JSON.stringify({ title: "My renamed thread" }),
    });

    expect(res.status).toBe(200);
    await expect(res.json()).resolves.toMatchObject({
      thread: { threadId: "thr_rename", title: "My renamed thread" },
    });
    const db = drizzle(env.REGISTRY_DB, { schema });
    const row = await db
      .select()
      .from(schema.threadIndex)
      .where(eq(schema.threadIndex.id, "thr_rename"))
      .get();
    expect(row).toMatchObject({ title: "My renamed thread", titleSet: true });
  });

  it("updates a member's thread reasoning effort", async () => {
    const seeded = await seedUserWorkspace();
    await insertThread({
      id: "thr_effort",
      workspaceId: seeded.workspaceId,
      agentId: seeded.agentId,
      title: "Effort thread",
      reasoningEffort: "medium",
      updatedAt: now + 1,
    });

    const res = await SELF.fetch("https://nadi.test/api/threads/thr_effort", {
      method: "PATCH",
      headers: {
        "content-type": "application/json",
        cookie: `better-auth.session_token=${seeded.token}`,
      },
      body: JSON.stringify({ reasoningEffort: "high" }),
    });

    expect(res.status).toBe(200);
    await expect(res.json()).resolves.toMatchObject({
      thread: { threadId: "thr_effort", reasoningEffort: "high" },
    });
    const db = drizzle(env.REGISTRY_DB, { schema });
    const row = await db
      .select()
      .from(schema.threadIndex)
      .where(eq(schema.threadIndex.id, "thr_effort"))
      .get();
    expect(row?.reasoningEffort).toBe("high");
  });

  it("rejects an invalid reasoning effort with 400", async () => {
    const seeded = await seedUserWorkspace();
    await insertThread({
      id: "thr_effort_bad",
      workspaceId: seeded.workspaceId,
      agentId: seeded.agentId,
      title: "Effort thread",
      updatedAt: now + 1,
    });

    const res = await SELF.fetch("https://nadi.test/api/threads/thr_effort_bad", {
      method: "PATCH",
      headers: {
        "content-type": "application/json",
        cookie: `better-auth.session_token=${seeded.token}`,
      },
      body: JSON.stringify({ reasoningEffort: "max" }),
    });

    expect(res.status).toBe(400);
  });

  it("rejects an empty rename title with 400", async () => {
    const seeded = await seedUserWorkspace();
    await insertThread({
      id: "thr_empty",
      workspaceId: seeded.workspaceId,
      agentId: seeded.agentId,
      title: "New thread",
      updatedAt: now + 1,
    });
    const res = await SELF.fetch("https://nadi.test/api/threads/thr_empty", {
      method: "PATCH",
      headers: {
        "content-type": "application/json",
        cookie: `better-auth.session_token=${seeded.token}`,
      },
      body: JSON.stringify({ title: "   " }),
    });
    expect(res.status).toBe(400);
  });

  it("returns 404 when renaming a non-member thread", async () => {
    const seeded = await seedUserWorkspace();
    const other = await seedUserWorkspace({
      userId: "other-user",
      token: "other-token",
      workspaceId: "workspace-other",
    });
    await insertThread({
      id: "thr_other_rn",
      workspaceId: other.workspaceId,
      agentId: other.agentId,
      title: "Other",
      updatedAt: now + 1,
    });
    const res = await SELF.fetch("https://nadi.test/api/threads/thr_other_rn", {
      method: "PATCH",
      headers: {
        "content-type": "application/json",
        cookie: `better-auth.session_token=${seeded.token}`,
      },
      body: JSON.stringify({ title: "hijack" }),
    });
    expect(res.status).toBe(404);
  });

  it("paginates and rejects a junk cursor", async () => {
    const seeded = await seedUserWorkspace({
      userId: "pagination-user",
      token: "pagination-token",
    });
    for (let i = 0; i < 4; i++) {
      await insertThread({
        id: `thr_p${i}`,
        workspaceId: seeded.workspaceId,
        agentId: seeded.agentId,
        title: `Chat ${i}`,
        updatedAt: now - i,
      });
    }

    const res = await SELF.fetch("https://nadi.test/api/threads?limit=2", {
      headers: { cookie: `better-auth.session_token=${seeded.token}` },
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { threads: unknown[]; nextCursor: string | null };
    expect(body.threads).toHaveLength(2);
    expect(body.nextCursor).toEqual(expect.any(String));

    const bad = await SELF.fetch("https://nadi.test/api/threads?cursor=junk!", {
      headers: { cookie: `better-auth.session_token=${seeded.token}` },
    });
    expect(bad.status).toBe(400);
  });

  it("still returns every thread when no limit is sent", async () => {
    // The deployed client. This must not change: absent limit is unbounded.
    // Seeded past MAX_THREAD_PAGE (not just DEFAULT_THREAD_PAGE) so this is
    // total against "absent limit acquired ANY bound at all" — an accidental
    // `?? MAX_THREAD_PAGE` would pass a DEFAULT_THREAD_PAGE-sized seed too.
    const seeded = await seedUserWorkspace({ userId: "nolimit-user", token: "nolimit-token" });
    for (let i = 0; i < MAX_THREAD_PAGE + 5; i++) {
      await insertThread({
        id: `thr_q${i}`,
        workspaceId: seeded.workspaceId,
        agentId: seeded.agentId,
        title: `Chat ${i}`,
        updatedAt: now - i,
      });
    }

    const res = await SELF.fetch("https://nadi.test/api/threads", {
      headers: { cookie: `better-auth.session_token=${seeded.token}` },
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { threads: unknown[]; nextCursor: string | null };
    expect(body.threads).toHaveLength(MAX_THREAD_PAGE + 5);
    expect(body.nextCursor).toBeNull();
  });

  it("treats an empty cursor param as page one, not a 400", async () => {
    const seeded = await seedUserWorkspace({
      userId: "emptycursor-user",
      token: "emptycursor-token",
    });
    await insertThread({
      id: "thr_emptycursor",
      workspaceId: seeded.workspaceId,
      agentId: seeded.agentId,
      title: "Chat",
      updatedAt: now,
    });

    const res = await SELF.fetch("https://nadi.test/api/threads?cursor=", {
      headers: { cookie: `better-auth.session_token=${seeded.token}` },
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { threads: unknown[]; nextCursor: string | null };
    expect(body.threads).toHaveLength(1);
  });

  it("rejects a non-integer limit with 400 instead of returning everything", async () => {
    const seeded = await seedUserWorkspace({ userId: "badlimit-user", token: "badlimit-token" });
    await insertThread({
      id: "thr_badlimit",
      workspaceId: seeded.workspaceId,
      agentId: seeded.agentId,
      title: "Chat",
      updatedAt: now,
    });

    for (const bad of ["abc", "0", "-5", "1.5"]) {
      const res = await SELF.fetch(`https://nadi.test/api/threads?limit=${bad}`, {
        headers: { cookie: `better-auth.session_token=${seeded.token}` },
      });
      expect(res.status).toBe(400);
    }
  });

  describe("POST /api/threads/reconcile", () => {
    it("returns only requested active threads visible to the signed-in user", async () => {
      const seeded = await seedUserWorkspace({
        userId: "reconcile-user",
        token: "reconcile-token",
      });
      const other = await seedUserWorkspace({
        userId: "reconcile-other",
        token: "reconcile-other-token",
        workspaceId: "reconcile-other-workspace",
      });
      await insertThread({
        id: "active",
        workspaceId: seeded.workspaceId,
        agentId: seeded.agentId,
        title: "Active",
        updatedAt: now,
      });
      await insertThread({
        id: "archived",
        workspaceId: seeded.workspaceId,
        agentId: seeded.agentId,
        title: "Archived",
        updatedAt: now - 1,
        archivedAt: now,
      });
      await insertThread({
        id: "unauthorized",
        workspaceId: other.workspaceId,
        agentId: other.agentId,
        title: "Unauthorized",
        updatedAt: now - 2,
      });

      const response = await SELF.fetch("https://nadi.test/api/threads/reconcile", {
        method: "POST",
        headers: {
          cookie: `better-auth.session_token=${seeded.token}`,
          "content-type": "application/json",
        },
        body: JSON.stringify({ threadIds: ["active", "archived", "unauthorized", "missing"] }),
      });

      expect(response.status).toBe(200);
      await expect(response.json()).resolves.toEqual({ activeThreadIds: ["active"] });
    });

    it.each([
      null,
      {},
      { threadIds: [] },
      { threadIds: [""] },
      { threadIds: ["dup", "dup"] },
      { threadIds: Array.from({ length: 101 }, (_, index) => `t${index}`) },
    ])("rejects an invalid reconciliation body %#", async (body) => {
      const seeded = await seedUserWorkspace({
        userId: "reconcile-invalid",
        token: "reconcile-invalid-token",
      });
      const response = await SELF.fetch("https://nadi.test/api/threads/reconcile", {
        method: "POST",
        headers: {
          cookie: `better-auth.session_token=${seeded.token}`,
          "content-type": "application/json",
        },
        body: JSON.stringify(body),
      });
      expect(response.status).toBe(400);
    });

    it("requires authentication", async () => {
      const response = await SELF.fetch("https://nadi.test/api/threads/reconcile", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ threadIds: ["active"] }),
      });
      expect(response.status).toBe(401);
    });
  });
});
