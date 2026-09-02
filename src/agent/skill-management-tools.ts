import { tool, type ToolSet } from "ai";
import { z } from "zod";
import { isValidSkillScriptPath } from "./skills/script-path";
import { registryDb } from "../db/client";
import {
  AgentSkillDuplicateError,
  AgentSkillNameError,
  AgentSkillRepository,
  normalizeSkillName,
} from "../db/repositories/agent-skills";
import type { Skill } from "../db/schema";
import { ThreadRepository } from "../db/repositories/threads";
import type { Env } from "../env";

export function createSkillManagementTools(input: { env: Env; threadId: string }): ToolSet {
  const { env, threadId } = input;

  async function resolveScope() {
    const db = registryDb(env);
    const thread = await new ThreadRepository(db).getById(threadId);
    if (!thread) return undefined;
    return {
      db,
      workspaceId: thread.workspaceId,
      agentId: thread.agentId,
    };
  }

  /**
   * The skill this thread's agent resolves `name` to — its OWN first, then the
   * workspace library, exactly as {@link AgentSkillRepository.listEffective}
   * resolves it at turn time.
   *
   * These tools used to be hard-scoped to the thread's agent, which meant a
   * model could READ a library skill (the catalog comes from `listEffective`)
   * and not edit it. Its natural recovery — `create_skill` with the same name —
   * SUCCEEDED and forked a private shadow, so this agent got the fix and every
   * other agent silently kept the old body. Resolving writes the same way reads
   * resolve is what closes that: the model edits the skill it is actually
   * loading, whichever scope holds it.
   *
   * The cost is real and deliberate: one edit of a library skill reaches every
   * agent that loads it, with no confirmation surface in chat. `reachNote`
   * below is what puts that blast radius in the transcript instead.
   */
  async function resolveTarget(
    repo: AgentSkillRepository,
    workspaceId: string,
    agentId: string,
    name: string,
  ): Promise<Skill | undefined> {
    return repo.getEffectiveByName({ workspaceId, agentId, name });
  }

  /**
   * Why a write missed, in terms the MODEL can act on.
   *
   * Two cases survive the widened scope. A library skill this agent has
   * EXCLUDED is not in its effective set, so it does not resolve — and a bare
   * "not found" for a skill the user can see in Settings is a dead end. A name
   * in neither scope is a genuine typo and gets the plain answer, so the
   * explanation cannot swallow one. A library skill in ANOTHER workspace also
   * gets the plain answer: naming it would leak that it exists.
   */
  async function missingSkillMessage(
    repo: AgentSkillRepository,
    workspaceId: string,
    stableName: string,
    verb: "edited" | "deleted",
  ): Promise<string> {
    const library = await repo.getActiveByName({ workspaceId, agentId: null, name: stableName });
    if (!library) return `error: skill ${stableName} not found`;
    return (
      `error: ${stableName} is a shared workspace-library skill that THIS agent has been ` +
      `excluded from, so it is not in scope here and cannot be ${verb}. Tell the user to ` +
      `re-include it on the agent's Skills page, or to change it in Settings -> Skills. Do ` +
      `NOT create a skill with the same name: that forks a private copy for this agent only ` +
      `and leaves every other agent on the old version.`
    );
  }

  /**
   * How far a library write just reached, for the transcript.
   *
   * The spec asks that a library skill state "how many agents it is live on"
   * BEFORE you edit it, and Settings -> Skills renders that count on the row.
   * Chat has no such surface, so the count goes in the tool result: the user
   * reads the transcript, and this is the only place the blast radius of a
   * model-initiated library edit can appear.
   *
   * Phrased as the skill SET rather than as "live on", because that is what
   * `countAgentsLiveOn` answers — agents that are unarchived, not excluded and
   * not shadowing the name. Whether each of them is currently enabled, and
   * whether the skill itself is, are separate facts this count does not carry.
   */
  async function reachNote(repo: AgentSkillRepository, skill: Skill): Promise<string> {
    if (skill.agentId !== null) return "";
    const counts = await repo.countAgentsLiveOn([skill.id]);
    const agents = counts.get(skill.id) ?? 0;
    if (agents === 0) return " (shared workspace-library skill; no agent has it in scope)";
    const plural = agents === 1 ? "1 agent" : `${agents} agents`;
    return ` (shared workspace-library skill, in the skill set of ${plural} — this one change applies to all of them)`;
  }

  function errorMessage(error: unknown): string {
    if (error instanceof AgentSkillNameError) return "error: invalid skill name";
    if (error instanceof AgentSkillDuplicateError) return `error: ${error.message}`;
    return `error: ${String(error)}`;
  }

  return {
    create_skill: tool({
      description:
        "Create a durable reusable skill, private to this Nadi agent. Use for user-approved repeated behavior, not secrets or one-off task state. To change a skill that already exists — including a shared workspace-library one — use edit_skill; creating one with an existing name shadows it for this agent only.",
      inputSchema: z.object({
        name: z.string().describe("Lower-case skill slug; spaces are normalized to hyphens."),
        description: z.string().min(1).describe("Short catalog description for future selection."),
        body: z.string().min(1).describe("Reusable skill instructions."),
        script: z
          .object({
            path: z
              .string()
              .min(1)
              .refine(isValidSkillScriptPath, {
                message: 'Skill script path must start with "scripts/", e.g. "scripts/run.py".',
              })
              .describe('Path under scripts/, e.g. "scripts/run.py".'),
            source: z.string().min(1),
          })
          .optional()
          .describe(
            "Optional runnable script (bash .sh / python .py / node .js) attached to this skill. " +
              'OMIT this field entirely when the skill has no script — do NOT pass a placeholder like {path:"none"}. ' +
              "A script is what opens the run_skill_script gate for this skill.",
          ),
        networkDomains: z
          .array(z.string().min(1))
          .optional()
          .describe(
            "Egress domains this skill's script needs; unioned into the sandbox allowlist.",
          ),
      }),
      execute: async ({ name, description, body, script, networkDomains }) => {
        const scope = await resolveScope();
        if (!scope) return `error: thread ${threadId} not found`;
        try {
          const repo = new AgentSkillRepository(scope.db);
          const created = await repo.create({
            workspaceId: scope.workspaceId,
            agentId: scope.agentId,
            name,
            description,
            body,
          });
          if (script) {
            await repo.setScript({
              workspaceId: scope.workspaceId,
              agentId: scope.agentId,
              name: created.name,
              path: script.path,
              source: script.source,
            });
          }
          if (networkDomains) {
            await repo.setNetworkDomains({
              workspaceId: scope.workspaceId,
              agentId: scope.agentId,
              name: created.name,
              domains: networkDomains,
            });
          }
          // A private skill that shares a library name shadows it for this
          // agent — the spec's rule, and not an error. But the shadow is
          // invisible from chat, and it is exactly what a model reaches for
          // when it means to fix the shared one, so the result says it happened.
          const shadowed = await repo.getActiveByName({
            workspaceId: scope.workspaceId,
            agentId: null,
            name: created.name,
          });
          if (shadowed)
            return (
              `created skill: ${created.name} - NOTE: this is private to this agent and now ` +
              `SHADOWS the shared workspace-library skill of the same name, for this agent ` +
              `only. Every other agent still loads the library version. If you meant to change ` +
              `the shared one, delete this and edit ${created.name} directly instead.`
            );
          return `created skill: ${created.name}`;
        } catch (error) {
          return errorMessage(error);
        }
      },
    }),
    edit_skill: tool({
      description:
        "Edit or rename a durable skill this agent has. Resolves the same way the agent loads skills: its own first, then the shared workspace library — so editing a library skill changes it for EVERY agent that loads it. Omit fields that should stay unchanged.",
      inputSchema: z.object({
        name: z.string().describe("Existing skill name."),
        newName: z.string().optional().describe("Optional replacement lower-case skill slug."),
        description: z.string().min(1).optional().describe("Optional replacement description."),
        body: z.string().min(1).optional().describe("Optional replacement skill instructions."),
        script: z
          .object({
            path: z
              .string()
              .min(1)
              .refine(isValidSkillScriptPath, {
                message: 'Skill script path must start with "scripts/", e.g. "scripts/run.py".',
              })
              .describe('Path under scripts/, e.g. "scripts/run.py".'),
            source: z.string().min(1),
          })
          .optional()
          .describe(
            "Optional runnable script (bash .sh / python .py / node .js) attached to this skill. " +
              'OMIT this field entirely when the skill has no script — do NOT pass a placeholder like {path:"none"}. ' +
              "A script is what opens the run_skill_script gate for this skill.",
          ),
        networkDomains: z
          .array(z.string().min(1))
          .optional()
          .describe(
            "Egress domains this skill's script needs; unioned into the sandbox allowlist.",
          ),
      }),
      execute: async ({ name, newName, description, body, script, networkDomains }) => {
        const scope = await resolveScope();
        if (!scope) return `error: thread ${threadId} not found`;
        try {
          const repo = new AgentSkillRepository(scope.db);
          const target = await resolveTarget(repo, scope.workspaceId, scope.agentId, name);
          if (!target)
            return missingSkillMessage(repo, scope.workspaceId, normalizeSkillName(name), "edited");
          // Every write below goes to the scope the skill was RESOLVED in, not
          // to the thread's agent: a library skill's script and domains hang
          // off the library row, and writing them agent-scoped would either
          // miss or silently fork.
          const targetScope = { workspaceId: scope.workspaceId, agentId: target.agentId };
          const edited = await repo.editById({
            ...targetScope,
            id: target.id,
            ...(newName !== undefined ? { name: newName } : {}),
            ...(description !== undefined ? { description } : {}),
            ...(body !== undefined ? { body } : {}),
          });
          if (!edited)
            return missingSkillMessage(repo, scope.workspaceId, normalizeSkillName(name), "edited");
          if (script) {
            await repo.setScript({
              ...targetScope,
              name: edited.name,
              path: script.path,
              source: script.source,
            });
          }
          if (networkDomains) {
            await repo.setNetworkDomains({
              ...targetScope,
              name: edited.name,
              domains: networkDomains,
            });
          }
          return `edited skill: ${edited.name}${await reachNote(repo, edited)}`;
        } catch (error) {
          return errorMessage(error);
        }
      },
    }),
    delete_skill: tool({
      description:
        "Delete a durable skill by soft-archiving it. Resolves like edit_skill: its own first, then the shared workspace library — deleting a library skill removes it from EVERY agent that loads it.",
      inputSchema: z.object({
        name: z.string().describe("Existing skill name."),
      }),
      execute: async ({ name }) => {
        const scope = await resolveScope();
        if (!scope) return `error: thread ${threadId} not found`;
        try {
          const stableName = normalizeSkillName(name);
          const repo = new AgentSkillRepository(scope.db);
          const target = await resolveTarget(repo, scope.workspaceId, scope.agentId, name);
          if (!target) return missingSkillMessage(repo, scope.workspaceId, stableName, "deleted");
          // Reach is read BEFORE the archive: `countAgentsLiveOn` skips
          // archived rows, so asking afterwards always answers zero and the
          // transcript would under-report what was just removed.
          const note = await reachNote(repo, target);
          const archived = await repo.archiveById({
            workspaceId: scope.workspaceId,
            agentId: target.agentId,
            id: target.id,
          });
          if (!archived) return missingSkillMessage(repo, scope.workspaceId, stableName, "deleted");
          return `deleted skill: ${stableName}${note}`;
        } catch (error) {
          return errorMessage(error);
        }
      },
    }),
  };
}
