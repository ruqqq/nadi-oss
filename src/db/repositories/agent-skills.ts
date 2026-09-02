import {
  and,
  asc,
  count,
  desc,
  eq,
  inArray,
  isNotNull,
  isNull,
  notExists,
  or,
  type SQL,
} from "drizzle-orm";
import type { DrizzleD1Database } from "drizzle-orm/d1";
import type * as schema from "../schema";
import { agents, agentSkillExclusions, agentSkillResources, skills, type Skill } from "../schema";
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

  /**
   * Edit one skill by ID, in its own scope.
   *
   * `edit` above is the chat tools' entry point and keys on the NAME, which is
   * what a model holds. A settings client holds the id it was listed with, and
   * the id is the only handle that survives the rename this method performs.
   * Scope-aware like every sibling: `agentId: null` is the workspace library,
   * so this is the one write that can change a shared skill's body.
   */
  async editById(input: {
    workspaceId: string;
    agentId: string | null;
    id: string;
    name?: string;
    description?: string;
    body?: string;
  }): Promise<Skill | undefined> {
    const current = await this.getOwnedById(input);
    // An archived row is restored, not edited: the partial unique index covers
    // ACTIVE names only, so a rename here could park a collision that fires on
    // restore instead of on the write that caused it.
    if (!current || current.archivedAt !== null) return undefined;
    const name = input.name !== undefined ? normalizeSkillName(input.name) : undefined;
    if (name !== undefined && name !== current.name) {
      await this.assertActiveNameAvailable({
        workspaceId: input.workspaceId,
        agentId: input.agentId,
        name,
      });
    }
    const patch = {
      ...(name !== undefined ? { name } : {}),
      ...(input.description !== undefined ? { description: input.description } : {}),
      ...(input.body !== undefined ? { body: input.body } : {}),
      updatedAt: Date.now(),
    };
    try {
      await this.db.update(skills).set(patch).where(eq(skills.id, current.id));
    } catch (error) {
      if (isUniqueConstraintError(error)) throw new AgentSkillDuplicateError(name ?? current.name);
      throw error;
    }
    return this.getOwnedById(input);
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

  /**
   * How many agents each library skill is actually live on — the blast radius
   * of editing it, which is the whole point of one shared copy.
   *
   * Counted: unarchived agents in the skill's workspace, MINUS those that
   * excluded it, MINUS those whose own skill of that name shadows it. A
   * DISABLED agent is counted: it still carries the skill and recovers on
   * re-enable, so a number that dropped when an agent was paused would
   * understate the radius.
   *
   * The exclusion and shadow rules are exactly `listEffective`'s, deliberately:
   * a count that disagreed with what the model loads is worse than no count.
   * The one divergence is the skill's OWN `enabled` flag, which is not applied
   * here — a workspace-disabled skill still reports its carriers, because it
   * reaches all of them the moment it is switched back on, and the row already
   * carries `enabled` for the view to say it is off. Archived and agent-private
   * skills count zero: nothing resolves them from the library.
   *
   * One statement for the whole batch, grouped by `skill_id`. A per-skill query
   * in a loop would put N round-trips on a settings page load.
   */
  async countAgentsLiveOn(skillIds: string[]): Promise<Map<string, number>> {
    const counts = new Map<string, number>(skillIds.map((id) => [id, 0]));
    // `inArray` with an empty list compiles to a always-false predicate on some
    // drivers and to invalid SQL on others; either way there is nothing to ask.
    if (skillIds.length === 0) return counts;
    const rows = await this.db
      .select({ skillId: skills.id, agents: count(agents.id) })
      .from(skills)
      .innerJoin(agents, and(eq(agents.workspaceId, skills.workspaceId), isNull(agents.archivedAt)))
      .leftJoin(exclusion, and(eq(exclusion.skillId, skills.id), eq(exclusion.agentId, agents.id)))
      .where(
        and(
          inArray(skills.id, skillIds),
          isNull(skills.agentId),
          isNull(skills.archivedAt),
          isNull(exclusion.agentId),
          notExists(
            this.db
              .select({ shadowed: shadowing.id })
              .from(shadowing)
              .where(
                and(
                  eq(shadowing.workspaceId, skills.workspaceId),
                  eq(shadowing.agentId, agents.id),
                  eq(shadowing.name, skills.name),
                  isNull(shadowing.archivedAt),
                ),
              ),
          ),
        ),
      )
      .groupBy(skills.id)
      .all();
    for (const row of rows) counts.set(row.skillId, row.agents);
    return counts;
  }

  /**
   * Promote one agent's private skill into the workspace library.
   *
   * The EXISTING row is re-pointed (`agent_id = NULL`) rather than copied: the
   * id, its resources and its network domains all travel with it, which is the
   * point — sharing a skill must not mean retyping it, and a delete+insert
   * would strand every `agent_skill_resources` row on the old id.
   *
   * Refuses (throws `AgentSkillDuplicateError`) when an active library skill
   * already owns the name. Agents that have their own skill of that name are
   * NOT disturbed: the promoted skill simply arrives shadowed for them, exactly
   * as any other library skill would.
   */
  async moveToLibrary(input: {
    workspaceId: string;
    agentId: string;
    id: string;
  }): Promise<Skill | undefined> {
    const current = await this.getOwnedById(input);
    // Archived is not "in a scope you can move out of" — restore it first.
    if (!current || current.archivedAt !== null) return undefined;
    await this.assertActiveNameAvailable({
      workspaceId: input.workspaceId,
      agentId: null,
      name: current.name,
    });
    try {
      await this.db
        .update(skills)
        .set({ agentId: null, updatedAt: Date.now() })
        .where(eq(skills.id, current.id));
    } catch (error) {
      // The partial unique index is the real authority; the check above only
      // buys a nicer message when it is not a race.
      if (isUniqueConstraintError(error)) throw new AgentSkillDuplicateError(current.name);
      throw error;
    }
    return this.db.select().from(skills).where(eq(skills.id, current.id)).get();
  }

  /**
   * Copy a skill (normally a library one) onto one agent as its own.
   *
   * A COPY, never a move: the source row keeps its scope and its resources, and
   * the new skill gets a fresh id and fresh `agent_skill_resources` rows, so
   * editing the copy's script cannot reach back into the original's. Re-pointing
   * the resource rows would make "customise this for one agent" silently edit
   * every agent's copy — the exact hazard the live-on count exists to warn about.
   *
   * The copy lands as a shadow of the library row for that agent (own beats
   * library by name), which is what makes "fork it here" work.
   */
  async copyToAgent(input: {
    workspaceId: string;
    /** The scope the source lives in: `null` for the workspace library. */
    agentId: string | null;
    id: string;
    targetAgentId: string;
  }): Promise<Skill | undefined> {
    const source = await this.getOwnedById(input);
    if (!source || source.archivedAt !== null) return undefined;
    // The DESTINATION is checked here as well as at the route, matching
    // `setSkillExclusion`, the other write that takes two ids with one of them
    // off a request body. Without it a caller who is a member of two
    // workspaces can write a row carrying THIS workspace's `workspace_id` under
    // the other workspace's agent - a row no listing in either workspace can
    // see, because `listActive` filters on workspace and the library listing on
    // `agent_id IS NULL`.
    const target = await this.db
      .select({ id: agents.id })
      .from(agents)
      .where(and(eq(agents.id, input.targetAgentId), eq(agents.workspaceId, input.workspaceId)))
      .get();
    if (!target) return undefined;
    await this.assertActiveNameAvailable({
      workspaceId: input.workspaceId,
      agentId: input.targetAgentId,
      name: source.name,
    });
    const now = Date.now();
    const row = {
      ...source,
      id: crypto.randomUUID(),
      agentId: input.targetAgentId,
      createdAt: now,
      updatedAt: now,
      archivedAt: null,
    };
    try {
      await this.db.insert(skills).values(row);
    } catch (error) {
      if (isUniqueConstraintError(error)) throw new AgentSkillDuplicateError(source.name);
      throw error;
    }
    const resources = await this.db
      .select()
      .from(agentSkillResources)
      .where(eq(agentSkillResources.skillId, source.id))
      .all();
    if (resources.length > 0) {
      await this.db.insert(agentSkillResources).values(
        resources.map((resource) => ({
          ...resource,
          id: crypto.randomUUID(),
          skillId: row.id,
          createdAt: now,
          updatedAt: now,
        })),
      );
    }
    return row;
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
