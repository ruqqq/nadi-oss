import { eq } from "drizzle-orm";
import { getAgentByName } from "agents";
import { createThreadWithWorkbench } from "../agent/create-thread";
import { registryDb } from "../db/client";
import { AutomatonRepository } from "../db/repositories/automata";
import { ProjectRepository } from "../db/repositories/projects";
import { WorkbenchRepository } from "../db/repositories/workbenches";
import { agents } from "../db/schema";
import type { Automaton } from "../db/schema";
import type { Env } from "../env";
import { log } from "../log";
import { computeNextDueAt, parseSchedule } from "./schedule";

import {
  AUTOMATON_FIRE_BATCH,
  AUTOMATON_GRACE_MS,
  AUTOMATON_QUEUED_TIMEOUT_MS,
  AUTOMATON_RUNNING_TIMEOUT_MS,
  AutomatonRunFailedAfterClaim,
  decideDueAction,
  isUniqueConstraintError,
} from "./fire-policy";

// The pure decision layer lives in `./fire-policy` so it can be unit tested
// under the node vitest project — this module imports `agents`, which pulls in
// `cloudflare:workers` and cannot be loaded there. Re-exported so existing
// importers (routes, index.ts, tests) see one entry point.
export {
  AUTO_ARCHIVE_CRON,
  AUTOMATA_CRON,
  AUTOMATON_FIRE_BATCH,
  AUTOMATON_GRACE_MS,
  AUTOMATON_QUEUED_TIMEOUT_MS,
  AUTOMATON_RUNNING_TIMEOUT_MS,
  AutomatonRunFailedAfterClaim,
  decideDueAction,
  isUniqueConstraintError,
} from "./fire-policy";

const INVALID_SCHEDULE_DISABLED_REASON = "Schedule is invalid.";

interface AutomatonRunStub {
  beginAutomatonRun(prompt: string): Promise<void>;
}

function formatDueDate(dueAt: number, timezone: string): string {
  return new Intl.DateTimeFormat("en-GB", {
    timeZone: timezone,
    weekday: "short",
    day: "numeric",
    month: "short",
  }).format(new Date(dueAt));
}

/**
 * Claim a run, create its thread, and kick the proactive turn. Returns as soon
 * as the submission is durable — never awaits inference.
 *
 * The claim insert is isolated in its own try/catch: for scheduled runs the
 * partial unique index on (automaton_id, due_at) makes it the dedupe lease,
 * so a unique-constraint conflict here means a concurrent tick already owns
 * this due. That error is rethrown as-is (no row was created, nothing to mark
 * failed) — callers should check {@link isUniqueConstraintError}.
 *
 * Everything after the claim runs in a second try/catch. A failure there
 * means the claim (and its run row) already exist, so it is persisted onto
 * the row via `failRun` and rethrown wrapped in
 * {@link AutomatonRunFailedAfterClaim} so the caller knows the claim was
 * consumed and the schedule must still advance.
 */
export async function startAutomatonRun(
  env: Env,
  db: ReturnType<typeof registryDb>,
  automaton: Automaton,
  opts: { trigger: "scheduled" | "manual"; dueAt: number | null },
): Promise<{ runId: string; threadId: string }> {
  const repo = new AutomatonRepository(db);
  const now = Date.now();
  const runId = `arun_${crypto.randomUUID()}`;
  const threadId = `thr_${crypto.randomUUID()}`;

  // The claim. For scheduled runs the partial unique index on
  // (automaton_id, due_at) makes this the dedupe lease.
  await repo.createRun({
    id: runId,
    automatonId: automaton.id,
    workspaceId: automaton.workspaceId,
    dueAt: opts.dueAt,
    trigger: opts.trigger,
    threadId,
    status: "queued",
    createdAt: now,
    updatedAt: now,
  });

  try {
    // Resolve the agent live — nothing is snapshotted at save time.
    const agent = await db.select().from(agents).where(eq(agents.id, automaton.agentId)).get();
    if (!agent) throw new Error(`automaton_agent_missing:${automaton.agentId}`);

    // The automaton's model override wins; with none set the run inherits the
    // agent's current model, so editing the agent carries every automaton that
    // hasn't chosen its own. Overriding half the triple isn't representable —
    // the service stores provider and model together or not at all.
    const overridden = automaton.modelProvider !== null && automaton.model !== null;
    const modelProvider = overridden ? automaton.modelProvider! : agent.provider;
    const model = overridden ? automaton.model! : agent.model;
    const modelInputModalities = overridden
      ? (automaton.modelInputModalities ?? '["text"]')
      : agent.modelInputModalities;

    const label =
      opts.dueAt === null ? "Manual run" : formatDueDate(opts.dueAt, automaton.timezone);
    // The automaton's own workbench overrides the project's default; with none
    // set (null), the run inherits the project's default workbench. A dangling
    // project id still fails loudly (assertProjectInWorkspace), matching before.
    const resolvedWorkbenchId =
      automaton.workbenchId ??
      (automaton.projectId
        ? (
            await new ProjectRepository(db).assertProjectInWorkspace(
              automaton.projectId,
              automaton.workspaceId,
            )
          ).defaultWorkbenchId
        : null);
    // Matches the manual create-thread path (resolveThreadWorkbenchId in
    // thread-routes.ts): a workbench that no longer exists or was archived
    // after being set degrades to no workbench rather than failing the run.
    // Unlike the manual path, this also covers an explicit
    // automaton.workbenchId that has since gone stale — an unattended
    // scheduled run has no caller present to see a 404, so the same
    // "don't fail the run over an archived workbench" reasoning applies
    // regardless of where the id came from. (An explicit id is validated at
    // set time in automata/service.ts, so this only matters if it's archived
    // later.)
    const workbenchId =
      resolvedWorkbenchId === null
        ? null
        : await new WorkbenchRepository(db)
            .assertActiveWorkbenchInWorkspace(resolvedWorkbenchId, automaton.workspaceId)
            .then(
              (row) => row.id,
              () => {
                log.warn("automata.workbench_dropped", {
                  automatonId: automaton.id,
                  workspaceId: automaton.workspaceId,
                  workbenchId: resolvedWorkbenchId,
                  source: automaton.workbenchId !== null ? "automaton_override" : "project_default",
                });
                return null;
              },
            );
    await createThreadWithWorkbench(
      db,
      {
        id: threadId,
        workspaceId: automaton.workspaceId,
        agentId: automaton.agentId,
        projectId: automaton.projectId,
        modelProvider,
        model,
        modelInputModalities,
        showReasoning: agent.showReasoning,
        title: `${automaton.name} — ${label}`,
        // Skip the auto-namer: the automaton already named this thread.
        titleSet: true,
        // Automata require Think; the legacy runtime cannot drive a proactive turn.
        runtime: "think",
        source: "automaton",
        automatonId: automaton.id,
        automatonRunId: runId,
        lastEventId: null,
        lastMessagePreview: "",
        createdAt: now,
        updatedAt: now,
      },
      workbenchId,
    );

    // MUST go through getAgentByName, not a raw `namespace.get(idFromName(...))`
    // stub. The raw form is a native DO RPC call, which per partyserver's own
    // doc comment bypasses the fetch/alarm/webSocket entry points where
    // `onStart()` normally runs. For every other thread that's masked because
    // some earlier client request already ran onStart(); an automaton thread
    // is brand new and has never had a client, so onStart() would never run
    // at all and `this.session` would stay uninitialized, crashing the
    // fire-and-forget submission drain. getAgentByName calls `stub.setName()`
    // and awaits it, which synchronizes onStart() before returning the stub.
    // Do not "simplify" this back to a raw stub.
    const stub = (await getAgentByName(
      env.THINK_THREAD_AGENT,
      threadId,
    )) as unknown as AutomatonRunStub;
    await stub.beginAutomatonRun(automaton.prompt);
  } catch (error) {
    await repo.failRun(runId, String(error), Date.now());
    throw new AutomatonRunFailedAfterClaim(error);
  }

  return { runId, threadId };
}

export async function fireDueAutomata(
  env: Env,
  now: number = Date.now(),
): Promise<{ fired: number; skipped: number }> {
  const db = registryDb(env);
  const repo = new AutomatonRepository(db);

  // Reap first: a DO that died mid-turn leaves a `running` row that would block
  // this automaton's overlap check forever.
  try {
    await repo.reapStaleRuns({
      runningBefore: now - AUTOMATON_RUNNING_TIMEOUT_MS,
      queuedBefore: now - AUTOMATON_QUEUED_TIMEOUT_MS,
      now,
    });
  } catch (error) {
    log.warn("automata.reap_failed", { error: String(error) });
  }

  let due: Automaton[];
  try {
    due = await repo.listDue(now, AUTOMATON_FIRE_BATCH);
  } catch (error) {
    log.warn("automata.list_due_failed", { error: String(error) });
    log.info("automata.fire_due.done", { fired: 0, skipped: 0, scanned: 0 });
    return { fired: 0, skipped: 0 };
  }
  let fired = 0;
  let skipped = 0;

  for (const automaton of due) {
    const dueAt = automaton.nextDueAt;
    if (dueAt === null) continue;

    // Set once the schedule is computed, so the outer catch can still advance
    // it on a post-claim failure (the claim was consumed either way).
    let nextDueAt: number | undefined;

    try {
      let schedule: ReturnType<typeof parseSchedule>;
      try {
        schedule = parseSchedule(automaton.scheduleJson);
      } catch (error) {
        await repo.disableWithReason(automaton.id, INVALID_SCHEDULE_DISABLED_REASON, now);
        skipped += 1;
        log.warn("automata.disabled_invalid_schedule", {
          automatonId: automaton.id,
          error: String(error),
        });
        continue;
      }
      nextDueAt = computeNextDueAt(schedule, automaton.timezone, dueAt);
      const unfinished = await repo.findUnfinishedRun(automaton.id);
      const action = decideDueAction({ dueAt, now, hasUnfinishedRun: Boolean(unfinished) });

      if (action !== "fire") {
        // Record the skip rather than swallow it — run history stays honest.
        try {
          await repo.createRun({
            id: `arun_${crypto.randomUUID()}`,
            automatonId: automaton.id,
            workspaceId: automaton.workspaceId,
            dueAt,
            trigger: "scheduled",
            threadId: null,
            status: "skipped",
            error:
              action === "skip_overlap" ? "previous run still unfinished" : "missed due window",
            createdAt: now,
            updatedAt: now,
          });
        } catch (error) {
          // A row for this (automatonId, dueAt) already exists — a concurrent
          // tick recorded its own skip, or raced a claim. Either way this
          // automaton is accounted for; only a genuinely new failure should
          // abort the advance below.
          if (!isUniqueConstraintError(error)) throw error;
        }
        await repo.advanceSchedule(automaton.id, nextDueAt, null);
        skipped += 1;
        continue;
      }

      await startAutomatonRun(env, db, automaton, { trigger: "scheduled", dueAt });
      await repo.advanceSchedule(automaton.id, nextDueAt, now);
      fired += 1;
    } catch (error) {
      if (error instanceof AutomatonRunFailedAfterClaim) {
        // The claim landed and startAutomatonRun already persisted the real
        // cause onto the run row. The claim is consumed regardless, so the
        // schedule must still advance or this automaton wedges forever.
        if (nextDueAt !== undefined) {
          await repo.advanceSchedule(automaton.id, nextDueAt, null);
        }
        skipped += 1;
        log.warn("automata.fire_failed", {
          automatonId: automaton.id,
          error: String(error.cause ?? error),
        });
        continue;
      }

      if (isUniqueConstraintError(error)) {
        // Another tick already claimed this due (or recorded its skip). It
        // owns advancing the schedule — nothing else to do here.
        skipped += 1;
        continue;
      }

      // Failed before or during the claim for a reason unrelated to the
      // unique lease (e.g. a schedule parse error). No run row exists, so
      // don't advance — this due is retried on the next tick.
      skipped += 1;
      log.warn("automata.fire_failed", { automatonId: automaton.id, error: String(error) });
    }
  }

  log.info("automata.fire_due.done", { fired, skipped, scanned: due.length });
  return { fired, skipped };
}
