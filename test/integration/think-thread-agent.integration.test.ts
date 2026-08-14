import { SELF, env, runInDurableObject } from "cloudflare:test";
import { simulateReadableStream, tool, type ModelMessage } from "ai";
import { eq } from "drizzle-orm";
import { drizzle } from "drizzle-orm/d1";
import type { DrizzleD1Database } from "drizzle-orm/d1";
import { beforeAll, describe, expect, it } from "vitest";
import { vi } from "vitest";
import { z } from "zod";
import * as schema from "../../src/db/schema";
import { SUBAGENT_DEADLINE_MS, SUBAGENT_STALE_AFTER_MS } from "../../src/agent/work-ledger";
import type { WorkLedgerStore } from "../../src/agent/work-ledger-store";
import { AgentMemoryRepository } from "../../src/db/repositories/agent-memories";
import {
  ThinkThreadAgent,
  type ThinkThreadAgent as ThinkThreadAgentType,
} from "../../src/agent/think-thread-agent";
import * as threadAgentModule from "../../src/agent/thread-agent-config";
import { resolveContextBudget } from "../../src/agent/context-budget";
import { DEFAULT_TOOL_OUTPUT_CAP_CHARS } from "../../src/agent/tool-output-cap";
import { CODING_MAX_TOOL_STEPS, MAX_TOOL_STEPS } from "../../src/agent/tool-step-limit";
import { AttachmentRepository } from "../../src/db/attachment-repository";
import { AgentSkillRepository } from "../../src/db/repositories/agent-skills";
import {
  WorkbenchRepository,
  type WorkbenchRepositoryEntry,
} from "../../src/db/repositories/workbenches";
import { ProjectRepository } from "../../src/db/repositories/projects";
import { ThreadRepositorySnapshotRepository } from "../../src/db/repositories/thread-repository-snapshots";
import * as posthogObservability from "../../src/observability/posthog";
import { saveDaytonaApiKey } from "../../src/compute/settings";
import { FakeComputeBackend } from "../../src/compute/backends/fake";
import { ThreadComputeService } from "../../src/compute/thread-service";
import { DEFAULT_MONITOR_POLL_INTERVAL_MS } from "../../src/compute/watchers";
import { applyRegistryTestSchema, seedRegistryThread } from "./helpers/registry";
import { FEEDBACK_MODEL_ID, FEEDBACK_MODEL_PROVIDER } from "../../src/agent/feedback-mode";

const featureEnv = env as typeof env & { BACKGROUND_WORK_ENABLED?: string | undefined };

/** Opening words of the first-turn clock reminder (src/agent/thread-start-clock.ts).
 *  Matched rather than reproduced in full so a wording change here is one edit. */
const CLOCK_STAMP_PREFIX = "The current date and time is";

type InitializableAgent = ThinkThreadAgentType & {
  __unsafe_ensureInitialized(): Promise<void>;
};

type TestDb = DrizzleD1Database<typeof schema>;

type SandboxServiceTestableAgent = InitializableAgent & {
  _testSandboxServiceOverrides?: {
    buildBackend?: () => Promise<FakeComputeBackend>;
    now?: () => number;
    execForegroundTimeoutMs?: number;
    execForegroundPollIntervalMs?: number;
    sleep?: (ms: number) => Promise<void>;
  };
  resolveComputeServiceForTest(): Promise<{
    service: ThreadComputeService;
    workspaceId: string;
  } | null>;
  watcherCompletionsForTest(): TestMessage[];
};

type TelemetryTestableAgent = ThinkThreadAgent & {
  beforeTurnProbeForTest(messages?: ModelMessage[]): Promise<unknown>;
  telemetryEnabledForTest(): boolean | undefined;
};

type FeedbackRuntimeProbe = {
  provider?: string;
  modelId?: string;
  system?: string;
  activeTools?: string[];
  maxSteps?: number;
  messageText?: string;
};

async function seedSandboxEnabledWorkspace(workspaceId: string) {
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
    env,
    workspaceId,
    secretName: "sandbox:daytona",
    value: "dt_test_secret",
  });
}

const runInThinkDo = runInDurableObject as any;

type TestMessagePart = {
  type: string;
  state?: string;
  toolName?: string;
};

type TestMessage = {
  parts: TestMessagePart[];
  metadata?: unknown;
};

function flattenTestParts(messages: TestMessage[]): TestMessagePart[] {
  return messages.flatMap((message) => message.parts);
}

/** The threshold Session's auto-compaction check actually compares against — the
 * SDK's own private field, not a Nadi mirror of it. */
function sessionThreshold(agent: unknown): { _tokenThreshold?: number } {
  return (agent as { session: unknown }).session as { _tokenThreshold?: number };
}
const armedThreshold = (agent: unknown): number | undefined =>
  sessionThreshold(agent)._tokenThreshold;
const setArmedThreshold = (agent: unknown, value: number): void => {
  sessionThreshold(agent)._tokenThreshold = value;
};

async function ensureThreadLifecycleColumns() {
  const columns = await env.REGISTRY_DB.prepare("PRAGMA table_info(thread_index)").all<{
    name: string;
  }>();
  const names = new Set(columns.results.map((column) => column.name));

  if (!names.has("activity_status")) {
    await env.REGISTRY_DB.prepare(
      "ALTER TABLE thread_index ADD COLUMN activity_status text NOT NULL DEFAULT 'idle'",
    ).run();
  }
  if (!names.has("current_turn_started_at")) {
    await env.REGISTRY_DB.prepare(
      "ALTER TABLE thread_index ADD COLUMN current_turn_started_at integer",
    ).run();
  }
  if (!names.has("attention_required_at")) {
    await env.REGISTRY_DB.prepare(
      "ALTER TABLE thread_index ADD COLUMN attention_required_at integer",
    ).run();
  }
  if (!names.has("unread_outcome")) {
    await env.REGISTRY_DB.prepare("ALTER TABLE thread_index ADD COLUMN unread_outcome text").run();
  }
  if (!names.has("unread_outcome_at")) {
    await env.REGISTRY_DB.prepare(
      "ALTER TABLE thread_index ADD COLUMN unread_outcome_at integer",
    ).run();
  }
  if (!names.has("last_seen_at")) {
    await env.REGISTRY_DB.prepare("ALTER TABLE thread_index ADD COLUMN last_seen_at integer").run();
  }
}

async function seedProject(
  db: TestDb,
  input: {
    projectId: string;
    workspaceId: string;
    name: string;
    description?: string;
    customInstructions?: string;
    createdAt: number;
  },
) {
  await new ProjectRepository(db).create({
    id: input.projectId,
    workspaceId: input.workspaceId,
    name: input.name,
    description: input.description ?? "",
    customInstructions: input.customInstructions ?? "",
    createdAt: input.createdAt,
    updatedAt: input.createdAt,
  });
}

async function seedFeedbackRuntimeThread(input: {
  threadId: string;
  workspaceId: string;
  agentId: string;
  projectInstructions?: string;
}) {
  await seedRegistryThread(env.REGISTRY_DB, {
    workspaceId: input.workspaceId,
    agentId: input.agentId,
    threadId: input.threadId,
    runtime: "think",
    provider: "workers-ai",
    model: "@cf/meta/llama-3.1-8b-instruct",
  });
  const db = drizzle(env.REGISTRY_DB, { schema });
  if (input.projectInstructions) {
    await seedProject(db, {
      projectId: `${input.threadId}-project`,
      workspaceId: input.workspaceId,
      name: "Dispatch",
      customInstructions: input.projectInstructions,
      createdAt: 1_800_000_000_000,
    });
    await db
      .update(schema.threadIndex)
      .set({ projectId: `${input.threadId}-project` })
      .where(eq(schema.threadIndex.id, input.threadId));
  }
  await db
    .update(schema.threadIndex)
    .set({ kind: "feedback" })
    .where(eq(schema.threadIndex.id, input.threadId));
}

// Workbench repositories are now self-contained (no workspace-level catalog).
// Tests record intended repo config by id, then assign it to a workbench.
const workbenchRepoConfigs = new Map<string, WorkbenchRepositoryEntry>();

async function seedWorkspaceRepository(
  _db: TestDb,
  input: {
    repositoryId: string;
    workspaceId: string;
    name: string;
    url: string;
    defaultBranch: string;
    checkoutPathName: string;
    rootDirectory?: string;
    setupCommand?: string;
    packageManager?: string;
    createdAt: number;
  },
) {
  workbenchRepoConfigs.set(input.repositoryId, {
    source: "url",
    name: input.name,
    url: input.url,
    defaultBranch: input.defaultBranch,
    checkoutPathName: input.checkoutPathName,
    rootDirectory: input.rootDirectory ?? "",
    setupCommand: input.setupCommand ?? "",
    packageManager: input.packageManager ?? "",
  });
}

async function assignWorkbenchRepos(
  db: TestDb,
  input: { workbenchId: string; workspaceId: string; repositoryIds: string[]; createdAt: number },
) {
  const entries = input.repositoryIds.map((id) => {
    const entry = workbenchRepoConfigs.get(id);
    if (!entry) throw new Error(`unknown workbench repo config: ${id}`);
    return entry;
  });
  await new WorkbenchRepository(db).replaceRepositories(
    input.workbenchId,
    input.workspaceId,
    entries,
    input.createdAt,
  );
}

beforeAll(async () => {
  const db = drizzle(env.REGISTRY_DB, { schema });
  await applyRegistryTestSchema(env.REGISTRY_DB);
  await seedRegistryThread(env.REGISTRY_DB, {
    workspaceId: "workspace-think-hooks",
    agentId: "agent-think-hooks",
    threadId: "think-thread:hooks",
    provider: "mock",
    model: "mock",
  });
  await seedRegistryThread(env.REGISTRY_DB, {
    workspaceId: "workspace-think-provider-probe",
    agentId: "agent-think-provider-probe",
    threadId: "think-provider-probe",
    provider: "mock",
    model: "mock",
  });
  await seedRegistryThread(env.REGISTRY_DB, {
    workspaceId: "workspace-think-tool-probe",
    agentId: "agent-think-tool-probe",
    threadId: "think-tool-probe",
    provider: "mock",
    model: "mock",
  });
  await seedRegistryThread(env.REGISTRY_DB, {
    workspaceId: "workspace-think-tool-probe-enabled",
    agentId: "agent-think-tool-probe-enabled",
    threadId: "think-tool-probe-enabled",
    runtime: "think",
    provider: "mock",
    model: "mock",
  });
  await seedSandboxEnabledWorkspace("workspace-think-tool-probe-enabled");
  await seedRegistryThread(env.REGISTRY_DB, {
    workspaceId: "workspace-think-exec-quick",
    agentId: "agent-think-exec-quick",
    threadId: "think-exec-quick",
    runtime: "think",
    provider: "mock",
    model: "mock",
  });
  await seedSandboxEnabledWorkspace("workspace-think-exec-quick");
  await seedRegistryThread(env.REGISTRY_DB, {
    workspaceId: "workspace-think-exec-background",
    agentId: "agent-think-exec-background",
    threadId: "think-exec-background",
    runtime: "think",
    provider: "mock",
    model: "mock",
  });
  await seedSandboxEnabledWorkspace("workspace-think-exec-background");
  await seedRegistryThread(env.REGISTRY_DB, {
    workspaceId: "workspace-think-exec-background-disabled",
    agentId: "agent-think-exec-background-disabled",
    threadId: "think-exec-background-disabled",
    runtime: "think",
    provider: "mock",
    model: "mock",
  });
  await seedSandboxEnabledWorkspace("workspace-think-exec-background-disabled");
  await seedRegistryThread(env.REGISTRY_DB, {
    workspaceId: "workspace-think-skill-probe",
    agentId: "agent-think-skill-probe",
    threadId: "think-skill-probe",
    runtime: "think",
    provider: "mock",
    model: "mock",
  });
  await new AgentSkillRepository(drizzle(env.REGISTRY_DB, { schema })).create({
    workspaceId: "workspace-think-skill-probe",
    agentId: "agent-think-skill-probe",
    name: "deployment",
    description: "Deploy safely",
    body: "Use the deployment checklist.",
  });
  await seedRegistryThread(env.REGISTRY_DB, {
    workspaceId: "workspace-think-chat-smoke",
    agentId: "agent-think-chat-smoke",
    threadId: "think-chat-smoke",
    runtime: "think",
    provider: "mock",
    model: "mock",
  });
  await seedRegistryThread(env.REGISTRY_DB, {
    workspaceId: "workspace-think-mcp-warmup",
    agentId: "agent-think-mcp-warmup",
    threadId: "think-mcp-warmup",
    runtime: "think",
    provider: "mock",
    model: "mock",
  });
  await seedRegistryThread(env.REGISTRY_DB, {
    workspaceId: "workspace-think-mcp-warmup-block",
    agentId: "agent-think-mcp-warmup-block",
    threadId: "think-mcp-warmup-block",
    runtime: "think",
    provider: "mock",
    model: "mock",
  });
  await seedRegistryThread(env.REGISTRY_DB, {
    workspaceId: "workspace-think-registry-model",
    agentId: "agent-think-registry-model",
    threadId: "think-registry-model",
    runtime: "think",
    provider: "mock",
    model: "mock",
  });
  await seedRegistryThread(env.REGISTRY_DB, {
    workspaceId: "workspace-think-compaction",
    agentId: "agent-think-compaction",
    threadId: "think-compaction",
    runtime: "think",
    provider: "mock",
    model: "mock",
  });
  await seedRegistryThread(env.REGISTRY_DB, {
    workspaceId: "workspace-think-attachments",
    agentId: "agent-think-attachments",
    threadId: "think-attachment-prep",
    runtime: "think",
    provider: "openai-oauth",
    model: "gpt-5.4-mini",
  });
  await drizzle(env.REGISTRY_DB, { schema })
    .insert(schema.attachments)
    .values({
      id: "think-img-1",
      workspaceId: "workspace-think-attachments",
      threadId: "think-attachment-prep",
      mimeType: "image/png",
      byteSize: 3,
      width: 10,
      height: 10,
      r2Key: "workspace-think-attachments/think-attachment-prep/think-img-1.png",
      status: "committed",
      createdAt: 1_800_000_000_000,
    })
    .onConflictDoNothing();
  await seedRegistryThread(env.REGISTRY_DB, {
    workspaceId: "workspace-think-mcp-approval",
    agentId: "agent-think-mcp-approval",
    threadId: "think-mcp-approval",
    runtime: "think",
    provider: "mock-tool-call",
    model: "mock-tool-call",
  });
  await seedRegistryThread(env.REGISTRY_DB, {
    workspaceId: "workspace-think-mcp-auto",
    agentId: "agent-think-mcp-auto",
    threadId: "think-mcp-auto",
    runtime: "think",
    provider: "mock-tool-call",
    model: "mock-tool-call",
  });
  await seedRegistryThread(env.REGISTRY_DB, {
    workspaceId: "workspace-think-tool-cap",
    agentId: "agent-think-tool-cap",
    threadId: "think-tool-cap",
    runtime: "think",
    provider: "mock-tool-call",
    model: "mock-tool-call",
  });
  await seedRegistryThread(env.REGISTRY_DB, {
    workspaceId: "workspace-think-mcp-deny",
    agentId: "agent-think-mcp-deny",
    threadId: "think-mcp-deny",
    runtime: "think",
    provider: "mock-tool-call",
    model: "mock-tool-call",
  });
  await seedRegistryThread(env.REGISTRY_DB, {
    workspaceId: "workspace-think-queue",
    agentId: "agent-think-queue",
    threadId: "think-queue",
    runtime: "think",
    provider: "mock",
    model: "mock",
  });
  await seedRegistryThread(env.REGISTRY_DB, {
    workspaceId: "workspace-think-queue-attachments",
    agentId: "agent-think-queue-attachments",
    threadId: "think-queue-attachments",
    runtime: "think",
    provider: "mock",
    model: "mock",
  });
  await env.ATTACHMENTS_BUCKET.put(
    "workspace-think-queue-attachments/think-queue-attachments/queued-img.png",
    new Uint8Array([1, 2, 3]),
  );
  await db
    .insert(schema.attachments)
    .values({
      id: "queued-img",
      workspaceId: "workspace-think-queue-attachments",
      threadId: "think-queue-attachments",
      mimeType: "image/png",
      byteSize: 3,
      width: 1,
      height: 1,
      r2Key: "workspace-think-queue-attachments/think-queue-attachments/queued-img.png",
      status: "pending",
      createdAt: 1,
    })
    .onConflictDoNothing();

  const promptCreatedAt = 1_800_000_100_100;
  await seedRegistryThread(env.REGISTRY_DB, {
    workspaceId: "workspace-think-project-context",
    agentId: "agent-think-project-context",
    threadId: "think-project-context-unassigned",
    runtime: "think",
    provider: "mock",
    model: "mock",
    projectId: null,
    createdAt: promptCreatedAt,
    updatedAt: promptCreatedAt,
  });
  await seedRegistryThread(env.REGISTRY_DB, {
    workspaceId: "workspace-think-project-context",
    agentId: "agent-think-project-context",
    threadId: "think-project-context-assigned",
    runtime: "think",
    provider: "mock",
    model: "mock",
    projectId: "project-think-context",
    createdAt: promptCreatedAt + 1,
    updatedAt: promptCreatedAt + 1,
  });
  await seedRegistryThread(env.REGISTRY_DB, {
    workspaceId: "workspace-think-project-context",
    agentId: "agent-think-project-context",
    threadId: "think-project-context-archived",
    runtime: "think",
    provider: "mock",
    model: "mock",
    projectId: "project-think-archived",
    createdAt: promptCreatedAt + 2,
    updatedAt: promptCreatedAt + 2,
  });
  await seedProject(db, {
    projectId: "project-think-context",
    workspaceId: "workspace-think-project-context",
    name: "Nadi",
    description: "Main app",
    customInstructions: "Prefer focused tests.",
    createdAt: promptCreatedAt,
  });
  await seedProject(db, {
    projectId: "project-think-archived",
    workspaceId: "workspace-think-project-context",
    name: "Archived Nadi",
    description: "Archived app",
    customInstructions: "Keep archived context available.",
    createdAt: promptCreatedAt,
  });
  await seedWorkspaceRepository(db, {
    repositoryId: "repo-think-snapshot",
    workspaceId: "workspace-think-project-context",
    name: "nadi",
    url: "https://github.com/acme/nadi.git",
    defaultBranch: "main",
    checkoutPathName: "nadi",
    rootDirectory: "/",
    setupCommand: "pnpm install",
    packageManager: "pnpm",
    createdAt: promptCreatedAt,
  });
  await seedWorkspaceRepository(db, {
    repositoryId: "repo-think-current",
    workspaceId: "workspace-think-project-context",
    name: "other-repo",
    url: "https://github.com/acme/other-repo.git",
    defaultBranch: "develop",
    checkoutPathName: "other-repo",
    rootDirectory: "apps/other",
    setupCommand: "npm install",
    packageManager: "npm",
    createdAt: promptCreatedAt,
  });
  await new WorkbenchRepository(db).create({
    id: "env-think-context",
    workspaceId: "workspace-think-project-context",
    name: "Think context env",
    description: "",
    setupScript: "",
    sandboxEnvVarsJson: "{}",
    createdAt: promptCreatedAt,
    updatedAt: promptCreatedAt,
  });
  await new WorkbenchRepository(db).create({
    id: "env-think-archived",
    workspaceId: "workspace-think-project-context",
    name: "Think archived env",
    description: "",
    setupScript: "",
    sandboxEnvVarsJson: "{}",
    createdAt: promptCreatedAt,
    updatedAt: promptCreatedAt,
  });
  await assignWorkbenchRepos(db, {
    workbenchId: "env-think-context",
    workspaceId: "workspace-think-project-context",
    repositoryIds: ["repo-think-snapshot"],
    createdAt: promptCreatedAt,
  });
  await assignWorkbenchRepos(db, {
    workbenchId: "env-think-archived",
    workspaceId: "workspace-think-project-context",
    repositoryIds: ["repo-think-snapshot"],
    createdAt: promptCreatedAt,
  });
  await new ThreadRepositorySnapshotRepository(db).replaceFromWorkbench(
    "think-project-context-assigned",
    "workspace-think-project-context",
    "env-think-context",
    promptCreatedAt + 1,
  );
  await new ThreadRepositorySnapshotRepository(db).replaceFromWorkbench(
    "think-project-context-archived",
    "workspace-think-project-context",
    "env-think-archived",
    promptCreatedAt + 2,
  );
  await new ProjectRepository(db).update("project-think-context", {
    customInstructions: "Use the latest project instructions.",
    updatedAt: promptCreatedAt + 10,
  });
  // Reassign the workbench's live repositories after the snapshot was taken:
  // the snapshot must stay immutable and not pick up this change.
  await assignWorkbenchRepos(db, {
    workbenchId: "env-think-context",
    workspaceId: "workspace-think-project-context",
    repositoryIds: ["repo-think-current"],
    createdAt: promptCreatedAt + 11,
  });
  await new ProjectRepository(db).archive("project-think-archived", promptCreatedAt + 12);
});

describe("ThinkThreadAgent spike", () => {
  it("instantiates and exposes runtime identity", async () => {
    const stub = env.THINK_THREAD_AGENT.get(env.THINK_THREAD_AGENT.idFromName("think-thread:test"));
    const result = await runInDurableObject(stub, async (instance: ThinkThreadAgent) =>
      instance.ping(),
    );
    expect(result).toBe("think:ok");
  });

  it("reports Think hook compatibility", async () => {
    const stub = env.THINK_THREAD_AGENT.get(
      env.THINK_THREAD_AGENT.idFromName("think-thread:hooks"),
    );
    const result = await runInDurableObject(stub, async (instance: ThinkThreadAgent) =>
      instance.compatibilityReport(),
    );
    expect(result.hasBeforeTurn).toBe(true);
    expect(result.hasConfigureSession).toBe(true);
    expect(result.hasGetSkills).toBe(true);
    expect(result.hasGetTools).toBe(true);
    expect(result.hasSessionMemory).toBe(true);
    expect(result.hasSkillsSource).toBe(true);
    expect(result.workspaceBash).toBe(false);
  });

  it("reports provider configuration for a registered thread", async () => {
    const stub = env.THINK_THREAD_AGENT.get(
      env.THINK_THREAD_AGENT.idFromName("think-provider-probe"),
    );
    const result = await runInDurableObject(stub, async (instance: ThinkThreadAgent) =>
      instance.providerProbeForTest(),
    );
    expect(result).toEqual({
      workspaceId: "workspace-think-provider-probe",
      agentId: "agent-think-provider-probe",
      provider: "mock",
      model: "mock",
    });
  });

  it("routes feedback threads to the hard-coded interviewer runtime before ordinary setup", async () => {
    const threadId = "feedback-runtime-probe";
    await seedFeedbackRuntimeThread({
      threadId,
      workspaceId: "workspace-feedback-runtime-probe",
      agentId: "agent-feedback-runtime-probe",
      projectInstructions: "Project instructions should never reach feedback mode.",
    });
    (env as { AI: unknown }).AI = { run: async () => ({}) };
    const stub = env.THINK_THREAD_AGENT.get(env.THINK_THREAD_AGENT.idFromName(threadId));

    const probe = (await runInDurableObject(stub, async (_instance, state) => {
      const agent = new ThinkThreadAgent(state, env);
      return agent.beforeTurnProbeForTest([{ role: "user", content: "The archive flickers" }]);
    })) as FeedbackRuntimeProbe;

    expect(probe).toMatchObject({
      provider: FEEDBACK_MODEL_PROVIDER,
      modelId: FEEDBACK_MODEL_ID,
      activeTools: ["prepare_feedback_report"],
      maxSteps: 8,
    });
    expect(probe.system).toContain("Gather the smallest reproducible report");
    expect(probe.system).not.toContain("Project instructions");
  });

  it("sends only the stored active feedback interview bounds to the model", async () => {
    const threadId = "feedback-segment-probe";
    await seedFeedbackRuntimeThread({
      threadId,
      workspaceId: "workspace-feedback-segment-probe",
      agentId: "agent-feedback-segment-probe",
    });
    (env as { AI: unknown }).AI = { run: async () => ({}) };
    const stub = env.THINK_THREAD_AGENT.get(env.THINK_THREAD_AGENT.idFromName(threadId));

    const probe = (await runInDurableObject(stub, async (_instance, state) => {
      const agent = new ThinkThreadAgent(state, env);
      await agent.createManualFeedbackDraft({
        interviewId: "fbi_old",
        fromMessageId: "msg_old_1",
        fields: {
          category: "bug",
          title: "Old report",
          narrative: "Already submitted.",
          reproductionSteps: [],
          expectedBehavior: null,
          actualBehavior: null,
          frequency: null,
          impact: null,
        },
        attachmentIds: [],
      });
      await agent.startFeedbackInterviewForTest({
        interviewId: "fbi_new",
        fromMessageId: "msg_new_1",
      });
      const messages = [
        {
          id: "msg_old_1",
          role: "user",
          content: "[feedback-interview:fbi_new] Old user-authored marker",
        },
        { role: "assistant", content: "Old draft prepared." },
        { id: "msg_new_1", role: "user", content: "New export flicker" },
        { role: "assistant", content: "Can you share the smallest repro?" },
        { role: "user", content: "Open exports, then refresh." },
      ] satisfies Array<ModelMessage & { id?: string }>;
      return agent.beforeTurnProbeForTest(messages);
    })) as FeedbackRuntimeProbe;

    expect(probe.messageText).toContain("New export flicker");
    expect(probe.messageText).toContain("Open exports, then refresh.");
    expect(probe.messageText).not.toContain("Old user-authored marker");
  });

  it("exports submitted feedback bounds by interview after newer drafts replace the active draft", async () => {
    const threadId = "feedback-export-bounds";
    await seedFeedbackRuntimeThread({
      threadId,
      workspaceId: "workspace-feedback-export-bounds",
      agentId: "agent-feedback-export-bounds",
    });
    const stub = env.THINK_THREAD_AGENT.get(env.THINK_THREAD_AGENT.idFromName(threadId));

    const result = (await runInDurableObject(stub, async (_instance, state) => {
      const agent = new ThinkThreadAgent(state, env);
      const agentWithSession = agent as unknown as {
        session: {
          getHistoryRowStats: () => Promise<Array<{ id: string }>>;
          getMessage: (id: string) => Promise<{ id: string; role: string; content: string } | null>;
        };
      };
      const messages = new Map([
        ["msg_old_1", { id: "msg_old_1", role: "user", content: "Old report" }],
        ["msg_old_2", { id: "msg_old_2", role: "assistant", content: "Old draft" }],
        ["msg_new_1", { id: "msg_new_1", role: "user", content: "New report" }],
        ["msg_new_2", { id: "msg_new_2", role: "assistant", content: "New draft" }],
      ]);
      let historyRows = [{ id: "msg_old_1" }, { id: "msg_old_2" }];
      agentWithSession.session = {
        getHistoryRowStats: async () => historyRows,
        getMessage: async (id) => messages.get(id) ?? null,
      };

      await agent.createManualFeedbackDraft({
        interviewId: "fbi_old",
        fromMessageId: "msg_old_1",
        fields: {
          category: "bug",
          title: "Old report",
          narrative: "Already submitted.",
          reproductionSteps: [],
          expectedBehavior: null,
          actualBehavior: null,
          frequency: null,
          impact: null,
        },
        attachmentIds: [],
      });
      historyRows = [
        { id: "msg_old_1" },
        { id: "msg_old_2" },
        { id: "msg_new_1" },
        { id: "msg_new_2" },
      ];
      await agent.createManualFeedbackDraft({
        interviewId: "fbi_new",
        fromMessageId: "msg_new_1",
        fields: {
          category: "feature",
          title: "New report",
          narrative: "A newer draft replaced the active draft.",
          reproductionSteps: [],
          expectedBehavior: null,
          actualBehavior: null,
          frequency: null,
          impact: null,
        },
        attachmentIds: [],
      });

      const oldMessages = await agent.exportSubmittedFeedbackInterview({
        interviewId: "fbi_old",
        fromMessageId: "msg_old_1",
        toMessageId: "msg_old_2",
      });
      let crossInterviewError = "";
      try {
        await agent.exportSubmittedFeedbackInterview({
          interviewId: "fbi_new",
          fromMessageId: "msg_old_1",
          toMessageId: "msg_old_2",
        });
      } catch (error) {
        crossInterviewError = error instanceof Error ? error.message : String(error);
      }
      let reversedError = "";
      try {
        await agent.exportSubmittedFeedbackInterview({
          interviewId: "fbi_old",
          fromMessageId: "msg_old_2",
          toMessageId: "msg_old_1",
        });
      } catch (error) {
        reversedError = error instanceof Error ? error.message : String(error);
      }
      return { oldMessages, crossInterviewError, reversedError };
    })) as {
      oldMessages: Array<{ id: string }>;
      crossInterviewError: string;
      reversedError: string;
    };

    expect(result.oldMessages.map((message) => message.id)).toEqual(["msg_old_1", "msg_old_2"]);
    expect(result.crossInterviewError).toBe("feedback_interview_bounds_mismatch");
    expect(result.reversedError).toBe("feedback_interview_bounds_reversed");
  });

  it("can inspect server-side tool names", async () => {
    const stub = env.THINK_THREAD_AGENT.get(env.THINK_THREAD_AGENT.idFromName("think-tool-probe"));
    const result = await runInDurableObject(stub, async (instance: ThinkThreadAgent) =>
      instance.toolProbeForTest(),
    );
    expect(result).toEqual(
      expect.arrayContaining([
        "forget_memory",
        "remember",
        "search_memories",
        "update_memory",
        "create_skill",
        "delete_skill",
        "edit_skill",
        "getAttachmentUrl",
        "listAttachments",
      ]),
    );
    // Naming is server-side now (auto-name-thread.ts) -- the model is never offered the tool.
    expect(result).not.toContain("nameNewConversation");
    expect(result).not.toContain("set_skill_enabled");
    expect(result).not.toContain("run_skill_script");
  });

  it("can inspect Think skill sources", async () => {
    const stub = env.THINK_THREAD_AGENT.get(env.THINK_THREAD_AGENT.idFromName("think-skill-probe"));
    const result = await runInDurableObject(stub, async (instance: ThinkThreadAgent) =>
      instance.skillProbeForTest(),
    );

    expect(result.sourceIds).toEqual(["nadi-built-in-skills", "nadi-agent-skills"]);
    expect(result.catalog).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ name: "skill_authoring" }),
        expect.objectContaining({ name: "deployment", description: "Deploy safely" }),
      ]),
    );
    expect(result.skillAuthoringBody).toContain("create_skill");
    expect(result.deploymentBody).toBe("Use the deployment checklist.");
  });

  it("includes Think skill activation tools in assembled turns", async () => {
    const stub = env.THINK_THREAD_AGENT.get(env.THINK_THREAD_AGENT.idFromName("think-skill-probe"));
    const result = await runInDurableObject(stub, async (instance: ThinkThreadAgent) => {
      await (instance as InitializableAgent).__unsafe_ensureInitialized();
      await instance.runTurn({ input: "Use the deployment skill" });
      return instance.beforeTurnToolNamesForTest();
    });

    expect(result).toEqual(
      expect.arrayContaining([
        "activate_skill",
        "read_skill_resource",
        "create_skill",
        "edit_skill",
        "delete_skill",
      ]),
    );
    expect(result).not.toContain("run_skill_script");
  });

  it("hides the built-in workspace file tools from the model", async () => {
    const stub = env.THINK_THREAD_AGENT.get(env.THINK_THREAD_AGENT.idFromName("think-skill-probe"));
    const result = await runInDurableObject(stub, async (instance: ThinkThreadAgent) => {
      await (instance as InitializableAgent).__unsafe_ensureInitialized();
      await instance.runTurn({ input: "List my files" });
      return {
        merged: instance.beforeTurnToolNamesForTest(),
        active: instance.beforeTurnActiveToolsForTest(),
      };
    });

    // Think merges the workspace tools into the raw turn set (so the guard is
    // meaningful)...
    expect(result.merged).toEqual(
      expect.arrayContaining(["read", "write", "edit", "list", "find", "grep", "delete"]),
    );
    // ...but they must be filtered out of the model-facing allowlist, while
    // native tools stay callable.
    for (const name of ["read", "write", "edit", "list", "find", "grep", "delete", "bash"]) {
      expect(result.active).not.toContain(name);
    }
    expect(result.active).toEqual(expect.arrayContaining(["listAttachments", "create_skill"]));
  });

  it("winds down tools and appends the summarize directive on the final tool step", async () => {
    const stub = env.THINK_THREAD_AGENT.get(env.THINK_THREAD_AGENT.idFromName("think-skill-probe"));
    const result = await runInDurableObject(stub, async (instance: ThinkThreadAgent) => {
      await (instance as InitializableAgent).__unsafe_ensureInitialized();
      instance._testMaxToolSteps = 4;
      // Populate currentTurnWindDownSystem with the real composed prompt.
      await instance.beforeTurnProbeForTest();
      const early = await instance.beforeStep({ stepNumber: 1 } as never);
      const final = await instance.beforeStep({ stepNumber: 3 } as never);
      instance._testMaxToolSteps = undefined;
      return { early, final };
    });

    // Non-final steps keep the normal tool loop untouched.
    expect(result.early).toBeUndefined();
    // The final allowed step strips tools and tells the model to summarize.
    expect(result.final?.activeTools).toEqual([]);
    expect(result.final?.system).toContain("reached the tool-call limit");
  });

  // Regression guard: several probes drive beforeTurn on a DO Think never handed
  // a session to. An unguarded `this.session.*` throws mid-hook and silently
  // un-exercises everything below it (prompt assembly, model resolution, tool
  // gating) for every test in this suite. Force the session-less shape so the
  // guard is asserted directly instead of depending on harness timing.
  it("runs beforeTurn end to end with no session (no unguarded this.session access)", async () => {
    const stub = env.THINK_THREAD_AGENT.get(
      env.THINK_THREAD_AGENT.idFromName("think-registry-model"),
    );
    const result = await runInDurableObject(stub, async (instance: ThinkThreadAgent) => {
      await (instance as InitializableAgent).__unsafe_ensureInitialized();
      const holder = instance as unknown as { session?: unknown };
      const saved = holder.session;
      holder.session = undefined;
      try {
        return await instance.beforeTurnProbeForTest();
      } finally {
        holder.session = saved;
      }
    });
    // beforeTurn ran to the end: it returns the assembled turn config.
    expect(result).toBeDefined();
  });

  it("resolves process monitoring from BACKGROUND_WORK_ENABLED", async () => {
    const previous = featureEnv.BACKGROUND_WORK_ENABLED;
    const stub = env.THINK_THREAD_AGENT.get(
      // This direct probe deliberately has no workspace config pin. Other
      // tests use think-registry-model for full turns, which correctly pins
      // its workspace decision for the lifetime of that turn.
      env.THINK_THREAD_AGENT.idFromName("think-background-work-flag-probe"),
    );

    try {
      featureEnv.BACKGROUND_WORK_ENABLED = "";
      const disabled = await runInDurableObject(stub, async (instance: ThinkThreadAgent) =>
        (instance as any).processMonitorEnabledForTest(),
      );
      featureEnv.BACKGROUND_WORK_ENABLED = "true";
      const enabled = await runInDurableObject(stub, async (instance: ThinkThreadAgent) =>
        (instance as any).processMonitorEnabledForTest(),
      );
      expect({ disabled, enabled }).toEqual({ disabled: false, enabled: true });
    } finally {
      featureEnv.BACKGROUND_WORK_ENABLED = previous;
    }
  });

  it.each([
    { flag: "", expected: false },
    { flag: "true", expected: true },
  ])(
    "keeps process monitoring, subagent admission, and exec mode aligned when BACKGROUND_WORK_ENABLED is %j",
    async ({ flag, expected }) => {
      const previous = featureEnv.BACKGROUND_WORK_ENABLED;
      const stub = env.THINK_THREAD_AGENT.get(
        env.THINK_THREAD_AGENT.idFromName("think-background-work-capability"),
      );

      try {
        featureEnv.BACKGROUND_WORK_ENABLED = flag;
        const probe = await runInDurableObject(stub, async (instance: ThinkThreadAgent) => {
          const testInstance = instance as unknown as {
            processMonitorEnabled(): boolean;
            subagentSpawnEnabled(): boolean;
            sandboxHostDeps(): { backgroundLongRunningExec?: boolean };
          };
          return {
            processMonitorEnabled: testInstance.processMonitorEnabled(),
            subagentSpawnEnabled: testInstance.subagentSpawnEnabled(),
            backgroundLongRunningExec: testInstance.sandboxHostDeps().backgroundLongRunningExec,
          };
        });

        expect(probe.processMonitorEnabled).toBe(expected);
        expect(probe.subagentSpawnEnabled).toBe(expected);
        expect(probe.backgroundLongRunningExec).toBe(expected);
      } finally {
        featureEnv.BACKGROUND_WORK_ENABLED = previous;
      }
    },
  );

  it("runs long exec synchronously without watchers when background work is disabled", async () => {
    const previous = featureEnv.BACKGROUND_WORK_ENABLED;
    const stub = env.THINK_THREAD_AGENT.get(
      env.THINK_THREAD_AGENT.idFromName("think-exec-background-disabled"),
    );

    try {
      featureEnv.BACKGROUND_WORK_ENABLED = "";
      const result = await runInDurableObject(stub, async (instance: ThinkThreadAgent) => {
        const testInstance = instance as SandboxServiceTestableAgent;
        await testInstance.__unsafe_ensureInitialized();
        const provider = new FakeComputeBackend();
        let now = 1000;
        try {
          testInstance._testSandboxServiceOverrides = {
            buildBackend: async () => provider,
            now: () => now,
            execForegroundTimeoutMs: 1,
            execForegroundPollIntervalMs: 1,
            sleep: async (ms) => {
              now += ms;
            },
          };
          const resolved = await testInstance.resolveComputeServiceForTest();
          if (!resolved) throw new Error("expected sandbox service");
          const execResult = await resolved.service.exec({ command: "sleep 300", label: "build" });
          return {
            backgroundLongRunningExec: (
              resolved.service as unknown as { deps: { backgroundLongRunningExec?: boolean } }
            ).deps.backgroundLongRunningExec,
            execResult,
            activeWatchers: resolved.service.listActiveWatchersView(),
            runCommandCalls: provider.runCommandCalls,
            startProcessCalls: provider.startProcessCalls,
          };
        } finally {
          delete testInstance._testSandboxServiceOverrides;
        }
      });

      expect(result.execResult).toMatchObject({
        ok: true,
        status: "exited",
        command: "sleep 300",
        label: "build",
      });
      expect(result.backgroundLongRunningExec).toBe(false);
      expect(result.activeWatchers).toEqual([]);
      expect(result.runCommandCalls).toEqual([{ command: "sleep 300", cwd: "/workspace" }]);
      expect(result.startProcessCalls).toEqual([]);
    } finally {
      featureEnv.BACKGROUND_WORK_ENABLED = previous;
    }
  });

  it("removes both subagent tools when background work is disabled", async () => {
    const previous = featureEnv.BACKGROUND_WORK_ENABLED;
    const stub = env.THINK_THREAD_AGENT.get(
      env.THINK_THREAD_AGENT.idFromName("think-registry-model"),
    );

    try {
      featureEnv.BACKGROUND_WORK_ENABLED = "";
      const disabled = await runInDurableObject(stub, async (instance: ThinkThreadAgent) =>
        instance.beforeTurnProbeForTest(),
      );
      featureEnv.BACKGROUND_WORK_ENABLED = "true";
      const enabled = await runInDurableObject(stub, async (instance: ThinkThreadAgent) =>
        instance.beforeTurnProbeForTest(),
      );
      expect((disabled as FeedbackRuntimeProbe).activeTools).not.toContain("spawn_subagent");
      expect((disabled as FeedbackRuntimeProbe).activeTools).not.toContain("check_subagents");
      expect((enabled as FeedbackRuntimeProbe).activeTools).toEqual(
        expect.arrayContaining(["spawn_subagent", "check_subagents"]),
      );
    } finally {
      featureEnv.BACKGROUND_WORK_ENABLED = previous;
    }
  });

  it("rejects direct subagent dispatch before provisioning or ledger writes", async () => {
    const previous = featureEnv.BACKGROUND_WORK_ENABLED;
    featureEnv.BACKGROUND_WORK_ENABLED = "";
    const stub = env.THINK_THREAD_AGENT.get(
      env.THINK_THREAD_AGENT.idFromName("background-work-disabled-direct"),
    );

    try {
      const result = await runInDurableObject(stub, async (instance: ThinkThreadAgent) => {
        const dispatch = await instance.debugSpawnSubagent("must not start", "disabled");
        const state = await instance.debugSubagentState();
        return { dispatch, state };
      });
      expect(result).toEqual({
        dispatch: { error: "background_work_disabled" },
        state: { timings: {}, leases: [] },
      });
    } finally {
      featureEnv.BACKGROUND_WORK_ENABLED = previous;
    }
  });

  it("re-resolves a workspace override before direct subagent dispatch", async () => {
    const previous = featureEnv.BACKGROUND_WORK_ENABLED;
    featureEnv.BACKGROUND_WORK_ENABLED = "true";
    const workspaceId = "workspace-think-exec-background-disabled";
    const stub = env.THINK_THREAD_AGENT.get(
      env.THINK_THREAD_AGENT.idFromName("think-exec-background-disabled"),
    );

    try {
      const result = await runInDurableObject(stub, async (instance: ThinkThreadAgent) => {
        // Prime the per-wake cache with the inherited deployment value, then
        // simulate an administrator disabling background work before a direct RPC.
        await instance.resolveRuntimeConfigForThink();
        await drizzle(env.REGISTRY_DB, { schema })
          .update(schema.workspaces)
          .set({ flagsJson: '{"backgroundWork":false}' })
          .where(eq(schema.workspaces.id, workspaceId));
        return instance.debugSpawnSubagent("must not start", "workspace disabled");
      });
      expect(result).toEqual({ error: "background_work_disabled" });
    } finally {
      await drizzle(env.REGISTRY_DB, { schema })
        .update(schema.workspaces)
        .set({ flagsJson: "{}" })
        .where(eq(schema.workspaces.id, workspaceId));
      featureEnv.BACKGROUND_WORK_ENABLED = previous;
    }
  });

  it("uses the workspace override for out-of-turn exec and watcher admission", async () => {
    const previous = featureEnv.BACKGROUND_WORK_ENABLED;
    featureEnv.BACKGROUND_WORK_ENABLED = "true";
    const workspaceId = "workspace-think-exec-background";
    const stub = env.THINK_THREAD_AGENT.get(
      env.THINK_THREAD_AGENT.idFromName("think-exec-background"),
    );

    try {
      const result = await runInDurableObject(stub, async (instance: ThinkThreadAgent) => {
        const testInstance = instance as SandboxServiceTestableAgent & {
          backgroundCapabilitiesForTest(): Promise<{
            backgroundExec: boolean;
            subagents: boolean;
          }>;
        };
        await instance.resolveRuntimeConfigForThink();
        await drizzle(env.REGISTRY_DB, { schema })
          .update(schema.workspaces)
          .set({ flagsJson: '{"backgroundWork":false}' })
          .where(eq(schema.workspaces.id, workspaceId));
        const resolved = await testInstance.resolveComputeServiceForTest();
        if (!resolved) throw new Error("expected sandbox service");
        return {
          watcherAdmission: (await testInstance.backgroundCapabilitiesForTest()).backgroundExec,
          backstop: await instance.debugRunBackstop(),
          execAdmission: (
            resolved.service as unknown as {
              deps: { backgroundLongRunningExec?: boolean };
            }
          ).deps.backgroundLongRunningExec,
        };
      });
      expect(result).toEqual({
        watcherAdmission: false,
        backstop: { attached: [], watchers: [], runningProcesses: [] },
        execAdmission: false,
      });
    } finally {
      await drizzle(env.REGISTRY_DB, { schema })
        .update(schema.workspaces)
        .set({ flagsJson: "{}" })
        .where(eq(schema.workspaces.id, workspaceId));
      featureEnv.BACKGROUND_WORK_ENABLED = previous;
    }
  });

  // The IN-TURN pair, pinned against a MIXED config. The out-of-turn admission
  // test below cannot catch these: it reads the compute deps through
  // `resolveComputeServiceForTest`, which passes admission explicitly and so
  // never consults `processMonitorEnabled()`. Without this, both getters could
  // collapse back onto one field and every other test would still pass.
  it("reads a different capability field in each in-turn gate", async () => {
    const stub = env.THINK_THREAD_AGENT.get(
      env.THINK_THREAD_AGENT.idFromName("think-capability-getters"),
    );
    const read = async (backgroundExecEnabled: boolean, subagentsEnabled: boolean) =>
      runInDurableObject(stub, async (instance: ThinkThreadAgent) => {
        (instance as any)._turnRuntimeConfig = { backgroundExecEnabled, subagentsEnabled };
        return {
          exec: (instance as any).processMonitorEnabledForTest(),
          subagents: (instance as any).subagentSpawnEnabledForTest(),
        };
      });

    // Subagents only: the exec gate must be closed and the subagent gate open.
    expect(await read(false, true)).toEqual({ exec: false, subagents: true });
    // And the reverse, so neither getter can be hard-wired to one field.
    expect(await read(true, false)).toEqual({ exec: true, subagents: false });
  });

  // The reason the capabilities are separate at all: a workspace can want
  // subagents without leaving processes alive past the turn. Driven end to end
  // through the real DO — the resolver's own unit tests prove the precedence, but
  // only this proves the two halves of the AGENT read different fields.
  it("admits subagents while refusing backgrounded exec, from one workspace's flags", async () => {
    const previous = featureEnv.BACKGROUND_WORK_ENABLED;
    featureEnv.BACKGROUND_WORK_ENABLED = "";
    const workspaceId = "workspace-think-exec-background";
    const stub = env.THINK_THREAD_AGENT.get(
      env.THINK_THREAD_AGENT.idFromName("think-exec-background"),
    );

    try {
      const result = await runInDurableObject(stub, async (instance: ThinkThreadAgent) => {
        const testInstance = instance as SandboxServiceTestableAgent & {
          backgroundCapabilitiesForTest(): Promise<{
            backgroundExec: boolean;
            subagents: boolean;
          }>;
        };
        await instance.resolveRuntimeConfigForThink();
        await drizzle(env.REGISTRY_DB, { schema })
          .update(schema.workspaces)
          .set({ flagsJson: '{"backgroundWork":true,"backgroundExec":false}' })
          .where(eq(schema.workspaces.id, workspaceId));
        const capabilities = await testInstance.backgroundCapabilitiesForTest();
        const resolved = await testInstance.resolveComputeServiceForTest();
        return {
          capabilities,
          // The compute layer must agree: with exec refused, a long-running
          // command may not detach.
          execBackgrounding: resolved
            ? (
                resolved.service as unknown as {
                  deps: { backgroundLongRunningExec?: boolean };
                }
              ).deps.backgroundLongRunningExec
            : undefined,
          // The exec-only RPC must refuse for exactly this reason, while the
          // kind-agnostic dock read still answers (a subagent row belongs in it).
          push: await instance.reportProcessCompletion({ processId: "proc_nope", exitCode: 0 }),
          dockReadable: Array.isArray(await instance.listBackgroundWork()),
        };
      });

      expect(result.capabilities).toEqual({ backgroundExec: false, subagents: true });
      expect(result.execBackgrounding).toBe(false);
      expect(result.push).toEqual({ accepted: false, reason: "background_work_disabled" });
      expect(result.dockReadable).toBe(true);
    } finally {
      await drizzle(env.REGISTRY_DB, { schema })
        .update(schema.workspaces)
        .set({ flagsJson: "{}" })
        .where(eq(schema.workspaces.id, workspaceId));
      featureEnv.BACKGROUND_WORK_ENABLED = previous;
    }
  });

  // The MIRROR of the test above, and the shape a real rollout uses: deployment
  // flag off, one workspace opted in. `backgroundWorkAdmissionEnabled` used to
  // short-circuit on the deployment flag BEFORE reading workspace state, so every
  // OUT-OF-TURN consumer was refused while the in-turn path happily backgrounded
  // work. Observed in production (2026-08-12): the dock's `listBackgroundWork`
  // returned [] so it never rendered, and `reportProcessCompletion` rejected every
  // pushed callback as `background_work_disabled` — completions silently fell back
  // to the 60s backstop poll, which made the push look like it worked.
  it("honours a workspace opt-in when the deployment flag is off", async () => {
    const previous = featureEnv.BACKGROUND_WORK_ENABLED;
    featureEnv.BACKGROUND_WORK_ENABLED = "";
    const workspaceId = "workspace-think-exec-background";
    const stub = env.THINK_THREAD_AGENT.get(
      env.THINK_THREAD_AGENT.idFromName("think-exec-background"),
    );

    try {
      const admission = await runInDurableObject(stub, async (instance: ThinkThreadAgent) => {
        const testInstance = instance as SandboxServiceTestableAgent & {
          backgroundCapabilitiesForTest(): Promise<{
            backgroundExec: boolean;
            subagents: boolean;
          }>;
        };
        await instance.resolveRuntimeConfigForThink();
        await drizzle(env.REGISTRY_DB, { schema })
          .update(schema.workspaces)
          .set({ flagsJson: '{"backgroundWork":true}' })
          .where(eq(schema.workspaces.id, workspaceId));
        return testInstance.backgroundCapabilitiesForTest();
      });
      // The legacy key still means BOTH, so a workspace that opted in before the
      // capabilities were split keeps exactly what it had.
      expect(admission).toEqual({ backgroundExec: true, subagents: true });
    } finally {
      await drizzle(env.REGISTRY_DB, { schema })
        .update(schema.workspaces)
        .set({ flagsJson: "{}" })
        .where(eq(schema.workspaces.id, workspaceId));
      featureEnv.BACKGROUND_WORK_ENABLED = previous;
    }
  });

  // The guard for what the removed short-circuit used to provide for free. An
  // unregistered thread cannot resolve a runtime config — `resolveRuntimeConfig
  // ForThink` throws `thread_agent_not_registered` — and admission must still
  // answer `false` rather than propagate that throw. A throw here is worse than a
  // wrong answer: in a DO RPC it also fires an unhandled rejection.
  it("fails closed, without throwing, when the thread has no registered agent", async () => {
    const previous = featureEnv.BACKGROUND_WORK_ENABLED;
    featureEnv.BACKGROUND_WORK_ENABLED = "true";
    const stub = env.THINK_THREAD_AGENT.get(
      env.THINK_THREAD_AGENT.idFromName("think-admission-unregistered"),
    );
    try {
      const admission = await runInDurableObject(stub, async (instance: ThinkThreadAgent) => {
        const testInstance = instance as unknown as {
          backgroundCapabilitiesForTest(): Promise<{
            backgroundExec: boolean;
            subagents: boolean;
          }>;
        };
        return testInstance.backgroundCapabilitiesForTest();
      });
      expect(admission).toEqual({ backgroundExec: false, subagents: false });
    } finally {
      featureEnv.BACKGROUND_WORK_ENABLED = previous;
    }
  });

  // The whole point of the auto-naming rework: the title must land WITHOUT the
  // model calling any tool. beforeTurn hands the naming to waitUntil, so this
  // drives the real hook on a real DO and asserts the D1 row afterwards. The
  // mock provider cannot generate text, which also exercises the fallback.
  it("names an untitled thread from beforeTurn, with no tool call", async () => {
    await seedRegistryThread(env.REGISTRY_DB, {
      workspaceId: "workspace-think-auto-name",
      agentId: "agent-think-auto-name",
      threadId: "think-auto-name",
      title: "New thread",
      runtime: "think",
      provider: "mock",
      model: "mock",
    });
    const stub = env.THINK_THREAD_AGENT.get(env.THINK_THREAD_AGENT.idFromName("think-auto-name"));

    await runInThinkDo(stub, async (instance: TelemetryTestableAgent) =>
      instance.beforeTurnProbeForTest([
        { role: "user", content: "how do I add D1 to this worker anyway" },
      ]),
    );

    const row = await drizzle(env.REGISTRY_DB, { schema })
      .select()
      .from(schema.threadIndex)
      .where(eq(schema.threadIndex.id, "think-auto-name"))
      .get();
    expect(row).toMatchObject({ titleSet: true });

    // Auto-naming used to call `generateText` — a non-streaming request that the
    // mock providers, and openai-oauth/codex in production, do not serve — so the
    // model was never actually reached and every title came from the crude
    // word-slice fallback. It streams now (see internal-llm.ts).
    //
    // This used to be asserted as `title === "Echo: <the message>"`, since the
    // mock echoes the prompt back. That no longer works: the naming prompt is now
    // a framed instruction block (see auto-name-thread.ts), so the echo of it is
    // an instruction, and `sanitizeTitle` rightly refuses to title a thread with
    // one. The billing ledger is the durable evidence instead — a row only exists
    // for a provider call that actually happened and reported usage, which is
    // exactly what the non-streaming path failed to do.
    const usage = await drizzle(env.REGISTRY_DB, { schema })
      .select()
      .from(schema.threadTokenUsage)
      .where(eq(schema.threadTokenUsage.threadId, "think-auto-name"))
      .all();
    expect(usage.map((u) => u.source)).toContain("auto_name");
  });

  // A memory the model can't see is a memory it doesn't have: prove the index
  // reaches the system prompt of a real turn, not just the formatter's unit test.
  it("puts the agent's memories in the turn's system prompt", async () => {
    await new AgentMemoryRepository(drizzle(env.REGISTRY_DB, { schema })).create({
      workspaceId: "workspace-think-registry-model",
      agentId: "agent-think-registry-model",
      sourceThreadId: "think-registry-model",
      title: "Deploys",
      content: "Always squash before deploying.",
      kind: "preference",
    });
    const stub = env.THINK_THREAD_AGENT.get(
      env.THINK_THREAD_AGENT.idFromName("think-registry-model"),
    );

    const result = (await runInThinkDo(stub, async (instance: TelemetryTestableAgent) =>
      instance.beforeTurnProbeForTest(),
    )) as { system?: string };

    expect(result.system).toContain("Memory index");
    expect(result.system).toContain("[preference]");
    expect(result.system).toContain("Deploys — Always squash before deploying.");
  });

  it("persists drafts for Think threads", async () => {
    const stub = env.THINK_THREAD_AGENT.get(env.THINK_THREAD_AGENT.idFromName("think-draft"));
    const result = await runInDurableObject(stub, async (instance: ThinkThreadAgent) => {
      await instance.setDraft("hello draft");
      const saved = await instance.getDraft();
      await instance.setDraft("   ");
      const cleared = await instance.getDraft();
      return { saved, cleared };
    });

    expect(result).toEqual({ saved: "hello draft", cleared: "" });
  });

  it("builds the Think turn model from the registered thread config", async () => {
    const stub = env.THINK_THREAD_AGENT.get(
      env.THINK_THREAD_AGENT.idFromName("think-registry-model"),
    );
    const result = await runInDurableObject(stub, async (instance: ThinkThreadAgent) =>
      instance.beforeTurnProbeForTest(),
    );

    expect(result).toEqual({
      modelId: "mock",
      provider: "mock",
      system: expect.stringContaining("You are Nadi."),
      // Even with no MCP tools, Think now emits an allowlist so the built-in
      // workspace file tools stay hidden; native tools remain callable.
      activeTools: expect.arrayContaining(["listAttachments", "create_skill"]),
      // Legacy parity: bound each turn to 50 tool-call rounds.
      maxSteps: MAX_TOOL_STEPS,
      messageText: "",
      providerOptions: undefined,
    });
  });

  it("disables Think PostHog instrumentation when workspace telemetry is not enabled", async () => {
    const stub = env.THINK_THREAD_AGENT.get(
      env.THINK_THREAD_AGENT.idFromName("think-registry-model"),
    );
    const result = await runInDurableObject(stub, async (instance: ThinkThreadAgent) => {
      const testInstance = instance as TelemetryTestableAgent;
      await testInstance.beforeTurnProbeForTest();
      return testInstance.telemetryEnabledForTest();
    });

    expect(result).toBe(false);
  });

  it("Think PostHog instrumentation skips run errors when workspace telemetry is disabled", async () => {
    const captureRunErrorSpy = vi.spyOn(posthogObservability, "captureRunError");
    const stub = env.THINK_THREAD_AGENT.get(
      env.THINK_THREAD_AGENT.idFromName("think-registry-model"),
    );

    await runInDurableObject(stub, async (instance: ThinkThreadAgent) => {
      const testInstance = instance as TelemetryTestableAgent;
      await testInstance.beforeTurnProbeForTest();
      instance.onChatError(new Error("disabled telemetry error"));
    });

    expect(captureRunErrorSpy).not.toHaveBeenCalled();
    captureRunErrorSpy.mockRestore();
  });

  it("does not propagate internal turn failures to the chat client", async () => {
    const stub = env.THINK_THREAD_AGENT.get(
      env.THINK_THREAD_AGENT.idFromName("think-registry-model"),
    );
    const propagated = await runInDurableObject(stub, async (instance: ThinkThreadAgent) =>
      instance.onChatError(
        new Error("Failed query: select thread_index", {
          cause: new Error("D1_ERROR: database is unavailable"),
        }),
      ),
    );

    expect(propagated).toBeInstanceOf(Error);
    expect((propagated as Error).message).toBe(
      "Something went wrong while sending your message. Please try again.",
    );
  });

  it("enables Think PostHog instrumentation when workspace telemetry is enabled", async () => {
    const db = drizzle(env.REGISTRY_DB, { schema });
    const now = Date.now();
    await db.insert(schema.workspacePrivacySettings).values({
      workspaceId: "workspace-think-registry-model",
      telemetryEnabled: true,
      createdAt: now,
      updatedAt: now,
    });

    const stub = env.THINK_THREAD_AGENT.get(
      env.THINK_THREAD_AGENT.idFromName("think-registry-model"),
    );
    const result = await runInDurableObject(stub, async (instance: ThinkThreadAgent) => {
      const testInstance = instance as TelemetryTestableAgent;
      await testInstance.beforeTurnProbeForTest();
      return testInstance.telemetryEnabledForTest();
    });

    expect(result).toBe(true);
  });

  it("does not include project instructions in Think prompts for unassigned threads", async () => {
    const stub = env.THINK_THREAD_AGENT.get(
      env.THINK_THREAD_AGENT.idFromName("think-project-context-unassigned"),
    );
    const result = await runInDurableObject(stub, async (instance: ThinkThreadAgent) =>
      instance.beforeTurnProbeForTest(),
    );

    expect(result.system).toContain("You are Nadi.");
    expect(result.system).not.toContain("Project context:");
    expect(result.system).not.toContain("Project instructions:");
  });

  it("uses the latest project instructions in Think prompts", async () => {
    const stub = env.THINK_THREAD_AGENT.get(
      env.THINK_THREAD_AGENT.idFromName("think-project-context-assigned"),
    );
    const result = await runInDurableObject(stub, async (instance: ThinkThreadAgent) =>
      instance.beforeTurnProbeForTest(),
    );

    expect(result.system).toContain("Project context:\nName: Nadi\nDescription: Main app");
    expect(result.system).toContain("Project instructions:\nUse the latest project instructions.");
  });

  it("uses thread repository snapshots rather than current project assignments", async () => {
    const stub = env.THINK_THREAD_AGENT.get(
      env.THINK_THREAD_AGENT.idFromName("think-project-context-assigned"),
    );
    const result = await runInDurableObject(stub, async (instance: ThinkThreadAgent) =>
      instance.beforeTurnProbeForTest(),
    );

    expect(result.system).toContain("- nadi\n  URL: https://github.com/acme/nadi.git");
    expect(result.system).toContain("  default branch: main");
    expect(result.system).toContain("  checkout path: nadi");
    expect(result.system).toContain("  package manager: pnpm");
    expect(result.system).not.toContain("other-repo");
    expect(result.system).not.toContain("https://github.com/acme/other-repo.git");
  });

  it("resolves archived assigned projects for Think prompts", async () => {
    const stub = env.THINK_THREAD_AGENT.get(
      env.THINK_THREAD_AGENT.idFromName("think-project-context-archived"),
    );
    const result = await runInDurableObject(stub, async (instance: ThinkThreadAgent) =>
      instance.beforeTurnProbeForTest(),
    );

    expect(result.system).toContain(
      "Project context:\nName: Archived Nadi\nDescription: Archived app",
    );
    expect(result.system).toContain("Project instructions:\nKeep archived context available.");
    expect(result.system).toContain("- nadi\n  URL: https://github.com/acme/nadi.git");
  });

  it("resolves the coding budget from the workbench, not a declaration", async () => {
    // "think-project-context-assigned" has a workbench snapshot
    // (env-think-context) assigned in beforeAll; the budget is resolved from
    // that snapshot, not from any per-thread declaration.
    const stub = env.THINK_THREAD_AGENT.get(
      env.THINK_THREAD_AGENT.idFromName("think-project-context-assigned"),
    );
    const result = await runInDurableObject(stub, async (instance: ThinkThreadAgent) => {
      await (instance as InitializableAgent).__unsafe_ensureInitialized();
      const probe = await instance.beforeTurnProbeForTest();
      return { maxSteps: probe.maxSteps };
    });

    expect(result.maxSteps).toBe(CODING_MAX_TOOL_STEPS);
  });

  it("resolves the default budget for a workbench-less thread", async () => {
    // "think-registry-model" has no workbench snapshot, so the default budget
    // applies.
    const stub = env.THINK_THREAD_AGENT.get(
      env.THINK_THREAD_AGENT.idFromName("think-registry-model"),
    );
    const result = await runInDurableObject(stub, async (instance: ThinkThreadAgent) => {
      await (instance as InitializableAgent).__unsafe_ensureInitialized();
      const probe = await instance.beforeTurnProbeForTest();
      return { maxSteps: probe.maxSteps };
    });

    expect(result.maxSteps).toBe(MAX_TOOL_STEPS);
  });

  it("hides all exec_* sandbox tools when sandbox execution is not configured", async () => {
    // The seeded thread has no workspace/agent sandbox settings, so the
    // effective sandbox config is disabled and the runtime must expose no
    // exec_* tools in the model-facing allowlist (design spec).
    const stub = env.THINK_THREAD_AGENT.get(
      env.THINK_THREAD_AGENT.idFromName("think-registry-model"),
    );
    const probe = await runInDurableObject(stub, async (instance: ThinkThreadAgent) =>
      instance.beforeTurnProbeForTest(),
    );

    const activeTools = probe.activeTools ?? [];
    for (const name of [
      "exec",
      "exec_output",
      "exec_output_grep",
      "exec_output_read",
      "exec_input",
      "exec_stop",
      "exec_list",
      "exec_watch",
      "exec_upload_file",
      "exec_download_file",
    ]) {
      expect(activeTools).not.toContain(name);
    }
    // Native (non-sandbox) tools are still available.
    expect(activeTools).toEqual(expect.arrayContaining(["listAttachments", "create_skill"]));
  });

  it("exposes exec but not exec_watch when sandbox execution is configured", async () => {
    const stub = env.THINK_THREAD_AGENT.get(
      env.THINK_THREAD_AGENT.idFromName("think-tool-probe-enabled"),
    );
    const probe = await runInDurableObject(stub, async (instance: ThinkThreadAgent) => {
      const testInstance = instance as SandboxServiceTestableAgent;
      try {
        testInstance._testSandboxServiceOverrides = {
          buildBackend: async () => new FakeComputeBackend(),
        };
        return testInstance.beforeTurnProbeForTest();
      } finally {
        delete testInstance._testSandboxServiceOverrides;
      }
    });

    const toolNames = probe.activeTools ?? [];
    expect(toolNames).toContain("exec");
    expect(toolNames).toContain("exec_output");
    expect(toolNames).toContain("exec_list");
    expect(toolNames).not.toContain("exec_start");
    expect(toolNames).not.toContain("exec_watch");
  });

  it("exec quick command returns output in one tool result", async () => {
    const stub = env.THINK_THREAD_AGENT.get(env.THINK_THREAD_AGENT.idFromName("think-exec-quick"));
    const result = await runInDurableObject(stub, async (instance: ThinkThreadAgent) => {
      const testInstance = instance as SandboxServiceTestableAgent;
      await testInstance.__unsafe_ensureInitialized();
      try {
        testInstance._testSandboxServiceOverrides = {
          buildBackend: async () => new FakeComputeBackend(),
        };
        const resolved = await testInstance.resolveComputeServiceForTest();
        if (!resolved) throw new Error("expected sandbox service");
        return resolved.service.exec({ command: "echo hello", label: "greet" });
      } finally {
        delete testInstance._testSandboxServiceOverrides;
      }
    });

    expect(result).toMatchObject({
      ok: true,
      status: "exited",
      command: "echo hello",
      label: "greet",
      exitCode: 0,
      stdoutPreview: "hello\n",
      stderrPreview: "",
      stdoutTruncated: false,
      stderrTruncated: false,
    });
  });

  it("exec watcher completion is delivered through the Durable Object tick path", async () => {
    const stub = env.THINK_THREAD_AGENT.get(
      env.THINK_THREAD_AGENT.idFromName("think-exec-background"),
    );
    const result = await runInDurableObject(stub, async (instance: ThinkThreadAgent) => {
      const testInstance = instance as SandboxServiceTestableAgent;
      await testInstance.__unsafe_ensureInitialized();
      const provider = new FakeComputeBackend();
      let now = 1000;
      const turnQueueHolder = testInstance as unknown as { _turnQueue?: { isActive: boolean } };
      try {
        testInstance._testSandboxServiceOverrides = {
          buildBackend: async () => provider,
          now: () => now,
          execForegroundTimeoutMs: 1,
          execForegroundPollIntervalMs: 1,
          sleep: async (ms) => {
            now += ms;
          },
        };
        // Keep proactive watcher completion in the durable injection buffer so
        // this test can assert the completion metadata before beforeStep drains it.
        turnQueueHolder._turnQueue = { isActive: true };

        const resolved = await testInstance.resolveComputeServiceForTest();
        if (!resolved) throw new Error("expected sandbox service");
        const execResult = await resolved.service.exec({ command: "sleep 300", label: "build" });
        const watchersAfterExec = resolved.service.listActiveWatchersView();
        const listedAfterExec = await resolved.service.execList({ status: "all", limit: 10 });
        const processAfterExec = listedAfterExec.processes.find(
          (process) => process.id === execResult.processId,
        );
        if (!processAfterExec?.backendProcessRef) {
          throw new Error("expected backend process reference for background process");
        }

        provider.finishProcess(processAfterExec.backendProcessRef, "exited", 0);
        now += DEFAULT_MONITOR_POLL_INTERVAL_MS;
        await instance.runSandboxEviction();

        const watchersAfterTick = resolved.service.listActiveWatchersView();
        const listedAfterTick = await resolved.service.execList({ status: "all", limit: 10 });
        const processAfterTick = listedAfterTick.processes.find(
          (process) => process.id === execResult.processId,
        );
        const completions = testInstance.watcherCompletionsForTest();
        return {
          execResult,
          watchersAfterExec,
          watchersAfterTick,
          processAfterTick,
          completions,
        };
      } finally {
        delete testInstance._testSandboxServiceOverrides;
        delete turnQueueHolder._turnQueue;
      }
    });

    expect(result.execResult).toMatchObject({
      ok: true,
      status: "backgrounded",
      command: "sleep 300",
      label: "build",
      watching: true,
      backgroundedAfterMs: 1,
    });
    expect(result.watchersAfterExec).toHaveLength(1);
    expect(result.watchersAfterExec[0]).toMatchObject({
      processId: result.execResult.processId,
      label: "build",
      command: "sleep 300",
    });
    expect(result.watchersAfterTick).toEqual([]);
    expect(result.processAfterTick).toMatchObject({
      id: result.execResult.processId,
      status: "exited",
      exitCode: 0,
    });
    expect(result.completions).toHaveLength(1);
    expect(result.completions[0]).toMatchObject({
      metadata: {
        nadiKind: "watcher-completion",
        watcher: {
          processId: result.execResult.processId,
          title: "build",
          command: "sleep 300",
          outcome: "exited",
          exitCode: 0,
        },
      },
    });
    expect(result.completions[0]?.parts[0]).toMatchObject({
      type: "text",
      text: expect.stringContaining("exited with code 0"),
    });
  });

  it("lists subagents without losing the SDK run-reader receiver", async () => {
    const stub = env.THINK_THREAD_AGENT.get(
      env.THINK_THREAD_AGENT.idFromName("think-subagent-list-reader"),
    );
    const result = await runInDurableObject(stub, async (instance: ThinkThreadAgent) => {
      await instance.__unsafe_ensureInitialized();
      // The run list derives from the work ledger — a subagent row IS the run.
      (instance as unknown as { workLedger: WorkLedgerStore }).workLedger.register({
        id: "sub_reader_1",
        kind: "subagent",
        startedAt: 1000,
        lastAliveAt: 1000,
        staleAfterMs: SUBAGENT_STALE_AFTER_MS,
        deadlineAt: 1000 + SUBAGENT_DEADLINE_MS,
        generation: "gen-test",
        terminal: null,
        deliveredAt: null,
      });
      (
        instance as unknown as {
          _readAgentToolRun?: (id: string) => {
            status: string;
            summary: string;
            input_preview: string;
          };
        }
      )._readAgentToolRun = function (this: { ctx: { storage: DurableObjectStorage } }) {
        // Regression guard: the real SDK method reads through `this`; calling it
        // after extracting the function loses the receiver and crashes.
        this.ctx.storage.sql.exec("SELECT 1").toArray();
        return {
          status: "completed",
          summary: "done",
          input_preview: JSON.stringify("reader probe"),
        };
      };

      return (instance as unknown as { listSubagentRuns(): Promise<unknown> }).listSubagentRuns();
    });

    expect(result).toEqual([
      {
        runId: "sub_reader_1",
        label: "reader probe",
        status: "completed",
        summary: "done",
      },
    ]);
  });

  it("rewrites managed attachments in Think model messages before provider input", async () => {
    const stub = env.THINK_THREAD_AGENT.get(
      env.THINK_THREAD_AGENT.idFromName("think-attachment-prep"),
    );
    const result = await runInDurableObject(stub, async (instance: ThinkThreadAgent) => {
      const out = await instance.prepareModelMessagesForThinkForTest(
        [
          {
            role: "user",
            content: [
              {
                type: "file",
                data: "/api/attachments/think-img-1",
                mediaType: "image/png",
              },
            ],
          },
        ],
        { inputModalities: ["text", "image"] },
      );
      const parts = (out[0] as { content: Array<{ data?: unknown; text?: string }> }).content;
      const reference = parts[0]!;
      const part = parts[1]!;
      return {
        reference: reference.text,
        isUrl: part.data instanceof URL,
        data: String(part.data),
      };
    });

    expect(result.reference).toBe(
      'Attachment reference: use id "think-img-1" for "think-img-1" (image/png).',
    );
    expect(result.isUrl).toBe(true);
    expect(result.data).toContain(
      "workspace-think-attachments/think-attachment-prep/think-img-1.png",
    );
    expect(result.data).toContain("X-Amz-Signature=");
  });

  it("runs a registry-resolved Think chat turn and persists the assistant response", async () => {
    const stub = env.THINK_THREAD_AGENT.get(
      env.THINK_THREAD_AGENT.idFromName("think-registry-model"),
    );
    const result = await runInDurableObject(stub, async (instance: ThinkThreadAgent) => {
      await (instance as InitializableAgent).__unsafe_ensureInitialized();
      const turn = await instance.runTurn({ input: "Registry model" });
      const messages = await instance.getMessages();
      return { turn, messages };
    });

    expect(result.turn.status).toBe("completed");
    expect(result.messages).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          role: "user",
          parts: expect.arrayContaining([expect.objectContaining({ text: "Registry model" })]),
        }),
        expect.objectContaining({
          role: "assistant",
          parts: expect.arrayContaining([
            // The mock model echoes the LAST message, and a thread's first turn
            // ends with the one-shot clock reminder (thread-start-clock.ts). So
            // this doubles as proof the stamp reaches the model through a real
            // turn, not just the beforeTurn probe.
            expect.objectContaining({ text: expect.stringContaining(CLOCK_STAMP_PREFIX) }),
          ]),
        }),
      ]),
    );
  });

  it("exposes manual in-place compaction for Think threads", async () => {
    const stub = env.THINK_THREAD_AGENT.get(env.THINK_THREAD_AGENT.idFromName("think-compaction"));
    const result = await runInDurableObject(stub, async (instance: ThinkThreadAgent) => {
      await (instance as InitializableAgent).__unsafe_ensureInitialized();
      const compactable = instance as ThinkThreadAgent & {
        getCompactionStatus(): { phase: "idle" | "compacting" };
        compactThread(): Promise<{ compacted: boolean; message: string }>;
      };
      const before = compactable.getCompactionStatus();
      const compacted = await compactable.compactThread();
      const after = compactable.getCompactionStatus();
      return { before, compacted, after };
    });

    expect(result).toEqual({
      before: { phase: "idle" },
      compacted: {
        compacted: false,
        message: "Nothing to compact yet.",
      },
      after: { phase: "idle" },
    });
  });

  // The compaction test that did not exist. The one above only ever covered the
  // path where compaction does NOTHING, which is how a summarizer that read every
  // object-shaped tool output as "[object Object]" — and a compaction that could
  // fire forever without shortening anything — both shipped. This drives a REAL
  // compaction through the real Session and real DO storage.
  //
  // Fixture sizing (window 32_000 → resolveContextBudget): compactAfterTokens
  // 17_920, tailTokenBudget 4_480 (25% of it), protectHead 3, minTailMessages 2.
  // `findTailCut` walks backward and protects everything it can afford, so a
  // transcript smaller than the tail budget leaves an EMPTY middle and compaction
  // legitimately no-ops. 50 turn pairs at ~900 chars each is ~12k tokens: well
  // over the 4_480-token tail (so the middle is large) and well under the 17_920
  // trigger (so seeding does not auto-compact and manual compaction is the driver).
  it("compacts a tool-heavy thread: history shortens and the summary sees tool outputs", async () => {
    await seedRegistryThread(env.REGISTRY_DB, {
      workspaceId: "workspace-think-compact-e2e",
      agentId: "agent-think-compact-e2e",
      threadId: "think-compact-e2e",
      runtime: "think",
      provider: "mock",
      model: "mock",
    });

    // The summarizer STREAMS (see internal-llm.ts): the non-streaming path is not
    // served by every provider — openai-oauth/codex returns "Invalid JSON
    // response" for it — so a thread on such a model could never compact. This
    // fake echoes the prompt it was streamed, which is what lets us assert on what
    // the summarizer could actually SEE.
    const summarizerPrompts: string[] = [];
    const modelSpy = vi.spyOn(threadAgentModule, "buildThreadModelForWorkspace").mockResolvedValue({
      specificationVersion: "v3",
      provider: "fake",
      modelId: "fake-summarizer",
      supportedUrls: {},
      doStream: async (options: { prompt: unknown }) => {
        const prompt = JSON.stringify(options.prompt);
        summarizerPrompts.push(prompt);
        return {
          stream: simulateReadableStream({
            initialDelayInMs: null,
            chunkDelayInMs: null,
            chunks: [
              { type: "text-start" as const, id: "s" },
              { type: "text-delta" as const, id: "s", delta: `SUMMARY OF: ${prompt}` },
              { type: "text-end" as const, id: "s" },
              {
                type: "finish" as const,
                finishReason: { unified: "stop" as const, raw: "stop" },
                usage: {
                  inputTokens: { total: 1, noCache: 1, cacheRead: 0, cacheWrite: 0 },
                  outputTokens: { total: 5, text: 5, reasoning: 0 },
                },
              },
            ],
          }),
          rawCall: { rawPrompt: null, rawSettings: {} },
        };
      },
    } as unknown as never);

    try {
      const stub = env.THINK_THREAD_AGENT.get(
        env.THINK_THREAD_AGENT.idFromName("think-compact-e2e"),
      );

      const result = await runInThinkDo(stub, async (instance: any) => {
        const agent = instance as InitializableAgent & {
          env: { THINK_COMPACT_AFTER_TOKENS?: string | undefined };
          session: {
            appendMessage(message: unknown): Promise<void>;
            getHistory(): Promise<{ id: string; parts: unknown[] }[]>;
            getCompactions(): Promise<{ summary: string }[]>;
          };
          compactThread(): Promise<{ compacted: boolean; message: string }>;
        };
        // The mock model has no catalog window; this is how the thread's budget
        // gets a small, hand-computable one. Set BEFORE initialization: onStart
        // derives the budget (and arms the compaction trigger) from it.
        const previousWindow = agent.env.THINK_COMPACT_AFTER_TOKENS;
        agent.env.THINK_COMPACT_AFTER_TOKENS = "32000";
        try {
          await agent.__unsafe_ensureInitialized();
          for (let i = 0; i < 50; i++) {
            await agent.session.appendMessage({
              id: `u${i}`,
              role: "user",
              parts: [{ type: "text", text: `step ${i}: read the config` }],
            });
            await agent.session.appendMessage({
              id: `a${i}`,
              role: "assistant",
              parts: [
                {
                  // Object-shaped output — the exact shape Nadi's capToolOutput
                  // preserves and the SDK's summary prompt destroyed.
                  type: "tool-read_file",
                  toolName: "read_file",
                  toolCallId: `call-${i}`,
                  state: "output-available",
                  input: { path: `src/file-${i}.ts` },
                  output: {
                    path: `src/file-${i}.ts`,
                    content: `export const marker${i} = true;\n${"// filler\n".repeat(80)}`,
                  },
                },
              ],
            });
          }

          const before = await agent.session.getHistory();
          const compacted = await agent.compactThread();
          const after = await agent.session.getHistory();
          const overlays = await agent.session.getCompactions();
          return { compacted, beforeLen: before.length, afterLen: after.length, overlays };
        } finally {
          if (previousWindow === undefined) {
            delete agent.env.THINK_COMPACT_AFTER_TOKENS;
          } else {
            agent.env.THINK_COMPACT_AFTER_TOKENS = previousWindow;
          }
        }
      });

      expect(result.compacted).toEqual({ compacted: true, message: "Thread compacted." });
      expect(result.beforeLen).toBe(100);
      // History actually shortened — the thing that never happened during the runaway.
      expect(result.afterLen).toBeLessThan(result.beforeLen);
      expect(result.overlays).toHaveLength(1);

      // The summarizer could SEE the tool outputs. Under the SDK's String(output)
      // every one of these prompts said "[object Object]" instead — so both the
      // paths and the file contents below disappear, and this is the assertion
      // that fails when the bug is reintroduced.
      expect(summarizerPrompts).toHaveLength(1);
      const prompt = summarizerPrompts[0]!;
      expect(prompt).not.toContain("[object Object]");
      expect(prompt).toContain("src/file-");
      expect(prompt).toMatch(/export const marker\d+ = true/);

      const summary = result.overlays[0].summary;
      expect(summary).not.toContain("[object Object]");
      expect(summary).toContain("src/file-");
    } finally {
      modelSpy.mockRestore();
    }
  });

  // A thread compacts MORE THAN ONCE as it keeps growing. Every compaction writes
  // a new overlay row, and the SDK is supposed to anchor each new row at the FIRST
  // row's `fromMessageId` so they collapse to a single summary when history is
  // rebuilt. In production a thread that compacted three times rendered TWO
  // "Thread compacted" dividers, i.e. the model was being fed two summaries where
  // it should read one — wasted context that compounds with every compaction.
  it("collapses repeat compactions into ONE overlay", async () => {
    await seedRegistryThread(env.REGISTRY_DB, {
      workspaceId: "workspace-think-recompact",
      agentId: "agent-think-recompact",
      threadId: "think-recompact",
      title: "recompact",
      runtime: "think",
      provider: "mock",
      model: "mock",
    });

    let n = 0;
    const modelSpy = vi.spyOn(threadAgentModule, "buildThreadModelForWorkspace").mockResolvedValue({
      specificationVersion: "v3",
      provider: "fake",
      modelId: "fake-summarizer",
      supportedUrls: {},
      doStream: async () => {
        n += 1;
        // Slow on purpose: an instant summarizer never lets two compact() calls
        // overlap, so the race this guards against would not happen and the test
        // would pass with the guard removed.
        await new Promise((resolve) => setTimeout(resolve, 40));
        return {
          stream: simulateReadableStream({
            initialDelayInMs: null,
            chunkDelayInMs: null,
            chunks: [
              { type: "text-start" as const, id: "s" },
              { type: "text-delta" as const, id: "s", delta: `## Topic\nsummary ${n}` },
              { type: "text-end" as const, id: "s" },
              {
                type: "finish" as const,
                finishReason: { unified: "stop" as const, raw: "stop" },
                usage: {
                  inputTokens: { total: 1, noCache: 1, cacheRead: 0, cacheWrite: 0 },
                  outputTokens: { total: 5, text: 5, reasoning: 0 },
                },
              },
            ],
          }),
          rawCall: { rawPrompt: null, rawSettings: {} },
        };
      },
    } as unknown as never);

    try {
      const stub = env.THINK_THREAD_AGENT.get(env.THINK_THREAD_AGENT.idFromName("think-recompact"));
      const result = await runInThinkDo(stub, async (instance: unknown) => {
        const agent = instance as unknown as {
          env: { THINK_COMPACT_AFTER_TOKENS?: string };
          __unsafe_ensureInitialized(): Promise<void>;
          session: {
            appendMessage(m: unknown): Promise<void>;
            getHistory(): Promise<{ id: string }[]>;
            getCompactions(): Promise<{ fromMessageId: string; toMessageId: string }[]>;
            compact(): Promise<unknown>;
          };
          compactThread(): Promise<{ compacted: boolean }>;
        };
        const previous = agent.env.THINK_COMPACT_AFTER_TOKENS;
        agent.env.THINK_COMPACT_AFTER_TOKENS = "32000";
        try {
          await agent.__unsafe_ensureInitialized();
          const seed = async (from: number, to: number) => {
            for (let i = from; i < to; i++) {
              await agent.session.appendMessage({
                id: `u${i}`,
                role: "user",
                parts: [{ type: "text", text: `q${i} ${"padding ".repeat(60)}` }],
              });
              await agent.session.appendMessage({
                id: `a${i}`,
                role: "assistant",
                parts: [{ type: "text", text: `a${i} ${"answer ".repeat(120)}` }],
              });
            }
          };

          // Compact, grow, compact again — exactly what the production thread did.
          // The two RACING calls in between are the real hazard: a DO is not atomic
          // across awaits, so an append can land while compact() awaits the
          // summarizer and call compact() again. Guarding only the summarizer left
          // each call to write its own overlay row (a live thread held three rows
          // where one would do); the guard now wraps compact() itself.
          await seed(0, 30);
          await Promise.all([agent.session.compact(), agent.session.compact()]);
          await seed(30, 50);
          await agent.session.compact();

          const history = await agent.session.getHistory();
          const rows = await agent.session.getCompactions();
          // `messages` is Think's CACHED view — it is what the UI and the debug
          // endpoint read. getHistory() is the durable truth. If they disagree,
          // the user sees overlays the model never gets.
          const cached = (agent as unknown as { messages: { id: string }[] }).messages;
          return {
            overlaysInHistory: history.filter((m) => m.id.startsWith("compaction_")).length,
            overlaysInCache: cached.filter((m) => m.id.startsWith("compaction_")).length,
            rowCount: rows.length,
            anchors: [...new Set(rows.map((r) => r.fromMessageId))],
            summarizerCalls: n,
          };
        } finally {
          if (previous === undefined) delete agent.env.THINK_COMPACT_AFTER_TOKENS;
          else agent.env.THINK_COMPACT_AFTER_TOKENS = previous;
        }
      });

      expect(result.rowCount).toBeGreaterThan(0);
      // The durable history and the cached view MUST agree: the cache is what the
      // UI and the debug endpoint read, the history is what the model gets.
      expect({
        rows: result.rowCount,
        anchors: result.anchors.length,
        history: result.overlaysInHistory,
        cache: result.overlaysInCache,
        // Two compactions ran, not three: the racing pair collapsed to ONE — one
        // summarizer call, one row. Without the guard each racing call summarizes
        // and writes its own row.
        calls: result.summarizerCalls,
      }).toEqual({ rows: 2, anchors: 1, history: 1, cache: 1, calls: 2 });

      // Every row must share the FIRST row's anchor — that is what makes them
      // collapse. Two anchors means two summaries in the model's context.
      expect(result.anchors).toHaveLength(1);
      expect(result.overlaysInHistory).toBe(1);
    } finally {
      modelSpy.mockRestore();
    }
  });

  // Session runs its auto-compaction check INSIDE appendMessage, and Think appends
  // the user message before `beforeTurn` runs. So whatever threshold `onStart`
  // armed is the one that decides the first append after every cold start or DO
  // eviction — a `beforeTurn` re-arm is too late for it. While that seed was the
  // flat 100k default, a large-window thread was compacted at 100k on the first
  // message of every session (discarding context it was entitled to keep) and a
  // small-window thread started its turn over budget. This asserts the armed
  // threshold is budget-derived BEFORE any turn exists.
  it("arms the model's budget-derived compaction trigger before any turn runs", async () => {
    const window = 32_000;
    const expected = resolveContextBudget(window).compactAfterTokens;
    expect(expected).toBe(17_920);

    await seedRegistryThread(env.REGISTRY_DB, {
      workspaceId: "workspace-think-compact-seed",
      agentId: "agent-think-compact-seed",
      threadId: "think-compact-seed",
      runtime: "think",
      provider: "mock",
      model: "mock",
    });
    const stub = env.THINK_THREAD_AGENT.get(
      env.THINK_THREAD_AGENT.idFromName("think-compact-seed"),
    );

    const armed = await runInThinkDo(stub, async (instance: any) => {
      const agent = instance as InitializableAgent & {
        env: { THINK_COMPACT_AFTER_TOKENS?: string | undefined };
      };
      const previousWindow = agent.env.THINK_COMPACT_AFTER_TOKENS;
      agent.env.THINK_COMPACT_AFTER_TOKENS = String(window);
      try {
        // onStart only — no turn, no beforeTurn, nothing appended.
        await agent.__unsafe_ensureInitialized();
        return armedThreshold(agent);
      } finally {
        if (previousWindow === undefined) {
          delete agent.env.THINK_COMPACT_AFTER_TOKENS;
        } else {
          agent.env.THINK_COMPACT_AFTER_TOKENS = previousWindow;
        }
      }
    });

    expect(armed).toBe(expected);
    // The bug this branch exists to kill: the flat seed.
    expect(armed).not.toBe(100_000);
  });

  // MCP servers are connected off the DO-init critical path: onStart kicks the
  // connect work in the background, and beforeTurn awaits its memoized readiness
  // promise before assembling the tool set. This is what stops a cold thread
  // open (WS handshake + /get-messages) from blocking on remote MCP handshakes.
  it("connects enabled MCP servers exactly once across init and turns", async () => {
    const stub = env.THINK_THREAD_AGENT.get(env.THINK_THREAD_AGENT.idFromName("think-mcp-warmup"));
    const calls = await runInThinkDo(stub, async (instance: any) => {
      let n = 0;
      instance._connectEnabledMcpServers = async () => {
        n += 1;
      };
      // onStart kicks warm-up; two turns each await the same memoized promise.
      await instance.__unsafe_ensureInitialized();
      await instance.beforeTurnProbeForTest();
      await instance.beforeTurnProbeForTest();
      return n;
    });

    expect(calls).toBe(1);
  });

  it("returns from init without awaiting MCP connections", async () => {
    const stub = env.THINK_THREAD_AGENT.get(
      env.THINK_THREAD_AGENT.idFromName("think-mcp-warmup-block"),
    );
    const result = await runInThinkDo(stub, async (instance: any) => {
      let started = false;
      let release!: () => void;
      const gate = new Promise<void>((resolve) => {
        release = resolve;
      });
      instance._connectEnabledMcpServers = async () => {
        started = true;
        await gate;
      };
      // Would hang forever here if onStart awaited the connect work.
      await instance.__unsafe_ensureInitialized();
      const startedBeforeRelease = started;
      // Let the backgrounded warm-up finish so it doesn't leak past the test.
      release();
      await instance._ensureMcpServers();
      return { startedBeforeRelease };
    });

    expect(result.startedBeforeRelease).toBe(true);
  });

  // `_ensureMcpServers` resolves on CONNECTED, not on discovered — so without
  // the wait, beforeTurn reads `getAITools()` while discovery is still running
  // and assembles a turn with an incomplete tool set. It fails silently: the
  // model simply does not see those tools. Found live on celld, where a cell
  // evicted between messages wakes on the turn itself.
  it("waits for MCP discovery to settle before reading the tool set", async () => {
    await seedRegistryThread(env.REGISTRY_DB, {
      workspaceId: "workspace-mcp-discovery-wait",
      agentId: "agent-mcp-discovery-wait",
      threadId: "think-mcp-discovery-wait",
    });
    const stub = env.THINK_THREAD_AGENT.get(
      env.THINK_THREAD_AGENT.idFromName("think-mcp-discovery-wait"),
    );
    const order = await runInThinkDo(stub, async (instance: any) => {
      const seen: string[] = [];
      instance._connectEnabledMcpServers = async () => {
        seen.push("connect");
      };
      instance.mcp.waitForConnections = async (options: { timeout?: number }) => {
        seen.push(`wait:${options?.timeout}`);
      };
      const realGetAITools = instance.mcp.getAITools.bind(instance.mcp);
      instance.mcp.getAITools = () => {
        seen.push("getAITools");
        return realGetAITools();
      };
      await instance.__unsafe_ensureInitialized();
      await instance.beforeTurnProbeForTest();
      return seen;
    });

    // The timeout is asserted, not just the ordering: `waitForConnections`
    // defaults to waiting FOREVER, so dropping the bound would let one
    // unreachable MCP server hang every turn on this thread.
    expect(order).toEqual(["connect", "wait:5000", "getAITools"]);
  });

  // Three one-line wirings with no other test coverage, each of which fails
  // SILENTLY when reverted: `contextOverflow.proactive` (Think skips the guard
  // when maxInputTokens is absent), `classifyChatError` (reactive recovery becomes
  // a console.warn no-op without a classifier), and the `beforeTurn` re-arm
  // (without it a stale threshold — e.g. after a mid-thread model switch — is
  // never corrected).
  it("beforeTurn arms both overflow guards and re-arms a stale compaction trigger", async () => {
    const window = 32_000;
    const budget = resolveContextBudget(window);

    await seedRegistryThread(env.REGISTRY_DB, {
      workspaceId: "workspace-think-overflow-wiring",
      agentId: "agent-think-overflow-wiring",
      threadId: "think-overflow-wiring",
      runtime: "think",
      provider: "mock",
      model: "mock",
    });
    const stub = env.THINK_THREAD_AGENT.get(
      env.THINK_THREAD_AGENT.idFromName("think-overflow-wiring"),
    );

    const result = await runInThinkDo(stub, async (instance: any) => {
      const agent = instance as TelemetryTestableAgent & {
        __unsafe_ensureInitialized(): Promise<void>;
        env: { THINK_COMPACT_AFTER_TOKENS?: string | undefined };
        contextOverflow: {
          reactive?: boolean;
          proactive?: { maxInputTokens?: number; headroom?: number };
        };
        classifyChatError(error: unknown, ctx?: unknown): string | void;
      };
      const previousWindow = agent.env.THINK_COMPACT_AFTER_TOKENS;
      agent.env.THINK_COMPACT_AFTER_TOKENS = String(window);
      try {
        await agent.__unsafe_ensureInitialized();
        // Stand in for a threshold that no longer matches the thread's budget
        // (what a mid-thread model switch leaves behind): only the beforeTurn
        // re-arm can correct it.
        setArmedThreshold(agent, 1);
        (agent as unknown as { _armedCompactAfter: number | null })._armedCompactAfter = null;

        await agent.beforeTurnProbeForTest([{ role: "user", content: "hello" }]);

        return {
          tokenThreshold: armedThreshold(agent),
          reactive: agent.contextOverflow.reactive,
          proactiveMaxInputTokens: agent.contextOverflow.proactive?.maxInputTokens,
          proactiveHeadroom: agent.contextOverflow.proactive?.headroom,
          // Anthropic's real context-overflow message. Think's base classifier
          // returns undefined for everything, which silently disables reactive
          // recovery.
          classification: agent.classifyChatError(new Error("prompt is too long")),
        };
      } finally {
        if (previousWindow === undefined) {
          delete agent.env.THINK_COMPACT_AFTER_TOKENS;
        } else {
          agent.env.THINK_COMPACT_AFTER_TOKENS = previousWindow;
        }
      }
    });

    expect(result.tokenThreshold).toBe(budget.compactAfterTokens);
    expect(result.reactive).toBe(true);
    expect(result.proactiveMaxInputTokens).toBe(budget.proactiveInputTokens);
    expect(result.proactiveHeadroom).toBe(1);
    expect(result.classification).toBe("context_overflow");
  });

  it("defaults injected MCP tools to approval_required for Think turns", async () => {
    const stub = env.THINK_THREAD_AGENT.get(
      env.THINK_THREAD_AGENT.idFromName("think-mcp-approval"),
    );
    const executeSpy = vi.fn().mockResolvedValue("should-not-run");

    const result = await runInThinkDo(stub, async (instance: any) => {
      const testInstance = instance as InitializableAgent & {
        _testToolOverride?: Record<string, unknown>;
        _testPolicyMap?: Record<string, "auto_allow" | "approval_required" | "deny">;
      };
      testInstance._testToolOverride = {
        demo_tool: tool({
          description: "Demo MCP tool for Think policy testing",
          inputSchema: z.object({ action: z.string() }),
          execute: executeSpy,
        }),
      };
      testInstance._testPolicyMap = {};
      await testInstance.__unsafe_ensureInitialized();
      const turn = await testInstance.runTurn({ input: "Run demo tool" });
      const messages = await testInstance.getMessages();
      return { status: turn.status, messages };
    });

    expect(result.status).toBe("completed");
    expect(executeSpy).not.toHaveBeenCalled();
    const toolPart = flattenTestParts(result.messages).find(
      (part) =>
        part.type === "tool-demo_tool" ||
        (part.type === "dynamic-tool" && (part as { toolName?: string }).toolName === "demo_tool"),
    );
    expect(toolPart, "expected Think to persist an approval-requested tool part").toBeDefined();
    expect((toolPart as { state?: string }).state).toBe("approval-requested");
  });

  it("marks a Think thread running at turn start and idle with completed unread at turn end", async () => {
    const db = drizzle(env.REGISTRY_DB, { schema });
    await ensureThreadLifecycleColumns();
    await seedRegistryThread(env.REGISTRY_DB, {
      workspaceId: "workspace-think-notify-complete",
      agentId: "agent-think-notify-complete",
      threadId: "think-notify-complete",
      runtime: "think",
      provider: "mock",
      model: "mock",
    });
    const stub = env.THINK_THREAD_AGENT.get(
      env.THINK_THREAD_AGENT.idFromName("think-notify-complete"),
    );

    await runInThinkDo(stub, async (instance: InitializableAgent) => {
      await instance.__unsafe_ensureInitialized();
      await instance.runTurn({ input: "Give me a quick status update." });
    });

    const row = await db
      .select()
      .from(schema.threadIndex)
      .where(eq(schema.threadIndex.id, "think-notify-complete"))
      .get();

    expect(row?.activityStatus).toBe("idle");
    expect(row?.unreadOutcome).toBe("completed");
  });

  it("marks a Think thread attention_required when tool approval pauses the run", async () => {
    const db = drizzle(env.REGISTRY_DB, { schema });
    await ensureThreadLifecycleColumns();
    await seedRegistryThread(env.REGISTRY_DB, {
      workspaceId: "workspace-think-notify-approval",
      agentId: "agent-think-notify-approval",
      threadId: "think-notify-approval",
      runtime: "think",
      provider: "mock-tool-call",
      model: "mock-tool-call",
    });
    const stub = env.THINK_THREAD_AGENT.get(
      env.THINK_THREAD_AGENT.idFromName("think-notify-approval"),
    );
    const executeSpy = vi.fn().mockResolvedValue("should-not-run");

    await runInThinkDo(stub, async (instance: any) => {
      const testInstance = instance as InitializableAgent & {
        _testToolOverride?: Record<string, unknown>;
        _testPolicyMap?: Record<string, "auto_allow" | "approval_required" | "deny">;
      };
      testInstance._testToolOverride = {
        demo_tool: tool({
          description: "Demo MCP tool for Think notification lifecycle testing",
          inputSchema: z.object({ action: z.string() }),
          execute: executeSpy,
        }),
      };
      testInstance._testPolicyMap = {};
      await testInstance.__unsafe_ensureInitialized();
      await testInstance.runTurn({ input: "Run demo tool" });
    });

    const row = await db
      .select()
      .from(schema.threadIndex)
      .where(eq(schema.threadIndex.id, "think-notify-approval"))
      .get();

    expect(executeSpy).not.toHaveBeenCalled();
    expect(row?.activityStatus).toBe("attention_required");
    expect(row?.attentionRequiredAt).toEqual(expect.any(Number));
  });

  it("executes auto_allow injected MCP tools for Think turns", async () => {
    const stub = env.THINK_THREAD_AGENT.get(env.THINK_THREAD_AGENT.idFromName("think-mcp-auto"));
    const executeSpy = vi.fn().mockResolvedValue("auto-tool-result");

    const result = await runInThinkDo(stub, async (instance: any) => {
      const testInstance = instance as InitializableAgent & {
        _testToolOverride?: Record<string, unknown>;
        _testPolicyMap?: Record<string, "auto_allow" | "approval_required" | "deny">;
      };
      testInstance._testToolOverride = {
        demo_tool: tool({
          description: "Demo MCP tool for Think policy testing",
          inputSchema: z.object({ action: z.string() }),
          execute: executeSpy,
        }),
      };
      testInstance._testPolicyMap = { demo_tool: "auto_allow" };
      await testInstance.__unsafe_ensureInitialized();
      const turn = await testInstance.runTurn({ input: "Run demo tool auto" });
      const messages = await testInstance.getMessages();
      return { status: turn.status, messages };
    });

    expect(result.status).toBe("completed");
    expect(executeSpy).toHaveBeenCalled();
    const outputPart = flattenTestParts(result.messages).find(
      (part) =>
        (part.type === "tool-demo_tool" || part.type === "dynamic-tool") &&
        (part as { state?: string }).state === "output-available",
    );
    expect(outputPart, "expected Think to persist an output-available tool part").toBeDefined();
  });

  // Guards the beforeTurn wiring, not the cap helper: the tool set the turn
  // really built must be wrapped with THIS model's window-scaled cap. With a
  // flat 128k cap a single tool result is ~32k tokens, so two protected tail
  // messages alone outweigh a small model's compaction trigger and compaction
  // can never converge — the runaway this codebase has already shipped once.
  it("caps a tool's output at the window-scaled budget of the turn's model", async () => {
    const smallWindow = 32_000;
    const cap = resolveContextBudget(smallWindow).maxToolOutputCapChars;
    // Bigger than the small model's cap, smaller than DEFAULT_TOOL_OUTPUT_CAP_CHARS:
    // an unwired call site would persist this output untouched.
    const hugeOutput = "z".repeat(60_000);
    expect(cap).toBeLessThan(hugeOutput.length);
    expect(hugeOutput.length).toBeLessThan(DEFAULT_TOOL_OUTPUT_CAP_CHARS);

    const stub = env.THINK_THREAD_AGENT.get(env.THINK_THREAD_AGENT.idFromName("think-tool-cap"));
    const result = await runInThinkDo(stub, async (instance: any) => {
      const testInstance = instance as InitializableAgent & {
        env: { THINK_COMPACT_AFTER_TOKENS?: string | undefined };
        _testToolOverride?: Record<string, unknown>;
        _testPolicyMap?: Record<string, "auto_allow" | "approval_required" | "deny">;
      };
      // The mock model has no catalog window, so this is how the thread's model
      // gets a small one.
      const previousWindow = testInstance.env.THINK_COMPACT_AFTER_TOKENS;
      testInstance.env.THINK_COMPACT_AFTER_TOKENS = String(smallWindow);
      try {
        testInstance._testToolOverride = {
          demo_tool: tool({
            description: "Demo MCP tool that dumps a pathologically large output",
            inputSchema: z.object({ action: z.string() }),
            execute: async () => hugeOutput,
          }),
        };
        testInstance._testPolicyMap = { demo_tool: "auto_allow" };
        await testInstance.__unsafe_ensureInitialized();
        const turn = await testInstance.runTurn({ input: "Dump the whole log" });
        const messages = await testInstance.getMessages();
        return { status: turn.status, messages };
      } finally {
        if (previousWindow === undefined) {
          delete testInstance.env.THINK_COMPACT_AFTER_TOKENS;
        } else {
          testInstance.env.THINK_COMPACT_AFTER_TOKENS = previousWindow;
        }
      }
    });

    expect(result.status).toBe("completed");
    const outputPart = flattenTestParts(result.messages).find(
      (part) =>
        (part.type === "tool-demo_tool" || part.type === "dynamic-tool") &&
        (part as { state?: string }).state === "output-available",
    ) as { output?: unknown } | undefined;
    expect(outputPart, "expected Think to persist an output-available tool part").toBeDefined();
    const output = String(outputPart?.output);
    expect(output).toContain("truncated");
    expect(output.length).toBeLessThanOrEqual(cap);
  });

  it("excludes denied injected MCP tools from Think active tools", async () => {
    const stub = env.THINK_THREAD_AGENT.get(env.THINK_THREAD_AGENT.idFromName("think-mcp-deny"));
    const executeSpy = vi.fn().mockResolvedValue("should-not-run");

    const result = await runInThinkDo(stub, async (instance: any) => {
      const testInstance = instance as InitializableAgent & {
        _testToolOverride?: Record<string, unknown>;
        _testPolicyMap?: Record<string, "auto_allow" | "approval_required" | "deny">;
      };
      testInstance._testToolOverride = {
        demo_tool: tool({
          description: "Demo MCP tool for Think policy testing",
          inputSchema: z.object({ action: z.string() }),
          execute: executeSpy,
        }),
      };
      testInstance._testPolicyMap = { demo_tool: "deny" };
      await testInstance.__unsafe_ensureInitialized();
      const probe = await testInstance.beforeTurnProbeForTest();
      const turn = await testInstance.runTurn({ input: "Run denied demo tool" });
      const messages = await testInstance.getMessages();
      return { activeTools: probe.activeTools, status: turn.status, messages };
    });

    expect(result.status).toBe("completed");
    expect(result.activeTools).not.toContain("demo_tool");
    expect(executeSpy).not.toHaveBeenCalled();
    const outputPart = flattenTestParts(result.messages).find(
      (part) =>
        (part.type === "tool-demo_tool" || part.type === "dynamic-tool") &&
        (part as { state?: string }).state === "output-available",
    );
    expect(outputPart).toBeUndefined();
  });

  it("submits and lists queued user messages", async () => {
    const stub = env.THINK_THREAD_AGENT.get(env.THINK_THREAD_AGENT.idFromName("think-queue"));
    const result = await runInDurableObject(stub, async (instance: ThinkThreadAgent) => {
      const submitted = await instance.submitQueuedUserMessage({
        message: {
          id: "queued-client-msg-1",
          role: "user",
          parts: [{ type: "text", text: "queued hello" }],
        },
      });
      const listed = await instance.listQueuedUserMessages();
      return { submitted, listed };
    });

    const submittedRow = result.submitted.find(
      (row) => row.clientMessageId === "queued-client-msg-1",
    );
    expect(submittedRow?.submissionId).toBeTruthy();
    expect(submittedRow?.textPreview).toBe("queued hello");
    expect(result.listed).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          textPreview: "queued hello",
          clientMessageId: "queued-client-msg-1",
        }),
      ]),
    );
  });

  it("merges rapid queued submits into one batch submission (timing tolerant)", async () => {
    const stub = env.THINK_THREAD_AGENT.get(env.THINK_THREAD_AGENT.idFromName("think-queue-batch"));
    const result = await runInDurableObject(stub, async (instance: ThinkThreadAgent) => {
      await instance.submitQueuedUserMessage({
        message: {
          id: "batch-msg-1",
          role: "user",
          parts: [{ type: "text", text: "batch one" }],
        },
      });
      const rows = await instance.submitQueuedUserMessage({
        message: {
          id: "batch-msg-2",
          role: "user",
          parts: [{ type: "text", text: "batch two" }],
        },
      });
      const appliedIds = instance.messages.map((message) => message.id);
      return { rows, appliedIds };
    });

    // Both messages are represented somewhere (a superseded batch stays in the
    // submission history as aborted, so a message may legitimately appear in
    // several TERMINAL rows — the client filters those out).
    const ids = result.rows.map((row) => row.clientMessageId);
    expect(ids).toContain("batch-msg-1");
    expect(ids).toContain("batch-msg-2");
    // Invariant: at most one NON-terminal row per message — the queue never
    // holds the same message in two waiting/active submissions at once.
    const nonTerminal = (status?: string) => status === "pending" || status === "running";
    const waitingRows = result.rows.filter((row) => nonTerminal(row.status));
    const waitingIds = waitingRows.map((row) => row.clientMessageId);
    expect(new Set(waitingIds).size).toBe(waitingIds.length);
    // If msg-1 was still waiting (non-terminal AND not applied) when msg-2
    // arrived, the two must have merged into ONE submission. The drain loop may
    // have already run msg-1's turn (no active turn blocks it in tests), so
    // only assert the merge when msg-1 was genuinely still waiting.
    const row1 = waitingRows.find((row) => row.clientMessageId === "batch-msg-1");
    const row2 = waitingRows.find((row) => row.clientMessageId === "batch-msg-2");
    const applied = new Set(result.appliedIds);
    if (row1 && row2 && !applied.has("batch-msg-1")) {
      expect(row1.submissionId).toBe(row2.submissionId);
    }
  });

  it("rejects empty queued user messages", async () => {
    const stub = env.THINK_THREAD_AGENT.get(env.THINK_THREAD_AGENT.idFromName("think-queue"));
    await expect(
      runInDurableObject(stub, async (instance: ThinkThreadAgent) =>
        instance.submitQueuedUserMessage({
          message: { id: "empty-queued", role: "user", parts: [] },
        }),
      ),
    ).rejects.toThrow("queued_message_empty");
  });

  it("exposes queued cancellation without timing assumptions", async () => {
    const stub = env.THINK_THREAD_AGENT.get(env.THINK_THREAD_AGENT.idFromName("think-queue"));
    const result = await runInDurableObject(stub, async (instance: ThinkThreadAgent) => {
      const submitted = await instance.submitQueuedUserMessage({
        message: {
          id: "queued-client-msg-cancel",
          role: "user",
          parts: [{ type: "text", text: "cancel me" }],
        },
      });
      const submittedRow = submitted.find(
        (row) => row.clientMessageId === "queued-client-msg-cancel",
      );
      if (!submittedRow) throw new Error("submitted row missing");
      const cancelled = await instance.cancelQueuedUserMessage(
        submittedRow.submissionId,
        "queued-client-msg-cancel",
      );
      return { cancelled };
    });

    // Cancel returns the authoritative row list; whether the row is gone
    // (cancelled while waiting) or still present (already ran) depends on
    // timing, but any surviving row must carry a valid status.
    for (const row of result.cancelled) {
      expect(["pending", "running", "completed", "aborted", "skipped", "error"]).toContain(
        row.status,
      );
    }
  });

  it("commits queued attachments when accepted and before Think model turns use them", async () => {
    const stub = env.THINK_THREAD_AGENT.get(
      env.THINK_THREAD_AGENT.idFromName("think-queue-attachments"),
    );
    const result = await runInThinkDo(stub, async (instance: InitializableAgent) => {
      await instance.__unsafe_ensureInitialized();
      await instance.submitQueuedUserMessage({
        message: {
          id: "queued-client-msg-with-file",
          role: "user",
          parts: [
            { type: "text", text: "queued file" },
            { type: "file", url: "/api/attachments/queued-img", mediaType: "image/png" },
          ],
        },
      });
      const acceptedRow = await new AttachmentRepository(env.REGISTRY_DB).getByIdInThread(
        "queued-img",
        "think-queue-attachments",
      );
      await (
        instance as ThinkThreadAgent & { _drainThinkSubmissions(): Promise<void> }
      )._drainThinkSubmissions();
      const row = await new AttachmentRepository(env.REGISTRY_DB).getByIdInThread(
        "queued-img",
        "think-queue-attachments",
      );
      return { acceptedStatus: acceptedRow?.status, drainedStatus: row?.status };
    });

    expect(result.acceptedStatus).toBe("committed");
    expect(result.drainedStatus).toBe("committed");
  });

  it("serves the Think agent route for an authorized registered thread", async () => {
    const db = drizzle(env.REGISTRY_DB, { schema });
    const createdAt = 1_800_000_000_000;
    await db
      .insert(schema.users)
      .values({
        id: "think-route-user",
        email: "think-route-user@example.com",
        name: null,
        createdAt: new Date(createdAt),
        emailVerified: true,
        image: null,
        updatedAt: new Date(createdAt),
      })
      .onConflictDoNothing();
    await seedRegistryThread(env.REGISTRY_DB, {
      workspaceId: "workspace-think-route-smoke",
      agentId: "agent-think-route-smoke",
      threadId: "think-route-smoke",
      runtime: "think",
      provider: "mock",
      model: "mock",
    });
    await db
      .insert(schema.sessions)
      .values({
        id: "session-think-route-user",
        userId: "think-route-user",
        token: "think-route-token",
        expiresAt: new Date(createdAt + 60_000),
        createdAt: new Date(createdAt),
        updatedAt: new Date(createdAt),
        ipAddress: null,
        userAgent: null,
      })
      .onConflictDoNothing();
    await db
      .insert(schema.workspaceMembers)
      .values({
        workspaceId: "workspace-think-route-smoke",
        userId: "think-route-user",
        role: "owner",
        createdAt,
      })
      .onConflictDoNothing();

    const res = await SELF.fetch(
      "https://nadi.test/think-agents/think-thread-agent/think-route-smoke",
      {
        headers: {
          cookie: "better-auth.session_token=think-route-token",
          upgrade: "websocket",
        },
      },
    );

    expect([101, 400, 426]).toContain(res.status);
    expect(res.status).not.toBe(401);
    expect(res.status).not.toBe(404);
  });

  it("serves Think message history over the runtime-specific history endpoint", async () => {
    const db = drizzle(env.REGISTRY_DB, { schema });
    const createdAt = 1_800_000_000_000;
    await db
      .insert(schema.users)
      .values({
        id: "think-history-user",
        email: "think-history-user@example.com",
        name: null,
        createdAt: new Date(createdAt),
        emailVerified: true,
        image: null,
        updatedAt: new Date(createdAt),
      })
      .onConflictDoNothing();
    await seedRegistryThread(env.REGISTRY_DB, {
      workspaceId: "workspace-think-history",
      agentId: "agent-think-history",
      threadId: "think-history-smoke",
      runtime: "think",
      provider: "mock",
      model: "mock",
    });
    await db
      .insert(schema.sessions)
      .values({
        id: "session-think-history-user",
        userId: "think-history-user",
        token: "think-history-token",
        expiresAt: new Date(createdAt + 60_000),
        createdAt: new Date(createdAt),
        updatedAt: new Date(createdAt),
        ipAddress: null,
        userAgent: null,
      })
      .onConflictDoNothing();
    await db
      .insert(schema.workspaceMembers)
      .values({
        workspaceId: "workspace-think-history",
        userId: "think-history-user",
        role: "owner",
        createdAt,
      })
      .onConflictDoNothing();

    const stub = env.THINK_THREAD_AGENT.get(
      env.THINK_THREAD_AGENT.idFromName("think-history-smoke"),
    );
    await runInThinkDo(stub, async (instance: InitializableAgent) => {
      await instance.__unsafe_ensureInitialized();
      await instance.runTurn({ input: "History route" });
    });

    const res = await SELF.fetch(
      "https://nadi.test/think-agents/think-thread-agent/think-history-smoke/get-messages",
      {
        headers: {
          cookie: "better-auth.session_token=think-history-token",
        },
      },
    );
    const body = await res.json<unknown>();

    expect(res.status).toBe(200);
    expect(Array.isArray(body)).toBe(true);
    expect(body).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          role: "user",
          parts: expect.arrayContaining([expect.objectContaining({ text: "History route" })]),
        }),
        expect.objectContaining({
          role: "assistant",
          // Echo of the first turn's clock reminder — see the note in "runs a
          // registry-resolved Think chat turn".
          parts: expect.arrayContaining([
            expect.objectContaining({ text: expect.stringContaining(CLOCK_STAMP_PREFIX) }),
          ]),
        }),
      ]),
    );
  });
});
