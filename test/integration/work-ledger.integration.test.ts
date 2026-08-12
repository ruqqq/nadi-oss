import { env, runDurableObjectAlarm, runInDurableObject } from "cloudflare:test";
import { drizzle } from "drizzle-orm/d1";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import * as schema from "../../src/db/schema";
import type { ThinkThreadAgent } from "../../src/agent/think-thread-agent";
import {
  PROCESS_STALE_AFTER_MS,
  SUBAGENT_DEADLINE_MS,
  SUBAGENT_STALE_AFTER_MS,
} from "../../src/agent/work-ledger";
import type { WorkLedgerStore } from "../../src/agent/work-ledger-store";
import { FakeComputeBackend } from "../../src/compute/backends/fake";
import { ComputeError } from "../../src/compute/errors";
import { ThreadComputeService } from "../../src/compute/thread-service";
import { ThreadComputeStore } from "../../src/compute/thread-store";
import { DEFAULT_MONITOR_POLL_INTERVAL_MS } from "../../src/compute/watchers";
import { saveDaytonaApiKey } from "../../src/compute/settings";
import { applyRegistryTestSchema, seedRegistryThread } from "./helpers/registry";

/**
 * END-TO-END coverage for the background-work reaper, through a REAL
 * ThinkThreadAgent Durable Object: the real `WorkLedgerStore` on real DO SQLite,
 * the real `ThreadComputeService`, the real `sandboxHostDeps()` wiring, the real
 * `scheduleComputeEviction`, and the real Agents SDK scheduler. Only the compute
 * BACKEND is a fake.
 *
 * This file exists because the unit suite structurally cannot pin the two
 * invariants that actually broke in production. `alarm-rearm.test.ts` drives
 * `runSandboxEviction` over a hand-built `this` whose `sandboxHostDeps()` is a
 * two-key object literal and whose `scheduleComputeEviction` is mocked to a
 * no-op — so it can never observe what the REAL host wiring arms, nor that
 * `scheduleComputeEviction` is cancel-then-SET on a single stored schedule id
 * rather than a min-fold. Here `schedule()` is spied on the real agent instance,
 * so a second arm is visible as what it is: a CANCEL of the first.
 *
 * CLOCK: `vi.useFakeTimers({ toFake: ["Date"] })`, deliberately, and no `now`
 * override on the compute service. `runWorkLedgerSweep` reads `Date.now()` while
 * the service's clock is injectable (`deps.now`, defaulting to `Date.now()` — so
 * in production they are the SAME clock). Overriding only the service's clock,
 * as the older DO tests do, skews the two apart and makes staleness assertions
 * vacuous: liveness stamped with a fake clock and classified against the real one
 * is either trivially fresh or trivially stale regardless of whether the code
 * under test works. Faking `Date` alone re-couples them and keeps `setTimeout`
 * real for the pool.
 */

const BASE = 1_800_000_000_000;

type LedgerTestableAgent = ThinkThreadAgent & {
  __unsafe_ensureInitialized(): Promise<void>;
  _testSandboxServiceOverrides?: {
    buildBackend?: () => Promise<FakeComputeBackend>;
    execForegroundTimeoutMs?: number;
    execForegroundPollIntervalMs?: number;
    sleep?: (ms: number) => Promise<void>;
  };
  resolveComputeServiceForTest(): Promise<{ service: ThreadComputeService } | null>;
};

/** The real ledger on the DO's real storage — the same object the agent uses. */
function ledgerOf(instance: ThinkThreadAgent): WorkLedgerStore {
  return (instance as unknown as { workLedger: WorkLedgerStore }).workLedger;
}

/** The real host deps the agent builds for compute + the reaper. */
function hostDepsOf(instance: ThinkThreadAgent): {
  hasBlockingWork?: () => Promise<boolean>;
  scheduleEviction: (timestampMs: number) => Promise<void>;
} {
  return (
    instance as unknown as {
      sandboxHostDeps(): {
        hasBlockingWork?: () => Promise<boolean>;
        scheduleEviction: (timestampMs: number) => Promise<void>;
      };
    }
  ).sandboxHostDeps();
}

function injectionsOf(instance: ThinkThreadAgent): Array<{ kind: string; text: string }> {
  return (
    instance as unknown as {
      injectionBuffer(): { peekAll(): Array<{ kind: string; message: { parts: unknown[] } }> };
    }
  )
    .injectionBuffer()
    .peekAll()
    .map((entry) => ({
      kind: entry.kind,
      text: (entry.message.parts as Array<{ type: string; text?: string }>)
        .filter((part) => part.type === "text")
        .map((part) => part.text ?? "")
        .join(""),
    }));
}

/**
 * Record every `schedule()` the agent makes. This is THE arm site: the host's
 * `scheduleEviction` -> `scheduleComputeEviction` -> `host.schedule(...)`, and
 * `sandboxHostDeps()` reaches it via a late `this.schedule` lookup, so an
 * own-property shadow observes the real call without touching production code.
 */
function spySchedule(instance: ThinkThreadAgent): {
  calls: Array<{ at: number; callback: string }>;
  restore: () => void;
} {
  const calls: Array<{ at: number; callback: string }> = [];
  const agent = instance as unknown as {
    schedule: (when: Date, callback: string, payload?: unknown) => Promise<{ id: string }>;
  };
  const original = agent.schedule.bind(agent);
  agent.schedule = async (when: Date, callback: string, payload?: unknown) => {
    calls.push({ at: when.getTime(), callback });
    return original(when, callback, payload);
  };
  return {
    calls,
    restore: () => {
      delete (instance as unknown as { schedule?: unknown }).schedule;
    },
  };
}

const evictionArms = (calls: Array<{ at: number; callback: string }>) =>
  calls.filter((call) => call.callback === "runSandboxEviction");

async function seedSandboxEnabledWorkspace(workspaceId: string) {
  const providerConfigJson = JSON.stringify({
    kind: "daytona",
    apiKeySecretName: "sandbox:daytona",
    apiUrl: null,
    target: null,
    profiles: {
      small: { kind: "image", value: "node:22" },
      medium: { kind: "image", value: "node:22" },
    },
  });
  await env.REGISTRY_DB.prepare(
    "INSERT OR IGNORE INTO workspace_sandbox_settings (workspace_id, enabled, provider, provider_config_json, image, idle_timeout_ms, max_process_runtime_ms, limits_json) VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
  )
    .bind(workspaceId, 1, "daytona", providerConfigJson, "node:22", 900_000, 600_000, "{}")
    .run();
  await saveDaytonaApiKey({
    env,
    workspaceId,
    secretName: "sandbox:daytona",
    value: "dt_test_secret",
  });
}

async function seedThread(threadId: string, options?: { sandbox?: boolean }) {
  const workspaceId = `workspace-${threadId}`;
  await seedRegistryThread(env.REGISTRY_DB, {
    workspaceId,
    agentId: `agent-${threadId}`,
    threadId,
    runtime: "think",
    provider: "mock",
    model: "mock",
  });
  if (options?.sandbox !== false) await seedSandboxEnabledWorkspace(workspaceId);
}

const THREADS = {
  generation: "think-ledger-generation",
  alarm: "think-ledger-alarm",
  hold: "think-ledger-hold",
  healthy: "think-ledger-healthy",
  oneArm: "think-ledger-one-arm",
  tickThrows: "think-ledger-tick-throws",
  disabled: "think-ledger-disabled",
  sweepBackendFree: "think-ledger-sweep-backend-free",
} as const;

/**
 * The legacy subagent lease keys `backfillLegacySubagentRuns` migrates. Spelled
 * out here rather than exported from the agent: these are dead-storage keys a
 * past version wrote, and the test must pin the literals production reads.
 */
const LEGACY_SUBAGENT_LEASE_KEY = "subagent:active-runs";
const LEGACY_SUBAGENT_TIMING_KEY = "subagent:run-timing";

/**
 * Every backend method both COUNTS and throws. Patched onto the INSTANCE, so the
 * prototype (and `id`) stay intact and the recorder covers whatever the backend
 * currently exposes rather than a hand-listed subset that a new method escapes.
 */
function tripwireBackend(backend: FakeComputeBackend): string[] {
  const calls: string[] = [];
  const proto = Object.getPrototypeOf(backend) as object;
  for (const name of Object.getOwnPropertyNames(proto)) {
    if (name === "constructor") continue;
    const descriptor = Object.getOwnPropertyDescriptor(proto, name);
    if (typeof descriptor?.value !== "function") continue;
    (backend as unknown as Record<string, unknown>)[name] = async (...args: unknown[]) => {
      void args;
      calls.push(name);
      throw new ComputeError("provider_transient", `tripwire: ${name} must not be called`);
    };
  }
  return calls;
}

function stubFor(threadId: string) {
  return env.THINK_THREAD_AGENT.get(env.THINK_THREAD_AGENT.idFromName(threadId));
}

/**
 * Prime the agent for compute work: fake backend, instant backgrounding, and a
 * `sleep` that advances the SAME faked clock everything else reads. Keeps
 * proactive injections in the durable buffer (`_turnQueue.isActive`) so a test
 * can count reminders instead of racing a real turn.
 */
function primeCompute(instance: ThinkThreadAgent, backend: FakeComputeBackend): () => void {
  const testInstance = instance as LedgerTestableAgent;
  testInstance._testSandboxServiceOverrides = {
    buildBackend: async () => backend,
    execForegroundTimeoutMs: 1,
    execForegroundPollIntervalMs: 1,
    sleep: async (ms: number) => {
      vi.setSystemTime(Date.now() + ms);
    },
  };
  const turnQueueHolder = instance as unknown as { _turnQueue?: { isActive: boolean } };
  turnQueueHolder._turnQueue = { isActive: true };
  return () => {
    delete testInstance._testSandboxServiceOverrides;
    delete turnQueueHolder._turnQueue;
  };
}

/** Start a real backgrounded, watched process; returns its real ledger row id. */
async function startWatchedProcess(
  instance: ThinkThreadAgent,
): Promise<{ processId: string; generation: string }> {
  const testInstance = instance as LedgerTestableAgent;
  const resolved = await testInstance.resolveComputeServiceForTest();
  if (!resolved) throw new Error("expected compute service");
  const execResult = (await resolved.service.exec({ command: "sleep 300", label: "build" })) as {
    status: string;
    processId: string;
  };
  expect(execResult.status).toBe("backgrounded");
  const generation = resolved.service.getGeneration();
  if (!generation) throw new Error("expected a provisioned generation nonce");
  return { processId: execResult.processId, generation };
}

/**
 * Every hook lives INSIDE this describe, deliberately. These tests are reached
 * through `isolated-do-suite.integration.test.ts`, which imports many files into
 * ONE module graph — so a top-level `beforeEach` would register on the shared
 * ROOT suite and fake `Date` for every other file's tests too.
 */
describe("work ledger (DO integration)", () => {
  beforeAll(async () => {
    drizzle(env.REGISTRY_DB, { schema });
    await applyRegistryTestSchema(env.REGISTRY_DB);
    for (const threadId of Object.values(THREADS)) {
      await seedThread(threadId, { sandbox: threadId !== THREADS.disabled });
    }
  });

  beforeEach(() => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(BASE);
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  describe("work ledger: a generation change faults every open row in ONE sweep", () => {
    /**
     * RED IF: `classifyWork` stops evaluating the generation before liveness /
     * deadline, `isReset` stops treating a differing `known` nonce as a reset, or
     * `runWorkLedgerSweep` stops iterating every open row in a single pass (e.g.
     * breaks after the first terminal, or filters to one kind).
     */
    it("faults a watched process and a subagent run together, as sandbox_reset", async () => {
      const stub = stubFor(THREADS.generation);
      const result = await runInDurableObject(stub, async (instance: ThinkThreadAgent, state) => {
        const testInstance = instance as LedgerTestableAgent;
        await testInstance.__unsafe_ensureInitialized();
        const cleanup = primeCompute(instance, new FakeComputeBackend());
        try {
          const { processId, generation } = await startWatchedProcess(instance);

          // A subagent row alongside the process row, registered under the SAME
          // live generation — so nothing is faulted until the nonce actually moves.
          const runId = "sub_generation_1";
          ledgerOf(instance).register({
            id: runId,
            kind: "subagent",
            startedAt: Date.now(),
            lastAliveAt: Date.now(),
            staleAfterMs: SUBAGENT_STALE_AFTER_MS,
            deadlineAt: Date.now() + SUBAGENT_DEADLINE_MS,
            generation,
            terminal: null,
            deliveredAt: null,
          });

          // ANTI-VACUITY: both rows are genuinely open and genuinely observed by
          // the sweep's own reader before anything is bumped, and the live
          // generation is positively KNOWN (an `unknown` generation can never be a
          // reset, so a sweep over it would pass for the wrong reason).
          const openBefore = ledgerOf(instance).listOpen();
          const generationBefore = (
            await testInstance.resolveComputeServiceForTest()
          )?.service.getGenerationView();

          // The reset: the container came back on a different nonce under both
          // still-open rows. Written through the REAL durable compute store, which
          // is exactly where a genuine re-provision writes it.
          const store = new ThreadComputeStore(state.storage);
          store.migrate();
          store.setGeneration({ kind: "known", nonce: "gen-after-reset" }, Date.now());

          const sweep = await instance.runWorkLedgerSweep();

          return {
            processId,
            runId,
            openBefore: openBefore.map((row) => ({ id: row.id, kind: row.kind })),
            generationBefore,
            sweep,
            rowsAfter: ledgerOf(instance)
              .listAll()
              .map((row) => ({ id: row.id, kind: row.kind, terminal: row.terminal })),
            injections: injectionsOf(instance),
          };
        } finally {
          cleanup();
        }
      });

      // ANTI-VACUITY: an empty ledger, or a sweep that threw on its first line,
      // also returns `{classified:[],terminalized:[]}`. Pin that both rows existed,
      // were open, and that the generation was KNOWN before the bump.
      expect(result.openBefore).toEqual(
        expect.arrayContaining([
          { id: result.processId, kind: "process" },
          { id: result.runId, kind: "subagent" },
        ]),
      );
      expect(result.openBefore).toHaveLength(2);
      expect(result.generationBefore).toMatchObject({ kind: "known" });

      // ONE sweep faults BOTH kinds.
      expect(result.sweep.classified).toEqual(
        expect.arrayContaining([
          { id: result.processId, state: "fault", reason: "sandbox_reset" },
          { id: result.runId, state: "fault", reason: "sandbox_reset" },
        ]),
      );
      expect(result.sweep.classified).toHaveLength(2);
      expect(result.sweep.terminalized.sort()).toEqual([result.processId, result.runId].sort());

      // The terminals landed durably, on both rows.
      for (const id of [result.processId, result.runId]) {
        expect(result.rowsAfter.find((row) => row.id === id)?.terminal).toMatchObject({
          outcome: "fault",
          reason: "sandbox_reset",
        });
      }

      // Both kinds told the model the FILESYSTEM is gone — the wording the model
      // acts on — and each got its own message.
      expect(result.injections).toHaveLength(2);
      expect(result.injections.map((entry) => entry.kind).sort()).toEqual([
        "subagent-completion",
        "watcher-completion",
      ]);
      for (const entry of result.injections) {
        expect(entry.text).toContain("the sandbox was reset");
      }
    });
  });

  describe("work ledger: the reaper runs off a REAL alarm", () => {
    /**
     * This drives a GENUINELY real alarm. `runDurableObjectAlarm` invokes the
     * Durable Object's physical `alarm()` handler — the Agents SDK's own override,
     * which selects due rows out of `cf_agents_schedules` and dispatches the
     * callback BY NAME. Nothing here calls `runSandboxEviction`; the only reason it
     * runs is that the real `exec` path armed a real schedule through the real
     * `scheduleComputeEviction`, under the callback name production registers.
     *
     * RED IF: the arm is removed from the exec path, the schedule callback name
     * stops matching the method, `runSandboxEviction` stops sweeping the ledger, or
     * `terminalize`'s exactly-once gate stops gating delivery (the second alarm
     * would then deliver a duplicate).
     */
    it("dispatches runSandboxEviction and delivers exactly one reminder", async () => {
      const stub = stubFor(THREADS.alarm);

      const setup = await runInDurableObject(stub, async (instance: ThinkThreadAgent) => {
        const testInstance = instance as LedgerTestableAgent;
        await testInstance.__unsafe_ensureInitialized();
        // Left INSTALLED across the alarm: the alarm must find the same primed
        // instance. Torn down in the final runInDurableObject below.
        primeCompute(instance, new FakeComputeBackend());
        const { processId, generation } = await startWatchedProcess(instance);

        // A subagent run already past its budget. The reaper is the only thing that
        // can ever close it — nothing else is watching it.
        const runId = "sub_alarm_1";
        ledgerOf(instance).register({
          id: runId,
          kind: "subagent",
          startedAt: Date.now() - SUBAGENT_DEADLINE_MS - 1_000,
          lastAliveAt: Date.now(),
          staleAfterMs: SUBAGENT_STALE_AFTER_MS,
          deadlineAt: Date.now() - 1_000,
          generation,
          terminal: null,
          deliveredAt: null,
        });
        return {
          processId,
          runId,
          openBefore: ledgerOf(instance)
            .listOpen()
            .map((row) => row.id),
        };
      });

      // ANTI-VACUITY: the row the alarm must close is open BEFORE the alarm.
      expect(setup.openBefore).toContain(setup.runId);

      // Past the schedule the exec path armed (BASE + one poll interval), so the
      // SDK's `WHERE time <= now` finds it.
      vi.setSystemTime(BASE + DEFAULT_MONITOR_POLL_INTERVAL_MS + 1_000);
      const ranFirst = await runDurableObjectAlarm(stub);

      const afterFirst = await runInDurableObject(stub, async (instance: ThinkThreadAgent) => ({
        row: ledgerOf(instance).get(setup.runId),
        injections: injectionsOf(instance),
      }));

      // A real alarm really fired, and it really closed the row.
      expect(ranFirst).toBe(true);
      expect(afterFirst.row?.terminal).toMatchObject({
        outcome: "timeout",
        reason: "watch_timeout",
      });
      const reminders = afterFirst.injections.filter(
        (entry) => entry.kind === "subagent-completion",
      );
      expect(reminders).toHaveLength(1);
      expect(reminders[0]?.text).toContain("time budget");

      // The tick re-armed, so a SECOND real alarm is available. Exactly-once means
      // it must add nothing: the row is already terminal.
      vi.setSystemTime(BASE + 60_000);
      const ranSecond = await runDurableObjectAlarm(stub);

      const afterSecond = await runInDurableObject(stub, async (instance: ThinkThreadAgent) => {
        const injections = injectionsOf(instance);
        delete (instance as LedgerTestableAgent)._testSandboxServiceOverrides;
        delete (instance as unknown as { _turnQueue?: unknown })._turnQueue;
        return { injections };
      });

      // ANTI-VACUITY: if no second alarm ran, "still exactly one" would be true for
      // the wrong reason.
      expect(ranSecond).toBe(true);
      expect(
        afterSecond.injections.filter((entry) => entry.kind === "subagent-completion"),
      ).toHaveLength(1);
    });
  });

  describe("work ledger: a reaped subagent releases the eviction hold", () => {
    /**
     * RED IF: `hasBlockingWork` stops deriving from open ledger rows (e.g. goes
     * back to a separately-written lease the reaper does not clear), the sweep
     * stops terminalizing subagent rows, or `openSubagentRows` stops filtering on
     * `terminal_outcome IS NULL`.
     */
    it("hasBlockingWork flips true -> false across the sweep", async () => {
      const stub = stubFor(THREADS.hold);
      const result = await runInDurableObject(stub, async (instance: ThinkThreadAgent) => {
        const testInstance = instance as LedgerTestableAgent;
        await testInstance.__unsafe_ensureInitialized();
        const cleanup = primeCompute(instance, new FakeComputeBackend());
        try {
          const { generation } = await startWatchedProcess(instance);
          const runId = "sub_hold_1";
          ledgerOf(instance).register({
            id: runId,
            kind: "subagent",
            startedAt: Date.now() - SUBAGENT_DEADLINE_MS - 1_000,
            lastAliveAt: Date.now(),
            staleAfterMs: SUBAGENT_STALE_AFTER_MS,
            deadlineAt: Date.now() - 1_000,
            generation,
            terminal: null,
            deliveredAt: null,
          });

          const holdBefore = await hostDepsOf(instance).hasBlockingWork?.();
          const sweep = await instance.runWorkLedgerSweep();
          const holdAfter = await hostDepsOf(instance).hasBlockingWork?.();
          return { runId, holdBefore, sweep, holdAfter };
        } finally {
          cleanup();
        }
      });

      // ANTI-VACUITY: the hold was really held, and the sweep really closed the row
      // that held it — otherwise `false` afterwards proves nothing.
      expect(result.holdBefore).toBe(true);
      expect(result.sweep.terminalized).toContain(result.runId);
      expect(result.holdAfter).toBe(false);
    });
  });

  describe("work ledger: a healthy long-running row survives repeated sweeps", () => {
    /**
     * The false-positive guard, and the reason this project ships dark first: a
     * false `fault` on a legitimate 40-minute build is worse than the hang it
     * replaces.
     *
     * Both clocks are the same faked `Date`, so silence is measured honestly —
     * across the passes below the process is silent for well over four stale
     * windows, and stays alive ONLY because each tick genuinely polls it and
     * stamps it.
     *
     * EVERY number here is DERIVED from the two real constants, never restated.
     * It used to advance a literal 20s per pass and expect 5 distinct stamps,
     * which encoded the old 7s poll: at 60s only 2 stamps land (the watcher is
     * due every third pass) and the assertion failed. Lowering 5 to 2 would
     * have retuned the guard until it was green and destroyed it — the count is
     * "the tick stamped on EVERY pass", so it has to move with the cadence.
     *
     * RED IF: `pollWatcher` stops calling `stampAlive`,
     * `PROCESS_STALE_AFTER_MS` drops below the poll interval, or `classifyWork`
     * faults an in-window row.
     *
     * NOT red if the tick/sweep order reverts to sweep-first: the advance is
     * strictly less than one stale window, and under sweep-first the PRIOR tick
     * stamped at the prior `now`, so the observed silence is always exactly one
     * advance — in window. Ordering is covered by `alarm-rearm.test.ts`'s
     * late-alarm test instead.
     */
    it("is never faulted while the tick keeps stamping it", async () => {
      // Past the poll so the watcher is genuinely DUE on every pass (that is
      // what makes it stamp), and inside the stale window so one pass's silence
      // is in-window under either tick/sweep order. `PROCESS_STALE_AFTER_MS` is
      // 3x the poll, so 2x sits between the two by construction.
      const ADVANCE_MS = DEFAULT_MONITOR_POLL_INTERVAL_MS * 2;
      expect(ADVANCE_MS).toBeGreaterThan(DEFAULT_MONITOR_POLL_INTERVAL_MS);
      expect(ADVANCE_MS).toBeLessThan(PROCESS_STALE_AFTER_MS);
      // Enough passes that the total elapsed dwarfs the stale window — the
      // "far more than the stale window elapsed" assertion at the bottom.
      const PASSES = Math.ceil((PROCESS_STALE_AFTER_MS * 4) / ADVANCE_MS) + 1;
      const stub = stubFor(THREADS.healthy);
      const result = await runInDurableObject(stub, async (instance: ThinkThreadAgent) => {
        const testInstance = instance as LedgerTestableAgent;
        await testInstance.__unsafe_ensureInitialized();
        const cleanup = primeCompute(instance, new FakeComputeBackend());
        try {
          const { processId } = await startWatchedProcess(instance);
          const stamps: number[] = [];
          const states: Array<{ terminal: unknown; watchers: number }> = [];

          // Never finished on the backend: the process really is still running.
          for (let index = 0; index < PASSES; index += 1) {
            vi.setSystemTime(Date.now() + ADVANCE_MS);
            await instance.runSandboxEviction();
            const row = ledgerOf(instance).get(processId);
            stamps.push(row?.lastAliveAt ?? -1);
            const resolved = await testInstance.resolveComputeServiceForTest();
            states.push({
              terminal: row?.terminal ?? null,
              watchers: resolved?.service.listActiveWatchersView().length ?? -1,
            });
          }

          return {
            processId,
            elapsedMs: Date.now() - BASE,
            stamps,
            states,
            injections: injectionsOf(instance),
          };
        } finally {
          cleanup();
        }
      });

      // ANTI-VACUITY: the row was really observed and really re-stamped each pass.
      // A row nothing stamps would repeat one value here and go stale below.
      expect(result.stamps).toHaveLength(PASSES);
      expect(new Set(result.stamps).size).toBe(PASSES);
      for (const stamp of result.stamps) expect(stamp).toBeGreaterThan(0);
      // The test is only meaningful if far more than the stale window elapsed.
      expect(result.elapsedMs).toBeGreaterThan(PROCESS_STALE_AFTER_MS * 4);

      // Never faulted, never unwatched, never reported.
      for (const state of result.states) {
        expect(state.terminal).toBeNull();
        expect(state.watchers).toBe(1);
      }
      expect(result.injections).toEqual([]);
    });
  });

  describe("work ledger: the tick arms EXACTLY once, at the poll time", () => {
    /**
     * INVARIANT A — never overwrite an arm. `scheduleComputeEviction` is
     * cancel-then-SET on a single stored schedule id, NOT a min-fold, so a second
     * arm CANCELS the first. That silently stretched a 7s watcher poll to 21s.
     *
     * This is the invariant every unit test misses: re-adding an unconditional
     * `scheduleEviction` to the end of `runSandboxEviction` leaves the whole unit
     * suite green, and reds this test on the arm COUNT — two arms instead of one.
     * (Not on the time: with the `if (armed) return;` gate gone the fallback
     * still min-folds the WATCHER horizon, so the surviving arm lands at the
     * same 7s poll time. The count is the whole signal.)
     *
     * RED IF: a second arm point is added anywhere on the tick path, the fallback
     * stops being gated on `alarmArmCount()`, or `armAlarm` stops min-folding the
     * watcher poll against `getWorkHorizon`.
     */
    it("arms once at the watcher poll, not at the ledger's later horizon", async () => {
      const stub = stubFor(THREADS.oneArm);
      const result = await runInDurableObject(stub, async (instance: ThinkThreadAgent) => {
        const testInstance = instance as LedgerTestableAgent;
        await testInstance.__unsafe_ensureInitialized();
        const cleanup = primeCompute(instance, new FakeComputeBackend());
        const spy = spySchedule(instance);
        try {
          const { processId } = await startWatchedProcess(instance);
          // Spy AFTER exec so the exec path's own arm is not counted; make the
          // watcher due so the tick genuinely polls and re-arms.
          spy.calls.length = 0;
          vi.setSystemTime(Date.now() + DEFAULT_MONITOR_POLL_INTERVAL_MS);
          const tickAt = Date.now();

          await instance.runSandboxEviction();

          const row = ledgerOf(instance).get(processId);
          return {
            processId,
            tickAt,
            arms: evictionArms(spy.calls),
            allCalls: spy.calls.length,
            row: row ? { lastAliveAt: row.lastAliveAt, terminal: row.terminal } : null,
          };
        } finally {
          spy.restore();
          cleanup();
        }
      });

      // ANTI-VACUITY: the row is open, so it DOES contribute a horizon to the
      // min-fold — "armed at the poll time" is a real discrimination, not a
      // statement about a ledger with nothing in it.
      expect(result.row).not.toBeNull();
      expect(result.row?.terminal).toBeNull();
      expect(result.row?.lastAliveAt).toBe(result.tickAt);

      const pollAt = result.tickAt + DEFAULT_MONITOR_POLL_INTERVAL_MS;
      const ledgerHorizon = result.tickAt + PROCESS_STALE_AFTER_MS;
      // The two candidates are genuinely different times.
      expect(pollAt).toBeLessThan(ledgerHorizon);

      // EXACTLY one arm, at the NEARER of the two.
      expect(result.arms).toHaveLength(1);
      expect(result.arms[0]?.at).toBe(pollAt);
      expect(result.allCalls).toBe(1);
    });
  });

  describe("work ledger: a throwing tick must still leave an alarm armed", () => {
    /**
     * INVARIANT B — never strand open work. `runComputeTick`'s `quota.refresh()`
     * is an unguarded D1 write; if a throw there stranded the thread, nothing would
     * ever wake it, the open row would never be swept, and the model would never
     * learn its process exited. That is the original bug this project exists to
     * kill.
     *
     * The throw is injected on the real `ThreadComputeService.prototype`, so it
     * originates at the REAL call site inside the real `runSandboxEviction`, over
     * real host wiring and the real scheduler.
     *
     * RED IF: the fallback re-arm block is removed, is moved inside the tick's
     * try-block, or is gated on "the tick did not throw" instead of on the FACT
     * that `alarmArmCount()` did not move.
     */
    it("arms the fallback when runComputeTick throws", async () => {
      const stub = stubFor(THREADS.tickThrows);
      const tickSpy = vi.spyOn(ThreadComputeService.prototype, "runComputeTick");
      try {
        const result = await runInDurableObject(stub, async (instance: ThinkThreadAgent) => {
          const testInstance = instance as LedgerTestableAgent;
          await testInstance.__unsafe_ensureInitialized();
          const cleanup = primeCompute(instance, new FakeComputeBackend());
          const spy = spySchedule(instance);
          try {
            const { processId } = await startWatchedProcess(instance);
            const startedAt = Date.now();
            spy.calls.length = 0;
            // Only now — the exec path above needs a working tick-free service.
            tickSpy.mockRejectedValue(new Error("quota refresh failed"));

            // Must NOT throw: the alarm callback swallows and logs.
            await expect(instance.runSandboxEviction()).resolves.toBeUndefined();

            const row = ledgerOf(instance).get(processId);
            return {
              startedAt,
              tickAttempts: tickSpy.mock.calls.length,
              arms: evictionArms(spy.calls),
              row: row ? { terminal: row.terminal } : null,
            };
          } finally {
            spy.restore();
            cleanup();
          }
        });

        // ANTI-VACUITY: the tick was really reached and really threw. Without this,
        // "an alarm was armed" could just be the ordinary happy path.
        expect(result.tickAttempts).toBeGreaterThan(0);
        // The row is still open — nothing closed it, so it MUST still be woken for.
        expect(result.row?.terminal).toBeNull();

        // The fallback armed, exactly once. The watcher's poll (still ahead of now)
        // is nearer than the ledger's 21s horizon, so it wins the fold.
        expect(result.arms).toHaveLength(1);
        expect(result.arms[0]?.at).toBe(result.startedAt + DEFAULT_MONITOR_POLL_INTERVAL_MS);
      } finally {
        tickSpy.mockRestore();
      }
    });
  });

  describe("work ledger: compute disabled still arms at the ledger horizon", () => {
    /**
     * The `!resolved` branch. With compute disabled `resolveComputeService` returns
     * null, so the tick never runs and never arms — but the ledger OUTLIVES the
     * compute service by design, and an open row still has to be swept. There is no
     * watcher store to read, so the ledger's own horizon is the whole fold.
     *
     * RED IF: the fallback is skipped when `resolved` is null, the work horizon
     * stops being computed from `nextSweepAt(listOpen())`, or the ledger sweep is
     * made conditional on a live compute service.
     */
    it("arms once at nextSweepAt when the compute service never resolves", async () => {
      const stub = stubFor(THREADS.disabled);
      const result = await runInDurableObject(stub, async (instance: ThinkThreadAgent) => {
        const testInstance = instance as LedgerTestableAgent;
        await testInstance.__unsafe_ensureInitialized();
        const spy = spySchedule(instance);
        try {
          const resolved = await testInstance.resolveComputeServiceForTest();

          const processId = "proc_disabled_1";
          ledgerOf(instance).register({
            id: processId,
            kind: "process",
            startedAt: Date.now(),
            lastAliveAt: Date.now(),
            staleAfterMs: PROCESS_STALE_AFTER_MS,
            deadlineAt: Date.now() + 600_000,
            generation: "gen-before-disable",
            terminal: null,
            deliveredAt: null,
          });
          const horizon = Date.now() + PROCESS_STALE_AFTER_MS;
          spy.calls.length = 0;

          await instance.runSandboxEviction();

          const row = ledgerOf(instance).get(processId);
          return {
            resolvedIsNull: resolved === null,
            horizon,
            arms: evictionArms(spy.calls),
            row: row ? { terminal: row.terminal } : null,
          };
        } finally {
          spy.restore();
        }
      });

      // ANTI-VACUITY: compute really is unresolved (this is the `!resolved` branch,
      // not the ordinary armed path), and the row really is still open — a closed
      // row would contribute no horizon and arming nothing would be correct.
      expect(result.resolvedIsNull).toBe(true);
      expect(result.row?.terminal).toBeNull();

      // Exactly one arm, at the ledger's horizon: with no compute service there is
      // no watcher horizon to fold against.
      expect(result.arms).toHaveLength(1);
      expect(result.arms[0]?.at).toBe(result.horizon);
    });
  });

  describe("work ledger: the sweep makes no backend call", () => {
    /**
     * THE invariant, pinned end to end over a real DO rather than at one
     * function: a backend call reachable from the reaper's CLASSIFICATION path
     * can block on a dead sandbox and wedge the whole Durable Object
     * (`blockConcurrencyWhile() waited for too long; the Durable Object was
     * reset`) — the production incident this whole design exists to fix.
     *
     * Scope is deliberately the WHOLE sweep, not `getGenerationView` alone
     * (`watcher-fault.test.ts` has that one). `runWorkLedgerSweep` awaits
     * `ensureLegacySubagentBackfill()`, so `backfillLegacySubagentRuns` — the
     * FOURTH `workLedger.register(` site, and the only one that must NOT probe
     * the generation — is inside this assertion. Its no-probe constraint was
     * previously guarded by a comment only; a dispatch has already asked an
     * implementer to "probe at the registration sites", which would wedge the DO
     * in production while the whole unit suite stayed green.
     *
     * RED IF: anything reachable from `runWorkLedgerSweep`, `getCurrentGeneration`,
     * `hasBlockingWork`, or `backfillLegacySubagentRuns` calls the backend — a
     * `refreshGeneration()` added at site 4 included.
     */
    it("classifies and backfills under a LIVE container without touching the backend", async () => {
      const stub = stubFor(THREADS.sweepBackendFree);
      const result = await runInDurableObject(stub, async (instance: ThinkThreadAgent, state) => {
        const testInstance = instance as LedgerTestableAgent;
        await testInstance.__unsafe_ensureInitialized();
        const backend = new FakeComputeBackend();
        const cleanup = primeCompute(instance, backend);
        try {
          // Provision for real, BEFORE the tripwire arms. This is what makes the
          // test non-vacuous: `refreshGeneration` early-returns unless the store
          // says `active` with a `runtimeRef`, so without a live container a probe
          // smuggled into the sweep would make no call and the tripwire could
          // never fire. Now it would.
          const { processId, generation } = await startWatchedProcess(instance);

          // The legacy keys, so `backfillLegacySubagentRuns` genuinely engages on
          // this sweep instead of taking its `runIds.length === 0` exit.
          const legacyRunId = "sub_legacy_backend_free";
          await state.storage.put(LEGACY_SUBAGENT_LEASE_KEY, [legacyRunId]);
          await state.storage.put(LEGACY_SUBAGENT_TIMING_KEY, {
            [legacyRunId]: { startedAt: Date.now() },
          });

          const stateBefore = new ThreadComputeStore(state.storage).getComputeState();
          const calls = tripwireBackend(backend);
          const sweep = await instance.runWorkLedgerSweep();
          const sweepCalls = [...calls];

          // ANTI-VACUITY, the positive control: the tripwire is ARMED and this
          // very instance can reach it. `refreshGeneration()` is the registration
          // probe — the exact call site 4 would gain — and it fires here. So the
          // empty list above is the sweep genuinely not probing, not a recorder
          // that was never wired up.
          await (await testInstance.resolveComputeServiceForTest())?.service.refreshGeneration();

          return {
            processId,
            generation,
            legacyRunId,
            statusBefore: stateBefore?.status,
            hasRuntimeRefBefore: stateBefore?.runtimeRef != null,
            generationBefore: stateBefore?.generation,
            sweep,
            rows: ledgerOf(instance)
              .listAll()
              .map((row) => ({ id: row.id, kind: row.kind, generation: row.generation })),
            openIds: ledgerOf(instance)
              .listOpen()
              .map((row) => row.id),
            leaseAfter: await state.storage.get(LEGACY_SUBAGENT_LEASE_KEY),
            sweepCalls,
            probeCalls: calls,
          };
        } finally {
          cleanup();
        }
      });

      // ANTI-VACUITY 1: the container really was live and really did carry a known
      // nonce when the sweep ran — the state in which a probe WOULD call out.
      expect(result.statusBefore).toBe("active");
      expect(result.hasRuntimeRefBefore).toBe(true);
      expect(result.generationBefore).toBe(result.generation);

      // THE ASSERTION. Asserted directly after the precondition above and before
      // the rest, so a refactor that reintroduces a probe fails on THIS line with
      // the method it called, rather than on a downstream symptom.
      expect(result.sweepCalls).toEqual([]);

      // ANTI-VACUITY 2: the backfill actually ran and actually registered — so
      // "no backend calls" cannot be satisfied by "nothing happened". The row is
      // stamped with the live nonce, which is `getCurrentGeneration()` (the store
      // read at site 4) having returned `known`, and the lease key is consumed.
      expect(result.rows).toEqual(
        expect.arrayContaining([
          { id: result.legacyRunId, kind: "subagent", generation: result.generation },
          { id: result.processId, kind: "process", generation: result.generation },
        ]),
      );
      expect(result.leaseAfter).toBeUndefined();

      // ANTI-VACUITY 3: the classification pass really had rows to walk, and both
      // survived it — the sweep ran to completion rather than throwing early.
      expect(result.openIds).toEqual(
        expect.arrayContaining([result.legacyRunId, result.processId]),
      );
      expect(result.sweep.terminalized).toEqual([]);

      // The positive control fired.
      expect(result.probeCalls).toContain("listDirectory");
    });
  });
});
