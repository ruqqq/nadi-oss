import { env, runInDurableObject } from "cloudflare:test";
import { beforeAll, beforeEach, describe, expect, it } from "vitest";
import { createBaseNativeThreadTools } from "../../src/agent/thread-tools";
import type { ThinkThreadAgent } from "../../src/agent/think-thread-agent";
import type { ListThreadsResult, ReadThreadResult } from "../../src/thread-knowledge/types";
import { routeDebug } from "../../src/http/debug-routes";
import type { Env } from "../../src/env";
import { applyRegistryTestSchema } from "./helpers/registry";
import { resetRegistryState } from "./helpers/reset";

type ToolMap = Record<string, { execute?: (input: unknown, options: unknown) => Promise<unknown> }>;
type ThinkThreadTestSeam = ThinkThreadAgent & {
  __unsafe_ensureInitialized(): Promise<void>;
  addMessages(messages: unknown[]): Promise<void>;
};

const runInThinkDo = runInDurableObject as any;
const baseTime = Date.UTC(2026, 6, 23, 12);
const since = new Date(baseTime).toISOString();
const until = new Date(baseTime + 7 * 24 * 60 * 60 * 1_000).toISOString();

function proseMessage(input: {
  id: string;
  role: "user" | "assistant";
  text: string;
  createdAt: number;
}) {
  return {
    id: input.id,
    role: input.role,
    createdAt: input.createdAt,
    parts: [{ type: "text", text: input.text }],
  };
}

async function callTool<T>(tools: ToolMap, name: string, input: unknown): Promise<T> {
  const execute = tools[name]?.execute;
  if (!execute) throw new Error(`missing tool ${name}`);
  return execute(input, {} as never) as Promise<T>;
}

async function insertThread(input: {
  workspaceId: string;
  agentId: string;
  threadId: string;
  title: string;
  source?: "manual" | "automaton";
  createdAt?: number;
  updatedAt: number;
}) {
  await env.REGISTRY_DB.prepare(
    "INSERT OR IGNORE INTO workspaces (id, name, created_at) VALUES (?, ?, ?)",
  )
    .bind(input.workspaceId, input.workspaceId, input.createdAt ?? input.updatedAt)
    .run();
  await env.REGISTRY_DB.prepare(
    "INSERT OR IGNORE INTO agents (id, workspace_id, name, system_prompt, provider, model, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)",
  )
    .bind(
      input.agentId,
      input.workspaceId,
      input.agentId,
      "You are Nadi.",
      "mock",
      "mock",
      input.createdAt ?? input.updatedAt,
    )
    .run();
  await env.REGISTRY_DB.prepare(
    `
      INSERT INTO thread_index (
        id, workspace_id, agent_id, title, title_set, runtime, source,
        automaton_id, automaton_run_id, last_event_id, last_message_preview,
        created_at, updated_at
      )
      VALUES (?, ?, ?, ?, 1, 'think', ?, ?, ?, NULL, '', ?, ?)
    `,
  )
    .bind(
      input.threadId,
      input.workspaceId,
      input.agentId,
      input.title,
      input.source ?? "manual",
      input.source === "automaton" ? `auto-${input.threadId}` : null,
      input.source === "automaton" ? `run-${input.threadId}` : null,
      input.createdAt ?? input.updatedAt,
      input.updatedAt,
    )
    .run();
}

async function seedThinkMessages(threadId: string, messages: unknown[]) {
  const stub = env.THINK_THREAD_AGENT.get(env.THINK_THREAD_AGENT.idFromName(threadId));
  await runInThinkDo(stub, async (agent: ThinkThreadTestSeam) => {
    await agent.__unsafe_ensureInitialized();
    await agent.addMessages(messages);
  });
}

describe("weekly digest thread knowledge flow", () => {
  beforeAll(async () => {
    await applyRegistryTestSchema(env.REGISTRY_DB);
  });

  beforeEach(async () => {
    await resetRegistryState(env.REGISTRY_DB);
  });

  it("retrieves the weekly manual-thread digest through model-facing tools from an automaton caller", async () => {
    const workspaceId = "workspace-weekly-digest";
    const agentId = "agent-weekly-digest";
    const callerThreadId = "thread-weekly-caller";
    await insertThread({
      workspaceId,
      agentId,
      threadId: callerThreadId,
      title: "Weekly digest caller",
      source: "automaton",
      updatedAt: baseTime + 6_000,
    });

    const manualThreads = [
      {
        threadId: "thread-weekly-manual-a",
        title: "Alpha launch",
        user: "Alpha user asked about shipping notes.",
        assistant: "Alpha assistant captured dashboard risks.",
        updatedAt: baseTime + 5_000,
      },
      {
        threadId: "thread-weekly-manual-b",
        title: "Bravo retention",
        user: "Bravo user discussed retention experiments.",
        assistant: "Bravo assistant summarized renewal blockers.",
        updatedAt: baseTime + 4_000,
      },
      {
        threadId: "thread-weekly-manual-c",
        title: "Charlie support",
        user: "Charlie user reported support escalations.",
        assistant: "Charlie assistant listed follow-up owners.",
        updatedAt: baseTime + 3_000,
      },
    ];

    for (const [index, thread] of manualThreads.entries()) {
      await insertThread({ workspaceId, agentId, ...thread });
      await seedThinkMessages(thread.threadId, [
        proseMessage({
          id: `${thread.threadId}-user`,
          role: "user",
          text: thread.user,
          createdAt: baseTime + index * 100 + 10,
        }),
        proseMessage({
          id: `${thread.threadId}-assistant`,
          role: "assistant",
          text: thread.assistant,
          createdAt: baseTime + index * 100 + 20,
        }),
      ]);
    }

    await insertThread({
      workspaceId,
      agentId,
      threadId: "thread-weekly-old-manual",
      title: "Old manual thread",
      updatedAt: baseTime - 1,
    });
    await seedThinkMessages("thread-weekly-old-manual", [
      proseMessage({
        id: "thread-weekly-old-user",
        role: "user",
        text: "Old manual prose should stay out of the weekly digest.",
        createdAt: baseTime - 10,
      }),
    ]);

    for (let index = 0; index < 2; index += 1) {
      await insertThread({
        workspaceId,
        agentId,
        threadId: `thread-weekly-automaton-${index}`,
        title: `Automaton run ${index}`,
        source: "automaton",
        updatedAt: baseTime + 2_000 + index,
      });
    }

    const tools = createBaseNativeThreadTools({
      env,
      threadId: callerThreadId,
      resolveThreadKnowledgeScope: async () => ({
        workspaceId,
        callerThreadId,
      }),
    }) as ToolMap;

    const listed = await callTool<ListThreadsResult>(tools, "list_threads", {
      since,
      until,
      limit: 10,
    });
    expect(listed.threads.map((thread) => thread.id)).toEqual([
      "thread-weekly-manual-a",
      "thread-weekly-manual-b",
      "thread-weekly-manual-c",
    ]);
    expect(listed.threads.every((thread) => thread.source === "manual")).toBe(true);

    for (const thread of manualThreads) {
      const read = await callTool<ReadThreadResult>(tools, "read_thread", {
        threadId: thread.threadId,
        since,
        until,
        limit: 50,
      });
      expect(read).toHaveProperty("limited", false);
      expect(read.messages.map((message) => message.text)).toEqual([thread.user, thread.assistant]);
    }

    const firstManualThread = manualThreads[0];
    if (!firstManualThread) throw new Error("missing manual thread fixture");
    const partialRead = await callTool<ReadThreadResult>(tools, "read_thread", {
      threadId: firstManualThread.threadId,
      since,
      until,
      limit: 1,
    });
    expect(partialRead.limited).toBe(true);
    expect(partialRead.nextCursor).toEqual(expect.any(String));

    for (let index = 0; index < 55; index += 1) {
      await insertThread({
        workspaceId,
        agentId,
        threadId: `thread-weekly-page-${String(index).padStart(2, "0")}`,
        title: `Weekly page ${index}`,
        updatedAt: baseTime + 10_000 + index,
      });
    }

    const firstPage = await callTool<ListThreadsResult>(tools, "list_threads", {
      since,
      until,
      limit: 50,
    });
    expect(firstPage.threads).toHaveLength(50);
    expect(firstPage.nextCursor).toEqual(expect.any(String));
  });

  it("keeps the thread-knowledge walkthrough DEBUG_TOKEN-gated and headless", async () => {
    const workspaceId = "workspace-debug-thread-knowledge";
    const agentId = "agent-debug-thread-knowledge";
    const threadId = "thread-debug-thread-knowledge";
    await insertThread({
      workspaceId,
      agentId,
      threadId,
      title: "Debug caller",
      source: "automaton",
      updatedAt: baseTime + 1,
    });
    const debugEnv = { ...env, DEBUG_TOKEN: "debug-token" } as Env;
    const body = JSON.stringify({ threadId });

    const denied = await routeDebug(
      new Request("https://nadi.test/api/debug/thread-knowledge-tools", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body,
      }),
      debugEnv,
    );
    expect(denied?.status).toBe(404);

    const allowed = await routeDebug(
      new Request("https://nadi.test/api/debug/thread-knowledge-tools", {
        method: "POST",
        headers: { "Content-Type": "application/json", "x-debug-token": "debug-token" },
        body,
      }),
      debugEnv,
    );
    expect(allowed?.status).toBe(200);
    const result = (await allowed?.json()) as {
      steps: Array<{ step: string; ok: boolean; detail: unknown }>;
    };
    expect(result.steps).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ step: "search", ok: true }),
        expect.objectContaining({ step: "read", ok: true }),
        expect.objectContaining({ step: "grep", ok: true }),
        expect.objectContaining({ step: "weekly-list", ok: true }),
        expect.objectContaining({ step: "cleanup", ok: true }),
      ]),
    );
  });
});
