import { tool, type ToolSet } from "ai";
import { z } from "zod";
import { registryDb } from "../db/client";
import { AgentMemoryRepository, type MemoryKind } from "../db/repositories/agent-memories";
import { ThreadRepository } from "../db/repositories/threads";
import type { Env } from "../env";
import { log } from "../log";

const MAX_MEMORY_CONTENT_LENGTH = 2_000;
const secretPattern = /sk-|BEGIN PRIVATE KEY|api_key=|password=|token=/i;
const memoryKindSchema = z.enum(["fact", "preference", "workflow", "project"]);

type ThreadScope = {
  workspaceId: string;
  agentId: string;
};

export function createMemoryTools(input: { env: Env; threadId: string }): ToolSet {
  const { env, threadId } = input;

  return {
    remember: tool({
      // Recording is trigger-based. The old copy said "when the user explicitly
      // asks you to remember", which meant nothing was ever recorded proactively:
      // users don't ask. Name the triggers, and keep the exclusions loud.
      description:
        "Store a durable memory for this agent. Call this yourself, without being asked, whenever the user corrects you, states a preference or constraint, settles on a way of working, or tells you something about their project, tools, or environment that will still be true next week. Do NOT store what the repository already states, details that only matter inside this thread, or secrets, credentials, tokens, and passwords. Check the memory index in your system prompt first: if a memory already covers this, call update_memory instead.",
      inputSchema: z.object({
        content: z
          .string()
          .describe("Stable fact, preference, workflow, or project context to remember"),
        title: z.string().optional().describe("Short label for the memory"),
        kind: memoryKindSchema.optional().describe("Memory category"),
      }),
      execute: async ({ content, title, kind }) => {
        const cleanContent = validateMemoryContent(content);
        if (!cleanContent.ok) return cleanContent.error;

        const scope = await resolveThreadScope(env, threadId);
        if (!scope.ok) return scope.error;

        try {
          const repo = new AgentMemoryRepository(registryDb(env));
          const cleanTitle = cleanOptionalText(title);
          const memory = await repo.create({
            workspaceId: scope.value.workspaceId,
            agentId: scope.value.agentId,
            sourceThreadId: threadId,
            content: cleanContent.content,
            ...(cleanTitle !== undefined ? { title: cleanTitle } : {}),
            ...(kind !== undefined ? { kind } : {}),
          });
          return `remembered: ${memory.id} ${summarizeMemory(memory.title, memory.content)}`;
        } catch (error) {
          log.error("agent_memory.remember_failed", { threadId, error: String(error) });
          return "error: failed to remember memory";
        }
      },
    }),

    search_memories: tool({
      // The system prompt already lists every memory (memory-index.ts), so this
      // is now a read-in-full, not the only way to discover a memory exists.
      description:
        "Read durable memories for this agent in full. Your system prompt lists them; call this to read the whole text of one whose hook looks relevant, or to look for memories past the listed ones.",
      inputSchema: z.object({
        query: z.string().describe("Search query for relevant durable memories"),
        limit: z.number().int().min(1).max(10).optional().describe("Maximum memories to return"),
      }),
      execute: async ({ query, limit }) => {
        const scope = await resolveThreadScope(env, threadId);
        if (!scope.ok) return scope.error;

        try {
          const repo = new AgentMemoryRepository(registryDb(env));
          const memories = await repo.search({
            workspaceId: scope.value.workspaceId,
            agentId: scope.value.agentId,
            query,
            ...(limit !== undefined ? { limit } : {}),
          });
          if (memories.length === 0) return "no memories found";
          return JSON.stringify({
            memories: memories.map((memory) => ({
              id: memory.id,
              title: memory.title,
              content: memory.content,
              kind: memory.kind,
              updatedAt: memory.updatedAt,
            })),
          });
        } catch (error) {
          log.error("agent_memory.search_failed", { threadId, error: String(error) });
          return "error: failed to search memories";
        }
      },
    }),

    update_memory: tool({
      description:
        "Update an existing durable memory for this agent when the user corrects or supersedes it. Use this instead of creating duplicates.",
      inputSchema: z.object({
        id: z.string().describe("Memory id returned by search_memories"),
        content: z.string().describe("Replacement memory content"),
        title: z.string().optional().describe("Replacement short label"),
        kind: memoryKindSchema.optional().describe("Replacement memory category"),
      }),
      execute: async ({ id, content, title, kind }) => {
        const cleanContent = validateMemoryContent(content);
        if (!cleanContent.ok) return cleanContent.error;

        const scope = await resolveThreadScope(env, threadId);
        if (!scope.ok) return scope.error;

        try {
          const repo = new AgentMemoryRepository(registryDb(env));
          const cleanTitle = cleanOptionalText(title);
          const memory = await repo.update({
            workspaceId: scope.value.workspaceId,
            agentId: scope.value.agentId,
            id,
            content: cleanContent.content,
            ...(cleanTitle !== undefined ? { title: cleanTitle } : {}),
            ...(kind !== undefined ? { kind } : {}),
          });
          if (!memory) return `not found: memory ${id}`;
          return `updated: ${memory.id} ${summarizeMemory(memory.title, memory.content)}`;
        } catch (error) {
          log.error("agent_memory.update_failed", { threadId, memoryId: id, error: String(error) });
          return "error: failed to update memory";
        }
      },
    }),

    forget_memory: tool({
      description:
        "Forget a durable memory for this agent when the user asks to remove, revoke, or forget it.",
      inputSchema: z.object({
        id: z.string().describe("Memory id returned by search_memories"),
      }),
      execute: async ({ id }) => {
        const scope = await resolveThreadScope(env, threadId);
        if (!scope.ok) return scope.error;

        try {
          const repo = new AgentMemoryRepository(registryDb(env));
          const archived = await repo.archive({
            workspaceId: scope.value.workspaceId,
            agentId: scope.value.agentId,
            id,
          });
          return archived ? `forgot: ${id}` : `not found: memory ${id}`;
        } catch (error) {
          log.error("agent_memory.forget_failed", { threadId, memoryId: id, error: String(error) });
          return "error: failed to forget memory";
        }
      },
    }),
  };
}

async function resolveThreadScope(
  env: Env,
  threadId: string,
): Promise<{ ok: true; value: ThreadScope } | { ok: false; error: string }> {
  const repo = new ThreadRepository(registryDb(env));
  const thread = await repo.getById(threadId);
  if (!thread) return { ok: false, error: `error: thread ${threadId} not found` };
  return { ok: true, value: { workspaceId: thread.workspaceId, agentId: thread.agentId } };
}

function validateMemoryContent(
  content: string,
): { ok: true; content: string } | { ok: false; error: string } {
  const trimmed = content.trim();
  if (trimmed.length === 0) return { ok: false, error: "error: memory content is required" };
  if (trimmed.length > MAX_MEMORY_CONTENT_LENGTH) {
    return { ok: false, error: "error: memory content is too long" };
  }
  if (secretPattern.test(trimmed)) {
    return { ok: false, error: "error: refusing to store secret-looking content" };
  }
  return { ok: true, content: trimmed };
}

function cleanOptionalText(value: string | undefined): string | undefined {
  const trimmed = value?.trim();
  return trimmed === "" ? undefined : trimmed;
}

function summarizeMemory(title: string | null, content: string): string {
  const summary = content.length > 120 ? `${content.slice(0, 117)}...` : content;
  return title ? `"${title}": ${summary}` : summary;
}

export type { MemoryKind };
