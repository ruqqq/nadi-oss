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
   * Why an agent-scoped write missed, in terms the MODEL can act on.
   *
   * These tools are hard-scoped to the thread's agent (`resolveScope`), so a
   * workspace-LIBRARY skill (`agent_id IS NULL`, shared by every agent) is
   * invisible to `edit`/`archive` even though the model can READ it — the
   * catalog comes from `listEffective`, which resolves library rows. A bare
   * "not found" for a skill the model is looking at steers it straight into
   * `create_skill` with the same name, which SUCCEEDS
   * (`assertActiveNameAvailable` is agent-scoped and
   * `idx_skills_agent_name_unique` is partial on `agent_id IS NOT NULL`) and
   * forks a PRIVATE copy: this agent gets the fix and every other agent silently
   * keeps the old body. So name the scope, name the editor that can change it,
   * and name the trap.
   *
   * This does not widen what the tools can write. Scoping them to the effective
   * set is a separate product decision — filed in the P4 ledger.
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
      `error: ${stableName} is a shared workspace-library skill, not this agent's own, ` +
      `so it cannot be ${verb} from chat. It is edited in Settings -> Skills, where one ` +
      `edit reaches every agent that loads it. Do NOT create a skill with the same name: ` +
      `that forks a private copy for this agent only and leaves every other agent on the ` +
      `old version. Tell the user to change it there, or - if only this agent should ` +
      `differ - to copy it onto this agent first from the agent's Skills page.`
    );
  }

  function errorMessage(error: unknown): string {
    if (error instanceof AgentSkillNameError) return "error: invalid skill name";
    if (error instanceof AgentSkillDuplicateError) return `error: ${error.message}`;
    return `error: ${String(error)}`;
  }

  return {
    create_skill: tool({
      description:
        "Create a durable reusable skill for this Nadi agent. Use for user-approved repeated behavior, not secrets or one-off task state.",
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
          return `created skill: ${created.name}`;
        } catch (error) {
          return errorMessage(error);
        }
      },
    }),
    edit_skill: tool({
      description:
        "Edit or rename an existing durable skill for this Nadi agent. Omit fields that should stay unchanged.",
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
          const editInput = {
            workspaceId: scope.workspaceId,
            agentId: scope.agentId,
            name,
            ...(newName !== undefined ? { newName } : {}),
            ...(description !== undefined ? { description } : {}),
            ...(body !== undefined ? { body } : {}),
          };
          const edited = await repo.edit(editInput);
          if (!edited)
            return missingSkillMessage(repo, scope.workspaceId, normalizeSkillName(name), "edited");
          if (script) {
            await repo.setScript({
              workspaceId: scope.workspaceId,
              agentId: scope.agentId,
              name: edited.name,
              path: script.path,
              source: script.source,
            });
          }
          if (networkDomains) {
            await repo.setNetworkDomains({
              workspaceId: scope.workspaceId,
              agentId: scope.agentId,
              name: edited.name,
              domains: networkDomains,
            });
          }
          return `edited skill: ${edited.name}`;
        } catch (error) {
          return errorMessage(error);
        }
      },
    }),
    delete_skill: tool({
      description: "Delete a durable skill for this Nadi agent by soft-archiving it.",
      inputSchema: z.object({
        name: z.string().describe("Existing skill name."),
      }),
      execute: async ({ name }) => {
        const scope = await resolveScope();
        if (!scope) return `error: thread ${threadId} not found`;
        try {
          const stableName = normalizeSkillName(name);
          const repo = new AgentSkillRepository(scope.db);
          const archived = await repo.archive({
            workspaceId: scope.workspaceId,
            agentId: scope.agentId,
            name,
          });
          if (!archived) return missingSkillMessage(repo, scope.workspaceId, stableName, "deleted");
          return `deleted skill: ${stableName}`;
        } catch (error) {
          return errorMessage(error);
        }
      },
    }),
  };
}
