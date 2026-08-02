import { and, desc, eq, isNotNull, isNull } from "drizzle-orm";
import type { DrizzleD1Database } from "drizzle-orm/d1";
import { agentMemories, type AgentMemory } from "../schema";
import type * as schema from "../schema";

export type MemoryKind = "fact" | "preference" | "workflow" | "project";

export interface CreateAgentMemoryInput {
  workspaceId: string;
  agentId: string;
  sourceThreadId?: string;
  content: string;
  title?: string;
  kind?: MemoryKind;
}

export interface SearchAgentMemoriesInput {
  workspaceId: string;
  agentId: string;
  query: string;
  limit?: number;
}

type ScoredMemory = {
  memory: AgentMemory;
  score: number;
};

const DEFAULT_SEARCH_LIMIT = 5;
const MAX_SEARCH_LIMIT = 10;

export class AgentMemoryRepository {
  constructor(private readonly db: DrizzleD1Database<typeof schema>) {}

  async create(input: CreateAgentMemoryInput): Promise<AgentMemory> {
    const now = Date.now();
    const row = {
      id: crypto.randomUUID(),
      workspaceId: input.workspaceId,
      agentId: input.agentId,
      sourceThreadId: input.sourceThreadId ?? null,
      content: input.content,
      title: input.title ?? null,
      kind: input.kind ?? "fact",
      createdAt: now,
      updatedAt: now,
      archivedAt: null,
    } satisfies typeof agentMemories.$inferInsert;

    await this.db.insert(agentMemories).values(row);
    return row;
  }

  async search(input: SearchAgentMemoriesInput): Promise<AgentMemory[]> {
    const limit = clampSearchLimit(input.limit);
    const rankingInput = buildRankingInput(input.query);
    if (rankingInput.tokens.length === 0 && rankingInput.phrase === "") return [];

    const rows = await this.db
      .select()
      .from(agentMemories)
      .where(
        and(
          eq(agentMemories.workspaceId, input.workspaceId),
          eq(agentMemories.agentId, input.agentId),
          isNull(agentMemories.archivedAt),
        ),
      )
      .orderBy(desc(agentMemories.updatedAt))
      .all();

    return rows
      .map((memory) => ({ memory, score: scoreMemory(memory, rankingInput) }))
      .filter((scored) => scored.score > 0)
      .sort(compareScoredMemories)
      .slice(0, limit)
      .map((scored) => scored.memory);
  }

  async update(input: {
    workspaceId: string;
    agentId: string;
    id: string;
    content: string;
    title?: string;
    kind?: MemoryKind;
  }): Promise<AgentMemory | undefined> {
    const fields: Partial<typeof agentMemories.$inferInsert> = {
      content: input.content,
      updatedAt: Date.now(),
    };
    if ("title" in input) fields.title = input.title ?? null;
    if (input.kind !== undefined) fields.kind = input.kind;

    await this.db
      .update(agentMemories)
      .set(fields)
      .where(
        and(
          eq(agentMemories.id, input.id),
          eq(agentMemories.workspaceId, input.workspaceId),
          eq(agentMemories.agentId, input.agentId),
          isNull(agentMemories.archivedAt),
        ),
      );

    return this.getActiveOwned(input);
  }

  async archive(input: { workspaceId: string; agentId: string; id: string }): Promise<boolean> {
    const existing = await this.getActiveOwned(input);
    if (!existing) return false;

    await this.db
      .update(agentMemories)
      .set({ archivedAt: Date.now(), updatedAt: Date.now() })
      .where(
        and(
          eq(agentMemories.id, input.id),
          eq(agentMemories.workspaceId, input.workspaceId),
          eq(agentMemories.agentId, input.agentId),
          isNull(agentMemories.archivedAt),
        ),
      );
    return true;
  }

  async listActive(input: { workspaceId: string; agentId: string }): Promise<AgentMemory[]> {
    return this.db
      .select()
      .from(agentMemories)
      .where(
        and(
          eq(agentMemories.workspaceId, input.workspaceId),
          eq(agentMemories.agentId, input.agentId),
          isNull(agentMemories.archivedAt),
        ),
      )
      .orderBy(desc(agentMemories.updatedAt))
      .all();
  }

  async listArchived(input: { workspaceId: string; agentId: string }): Promise<AgentMemory[]> {
    return this.db
      .select()
      .from(agentMemories)
      .where(
        and(
          eq(agentMemories.workspaceId, input.workspaceId),
          eq(agentMemories.agentId, input.agentId),
          isNotNull(agentMemories.archivedAt),
        ),
      )
      .orderBy(desc(agentMemories.archivedAt))
      .all();
  }

  async restore(input: {
    workspaceId: string;
    agentId: string;
    id: string;
  }): Promise<AgentMemory | undefined> {
    await this.db
      .update(agentMemories)
      .set({ archivedAt: null, updatedAt: Date.now() })
      .where(
        and(
          eq(agentMemories.id, input.id),
          eq(agentMemories.workspaceId, input.workspaceId),
          eq(agentMemories.agentId, input.agentId),
        ),
      );
    return this.getActiveOwned(input);
  }

  private async getActiveOwned(input: {
    workspaceId: string;
    agentId: string;
    id: string;
  }): Promise<AgentMemory | undefined> {
    return this.db
      .select()
      .from(agentMemories)
      .where(
        and(
          eq(agentMemories.id, input.id),
          eq(agentMemories.workspaceId, input.workspaceId),
          eq(agentMemories.agentId, input.agentId),
          isNull(agentMemories.archivedAt),
        ),
      )
      .get();
  }
}

function clampSearchLimit(limit: number | undefined): number {
  if (limit === undefined || !Number.isFinite(limit)) return DEFAULT_SEARCH_LIMIT;
  return Math.max(1, Math.min(MAX_SEARCH_LIMIT, Math.trunc(limit)));
}

function buildRankingInput(query: string): { phrase: string; tokens: string[] } {
  const phrase = query.trim().toLowerCase();
  return {
    phrase,
    tokens: [...new Set(phrase.match(/[a-z0-9]+/g) ?? [])],
  };
}

function scoreMemory(memory: AgentMemory, input: { phrase: string; tokens: string[] }): number {
  const title = (memory.title ?? "").toLowerCase();
  const content = memory.content.toLowerCase();
  let score = 0;

  if (input.phrase !== "") {
    if (title.includes(input.phrase)) score += 100;
    if (content.includes(input.phrase)) score += 50;
  }

  for (const token of input.tokens) {
    if (title.includes(token)) score += 10;
    if (content.includes(token)) score += 2;
  }

  return score;
}

function compareScoredMemories(a: ScoredMemory, b: ScoredMemory): number {
  if (a.score !== b.score) return b.score - a.score;
  if (a.memory.updatedAt !== b.memory.updatedAt) return b.memory.updatedAt - a.memory.updatedAt;
  if (a.memory.content.length !== b.memory.content.length) {
    return a.memory.content.length - b.memory.content.length;
  }
  return a.memory.id.localeCompare(b.memory.id);
}
