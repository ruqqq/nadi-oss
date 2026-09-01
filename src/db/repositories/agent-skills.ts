import { and, asc, desc, eq, isNotNull, isNull, notExists, or, type SQL } from "drizzle-orm";
import type { DrizzleD1Database } from "drizzle-orm/d1";
import type * as schema from "../schema";
import { agentSkillExclusions, agentSkillResources, skills, type Skill } from "../schema";
import { alias } from "drizzle-orm/sqlite-core";
import { assertValidSkillScriptPath } from "../../agent/skills/script-path";

const MAX_SKILL_NAME_LENGTH = 80;
const VALID_SKILL_NAME = /^[a-z0-9_-]+$/;

/** A library skill plus why it is, or is not, live on one agent. */
export type LibrarySkillForAgent = Skill & {
  /** This agent opted out of it (`agent_skill_exclusions`). */
  excluded: boolean;
  /** The agent's own skill of the same name that hides this one, if any. */
  shadowedByOwnSkillId: string | null;
};

export interface CreateAgentSkillInput {
  workspaceId: string;
  agentId: string | null;
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

  async create(input: CreateAgentSkillInput): Promise<Skill> {
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
      await this.db.insert(skills).values(row);
    } catch (error) {
      if (isUniqueConstraintError(error)) throw new AgentSkillDuplicateError(name);
      throw error;
    }
    return row;
  }

  async listActive(
    input: { workspaceId: string; agentId: string | null },
    opts?: { includeDisabled?: boolean },
  ): Promise<Skill[]> {
    const conditions = [
      eq(skills.workspaceId, input.workspaceId),
      scopeAgent(input.agentId),
      isNull(skills.archivedAt),
    ];
    if (!opts?.includeDisabled) conditions.push(eq(skills.enabled, true));
    return this.db
      .select()
      .from(skills)
      .where(and(...conditions))
      .orderBy(asc(skills.name))
      .all();
  }

  async listArchived(input: { workspaceId: string; agentId: string | null }): Promise<Skill[]> {
    return this.db
      .select()
      .from(skills)
      .where(
        and(
          eq(skills.workspaceId, input.workspaceId),
          scopeAgent(input.agentId),
          isNotNull(skills.archivedAt),
        ),
      )
      .orderBy(desc(skills.archivedAt))
      .all();
  }

  async setEnabled(input: {
    workspaceId: string;
    agentId: string | null;
    id: string;
    enabled: boolean;
  }): Promise<Skill | undefined> {
    await this.db
      .update(skills)
      .set({ enabled: input.enabled, updatedAt: Date.now() })
      .where(
        and(
          eq(skills.id, input.id),
          eq(skills.workspaceId, input.workspaceId),
          scopeAgent(input.agentId),
          isNull(skills.archivedAt),
        ),
      );
    return this.getOwnedById(input);
  }

  async archiveById(input: {
    workspaceId: string;
    agentId: string | null;
    id: string;
  }): Promise<Skill | undefined> {
    await this.db
      .update(skills)
      .set({ archivedAt: Date.now(), updatedAt: Date.now() })
      .where(
        and(
          eq(skills.id, input.id),
          eq(skills.workspaceId, input.workspaceId),
          scopeAgent(input.agentId),
          isNull(skills.archivedAt),
        ),
      );
    return this.getOwnedById(input);
  }

  async restore(input: {
    workspaceId: string;
    agentId: string | null;
    id: string;
  }): Promise<Skill | undefined> {
    const current = await this.getOwnedById(input);
    if (!current) return undefined;
    try {
      await this.db
        .update(skills)
        .set({ archivedAt: null, updatedAt: Date.now() })
        .where(eq(skills.id, current.id));
    } catch (error) {
      if (isUniqueConstraintError(error)) throw new AgentSkillDuplicateError(current.name);
      throw error;
    }
    return this.getOwnedById(input);
  }

  private async getOwnedById(input: {
    workspaceId: string;
    agentId: string | null;
    id: string;
  }): Promise<Skill | undefined> {
    return this.db
      .select()
      .from(skills)
      .where(
        and(
          eq(skills.id, input.id),
          eq(skills.workspaceId, input.workspaceId),
          scopeAgent(input.agentId),
        ),
      )
      .get();
  }

  async getActiveByName(input: {
    workspaceId: string;
    agentId: string | null;
    name: string;
  }): Promise<Skill | undefined> {
    const name = normalizeSkillName(input.name);
    return this.db
      .select()
      .from(skills)
      .where(
        and(
          eq(skills.workspaceId, input.workspaceId),
          scopeAgent(input.agentId),
          eq(skills.name, name),
          isNull(skills.archivedAt),
        ),
      )
      .get();
  }

  async edit(input: {
    workspaceId: string;
    agentId: string | null;
    name: string;
    newName?: string;
    description?: string;
    body?: string;
  }): Promise<Skill | undefined> {
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
      await this.db.update(skills).set(patch).where(eq(skills.id, current.id));
    } catch (error) {
      if (isUniqueConstraintError(error)) throw new AgentSkillDuplicateError(newName ?? name);
      throw error;
    }
    return this.db.select().from(skills).where(eq(skills.id, current.id)).get();
  }

  async archive(input: {
    workspaceId: string;
    agentId: string | null;
    name: string;
  }): Promise<boolean> {
    const current = await this.getActiveByName(input);
    if (!current) return false;
    await this.db
      .update(skills)
      .set({ archivedAt: Date.now(), updatedAt: Date.now() })
      .where(eq(skills.id, current.id));
    return true;
  }

  private async assertActiveNameAvailable(input: {
    workspaceId: string;
    agentId: string | null;
    name: string;
  }) {
    const existing = await this.getActiveByName(input);
    if (existing) throw new AgentSkillDuplicateError(input.name);
  }

  async setScript(input: {
    workspaceId: string;
    agentId: string | null;
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
    await this.db.update(skills).set({ updatedAt: now }).where(eq(skills.id, skill.id));
  }

  async setNetworkDomains(input: {
    workspaceId: string;
    agentId: string | null;
    name: string;
    domains: string[];
  }): Promise<void> {
    const skill = await this.getActiveByName(input);
    if (!skill) throw new Error(`skill not found: ${normalizeSkillName(input.name)}`);
    const deduped = [...new Set(input.domains.map((d) => d.trim()).filter(Boolean))];
    await this.db
      .update(skills)
      .set({
        networkDomains: deduped.length ? JSON.stringify(deduped) : null,
        updatedAt: Date.now(),
      })
      .where(eq(skills.id, skill.id));
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

  /**
   * The skills an agent actually runs with, resolved at turn time:
   *
   *   1. library skills (`agent_id IS NULL`, unarchived, enabled) MINUS this
   *      agent's exclusions,
   *   2. plus this agent's own skills,
   *   3. and on a name clash the agent's own WINS — the library one is not
   *      loaded at all (specific beats general; no error, no ambiguity).
   *
   * One round-trip: this runs on the thread DO's cold-wake path, where each D1
   * query costs ~220ms. The shadowing rule is a NOT EXISTS rather than a
   * post-filter in JS so `hasEnabledScriptSkill` can reuse the same predicate
   * and stay a single query too.
   *
   * A shadowing agent skill hides the library one whether or not it is itself
   * enabled: an agent that has defined its own `deploy` has taken ownership of
   * that name, and a disabled one means "off for this agent", not "fall back to
   * the library's".
   */
  async listEffective(scope: { workspaceId: string; agentId: string }): Promise<Skill[]> {
    const rows = await this.db
      .select()
      .from(skills)
      .leftJoin(exclusion, exclusionJoin(scope.agentId))
      .where(and(effectiveCondition(this.db, scope), eq(skills.enabled, true)))
      .orderBy(asc(skills.name))
      .all();
    return rows.map((row) => row.skills);
  }

  /** The one skill this agent resolves `name` to, own-before-library. */
  async getEffectiveByName(input: {
    workspaceId: string;
    agentId: string;
    name: string;
  }): Promise<Skill | undefined> {
    const name = normalizeSkillName(input.name);
    const rows = await this.db
      .select()
      .from(skills)
      .leftJoin(exclusion, exclusionJoin(input.agentId))
      .where(and(effectiveCondition(this.db, input), eq(skills.name, name)))
      .all();
    // Shadowing already drops the library row when the agent owns the name;
    // preferring the agent-owned row here keeps that true even if it did not.
    return (rows.find((row) => row.skills.agentId !== null) ?? rows[0])?.skills;
  }

  /**
   * Every workspace-library skill, annotated with why it is or is not live on
   * this agent.
   *
   * The mirror image of {@link listEffective}, which returns the post-exclusion,
   * post-shadow set the model actually loads. A settings view rendered from
   * that would be missing exactly the rows it has to offer a toggle for — an
   * excluded skill has already vanished from it, so nothing could turn it back
   * on. So this lists the library WHOLE and hangs the two reasons off each row.
   *
   * Disabled library skills are included (they carry `enabled: false`): the
   * workspace switched them off for everyone, which is a third, distinct
   * reason the agent is not running them, and the view has to say so rather
   * than silently drop the row. Archived ones are not — they are gone.
   *
   * The shadow join deliberately does NOT filter on `shadowing.enabled`,
   * matching `listEffective`: an agent that defined its own `deploy` owns that
   * name, and disabling its own copy means "off here", not "fall back to the
   * library's". Filtering on it here would paint the library row as live while
   * the model never loads it.
   */
  async listLibraryForAgent(scope: {
    workspaceId: string;
    agentId: string;
  }): Promise<LibrarySkillForAgent[]> {
    const rows = await this.db
      .select({
        skill: skills,
        excludedAgentId: exclusion.agentId,
        shadowedByOwnSkillId: shadowing.id,
      })
      .from(skills)
      .leftJoin(exclusion, exclusionJoin(scope.agentId))
      .leftJoin(
        shadowing,
        and(
          eq(shadowing.workspaceId, skills.workspaceId),
          eq(shadowing.agentId, scope.agentId),
          eq(shadowing.name, skills.name),
          isNull(shadowing.archivedAt),
        ),
      )
      .where(
        and(
          eq(skills.workspaceId, scope.workspaceId),
          isNull(skills.agentId),
          isNull(skills.archivedAt),
        ),
      )
      .orderBy(asc(skills.name))
      .all();
    return rows.map((row) => ({
      ...row.skill,
      excluded: row.excludedAgentId !== null,
      shadowedByOwnSkillId: row.shadowedByOwnSkillId,
    }));
  }

  /**
   * One live workspace-library skill by id, or undefined.
   *
   * The exclusion routes take a skill id straight from the URL, so this is
   * where "is that id even a library skill in YOUR workspace" is answered —
   * without it a guessed id writes an `agent_skill_exclusions` row across a
   * workspace boundary, and an agent-private id would take an exclusion row
   * that resolution never reads (private skills are archived, not excluded).
   */
  async getLibrarySkillById(input: {
    workspaceId: string;
    skillId: string;
  }): Promise<Skill | undefined> {
    return this.db
      .select()
      .from(skills)
      .where(
        and(
          eq(skills.id, input.skillId),
          eq(skills.workspaceId, input.workspaceId),
          isNull(skills.agentId),
          isNull(skills.archivedAt),
        ),
      )
      .get();
  }

  /** Opt this agent OUT of one workspace-library skill. */
  async excludeLibrarySkill(input: { agentId: string; skillId: string }): Promise<void> {
    await this.db
      .insert(agentSkillExclusions)
      .values({ agentId: input.agentId, skillId: input.skillId, createdAt: Date.now() })
      .onConflictDoNothing();
  }

  /** Undo an exclusion, putting the library skill back on this agent. */
  async includeLibrarySkill(input: { agentId: string; skillId: string }): Promise<void> {
    await this.db
      .delete(agentSkillExclusions)
      .where(
        and(
          eq(agentSkillExclusions.agentId, input.agentId),
          eq(agentSkillExclusions.skillId, input.skillId),
        ),
      );
  }

  async listExcludedSkillIds(agentId: string): Promise<string[]> {
    const rows = await this.db
      .select({ skillId: agentSkillExclusions.skillId })
      .from(agentSkillExclusions)
      .where(eq(agentSkillExclusions.agentId, agentId))
      .all();
    return rows.map((row) => row.skillId);
  }

  /**
   * Egress hosts the sandbox allowlist must open for this agent.
   *
   * Resolved over the EFFECTIVE set, not the agent's own rows: a library
   * skill's hosts must open for agents that actually have it, and must stay
   * shut for an agent that excluded it — otherwise the opt-out is cosmetic.
   */
  async listEnabledSkillDomains(scope: {
    workspaceId: string;
    agentId: string;
  }): Promise<string[]> {
    const rows = await this.listEffective(scope); // enabled + non-archived + exclusions applied
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
   * keeps the same filters (EFFECTIVE scope, not archived, enabled,
   * kind=script) — effective, so an excluded or shadowed library script does
   * not open the gate for an agent that cannot run it.
   */
  async hasEnabledScriptSkill(scope: { workspaceId: string; agentId: string }): Promise<boolean> {
    const rows = await this.db
      .select({ skillId: agentSkillResources.skillId })
      .from(agentSkillResources)
      .innerJoin(skills, eq(agentSkillResources.skillId, skills.id))
      .leftJoin(exclusion, exclusionJoin(scope.agentId))
      .where(
        and(
          effectiveCondition(this.db, scope),
          eq(skills.enabled, true),
          eq(agentSkillResources.kind, "script"),
        ),
      )
      .limit(1)
      .all();
    return rows.length > 0;
  }
}

/** `agent_id = ?` for an agent scope, `agent_id IS NULL` for the library. */
function scopeAgent(agentId: string | null): SQL {
  return agentId === null ? isNull(skills.agentId) : eq(skills.agentId, agentId);
}

/** This agent's exclusion row for the skill under consideration, or none. */
const exclusion = alias(agentSkillExclusions, "agent_skill_exclusion");
/** The agent's own skill that would shadow the library row by name. */
const shadowing = alias(skills, "shadowing_skill");

function exclusionJoin(agentId: string) {
  return and(eq(exclusion.skillId, skills.id), eq(exclusion.agentId, agentId)) as SQL;
}

function effectiveCondition(
  db: DrizzleD1Database<typeof schema>,
  scope: { workspaceId: string; agentId: string },
): SQL {
  return and(
    eq(skills.workspaceId, scope.workspaceId),
    isNull(skills.archivedAt),
    or(
      // The agent's own.
      eq(skills.agentId, scope.agentId),
      // A library skill it has neither excluded nor shadowed.
      and(
        isNull(skills.agentId),
        isNull(exclusion.agentId),
        notExists(
          db
            .select({ shadowed: shadowing.id })
            .from(shadowing)
            .where(
              and(
                eq(shadowing.workspaceId, skills.workspaceId),
                eq(shadowing.agentId, scope.agentId),
                eq(shadowing.name, skills.name),
                isNull(shadowing.archivedAt),
              ),
            ),
        ),
      ),
    ),
  ) as SQL;
}

function isUniqueConstraintError(error: unknown): boolean {
  let current: unknown = error;
  for (let depth = 0; current && depth < 5; depth++) {
    if (String(current).toLowerCase().includes("unique")) return true;
    current = current instanceof Error ? current.cause : undefined;
  }
  return false;
}
