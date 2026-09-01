/**
 * P3 TASK 1b — a compute back-call goes to the thread that OWNS the work.
 *
 * Task 1 keyed the box by agent and made the alarm's SWEEP roster-driven. The
 * TICK was left bound to a single thread: `SandboxAlarmParams.threadId`, i.e.
 * whichever thread most recently opened a session. With one box per thread that
 * was correct by construction. With one box per agent it is a MIS-DELIVERY —
 * thread A's watcher completion is announced in thread B's conversation, and
 * A's ledger row is stamped on B's ledger where nothing will ever read it.
 *
 * Nothing throws when this is wrong, which is why it is asserted here against
 * real Durable Objects, a real watcher poll and the real work ledger: the
 * evidence is WHERE the reminder and the terminal landed, not whether the tick
 * completed.
 */
import { env, runInDurableObject } from "cloudflare:test";
import { beforeAll, describe, expect, it } from "vitest";
import { drizzle } from "drizzle-orm/d1";
import * as schema from "../../src/db/schema";
import { applyRegistryTestSchema } from "./helpers/registry";
import { WORK_DELIVERY_RETRY_MS } from "../../src/agent/work-ledger";

const runInThinkDo = runInDurableObject as any;
const runInSandboxDo = runInDurableObject as any;

const now = 1_800_000_000_000;
const WORKSPACE_ID = "ws_sbx_route";

/**
 * Seeded fresh inside every `it()` — `REGISTRY_DB` gets its own storage
 * snapshot per test, so a `beforeAll` write does not reach one. Per-test agent
 * ids because the agent id is what picks the box, and `integration-fast` shares
 * one isolate across files.
 */
async function seedAgent(agentId: string) {
  const db = drizzle(env.REGISTRY_DB, { schema });
  await db
    .insert(schema.workspaces)
    .values({ id: WORKSPACE_ID, name: "Routing WS", flagsJson: "{}", createdAt: now })
    .onConflictDoNothing();
  await db.insert(schema.agents).values({
    id: agentId,
    workspaceId: WORKSPACE_ID,
    name: "Nadi",
    systemPrompt: "",
    provider: "anthropic",
    model: "claude-opus-5",
    modelInputModalities: '["text"]',
    reasoningEffort: "medium",
    createdAt: now,
  });
  await db
    .insert(schema.workspaceSandboxSettings)
    .values({
      workspaceId: WORKSPACE_ID,
      enabled: true,
      provider: "mock",
      providerConfigJson: JSON.stringify({ kind: "mock" }),
      image: "",
      createdAt: now,
      updatedAt: now,
    })
    .onConflictDoNothing();
}

async function seedThread(threadId: string, agentId: string) {
  await drizzle(env.REGISTRY_DB, { schema }).insert(schema.threadIndex).values({
    id: threadId,
    workspaceId: WORKSPACE_ID,
    agentId,
    kind: "regular",
    title: "T",
    source: "manual",
    createdAt: now,
    updatedAt: now,
  });
}

function sandboxStub(agentId: string) {
  return env.AGENT_SANDBOX.get(env.AGENT_SANDBOX.idFromName(agentId));
}

function threadStub(threadId: string) {
  return env.THINK_THREAD_AGENT.get(env.THINK_THREAD_AGENT.idFromName(threadId));
}

async function openSession(agentId: string, threadId: string) {
  const opened = await sandboxStub(agentId).session({
    threadId,
    supportsProcessMonitor: true,
    runtimeConfig: { workspaceId: WORKSPACE_ID, agentId },
  });
  if (!opened.ok) throw new Error(`session failed: ${opened.error.code}`);
  if (!opened.value) throw new Error("expected compute to be enabled");
  return opened.value;
}

/** Mirrors the DO's own `SWEEP_ROSTER_PREFIX` — what the alarm's fan-out reads. */
const SWEEP_ROSTER_PREFIX = "sb:sw:";

async function rosterThreads(agentId: string): Promise<string[]> {
  return await runInSandboxDo(sandboxStub(agentId), async (instance: any) => {
    const rows = await instance.ctx.storage.list({ prefix: SWEEP_ROSTER_PREFIX });
    return [...rows.keys()].map((key: string) => key.slice(SWEEP_ROSTER_PREFIX.length));
  });
}

async function fireAlarm(agentId: string) {
  await runInSandboxDo(sandboxStub(agentId), async (instance: any) => {
    await instance.alarm();
  });
}

/**
 * The proactive watcher reminder does NOT land in the transcript — it goes
 * through the injection buffer so it steers into the running turn. So that is
 * where delivery is observed.
 */
/**
 * The thread's transcript, as JSON text for substring matching.
 *
 * NOT the injection buffer: a proactive watcher reminder is enqueued there and
 * then immediately drained into a turn by `_kickInjectionTurn`, so the buffer
 * is empty again by the time a test can look. The message it drained is in the
 * transcript, which is where the model would actually read it.
 */
async function transcriptText(threadId: string): Promise<string> {
  const messages = await runInThinkDo(threadStub(threadId), async (instance: any) => {
    await instance.__unsafe_ensureInitialized();
    return await instance.exportRawHistory();
  });
  return JSON.stringify(messages);
}

async function ledgerRow(threadId: string, rowId: string) {
  const rows = await runInThinkDo(threadStub(threadId), async (instance: any) => {
    await instance.__unsafe_ensureInitialized();
    return (await instance.debugWorkLedger()).rows;
  });
  return rows.find((row: any) => row.id === rowId);
}

/**
 * Age the watcher past its absolute cap and make it due, in the box's own
 * store. This is the clock moving, not a fixture: `classifyWatcher` reads
 * exactly these three columns and the process itself stays genuinely running,
 * so the poll takes the `timeout` arm — the one that both DELIVERS and closes
 * the ledger row.
 */
async function ageWatcher(agentId: string) {
  await runInSandboxDo(sandboxStub(agentId), async (instance: any) => {
    instance.ctx.storage.sql.exec(
      "UPDATE sandbox_process_watchers SET next_poll_at = 0, deadline_at = 0, created_at = 0",
    );
  });
}

describe("compute back-calls route to the thread that owns the work", () => {
  beforeAll(async () => {
    await applyRegistryTestSchema(env.REGISTRY_DB);
  });

  it("delivers a watcher completion to the thread that started it, not the alarm-params thread", async () => {
    const agentId = "agent_sbx_route";
    const owner = "thr_sbx_route_owner";
    const later = "thr_sbx_route_later";
    await seedAgent(agentId);
    await seedThread(owner, agentId);
    await seedThread(later, agentId);

    // OWNER starts the background work and asks to be told about it.
    const ownerSession = await openSession(agentId, owner);
    const started = await ownerSession.session.execStart({
      command: "sleep 300",
      label: "owner build",
    });
    if (!started.ok) throw new Error(`execStart failed: ${started.error.code}`);
    const processId: string = started.value.processId;
    const watched = await ownerSession.session.execWatch({ processId });
    if (!watched.ok) throw new Error(`execWatch failed: ${watched.error.code}`);
    expect(watched.value.watching).toBe(true);

    await ageWatcher(agentId);

    // LATER takes the next turn on the same agent, so it becomes the single
    // `SandboxAlarmParams.threadId` the tick replays. Nothing about the work
    // above belongs to it.
    await openSession(agentId, later);

    await fireAlarm(agentId);

    expect(
      await transcriptText(owner),
      "the reminder belongs to the thread that started the process",
    ).toContain(processId);
    expect(
      await transcriptText(later),
      "the thread that merely took the later turn must never hear about it",
    ).not.toContain(processId);

    // The ledger half of the same routing: the terminal and the delivery stamp
    // belong on the owner's ledger, which is the only one anything reads.
    const ownerRow = await ledgerRow(owner, processId);
    expect(ownerRow?.terminal?.reason).toBe("watch_timeout");
    expect(ownerRow?.deliveredAt).not.toBeNull();
    expect(
      await ledgerRow(later, processId),
      "no row may be invented on the alarm-params thread's ledger",
    ).toBeUndefined();
  });

  /**
   * The same routing, entered from the turn-end backstop instead of the model.
   *
   * `autoWatchRunningProcesses` walks EVERY running process in the box, and the
   * box is the agent's. So the thread whose turn is ending routinely adopts a
   * process another thread started — and the watcher it creates must answer to
   * the process's owner, not to itself. Stamping the adopting thread here is
   * the same mis-delivery as the tick's, arriving one layer earlier.
   */
  it("stamps an ADOPTED process's watcher with the thread that started it", async () => {
    const agentId = "agent_sbx_adopt";
    const owner = "thr_sbx_adopt_owner";
    const adopter = "thr_sbx_adopt_adopter";
    await seedAgent(agentId);
    await seedThread(owner, agentId);
    await seedThread(adopter, agentId);

    const ownerSession = await openSession(agentId, owner);
    const started = await ownerSession.session.execStart({
      command: "sleep 300",
      label: "owner build",
    });
    if (!started.ok) throw new Error(`execStart failed: ${started.error.code}`);
    const processId: string = started.value.processId;

    // Empty the roster first, so the assertion below is about the REGISTER
    // rostering the owner and not about the owner's own session having done it.
    // (The owner has a running process but no ledger row yet, so this prunes.)
    await fireAlarm(agentId);
    expect(await rosterThreads(agentId)).toEqual([]);

    // The ADOPTER's turn ends and its backstop attaches a watcher to every
    // running process it can see — including the owner's.
    const adopterSession = await openSession(agentId, adopter);
    const attached = await adopterSession.session.autoWatchRunningProcesses();
    if (!attached.ok) throw new Error(`autoWatch failed: ${attached.error.code}`);
    expect(attached.value.attached).toContain(processId);
    // The roster invariant: a thread with a ledger row ALWAYS has a roster row.
    // The register that just landed was routed to the OWNER, so the roster entry
    // has to be the owner's — rostering the registering thread instead leaves the
    // owner's row with nothing to sweep it.
    expect(await rosterThreads(agentId)).toContain(owner);

    await ageWatcher(agentId);
    await fireAlarm(agentId);

    expect(
      await transcriptText(owner),
      "the adopted process still belongs to the thread that started it",
    ).toContain(processId);
    expect(await transcriptText(adopter)).not.toContain(processId);
    expect((await ledgerRow(owner, processId))?.terminal?.reason).toBe("watch_timeout");
    expect(await ledgerRow(adopter, processId)).toBeUndefined();
  });
});

/**
 * FIX ROUND 1 — the teardown paths, where routing the LEDGER without routing the
 * NOTICE turned a late message into no message at all.
 *
 * `stopRunningProcesses({deliver:true})` stamps the delivery gate because its
 * caller "already told the model". Once the terminal is routed to the process's
 * OWNER, that sentence is only true for the one thread the caller is talking to.
 * Every other owner gets its row closed AND marked told, which is precisely the
 * state the reaper is built to skip — so nobody ever says the work was killed.
 */
describe("a teardown speaks only for the thread it is talking to", () => {
  beforeAll(async () => {
    await applyRegistryTestSchema(env.REGISTRY_DB);
  });

  /**
   * A background process with NO watcher: `runComputeTick` returns early while
   * `countWatchers() > 0`, so a watched process already defers eviction. The
   * unwatched one is what actually reaches a teardown owned by another thread.
   */
  async function startUnwatchedProcess(agentId: string, threadId: string): Promise<string> {
    const opened = await openSession(agentId, threadId);
    const started = await opened.session.execStart({ command: "sleep 300", label: "long build" });
    if (!started.ok) throw new Error(`execStart failed: ${started.error.code}`);
    const processId: string = started.value.processId;
    // Register the ledger row the way the watcher path does, then drop the
    // watcher — the state a process is in once its watch has timed out while it
    // keeps running.
    const watched = await opened.session.execWatch({ processId });
    if (!watched.ok) throw new Error(`execWatch failed: ${watched.error.code}`);
    await runInSandboxDo(sandboxStub(agentId), async (instance: any) => {
      instance.ctx.storage.sql.exec("DELETE FROM sandbox_process_watchers");
    });
    return processId;
  }

  it("leaves another thread's row OWED when the shutdown notice went elsewhere", async () => {
    const agentId = "agent_sbx_teardown";
    const owner = "thr_sbx_teardown_owner";
    const shutter = "thr_sbx_teardown_shutter";
    await seedAgent(agentId);
    await seedThread(owner, agentId);
    await seedThread(shutter, agentId);

    const processId = await startUnwatchedProcess(agentId, owner);

    // SHUTTER tears the box down. Its own reminder tells SHUTTER, and only
    // SHUTTER, that everything running is gone.
    const shutterSession = await openSession(agentId, shutter);
    const result = await shutterSession.session.execShutdown({ confirm: true });
    if (!result.ok) throw new Error(`execShutdown failed: ${result.error.code}`);

    const row = await ledgerRow(owner, processId);
    // The terminal is correct and stays: the process really was stopped, and
    // routing it to the owner is what this task fixed.
    expect(row?.terminal?.reason).toBe("process_stopped");
    // The DELIVERY is the half that must not be claimed. Nothing has told the
    // owner, so the row stays owed and the owner's own sweep reports it.
    expect(
      row?.deliveredAt,
      "the owner was never told, so the row must stay OWED — stamping it delivered " +
        "is what makes the reaper skip it and the owner hear nothing, ever",
    ).toBeNull();

    // And the notice itself went where the caller was talking.
    expect(await transcriptText(shutter)).toContain("shut down on request");
    expect(await transcriptText(owner)).not.toContain("shut down on request");
  });

  /**
   * FIX ROUND 2 — the withheld claim needs a WAKE to redeem it.
   *
   * Withholding the stamp only helps if something later sweeps the row, and
   * `runWorkLedgerSweep`'s sole trigger is `AgentSandbox.alarm()`. `execShutdown`
   * calls `clearAlarm()` four lines after leaving the sibling's row owed, which
   * deleted the box's only alarm — so "the owner's own sweep reports it" was a
   * promise nothing kept until some other thread happened to do compute.
   */
  it("leaves an ALARM armed when a teardown leaves another thread's row owed", async () => {
    const agentId = "agent_sbx_teardown_wake";
    const owner = "thr_sbx_wake_owner";
    const shutter = "thr_sbx_wake_shutter";
    await seedAgent(agentId);
    await seedThread(owner, agentId);
    await seedThread(shutter, agentId);

    await startUnwatchedProcess(agentId, owner);

    const shutterSession = await openSession(agentId, shutter);
    const before = Date.now();
    const result = await shutterSession.session.execShutdown({ confirm: true });
    if (!result.ok) throw new Error(`execShutdown failed: ${result.error.code}`);

    const armed = await runInSandboxDo(sandboxStub(agentId), async (instance: any) =>
      instance.ctx.storage.getAlarm(),
    );
    expect(
      armed,
      "the owed row's only sweep trigger is this alarm; clearing it strands the row " +
        "AND the notice the owner was promised",
    ).not.toBeNull();

    // ...and armed at a time that can actually redeem it. `!== null` alone
    // passes for an alarm set to 0, to a stale past timestamp, or to the idle
    // release half an hour out — none of which is "the owed row's retry".
    // Bounded rather than equated: the owner's row is terminal-but-undelivered,
    // so `workHorizon` folds to the OWED component, `now + WORK_DELIVERY_RETRY_MS`.
    // Asserting the window keeps this a statement about behaviour rather than a
    // copy of the arithmetic.
    expect(armed, "an alarm in the past is a hot-refire, not a wake").toBeGreaterThan(before);
    expect(
      armed,
      "and one an idle-release away is the owner waiting ~30 minutes for a card it is owed",
    ).toBeLessThanOrEqual(Date.now() + WORK_DELIVERY_RETRY_MS);
  });

  /**
   * FIX ROUND 2 — the other direction of `toldThisOwner`, which nothing covered.
   *
   * Deleting the `markDelivered` call entirely left all six vitest projects
   * green (4990 tests), because the only `deliveredAt` assertions go through
   * `stopAllRunningProcesses`, a different funnel that stamps inline. Without
   * the stamp, every `exec_shutdown` earns the model a duplicate per-process
   * "stopped" card from the sweep, contradicting the reminder it just read.
   */
  it("DOES claim the delivery for its own thread's rows", async () => {
    const agentId = "agent_sbx_teardown_self";
    const owner = "thr_sbx_self_owner";
    await seedAgent(agentId);
    await seedThread(owner, agentId);

    const processId = await startUnwatchedProcess(agentId, owner);

    // The SAME thread tears the box down, so its own reminder genuinely covers
    // this row and the sweep must not say it a second time.
    const ownerSession = await openSession(agentId, owner);
    const result = await ownerSession.session.execShutdown({ confirm: true });
    if (!result.ok) throw new Error(`execShutdown failed: ${result.error.code}`);

    const row = await ledgerRow(owner, processId);
    expect(row?.terminal?.reason).toBe("process_stopped");
    expect(
      row?.deliveredAt,
      "this thread WAS told, in the shutdown reminder — leaving the row owed makes " +
        "the sweep inject a second, contradicting card for the same process",
    ).not.toBeNull();
    expect(await transcriptText(owner)).toContain("shut down on request");
  });

  /**
   * `hasBlockingWork` means "a CHILD AGENT is on this machine". The machine is
   * the agent's now, so the question is about the box, not about whichever
   * thread happens to be asking. Asking one thread lets a sibling destroy a
   * container out from under a live child — the loss the unreachable-fallback
   * (`true`) exists to prevent, reintroduced by scope.
   */
  it("refuses to shut down while ANOTHER thread of the agent has a live child", async () => {
    const agentId = "agent_sbx_children";
    const parent = "thr_sbx_children_parent";
    const sibling = "thr_sbx_children_sibling";
    await seedAgent(agentId);
    await seedThread(parent, agentId);
    await seedThread(sibling, agentId);

    // An open SUBAGENT row on the parent: a child holding this box.
    await runInSandboxDo(sandboxStub(agentId), async (instance: any) => {
      await instance.threadHostDeps(parent).workLedger.register({
        id: "run_child_1",
        kind: "subagent" as const,
        startedAt: Date.now(),
        lastAliveAt: Date.now(),
        staleAfterMs: 180_000,
        deadlineAt: Date.now() + 3_600_000,
        generation: "gen_children",
        terminal: null,
        deliveredAt: null,
      });
    });

    const siblingSession = await openSession(agentId, sibling);
    const result = await siblingSession.session.execShutdown({ confirm: true });
    expect(
      result.ok ? "no error" : result.error.message,
      "the sibling must not be able to destroy the box the parent's child is running on",
    ).toContain("compute_children_active");
  });
});

/**
 * FIX ROUND 1 — the watcher cap, which P3 turned from a per-conversation
 * fairness rule into a per-BOX one without renaming or re-scoping it.
 */
describe("one thread cannot spend the whole agent's watcher budget", () => {
  beforeAll(async () => {
    await applyRegistryTestSchema(env.REGISTRY_DB);
  });

  it("still watches a sibling's process after one thread has filled its own quota", async () => {
    const agentId = "agent_sbx_cap";
    const hog = "thr_sbx_cap_hog";
    const sibling = "thr_sbx_cap_sibling";
    await seedAgent(agentId);
    await seedThread(hog, agentId);
    await seedThread(sibling, agentId);

    // MAX_WATCHERS_PER_THREAD is 8. The hog takes every one of them.
    const hogSession = await openSession(agentId, hog);
    for (let index = 0; index < 8; index += 1) {
      const started = await hogSession.session.execStart({ command: `sleep ${300 + index}` });
      if (!started.ok) throw new Error(`execStart failed: ${started.error.code}`);
      const watched = await hogSession.session.execWatch({ processId: started.value.processId });
      if (!watched.ok) throw new Error(`execWatch failed: ${watched.error.code}`);
      expect(watched.value.watching).toBe(true);
    }

    // The sibling's own first background command must still get a watcher. It
    // shares the box, not the quota — before this, `countWatchers()` counted the
    // BOX and the sibling was silently handed a watcher-less process.
    const siblingSession = await openSession(agentId, sibling);
    const started = await siblingSession.session.execStart({ command: "sleep 900" });
    if (!started.ok) throw new Error(`execStart failed: ${started.error.code}`);
    const watched = await siblingSession.session.execWatch({
      processId: started.value.processId,
    });
    expect(
      watched.ok ? watched.value.watching : `refused: ${watched.error.message}`,
      "a busy sibling must not be able to deny this thread its completion cards",
    ).toBe(true);

    // And the hog is still held to ITS limit, with a reason it can act on.
    const ninth = await hogSession.session.execStart({ command: "sleep 999" });
    if (!ninth.ok) throw new Error(`execStart failed: ${ninth.error.code}`);
    const refused = await hogSession.session.execWatch({ processId: ninth.value.processId });
    expect(refused.ok).toBe(false);
    if (!refused.ok) expect(refused.error.message).toContain("thread_limit");
  });

  /**
   * FIX ROUND 2 — a sibling's full quota must not abort the whole backstop.
   *
   * `autoWatchRunningProcesses` walks every process in the BOX while admission
   * is per-OWNER, so a `thread_limit` is a fact about one other thread and says
   * nothing about the next process in the list. Breaking on it put finding 2's
   * starvation back one layer up, visible only as a log line.
   */
  it("skips a process it may not watch instead of abandoning the whole sweep", async () => {
    const agentId = "agent_sbx_backstop";
    const hog = "thr_sbx_backstop_hog";
    const other = "thr_sbx_backstop_other";
    await seedAgent(agentId);
    await seedThread(hog, agentId);
    await seedThread(other, agentId);

    const hogSession = await openSession(agentId, hog);
    for (let index = 0; index < 8; index += 1) {
      const started = await hogSession.session.execStart({ command: `sleep ${400 + index}` });
      if (!started.ok) throw new Error(`execStart failed: ${started.error.code}`);
      const watched = await hogSession.session.execWatch({ processId: started.value.processId });
      if (!watched.ok) throw new Error(`execWatch failed: ${watched.error.code}`);
    }

    // OTHER's own unwatched process...
    const otherSession = await openSession(agentId, other);
    const mine = await otherSession.session.execStart({ command: "sleep 800" });
    if (!mine.ok) throw new Error(`execStart failed: ${mine.error.code}`);
    // ...and the hog's NINTH, which its own quota already refuses.
    const ninth = await hogSession.session.execStart({ command: "sleep 999" });
    if (!ninth.ok) throw new Error(`execStart failed: ${ninth.error.code}`);

    // `listProcesses` is `ORDER BY started_at DESC`, and ms-resolution starts
    // can tie. Stamp the order the defect needs — the refusable row FIRST —
    // rather than depending on the clock. Both stay in the past so `minAgeMs`
    // (0) still admits them.
    await runInSandboxDo(sandboxStub(agentId), async (instance: any) => {
      const now = Date.now();
      instance.ctx.storage.sql.exec(
        "UPDATE sandbox_processes SET started_at = ? WHERE id = ?",
        now - 1_000,
        ninth.value.processId,
      );
      instance.ctx.storage.sql.exec(
        "UPDATE sandbox_processes SET started_at = ? WHERE id = ?",
        now - 5_000,
        mine.value.processId,
      );
    });

    const attached = await otherSession.session.autoWatchRunningProcesses();
    if (!attached.ok) throw new Error(`autoWatch failed: ${attached.error.code}`);
    expect(
      attached.value.attached,
      "the hog's refused ninth must be skipped, not treated as the end of the walk",
    ).toContain(mine.value.processId);
    expect(attached.value.attached).not.toContain(ninth.value.processId);
  });

  /**
   * FIX ROUND 1 — an explicit `exec_watch` on a sibling's process. Routing the
   * card to the owner is right; letting the caller believe it will hear back is
   * not.
   */
  it("tells a thread when the watch it asked for reports somewhere else", async () => {
    const agentId = "agent_sbx_routed_notice";
    const owner = "thr_sbx_routed_owner";
    const onlooker = "thr_sbx_routed_onlooker";
    await seedAgent(agentId);
    await seedThread(owner, agentId);
    await seedThread(onlooker, agentId);

    const ownerSession = await openSession(agentId, owner);
    const started = await ownerSession.session.execStart({ command: "sleep 300" });
    if (!started.ok) throw new Error(`execStart failed: ${started.error.code}`);
    const processId: string = started.value.processId;

    const onlookerSession = await openSession(agentId, onlooker);
    const watched = await onlookerSession.session.execWatch({ processId });
    if (!watched.ok) throw new Error(`execWatch failed: ${watched.error.code}`);
    if (!watched.value.watching) throw new Error(`not watching: ${watched.value.status}`);
    expect(watched.value.routedTo, "the caller must be told where the card will go").toBe(owner);
    expect(watched.value.note).toContain("another thread");

    // The owner's own watch says nothing of the sort — the field is a warning
    // about a mismatch, not decoration on every result.
    const ownWatch = await ownerSession.session.execWatch({ processId });
    if (!ownWatch.ok) throw new Error(`execWatch failed: ${ownWatch.error.code}`);
    if (!ownWatch.value.watching) throw new Error(`not watching: ${ownWatch.value.status}`);
    expect(ownWatch.value.routedTo).toBeUndefined();
  });
});
