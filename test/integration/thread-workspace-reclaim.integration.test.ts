/**
 * P3 TASK 4 — a thread's worktree is reclaimed when the thread ends, LAZILY.
 *
 * The whole design is two halves that must not be collapsed into one:
 *
 *  1. Ending a thread RECORDS A DEBT on the agent's box and does nothing else.
 *     No `exec`, no alarm, no wake. Auto-archive is a cron over many idle
 *     threads; an eager removal would wake every idle agent's sprite nightly to
 *     delete a directory nobody is waiting on, and bill them all awake.
 *  2. The next turn that has the box awake for its OWN reasons pays the
 *     removal, on the first `exec` of the turn.
 *
 * None of that is visible to typecheck, and the wrong answer to any of it fails
 * nothing: an alarm armed here would only show up on the bill, a debt never
 * swept only shows up as disk, and a sweep that ran on the ALARM would only
 * show up as a sprite that never sleeps.
 */
import { env, runInDurableObject } from "cloudflare:test";
import { beforeAll, describe, expect, it } from "vitest";
import { drizzle } from "drizzle-orm/d1";
import * as schema from "../../src/db/schema";
import { applyRegistryTestSchema } from "./helpers/registry";
import { FakeComputeBackend } from "../../src/compute/backends/fake";
import {
  clearComputeHostTestOverrides,
  setComputeHostTestOverrides,
} from "../../src/compute/host-test-overrides";
import { RECLAIM_MARKER, threadWorkRoot } from "../../src/compute/workspace-layout";

const now = 1_800_000_000_000;
const WORKSPACE_ID = "ws_reclaim";

/** Mirrors the DO's own `PENDING_RECLAIM_PREFIX` — the debt is what this suite reads. */
const PENDING_RECLAIM_PREFIX = "sb:rc:";

/**
 * `integration-fast` runs with `isolate: false` and a Durable Object addressed
 * by name is not proven to get a fresh storage snapshot per `it()`, so every
 * test uses its OWN agent id (which is the box key) and its own thread ids.
 */
const agentIdFor = (suffix: string) => `agent_reclaim_${suffix}`;

async function seedAgent(agentId: string) {
  const db = drizzle(env.REGISTRY_DB, { schema });
  await db
    .insert(schema.workspaces)
    .values({ id: WORKSPACE_ID, name: "Reclaim WS", flagsJson: "{}", createdAt: now })
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

/** The box. `idFromName(agentId)` — one per agent, shared by every thread. */
const stub = (agentId: string) => env.AGENT_SANDBOX.get(env.AGENT_SANDBOX.idFromName(agentId));

async function openSession(agentId: string, threadId: string) {
  const opened = await stub(agentId).session({
    threadId,
    workspaceThreadId: threadId,
    supportsProcessMonitor: true,
    runtimeConfig: { workspaceId: WORKSPACE_ID, agentId },
  });
  if (!opened.ok) throw new Error(`session failed: ${opened.error.code}`);
  if (!opened.value) throw new Error("expected compute to be enabled");
  return opened.value;
}

/** The pending-reclaim debts this box is carrying, thread ids only. */
async function pendingReclaims(agentId: string): Promise<string[]> {
  return await runInDurableObject(stub(agentId), async (_instance, state) => {
    const rows = await state.storage.list<number>({ prefix: PENDING_RECLAIM_PREFIX });
    return [...rows.keys()].map((key) => key.slice(PENDING_RECLAIM_PREFIX.length)).sort();
  });
}

/**
 * Point the box at an instrumented backend, so the reclaim's own command is
 * observable. `FakeComputeBackend` answers every command 0, which is what a
 * successful reclaim looks like.
 */
function instrument(...threadIds: string[]): FakeComputeBackend {
  const backend = new FakeComputeBackend();
  // EVERY thread that opens a session on the box gets the SAME instance. The
  // override is keyed by thread, and the runtime reference is stored per BOX:
  // instrumenting only one thread leaves a sibling's session holding a
  // reference the other backend has never heard of.
  for (const threadId of threadIds) {
    setComputeHostTestOverrides(threadId, { buildBackend: async () => backend });
  }
  return backend;
}

const reclaimCommands = (backend: FakeComputeBackend) =>
  backend.runCommandCalls.map((call) => call.command).filter((c) => c.includes(RECLAIM_MARKER));

describe("lazy reclaim of an ended thread's worktree", () => {
  beforeAll(async () => {
    await applyRegistryTestSchema(env.REGISTRY_DB);
  });

  /**
   * THE LAZINESS, ASSERTED DIRECTLY. Marking must not touch the machine and must
   * not arm the box's single alarm — an alarm here would wake the sprite, which
   * is the entire cost this design exists to avoid, and nothing else in the
   * system would ever notice.
   */
  it("records a debt without running a command or arming an alarm", async () => {
    const agentId = agentIdFor("lazy");
    const threadId = "thr_reclaim_lazy";
    await seedAgent(agentId);
    await seedThread(threadId, agentId);
    const backend = instrument(threadId);
    try {
      await openSession(agentId, threadId);
      const alarmBefore = await runInDurableObject(stub(agentId), async (_i, state) =>
        state.storage.getAlarm(),
      );
      const callsBefore = backend.runCommandCalls.length;

      const marked = await stub(agentId).releaseThreadWorkspace({ threadId });
      expect(marked.ok).toBe(true);

      expect(await pendingReclaims(agentId)).toEqual([threadId]);
      expect(backend.runCommandCalls.length).toBe(callsBefore);
      const alarmAfter = await runInDurableObject(stub(agentId), async (_i, state) =>
        state.storage.getAlarm(),
      );
      expect(alarmAfter).toBe(alarmBefore);
    } finally {
      clearComputeHostTestOverrides(threadId);
    }
  });

  /**
   * A box no session has ever run on cannot hold a thread's directory, so a
   * mark against it must write NOTHING — otherwise archiving a thread of a
   * compute-less agent permanently populates a Durable Object nothing else will
   * ever read.
   */
  it("records nothing on a box that has never opened a session", async () => {
    const agentId = agentIdFor("virgin");
    const marked = await stub(agentId).releaseThreadWorkspace({ threadId: "thr_reclaim_virgin" });
    expect(marked.ok).toBe(true);
    expect(await pendingReclaims(agentId)).toEqual([]);
  });

  /**
   * THE SWEEP. A sibling thread's turn — the box is awake because a user is
   * using it — pays the removal on its first `exec`, and the debt is cleared
   * only once the command actually ran.
   */
  it("removes the ended thread's work root on the next turn's first exec", async () => {
    const agentId = agentIdFor("sweep");
    const ended = "thr_reclaim_ended";
    const live = "thr_reclaim_live";
    await seedAgent(agentId);
    await seedThread(ended, agentId);
    await seedThread(live, agentId);
    const backend = instrument(ended, live);
    try {
      const first = await openSession(agentId, ended);
      // A real turn on the ending thread, so the box exists and its directory
      // does too — the debt below is about something.
      expect((await first.session.execRun({ command: "echo hi" })).ok).toBe(true);
      expect((await stub(agentId).releaseThreadWorkspace({ threadId: ended })).ok).toBe(true);
      expect(await pendingReclaims(agentId)).toEqual([ended]);

      const second = await openSession(agentId, live);
      expect((await second.session.execRun({ command: "echo hi" })).ok).toBe(true);

      const commands = reclaimCommands(backend);
      expect(commands).toHaveLength(1);
      expect(commands[0]).toContain(threadWorkRoot(ended));
      // The LIVE thread's own directory must not appear in a removal command.
      expect(commands[0]).not.toContain(threadWorkRoot(live));
      expect(await pendingReclaims(agentId)).toEqual([]);
    } finally {
      clearComputeHostTestOverrides(ended);
      clearComputeHostTestOverrides(live);
    }
  });

  /**
   * The guard against deleting the cwd out from under a live turn. Unreachable
   * in production today (an archived thread cannot open a socket and a deleted
   * one has no DO), which is exactly why it needs a test: nothing else would
   * ever exercise it, and the failure it prevents is silent data loss.
   */
  it("never reclaims the working directory the resolving session is using", async () => {
    const agentId = agentIdFor("self");
    const threadId = "thr_reclaim_self";
    await seedAgent(agentId);
    await seedThread(threadId, agentId);
    const backend = instrument(threadId);
    try {
      const opened = await openSession(agentId, threadId);
      expect((await opened.session.execRun({ command: "echo hi" })).ok).toBe(true);
      expect((await stub(agentId).releaseThreadWorkspace({ threadId })).ok).toBe(true);

      const again = await openSession(agentId, threadId);
      expect((await again.session.execRun({ command: "echo hi" })).ok).toBe(true);

      expect(reclaimCommands(backend)).toEqual([]);
      // The debt is KEPT, not dropped: another thread of the agent will pay it.
      expect(await pendingReclaims(agentId)).toEqual([threadId]);
    } finally {
      clearComputeHostTestOverrides(threadId);
    }
  });

  /**
   * A REMOVAL THAT DID NOT HAPPEN IS STILL OWED. The debt is cleared on the
   * exit code of the command, never on having tried: a pass that cleared its
   * rows on failure would leave the directory on disk with nothing left in the
   * system that names it, and no log line would say so.
   */
  it("keeps the debt when the reclaim command fails", async () => {
    const agentId = agentIdFor("failure");
    const ended = "thr_reclaim_fail_ended";
    const live = "thr_reclaim_fail_live";
    await seedAgent(agentId);
    await seedThread(ended, agentId);
    await seedThread(live, agentId);
    const backend = instrument(ended, live);
    backend.scriptedExits.push({ match: RECLAIM_MARKER, exitCode: 1 });
    try {
      const first = await openSession(agentId, ended);
      expect((await first.session.execRun({ command: "echo hi" })).ok).toBe(true);
      expect((await stub(agentId).releaseThreadWorkspace({ threadId: ended })).ok).toBe(true);

      // Five turns, and the cap stops the retry at three. A permanently failing
      // `rm` must not stall the first tool call of every turn for the rest of
      // the wake — and the debt must survive the cap, so the next wake tries
      // again. The cap can delay a reclaim; it can never cancel one.
      for (let turn = 0; turn < 5; turn += 1) {
        const session = await openSession(agentId, live);
        expect((await session.session.execRun({ command: "echo hi" })).ok).toBe(true);
      }

      // It really did try — this is not "the sweep never ran".
      expect(reclaimCommands(backend)).toHaveLength(3);
      expect(await pendingReclaims(agentId)).toEqual([ended]);
    } finally {
      clearComputeHostTestOverrides(ended);
      clearComputeHostTestOverrides(live);
    }
  });

  /**
   * The batch cap. One `exec` names every root, so an agent whose auto-archive
   * cron retired hundreds of threads between two turns would otherwise build a
   * command tens of kilobytes long on the first tool call of the next turn.
   * Oldest first, so the cap can never starve the thread owed longest.
   */
  it("caps one pass at 25 threads, oldest debt first, and keeps the rest", async () => {
    const agentId = agentIdFor("batch");
    const live = "thr_reclaim_batch_live";
    await seedAgent(agentId);
    await seedThread(live, agentId);
    const backend = instrument(live);
    try {
      // A session first, so the box's "has ever run" evidence exists.
      const warm = await openSession(agentId, live);
      expect((await warm.session.execRun({ command: "echo hi" })).ok).toBe(true);

      // 30 debts, stamped so the LAST id written is the OLDEST debt.
      const ids = Array.from({ length: 30 }, (_, i) => `thr_batch_${String(i).padStart(2, "0")}`);
      await runInDurableObject(stub(agentId), async (_i, state) => {
        for (const [index, id] of ids.entries()) {
          await state.storage.put<number>(PENDING_RECLAIM_PREFIX + id, now + ids.length - index);
        }
      });

      const next = await openSession(agentId, live);
      expect((await next.session.execRun({ command: "echo hi" })).ok).toBe(true);

      const commands = reclaimCommands(backend);
      expect(commands).toHaveLength(1);
      const named = ids.filter((id) => commands[0]!.includes(threadWorkRoot(id)));
      expect(named).toHaveLength(25);
      // Oldest first: the last five ids written carry the newest stamps and are
      // the five left behind.
      expect(await pendingReclaims(agentId)).toEqual(ids.slice(0, 5).sort());
    } finally {
      clearComputeHostTestOverrides(live);
    }
  });
});
