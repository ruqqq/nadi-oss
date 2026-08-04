import { and, eq, isNull } from "drizzle-orm";
import type { DrizzleD1Database } from "drizzle-orm/d1";
import type * as schema from "../db/schema";
import { automata } from "../db/schema";
import { AutomatonRepository } from "../db/repositories/automata";
import { ProjectRepository } from "../db/repositories/projects";
import { WorkbenchRepository } from "../db/repositories/workbenches";
import type { Env } from "../env";
import {
  isSupportedAgentProvider,
  isUsableProviderForWorkspace,
  parseModelInputModalities,
} from "../settings/model-selection";
import {
  computeNextDueAt,
  isValidTimezone,
  parseSchedule,
  type AutomatonSchedule,
} from "./schedule";

function scheduleValidationError(
  error: unknown,
  opts?: { reEnable?: boolean },
): AutomatonValidationError {
  const msg = String((error as Error).message);
  if (msg.includes("runAt must be in the future")) {
    return new AutomatonValidationError(
      opts?.reEnable ? "Pick a new time before enabling." : "Pick a time in the future.",
    );
  }
  return new AutomatonValidationError(msg);
}

function computeInitialNextDueAt(schedule: AutomatonSchedule, timezone: string): number {
  try {
    return computeNextDueAt(schedule, timezone, Date.now());
  } catch (error) {
    throw scheduleValidationError(error);
  }
}

/** Bad input: maps to HTTP 400 in the route path. */
export class AutomatonValidationError extends Error {}
/** A project id that isn't an active project in the workspace: HTTP 404. */
export class AutomatonProjectNotFoundError extends Error {}
/** Unknown, archived, or out-of-workspace automaton: HTTP 404. */
export class AutomatonNotFoundError extends Error {}

export interface AutomatonServiceContext {
  env: Env;
  workspaceId: string;
  ownerUserId: string;
  agentId: string;
  /**
   * Whose entitlements the provider check runs against. Routes pass the signed-in
   * user; the agent tools pass the workspace owner, which is who the runtime gate
   * already checks when it builds the model.
   */
  viewerEmail: string | null;
}

export interface CreateAutomatonInput {
  name: unknown;
  prompt: unknown;
  timezone: unknown;
  schedule: unknown;
  projectId?: unknown;
  workbenchId?: unknown;
  notifyMode?: unknown;
  enabled?: unknown;
  modelProvider?: unknown;
  model?: unknown;
  modelInputModalities?: unknown;
}

export interface UpdateAutomatonPatch {
  name?: unknown;
  prompt?: unknown;
  timezone?: unknown;
  schedule?: unknown;
  projectId?: unknown;
  workbenchId?: unknown;
  notifyMode?: unknown;
  enabled?: unknown;
  modelProvider?: unknown;
  model?: unknown;
  modelInputModalities?: unknown;
}

type Db = DrizzleD1Database<typeof schema>;

/** The persisted override triple. All-null means "inherit the agent's model". */
interface ModelSelection {
  modelProvider: string | null;
  model: string | null;
  modelInputModalities: string | null;
}

function parseNotifyMode(value: unknown): "all" | "failures_only" {
  if (value === undefined) return "all";
  if (value === "all" || value === "failures_only") return value;
  throw new AutomatonValidationError("notifyMode must be 'all' or 'failures_only'");
}

// Mirrors resolveAutomatonProjectId in automaton-routes.ts: undefined = leave
// unset, null = clear, a string must be an active project in this workspace.
async function resolveProjectId(
  db: Db,
  workspaceId: string,
  value: unknown,
): Promise<{ set: boolean; value: string | null }> {
  if (value === undefined) return { set: false, value: null };
  if (value === null) return { set: true, value: null };
  if (typeof value !== "string" || !value.trim()) {
    throw new AutomatonValidationError("projectId must be a project id or null.");
  }
  const clean = value.trim();
  try {
    await new ProjectRepository(db).assertActiveProjectInWorkspace(clean, workspaceId);
  } catch {
    // 404, not 403: never confirm another workspace's project exists.
    throw new AutomatonProjectNotFoundError("Project not found.");
  }
  return { set: true, value: clean };
}

// Mirrors resolveProjectId: undefined = leave unset, null = clear (inherit the
// project's default at fire time), a string must be an active workbench here.
async function resolveWorkbenchId(
  db: Db,
  workspaceId: string,
  value: unknown,
): Promise<{ set: boolean; value: string | null }> {
  if (value === undefined) return { set: false, value: null };
  if (value === null) return { set: true, value: null };
  if (typeof value !== "string" || !value.trim()) {
    throw new AutomatonValidationError("workbenchId must be a workbench id or null.");
  }
  const clean = value.trim();
  try {
    await new WorkbenchRepository(db).assertActiveWorkbenchInWorkspace(clean, workspaceId);
  } catch {
    // 404, not 403: never confirm another workspace's workbench exists.
    throw new AutomatonProjectNotFoundError("Workbench not found.");
  }
  return { set: true, value: clean };
}

/**
 * The model override, resolved the same way as projectId: absent = leave as-is,
 * explicit null = clear back to the agent's model, a value = validate and set.
 * Provider and model move as a unit — half an override would silently pair a
 * provider with a model it can't run.
 */
async function resolveModelSelection(
  env: Env,
  workspaceId: string,
  viewerEmail: string | null,
  input: { modelProvider?: unknown; model?: unknown; modelInputModalities?: unknown },
): Promise<{ set: boolean; value: ModelSelection }> {
  const cleared: ModelSelection = {
    modelProvider: null,
    model: null,
    modelInputModalities: null,
  };

  if (input.modelProvider === undefined && input.model === undefined) {
    return { set: false, value: cleared };
  }
  if (input.modelProvider === null || input.model === null) {
    return { set: true, value: cleared };
  }

  const provider = typeof input.modelProvider === "string" ? input.modelProvider.trim() : "";
  const model = typeof input.model === "string" ? input.model.trim() : "";
  if (!provider || !model) {
    throw new AutomatonValidationError(
      "Set modelProvider and model together, or null to use the agent's model.",
    );
  }
  if (!isSupportedAgentProvider(provider)) {
    throw new AutomatonValidationError(`Unknown provider: ${provider}`);
  }
  if (!(await isUsableProviderForWorkspace(env, workspaceId, provider, viewerEmail))) {
    // Fail here rather than at 3am: an unconfigured provider would throw on every
    // scheduled run, and the user would find out from a failure notification.
    throw new AutomatonValidationError(
      `${provider} is not set up for this workspace. Add its API key in Settings first.`,
    );
  }

  const modalities =
    input.modelInputModalities === undefined
      ? ["text"]
      : parseModelInputModalities(input.modelInputModalities);
  if (!modalities) {
    throw new AutomatonValidationError("modelInputModalities must be known input modalities.");
  }

  return {
    set: true,
    value: {
      modelProvider: provider,
      model,
      modelInputModalities: JSON.stringify(modalities),
    },
  };
}

export class AutomatonService {
  private readonly repo: AutomatonRepository;

  constructor(
    private readonly db: Db,
    private readonly ctx: AutomatonServiceContext,
  ) {
    this.repo = new AutomatonRepository(db);
  }

  async list() {
    const rows = await this.db
      .select()
      .from(automata)
      .where(and(eq(automata.workspaceId, this.ctx.workspaceId), isNull(automata.archivedAt)))
      .all();
    const latest = await this.repo.listLatestRunsFor(rows.map((r) => r.id));
    const byId = new Map(latest.map((run) => [run.automatonId, run]));
    return rows.map((row) => {
      const run = byId.get(row.id);
      return {
        ...row,
        lastRun: run
          ? {
              id: run.id,
              status: run.status,
              trigger: run.trigger,
              startedAt: run.startedAt,
              finishedAt: run.finishedAt,
              threadId: run.threadId,
              error: run.error,
            }
          : null,
      };
    });
  }

  private async requireInWorkspace(id: string) {
    const automaton = await this.repo.getById(id);
    if (
      !automaton ||
      automaton.archivedAt !== null ||
      automaton.workspaceId !== this.ctx.workspaceId
    ) {
      throw new AutomatonNotFoundError("Not found");
    }
    return automaton;
  }

  async get(id: string) {
    const automaton = await this.requireInWorkspace(id);
    const runs = await this.repo.listRuns(id, 20);
    return { automaton, runs };
  }

  async create(input: CreateAutomatonInput) {
    const name = typeof input.name === "string" ? input.name.trim() : "";
    if (!name) throw new AutomatonValidationError("Give the automaton a name.");
    const prompt = typeof input.prompt === "string" ? input.prompt.trim() : "";
    if (!prompt) throw new AutomatonValidationError("Give the automaton something to do.");
    const timezone = typeof input.timezone === "string" ? input.timezone : "";
    if (!isValidTimezone(timezone)) {
      throw new AutomatonValidationError(`Unknown timezone: ${timezone}`);
    }

    const scheduleJson = JSON.stringify(input.schedule ?? {});
    let nextDueAt: number;
    try {
      nextDueAt = computeInitialNextDueAt(parseSchedule(scheduleJson), timezone);
    } catch (error) {
      if (error instanceof AutomatonValidationError) throw error;
      throw scheduleValidationError(error);
    }

    const project = await resolveProjectId(this.db, this.ctx.workspaceId, input.projectId);
    const workbench = await resolveWorkbenchId(this.db, this.ctx.workspaceId, input.workbenchId);
    const notifyMode = parseNotifyMode(input.notifyMode);
    const model = await resolveModelSelection(
      this.ctx.env,
      this.ctx.workspaceId,
      this.ctx.viewerEmail,
      input,
    );

    const now = Date.now();
    const row = {
      id: `auto_${crypto.randomUUID()}`,
      workspaceId: this.ctx.workspaceId,
      ownerUserId: this.ctx.ownerUserId,
      agentId: this.ctx.agentId,
      projectId: project.set ? project.value : null,
      workbenchId: workbench.set ? workbench.value : null,
      name,
      prompt,
      modelProvider: model.value.modelProvider,
      model: model.value.model,
      modelInputModalities: model.value.modelInputModalities,
      scheduleJson,
      timezone,
      // Matches the route: any value other than an explicit `false` enables.
      enabled: input.enabled !== false,
      disabledReason: null,
      notifyMode,
      nextDueAt,
      lastFiredAt: null,
      archivedAt: null,
      createdAt: now,
      updatedAt: now,
    };
    await this.db.insert(automata).values(row);
    return row;
  }

  async update(id: string, input: UpdateAutomatonPatch) {
    const automaton = await this.requireInWorkspace(id);
    const patch: Partial<typeof automata.$inferInsert> = {};

    if (input.name !== undefined) {
      const name = typeof input.name === "string" ? input.name.trim() : "";
      if (!name) throw new AutomatonValidationError("Give the automaton a name.");
      patch.name = name;
    }

    if (input.prompt !== undefined) {
      const prompt = typeof input.prompt === "string" ? input.prompt.trim() : "";
      if (!prompt) throw new AutomatonValidationError("Give the automaton something to do.");
      patch.prompt = prompt;
    }

    const project = await resolveProjectId(this.db, automaton.workspaceId, input.projectId);
    if (project.set) patch.projectId = project.value;

    const workbench = await resolveWorkbenchId(this.db, automaton.workspaceId, input.workbenchId);
    if (workbench.set) patch.workbenchId = workbench.value;

    const model = await resolveModelSelection(
      this.ctx.env,
      automaton.workspaceId,
      this.ctx.viewerEmail,
      input,
    );
    if (model.set) {
      patch.modelProvider = model.value.modelProvider;
      patch.model = model.value.model;
      patch.modelInputModalities = model.value.modelInputModalities;
    }

    const timezone = typeof input.timezone === "string" ? input.timezone : automaton.timezone;
    if (input.timezone !== undefined) {
      if (!isValidTimezone(timezone)) {
        throw new AutomatonValidationError(`Unknown timezone: ${timezone}`);
      }
      patch.timezone = timezone;
    }

    const scheduleJson =
      input.schedule !== undefined ? JSON.stringify(input.schedule) : automaton.scheduleJson;
    if (input.schedule !== undefined) {
      try {
        parseSchedule(scheduleJson);
      } catch (error) {
        throw new AutomatonValidationError(String((error as Error).message));
      }
      patch.scheduleJson = scheduleJson;
    }

    let enabledFlipped = false;
    if (input.enabled !== undefined) {
      if (typeof input.enabled !== "boolean") {
        throw new AutomatonValidationError("enabled must be a boolean");
      }
      enabledFlipped = automaton.enabled === false && input.enabled === true;
      patch.enabled = input.enabled;
      if (input.enabled === true) patch.disabledReason = null;
    }

    // Recompute nextDueAt (next FUTURE occurrence — never backfills) whenever the
    // schedule, timezone, or a false->true enable flip appears in the patch.
    if (input.schedule !== undefined || input.timezone !== undefined || enabledFlipped) {
      try {
        patch.nextDueAt = computeNextDueAt(parseSchedule(scheduleJson), timezone, Date.now());
        patch.disabledReason = null;
      } catch (error) {
        throw scheduleValidationError(error, { reEnable: enabledFlipped });
      }
    }

    if (input.notifyMode !== undefined) {
      patch.notifyMode = parseNotifyMode(input.notifyMode);
    }

    if (Object.keys(patch).length === 0) {
      throw new AutomatonValidationError("No valid fields to update");
    }

    patch.updatedAt = Date.now();
    await this.db.update(automata).set(patch).where(eq(automata.id, id));
    const updated = await this.repo.getById(id);
    if (!updated) throw new AutomatonNotFoundError("Not found");
    return updated;
  }
}
