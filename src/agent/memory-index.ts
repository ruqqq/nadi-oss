import { registryDb } from "../db/client";
import { AgentMemoryRepository } from "../db/repositories/agent-memories";
import type { MemoryKind } from "../db/repositories/agent-memories";
import type { Env } from "../env";

/** One line of the index: enough to decide "is this relevant?", not the whole memory. */
export interface MemoryIndexEntry {
  id: string;
  kind: MemoryKind;
  hook: string;
}

export interface MemoryIndexContext {
  entries: MemoryIndexEntry[];
  /** Total active memories, so a truncated index can say what it left out. */
  total: number;
}

/** Most-recently-updated memories are the ones most likely to still be true. */
const MAX_INDEX_ENTRIES = 50;
const MAX_HOOK_LENGTH = 110;

/**
 * The agent's memories, listed in every system prompt.
 *
 * Recall used to depend on the model deciding to call `search_memories` with a
 * query that happened to lexically overlap the stored text -- three chances to
 * silently fail, after which a memory may as well not exist. An always-present
 * index means the model KNOWS what it knows, and `search_memories` degrades from
 * the only way in to "read one of these in full".
 */
export async function resolveMemoryIndex(input: {
  env: Env;
  workspaceId: string;
  agentId: string;
}): Promise<MemoryIndexContext | undefined> {
  const repo = new AgentMemoryRepository(registryDb(input.env));
  const memories = await repo.listActive({
    workspaceId: input.workspaceId,
    agentId: input.agentId,
  });
  if (memories.length === 0) return undefined;

  return {
    total: memories.length,
    entries: memories.slice(0, MAX_INDEX_ENTRIES).map((memory) => ({
      id: memory.id,
      kind: memory.kind,
      hook: buildHook(memory.title, memory.content),
    })),
  };
}

/** `title — content snippet`, or just the snippet when a memory has no title. */
function buildHook(title: string | null, content: string): string {
  const snippet = content.replace(/\s+/g, " ").trim();
  const cleanTitle = title?.trim();
  const line = cleanTitle ? `${cleanTitle} — ${snippet}` : snippet;
  return line.length > MAX_HOOK_LENGTH ? `${line.slice(0, MAX_HOOK_LENGTH - 1).trimEnd()}…` : line;
}

export function formatMemoryIndex(index: MemoryIndexContext): string {
  const lines = [
    "Memory index (durable memories you already hold for this agent). Treat these as known:",
    "call `search_memories` only to read one in full, or to look past this list.",
    ...index.entries.map((entry) => `- [${entry.kind}] ${entry.id}: ${entry.hook}`),
  ];
  if (index.total > index.entries.length) {
    lines.push(
      `(${index.entries.length} most recently updated of ${index.total}; search for older ones.)`,
    );
  }
  return `\n\n${lines.join("\n")}`;
}
