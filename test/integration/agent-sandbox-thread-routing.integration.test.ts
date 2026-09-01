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
