import { and, asc, desc, eq, isNotNull, isNull } from "drizzle-orm";
import type { DrizzleD1Database } from "drizzle-orm/d1";
import type * as schema from "../schema";
import { agentSkillResources, agentSkills, type AgentSkill } from "../schema";
import { assertValidSkillScriptPath } from "../../agent/skills/script-path";

const MAX_SKILL_NAME_LENGTH = 80;
const VALID_SKILL_NAME = /^[a-z0-9_-]+$/;

export interface CreateAgentSkillInput {
  workspaceId: string;
  agentId: string;
  name: string;
  description: string;
  body: string;
}

export class AgentSkillNameError extends Error {
  constructor(name: string) {
    super(`invalid skill name: ${name}`);
    this.name = "AgentSkillNameError";
  }
}

export class AgentSkillDuplicateError extends Error {
  constructor(name: string) {
    super(`duplicate skill name: ${name}`);
    this.name = "AgentSkillDuplicateError";
  }
}

export function normalizeSkillName(name: string): string {
  const normalized = name.trim().toLowerCase().replace(/\s+/g, "-");
  if (
    normalized.length === 0 ||
    normalized.length > MAX_SKILL_NAME_LENGTH ||
    !VALID_SKILL_NAME.test(normalized)
  ) {
    throw new AgentSkillNameError(name);
  }
  return normalized;
}

export class AgentSkillRepository {
  constructor(private readonly db: DrizzleD1Database<typeof schema>) {}

  async create(input: CreateAgentSkillInput): Promise<AgentSkill> {
    const name = normalizeSkillName(input.name);
    await this.assertActiveNameAvailable({
      workspaceId: input.workspaceId,
      agentId: input.agentId,
      name,
    });
    const now = Date.now();
    const row = {
      id: crypto.randomUUID(),
      workspaceId: input.workspaceId,
      agentId: input.agentId,
      name,
      description: input.description,
      body: input.body,
      networkDomains: null,
      enabled: true,
      createdAt: now,
      updatedAt: now,
      archivedAt: null,
    };
    try {
      await this.db.insert(agentSkills).values(row);
    } catch (error) {
      if (isUniqueConstraintError(error)) throw new AgentSkillDuplicateError(name);
      throw error;
    }
    return row;
  }

  async listActive(
    input: { workspaceId: string; agentId: string },
    opts?: { includeDisabled?: boolean },
  ): Promise<AgentSkill[]> {
    const conditions = [
      eq(agentSkills.workspaceId, input.workspaceId),
      eq(agentSkills.agentId, input.agentId),
      isNull(agentSkills.archivedAt),
    ];
    if (!opts?.includeDisabled) conditions.push(eq(agentSkills.enabled, true));
    return this.db
      .select()
      .from(agentSkills)
      .where(and(...conditions))
      .orderBy(asc(agentSkills.name))
      .all();
  }

  async listArchived(input: { workspaceId: string; agentId: string }): Promise<AgentSkill[]> {
    return this.db
      .select()
      .from(agentSkills)
      .where(
        and(
          eq(agentSkills.workspaceId, input.workspaceId),
          eq(agentSkills.agentId, input.agentId),
          isNotNull(agentSkills.archivedAt),
        ),
      )
      .orderBy(desc(agentSkills.archivedAt))
      .all();
  }

  async setEnabled(input: {
    workspaceId: string;
    agentId: string;
    id: string;
    enabled: boolean;
  }): Promise<AgentSkill | undefined> {
    await this.db
      .update(agentSkills)
      .set({ enabled: input.enabled, updatedAt: Date.now() })
      .where(
        and(
          eq(agentSkills.id, input.id),
          eq(agentSkills.workspaceId, input.workspaceId),
          eq(agentSkills.agentId, input.agentId),
          isNull(agentSkills.archivedAt),
        ),
      );
    return this.getOwnedById(input);
  }

  async archiveById(input: {
    workspaceId: string;
    agentId: string;
    id: string;
  }): Promise<AgentSkill | undefined> {
    await this.db
      .update(agentSkills)
      .set({ archivedAt: Date.now(), updatedAt: Date.now() })
      .where(
        and(
          eq(agentSkills.id, input.id),
          eq(agentSkills.workspaceId, input.workspaceId),
          eq(agentSkills.agentId, input.agentId),
          isNull(agentSkills.archivedAt),
        ),
      );
    return this.getOwnedById(input);
  }

  async restore(input: {
    workspaceId: string;
    agentId: string;
    id: string;
  }): Promise<AgentSkill | undefined> {
    const current = await this.getOwnedById(input);
    if (!current) return undefined;
    try {
      await this.db
        .update(agentSkills)
        .set({ archivedAt: null, updatedAt: Date.now() })
        .where(eq(agentSkills.id, current.id));
    } catch (error) {
      if (isUniqueConstraintError(error)) throw new AgentSkillDuplicateError(current.name);
      throw error;
    }
    return this.getOwnedById(input);
  }

  private async getOwnedById(input: {
    workspaceId: string;
    agentId: string;
    id: string;
  }): Promise<AgentSkill | undefined> {
    return this.db
      .select()
      .from(agentSkills)
      .where(
        and(
          eq(agentSkills.id, input.id),
          eq(agentSkills.workspaceId, input.workspaceId),
          eq(agentSkills.agentId, input.agentId),
        ),
      )
      .get();
  }

  async getActiveByName(input: {
    workspaceId: string;
    agentId: string;
    name: string;
  }): Promise<AgentSkill | undefined> {
    const name = normalizeSkillName(input.name);
    return this.db
      .select()
      .from(agentSkills)
      .where(
        and(
          eq(agentSkills.workspaceId, input.workspaceId),
          eq(agentSkills.agentId, input.agentId),
          eq(agentSkills.name, name),
          isNull(agentSkills.archivedAt),
        ),
      )
      .get();
  }

  async edit(input: {
    workspaceId: string;
    agentId: string;
    name: string;
    newName?: string;
    description?: string;
    body?: string;
  }): Promise<AgentSkill | undefined> {
    const name = normalizeSkillName(input.name);
    const current = await this.getActiveByName({ ...input, name });
    if (!current) return undefined;

    const newName = input.newName !== undefined ? normalizeSkillName(input.newName) : undefined;
    if (newName !== undefined && newName !== name) {
      await this.assertActiveNameAvailable({
        workspaceId: input.workspaceId,
        agentId: input.agentId,
        name: newName,
      });
    }

    const patch = {
      ...(newName !== undefined ? { name: newName } : {}),
      ...(input.description !== undefined ? { description: input.description } : {}),
      ...(input.body !== undefined ? { body: input.body } : {}),
      updatedAt: Date.now(),
    };
    try {
      await this.db.update(agentSkills).set(patch).where(eq(agentSkills.id, current.id));
    } catch (error) {
      if (isUniqueConstraintError(error)) throw new AgentSkillDuplicateError(newName ?? name);
      throw error;
    }
    return this.db.select().from(agentSkills).where(eq(agentSkills.id, current.id)).get();
  }

  async archive(input: { workspaceId: string; agentId: string; name: string }): Promise<boolean> {
    const current = await this.getActiveByName(input);
    if (!current) return false;
    await this.db
      .update(agentSkills)
      .set({ archivedAt: Date.now(), updatedAt: Date.now() })
      .where(eq(agentSkills.id, current.id));
    return true;
  }

  private async assertActiveNameAvailable(input: {
    workspaceId: string;
    agentId: string;
    name: string;
  }) {
    const existing = await this.getActiveByName(input);
    if (existing) throw new AgentSkillDuplicateError(input.name);
  }

  async setScript(input: {
    workspaceId: string;
    agentId: string;
    name: string;
    path: string;
    source: string;
  }): Promise<void> {
    // The single write path for a script resource, so validate here: a stored
    // script the SDK refuses to run still opens the run_skill_script gate.
    assertValidSkillScriptPath(input.path);
    const skill = await this.getActiveByName(input);
    if (!skill) throw new Error(`skill not found: ${normalizeSkillName(input.name)}`);
    const now = Date.now();
    // A skill has at most one script resource: clear any existing script, then insert.
    await this.db
      .delete(agentSkillResources)
      .where(
        and(eq(agentSkillResources.skillId, skill.id), eq(agentSkillResources.kind, "script")),
      );
    await this.db.insert(agentSkillResources).values({
      id: crypto.randomUUID(),
      skillId: skill.id,
      path: input.path,
      kind: "script",
      encoding: "text",
      mimeType: null,
      content: input.source,
      createdAt: now,
      updatedAt: now,
    });
    await this.db.update(agentSkills).set({ updatedAt: now }).where(eq(agentSkills.id, skill.id));
  }

  async setNetworkDomains(input: {
    workspaceId: string;
    agentId: string;
    name: string;
    domains: string[];
  }): Promise<void> {
    const skill = await this.getActiveByName(input);
    if (!skill) throw new Error(`skill not found: ${normalizeSkillName(input.name)}`);
    const deduped = [...new Set(input.domains.map((d) => d.trim()).filter(Boolean))];
    await this.db
      .update(agentSkills)
      .set({
        networkDomains: deduped.length ? JSON.stringify(deduped) : null,
        updatedAt: Date.now(),
      })
      .where(eq(agentSkills.id, skill.id));
  }

  async listResourceDescriptors(skillId: string): Promise<
    Array<{
      path: string;
      kind: string;
      encoding: "text" | "base64";
      mimeType: string | null;
      size: number;
    }>
  > {
    const rows = await this.db
      .select()
      .from(agentSkillResources)
      .where(eq(agentSkillResources.skillId, skillId))
      .all();
    return rows.map((r) => ({
      path: r.path,
      kind: r.kind,
      encoding: r.encoding,
      mimeType: r.mimeType,
      size: r.content.length,
    }));
  }

  async getResource(
    skillId: string,
    path: string,
  ): Promise<{
    path: string;
    kind: string;
    encoding: "text" | "base64";
    mimeType: string | null;
    content: string;
  } | null> {
    const row = await this.db
      .select()
      .from(agentSkillResources)
      .where(and(eq(agentSkillResources.skillId, skillId), eq(agentSkillResources.path, path)))
      .get();
    if (!row) return null;
    return {
      path: row.path,
      kind: row.kind,
      encoding: row.encoding,
      mimeType: row.mimeType,
      content: row.content,
    };
  }

  async listEnabledSkillDomains(scope: {
    workspaceId: string;
    agentId: string;
  }): Promise<string[]> {
    const rows = await this.listActive(scope); // enabled + non-archived by default
    const domains = new Set<string>();
    for (const row of rows) {
      if (!row.networkDomains) continue;
      try {
        for (const d of JSON.parse(row.networkDomains) as string[]) domains.add(d);
      } catch {
        /* ignore malformed */
      }
    }
    return [...domains];
  }

  /**
   * Whether any enabled, non-archived skill in scope ships a runnable script.
   *
   * One round-trip on purpose: this runs during a thread DO's cold `onStart`
   * (it gates the skill script runner), and a D1 round-trip from inside a DO
   * costs ~220ms. It used to call `listActive()` — re-running the exact SELECT
   * the skill source already issues — and then fan out a second query over the
   * returned ids: three sequential waves to answer one boolean. The join below
   * keeps the same filters (scope, not archived, enabled, kind=script).
   */
  async hasEnabledScriptSkill(scope: { workspaceId: string; agentId: string }): Promise<boolean> {
    const rows = await this.db
      .select({ skillId: agentSkillResources.skillId })
      .from(agentSkillResources)
      .innerJoin(agentSkills, eq(agentSkillResources.skillId, agentSkills.id))
      .where(
        and(
          eq(agentSkills.workspaceId, scope.workspaceId),
          eq(agentSkills.agentId, scope.agentId),
          isNull(agentSkills.archivedAt),
          eq(agentSkills.enabled, true),
          eq(agentSkillResources.kind, "script"),
        ),
      )
      .limit(1)
      .all();
    return rows.length > 0;
  }
}

function isUniqueConstraintError(error: unknown): boolean {
  let current: unknown = error;
  for (let depth = 0; current && depth < 5; depth++) {
    if (String(current).toLowerCase().includes("unique")) return true;
    current = current instanceof Error ? current.cause : undefined;
  }
  return false;
}
