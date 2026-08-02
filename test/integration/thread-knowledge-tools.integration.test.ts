import { env, runInDurableObject } from "cloudflare:test";
import { beforeAll, beforeEach, describe, expect, it } from "vitest";
import { createBaseNativeThreadTools } from "../../src/agent/thread-tools";
import type { SubAgent } from "../../src/agent/subagent";
import type { ThinkThreadAgent } from "../../src/agent/think-thread-agent";
import { applyRegistryTestSchema, seedRegistryThread } from "./helpers/registry";
import { resetRegistryState } from "./helpers/reset";

declare global {
  namespace Cloudflare {
    interface Env {
      SUB_AGENT: DurableObjectNamespace<SubAgent>;
    }
  }
}

type ToolMap = Record<string, { execute?: (input: unknown, options: unknown) => Promise<unknown> }>;
type SubAgentTestSeam = SubAgent & {
  _testSubagentContext?: {
    parentThreadId: string;
    workspaceId: string;
    agentId: string;
    attachedRuntime: { provider: string; version: 1; payload: Record<string, string> };
  };
  __unsafe_ensureInitialized(): Promise<void>;
};

const runInThinkDo = runInDurableObject as any;
const runInSubAgentDo = runInDurableObject as any;
const now = 1_800_000_000_000;
const knowledgeToolNames = ["grep_thread", "list_threads", "read_thread", "search_threads"];

async function callTool(tools: ToolMap, name: string, input: unknown) {
  const execute = tools[name]?.execute;
  if (!execute) throw new Error(`missing tool ${name}`);
  return execute(input, {} as never);
}

async function seedSearchMessage(input: {
  workspaceId: string;
  threadId: string;
  messageId: string;
  content: string;
  createdAt: number;
}) {
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
      VALUES (?, ?, ?, 'assistant', ?, ?, ?, ?, 1)
    `,
  )
    .bind(
      input.workspaceId,
      input.threadId,
      input.messageId,
      input.createdAt,
      input.content,
      `content-${input.messageId}`,
      `source-${input.messageId}`,
    )
    .run();
}

async function markSearchCurrent(threadId: string, indexedThrough: number) {
  await env.REGISTRY_DB.prepare(
    "UPDATE thread_index SET search_indexed_through = ?, last_message_preview = ? WHERE id = ?",
  )
    .bind(indexedThrough, "orchidneedle evidence from target", threadId)
    .run();
}

async function seedThinkMessages(threadId: string) {
  const stub = env.THINK_THREAD_AGENT.get(env.THINK_THREAD_AGENT.idFromName(threadId));
  await runInThinkDo(
    stub,
    async (instance: ThinkThreadAgent & { __unsafe_ensureInitialized(): Promise<void> }) => {
      await instance.__unsafe_ensureInitialized();
      await instance.addMessages([
        {
          id: "target-user",
          role: "user",
          parts: [{ type: "text", text: "Please keep the launch notes handy." }],
        },
        {
          id: "target-assistant",
          role: "assistant",
          parts: [{ type: "text", text: "orchidneedle evidence lives in this assistant message." }],
        },
      ]);
    },
  );
}

describe("thread knowledge native tools", () => {
  beforeAll(async () => {
    await applyRegistryTestSchema(env.REGISTRY_DB);
  });

  beforeEach(async () => {
    await resetRegistryState(env.REGISTRY_DB);
  });

  it("lists, searches, reads, and greps visible workspace conversations through model-native tools", async () => {
    const workspaceId = "workspace-tool-integration";
    const caller = await seedRegistryThread(env.REGISTRY_DB, {
      workspaceId,
      agentId: "agent-caller",
      threadId: "thread-tool-caller",
      runtime: "think",
      title: "Caller thread",
      updatedAt: now + 1,
    });
    const target = await seedRegistryThread(env.REGISTRY_DB, {
      workspaceId,
      agentId: "agent-second",
      threadId: "thread-tool-target",
      runtime: "think",
      title: "Target thread",
      updatedAt: now + 2,
    });
    await seedRegistryThread(env.REGISTRY_DB, {
      workspaceId: "workspace-tool-foreign",
      agentId: "agent-foreign",
      threadId: "thread-tool-foreign",
      runtime: "think",
      title: "Foreign thread",
      updatedAt: now + 3,
    });
    await seedThinkMessages(target.threadId);
    await seedSearchMessage({
      workspaceId,
      threadId: target.threadId,
      messageId: "target-assistant",
      createdAt: now + 10,
      content: "orchidneedle evidence lives in this assistant message.",
    });
    await markSearchCurrent(target.threadId, now + 2);

    const tools = createBaseNativeThreadTools({
      env,
      threadId: caller.threadId,
      resolveThreadKnowledgeScope: async () => ({
        workspaceId: caller.workspaceId,
        callerThreadId: caller.threadId,
      }),
    }) as ToolMap;

    const listed = (await callTool(tools, "list_threads", { limit: 10 })) as {
      threads: Array<{ id: string }>;
    };
    expect(listed.threads.map((thread) => thread.id)).toContain(target.threadId);
    expect(listed.threads.map((thread) => thread.id)).not.toContain("thread-tool-foreign");

    const searched = (await callTool(tools, "search_threads", { query: "orchidneedle" })) as {
      results: Array<{ thread: { id: string }; excerpts: Array<{ text: string }> }>;
    };
    expect(searched.results[0]).toMatchObject({
      thread: { id: target.threadId },
      excerpts: [expect.objectContaining({ text: expect.stringContaining("orchidneedle") })],
    });

    const read = (await callTool(tools, "read_thread", { threadId: target.threadId })) as {
      messages: Array<{ id: string; text: string }>;
    };
    expect(read.messages.map((message) => message.id)).toEqual(["target-user", "target-assistant"]);

    const grep = (await callTool(tools, "grep_thread", {
      threadId: target.threadId,
      pattern: "orchidneedle",
    })) as { matches: Array<{ messageId: string; text: string }> };
    expect(grep.matches).toEqual([
      expect.objectContaining({
        messageId: "target-assistant",
        text: "orchidneedle evidence lives in this assistant message.",
      }),
    ]);

    const stub = env.THINK_THREAD_AGENT.get(env.THINK_THREAD_AGENT.idFromName(caller.threadId));
    const probed = await runInThinkDo(stub, async (agent: ThinkThreadAgent) =>
      agent.toolProbeForTest(),
    );
    expect(probed).toEqual(expect.arrayContaining(knowledgeToolNames));
  });

  it("resolves a SubAgent knowledge scope through its parent runtime config", async () => {
    const parent = await seedRegistryThread(env.REGISTRY_DB, {
      workspaceId: "workspace-subagent-knowledge",
      agentId: "agent-parent-knowledge",
      threadId: "thread-parent-knowledge",
      runtime: "think",
      title: "Parent thread",
      updatedAt: now + 20,
    });
    const sibling = await seedRegistryThread(env.REGISTRY_DB, {
      workspaceId: parent.workspaceId,
      agentId: "agent-sibling-knowledge",
      threadId: "thread-sibling-knowledge",
      runtime: "think",
      title: "Sibling thread",
      updatedAt: now + 21,
    });

    const stub = env.SUB_AGENT.get(env.SUB_AGENT.idFromName("sub_knowledge_scope"));
    const listed = await runInSubAgentDo(stub, async (child: SubAgentTestSeam) => {
      child._testSubagentContext = {
        parentThreadId: parent.threadId,
        workspaceId: parent.workspaceId,
        agentId: parent.agentId,
        attachedRuntime: {
          provider: "daytona",
          version: 1,
          payload: { kind: "runtime", sandboxId: "fake_sbx_parent" },
        },
      };
      await child.__unsafe_ensureInitialized();
      const tools = child.getTools() as ToolMap;
      return callTool(tools, "list_threads", { limit: 10 });
    });

    expect(
      (listed as { threads: Array<{ id: string }> }).threads.map((thread) => thread.id),
    ).toContain(sibling.threadId);
  });
});
