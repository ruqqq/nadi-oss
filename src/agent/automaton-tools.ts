import { tool, type ToolSet } from "ai";
import { z } from "zod";
import type { Env } from "../env";
import { registryDb } from "../db/client";
import { WorkspaceRepository } from "../db/repositories/workspaces";
import { WorkbenchRepository } from "../db/repositories/workbenches";
import type { resolveThreadRuntimeConfigForAgent } from "./thread-agent-config";
import { describeSchedule, parseSchedule } from "../automata/schedule";
import {
  AutomatonService,
  AutomatonNotFoundError,
  AutomatonProjectNotFoundError,
  AutomatonValidationError,
  type AutomatonServiceContext,
} from "../automata/service";

export const automatonScheduleSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("hourly"), minute: z.number().int().min(0).max(59) }),
  z.object({
    kind: z.literal("daily"),
    hour: z.number().int().min(0).max(23),
    minute: z.number().int().min(0).max(59),
  }),
  z.object({
    kind: z.literal("weekdays"),
    hour: z.number().int().min(0).max(23),
    minute: z.number().int().min(0).max(59),
  }),
  z.object({
    kind: z.literal("weekly"),
    weekday: z.number().int().min(0).max(6).describe("0 = Sunday .. 6 = Saturday"),
    hour: z.number().int().min(0).max(23),
    minute: z.number().int().min(0).max(59),
  }),
  z.object({
    kind: z.literal("cron"),
    expr: z.string().describe("A 5-field cron expression, e.g. '0 8 * * 1-5'."),
  }),
  z.object({
    kind: z.literal("once"),
    runAt: z
      .number()
      .int()
      .describe(
        "Absolute UTC epoch milliseconds for the single fire. Must be in the future when saved or re-enabled.",
      ),
  }),
]);

const notifyModeSchema = z.enum(["all", "failures_only"]);

// Provider and model are set together or cleared together (both null), which the
// service enforces. Left unset, the automaton runs on the workspace agent's model.
const modelProviderSchema = z
  .string()
  .nullable()
  .optional()
  .describe(
    "Provider to run this automaton on (e.g. 'anthropic'), or null to use the workspace agent's model. Must be a provider already set up in Settings, and must be passed together with `model`.",
  );
const modelSchema = z
  .string()
  .nullable()
  .optional()
  .describe(
    "Model id to run this automaton on (e.g. 'claude-opus-4-8'), or null to use the workspace agent's model. Must be passed together with `modelProvider`.",
  );

function toErrorResult(error: unknown): { ok: false; error: string } {
  if (
    error instanceof AutomatonValidationError ||
    error instanceof AutomatonProjectNotFoundError ||
    error instanceof AutomatonNotFoundError
  ) {
    return { ok: false, error: error.message };
  }
  throw error;
}

function scheduleSummary(scheduleJson: string, timezone: string): string {
  try {
    return describeSchedule(parseSchedule(scheduleJson), timezone);
  } catch {
    return "Custom";
  }
}

export function createAutomatonManagementTools(input: { env: Env; threadId: string }): ToolSet {
  const { env, threadId } = input;

  async function resolveService(): Promise<
    | {
        ok: true;
        service: AutomatonService;
        db: ReturnType<typeof registryDb>;
        workspaceId: string;
      }
    | { ok: false; error: string }
  > {
    const db = registryDb(env);
    let config: Awaited<ReturnType<typeof resolveThreadRuntimeConfigForAgent>>;
    try {
      // Deferred: statically importing thread-agent-config.ts pulls in the
      // provider/model factory graph, which is not safe to load under the
      // plain-node unit test environment. A dynamic import defers that load to
      // execute()-time, which only ever runs
      // under the Workers pool (integration tests) or in production.
      const { resolveThreadRuntimeConfigForAgent } = await import("./thread-agent-config");
      config = await resolveThreadRuntimeConfigForAgent(env, threadId);
    } catch {
      return { ok: false, error: "This thread is not fully set up yet." };
    }
    if (!config) return { ok: false, error: "This thread is not registered." };
    const workspaces = new WorkspaceRepository(db);
    const ownerUserId = await workspaces.getOwnerUserId(config.workspaceId);
    if (!ownerUserId) return { ok: false, error: "This workspace has no owner." };
    const ctx: AutomatonServiceContext = {
      env,
      workspaceId: config.workspaceId,
      ownerUserId,
      agentId: config.agentId,
      // The owner's entitlements, matching whose email the runtime gate checks
      // when it actually builds the model for a gated provider.
      viewerEmail: await workspaces.getOwnerEmail(config.workspaceId),
    };
    return {
      ok: true,
      service: new AutomatonService(db, ctx),
      db,
      workspaceId: config.workspaceId,
    };
  }

  return {
    list_automata: tool({
      description:
        "List the workspace's Automata (saved agent tasks that run on a schedule or on demand). Returns each automaton's id, name, human-readable schedule, timezone, whether it is enabled, its next run time, and its most recent run's status.",
      inputSchema: z.object({}),
      execute: async () => {
        const resolved = await resolveService();
        if (!resolved.ok) return { ok: false, error: resolved.error };
        try {
          const rows = await resolved.service.list();
          return {
            ok: true,
            automata: rows.map((row) => ({
              id: row.id,
              name: row.name,
              schedule: scheduleSummary(row.scheduleJson, row.timezone),
              timezone: row.timezone,
              enabled: row.enabled,
              nextDueAt: row.nextDueAt,
              projectId: row.projectId,
              workbenchId: row.workbenchId,
              lastRun: row.lastRun,
            })),
          };
        } catch (error) {
          return toErrorResult(error);
        }
      },
    }),

    list_workbenches: tool({
      description:
        "List the workspace's workbenches. A workbench bundles the repositories and setup an automaton's run works against. Returns each workbench's id, name, and description. Pass a workbench id as `workbenchId` to create_automaton/update_automaton to override the project's default workbench.",
      inputSchema: z.object({}),
      execute: async () => {
        const resolved = await resolveService();
        if (!resolved.ok) return { ok: false, error: resolved.error };
        try {
          const rows = await new WorkbenchRepository(resolved.db).listForWorkspace(
            resolved.workspaceId,
            "active",
          );
          return {
            ok: true,
            workbenches: rows.map((w) => ({
              id: w.id,
              name: w.name,
              description: w.description,
            })),
          };
        } catch (error) {
          return toErrorResult(error);
        }
      },
    }),

    get_automaton: tool({
      description:
        "Fetch one automaton by id, including its recent run history (status, trigger, timings, and the thread each run created).",
      inputSchema: z.object({ id: z.string().describe("The automaton id (auto_...).") }),
      execute: async ({ id }) => {
        const resolved = await resolveService();
        if (!resolved.ok) return { ok: false, error: resolved.error };
        try {
          const { automaton, runs } = await resolved.service.get(id);
          return {
            ok: true,
            automaton: {
              id: automaton.id,
              name: automaton.name,
              prompt: automaton.prompt,
              schedule: scheduleSummary(automaton.scheduleJson, automaton.timezone),
              scheduleJson: automaton.scheduleJson,
              timezone: automaton.timezone,
              enabled: automaton.enabled,
              nextDueAt: automaton.nextDueAt,
              lastFiredAt: automaton.lastFiredAt,
              projectId: automaton.projectId,
              workbenchId: automaton.workbenchId,
              notifyMode: automaton.notifyMode,
            },
            runs: runs.map((r) => ({
              id: r.id,
              status: r.status,
              trigger: r.trigger,
              startedAt: r.startedAt,
              finishedAt: r.finishedAt,
              threadId: r.threadId,
              error: r.error,
            })),
          };
        } catch (error) {
          return toErrorResult(error);
        }
      },
    }),

    create_automaton: {
      ...tool({
        description:
          "Create a new automaton: a saved agent task that runs the given prompt on a schedule. Prefer preset kinds (hourly/daily/weekdays/weekly) for recurring tasks; use kind 'once' with a future UTC `runAt` (epoch ms) for a single fire that auto-disables afterward; use kind 'cron' only when presets cannot express the cadence. timezone is an IANA name like 'Asia/Singapore'. This is a mutation and requires user approval.",
        inputSchema: z.object({
          name: z.string().describe("Short human name for the automaton."),
          prompt: z.string().describe("The instruction to run each time it fires."),
          timezone: z.string().describe("IANA timezone, e.g. 'Asia/Singapore'."),
          schedule: automatonScheduleSchema,
          projectId: z
            .string()
            .nullable()
            .optional()
            .describe("Optional project id to scope runs to, or null for none."),
          workbenchId: z
            .string()
            .nullable()
            .optional()
            .describe(
              "Optional workbench id (from list_workbenches) to override the project's default workbench for this automaton's runs, or null to inherit the project default.",
            ),
          notifyMode: notifyModeSchema.optional().describe("Defaults to 'all'."),
          enabled: z.boolean().optional().describe("Defaults to true."),
          modelProvider: modelProviderSchema,
          model: modelSchema,
        }),
        execute: async (args) => {
          const resolved = await resolveService();
          if (!resolved.ok) return { ok: false, error: resolved.error };
          try {
            const automaton = await resolved.service.create(args);
            return {
              ok: true,
              automaton: {
                id: automaton.id,
                name: automaton.name,
                schedule: scheduleSummary(automaton.scheduleJson, automaton.timezone),
                nextDueAt: automaton.nextDueAt,
                enabled: automaton.enabled,
              },
            };
          } catch (error) {
            return toErrorResult(error);
          }
        },
      }),
      needsApproval: true,
    },

    update_automaton: {
      ...tool({
        description:
          "Update an existing automaton. Only the fields you pass are changed. Set enabled:false to disable it (it stops firing) or enabled:true to re-enable it (its next run is scheduled from now, never backfilled). For kind 'once', re-enabling requires a future `runAt` — patch the schedule first or together with enabled:true. After a scheduled Once fire the automaton is left disabled. Changing the schedule or timezone reschedules the next run. This is a mutation and requires user approval.",
        inputSchema: z.object({
          id: z.string().describe("The automaton id (auto_...)."),
          name: z.string().optional(),
          prompt: z.string().optional(),
          timezone: z.string().optional(),
          schedule: automatonScheduleSchema.optional(),
          projectId: z.string().nullable().optional(),
          workbenchId: z
            .string()
            .nullable()
            .optional()
            .describe(
              "Workbench id from list_workbenches to override, or null to inherit the project default.",
            ),
          notifyMode: notifyModeSchema.optional(),
          enabled: z.boolean().optional().describe("false disables, true enables."),
          modelProvider: modelProviderSchema,
          model: modelSchema,
        }),
        execute: async ({ id, ...patch }) => {
          const resolved = await resolveService();
          if (!resolved.ok) return { ok: false, error: resolved.error };
          try {
            const automaton = await resolved.service.update(id, patch);
            return {
              ok: true,
              automaton: {
                id: automaton.id,
                name: automaton.name,
                schedule: scheduleSummary(automaton.scheduleJson, automaton.timezone),
                nextDueAt: automaton.nextDueAt,
                enabled: automaton.enabled,
              },
            };
          } catch (error) {
            return toErrorResult(error);
          }
        },
      }),
      needsApproval: true,
    },
  };
}
