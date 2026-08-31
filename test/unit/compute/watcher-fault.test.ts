import { describe, expect, it } from "vitest";
import { FakeComputeBackend } from "../../../src/compute/backends/fake";
import { DEFAULT_COMPUTE_LIMITS } from "../../../src/compute/config";
import { ComputeError } from "../../../src/compute/errors";
import { GENERATION_PATH } from "../../../src/compute/generation";
import { ThreadComputeService } from "../../../src/compute/thread-service";
import type { ThreadComputeStoreLike } from "../../../src/compute/thread-service";
import type { EffectiveComputeConfig } from "../../../src/compute/types";
import { WATCH_ABSOLUTE_TIMEOUT_MS } from "../../../src/compute/watchers";
import {
  PROCESS_STALE_AFTER_MS,
  UNKNOWN_GENERATION,
  classifyWork,
  nextSweepAt,
  type WorkRow,
  type WorkTerminal,
} from "../../../src/agent/work-ledger";
import type {
  BackendProcessReference,
  BackendReference,
  ProcessStatus,
  StopMode,
} from "../../../src/compute/backend";
import { createMemoryComputeStore } from "./helpers/memory-store";

const CONFIG: EffectiveComputeConfig = {
  provider: "fake",
  providerConfig: { kind: "cloudflare" },
  resourceProfile: "small",
  idleTimeoutMs: 1_000,
  recoveryTtlMs: 5_000,
  maxProcessRuntimeMs: 10_000,
  monitorPollIntervalMs: 100,
  limits: DEFAULT_COMPUTE_LIMITS,
  allowedHosts: null,
  editableEnv: {},
  agentEditableEnv: {},
  secretEnvNames: [],
  environmentEditableEnv: {},
  environmentSecretEnvNames: [],
};

function createLedgerSpy() {
  const rows = new Map<string, WorkRow>();
  const stamps: Array<{ id: string; at: number }> = [];
  const terminalized: string[] = [];
  return {
    rows,
    stamps,
    terminalized,
    sink: {
      register: async (row: WorkRow) => void rows.set(row.id, row),
      stampAlive: async (id: string, at: number) => void stamps.push({ id, at }),
      // Mirrors WorkLedgerStore.terminalize's exactly-once gate: only the
      // transition that actually closed an open row returns true.
      terminalize: async (id: string, terminal: WorkTerminal) => {
        const row = rows.get(id);
        if (!row || row.terminal) return false;
        rows.set(id, { ...row, terminal });
        terminalized.push(id);
        return true;
      },
      // Mirrors WorkLedgerStore.markDelivered: only a TERMINAL row that has not
      // already discharged its notification obligation can claim the gate.
      markDelivered: async (id: string, at: number) => {
        const row = rows.get(id);
        if (!row?.terminal || row.deliveredAt !== null) return false;
        rows.set(id, { ...row, deliveredAt: at });
        return true;
      },
      // Mirrors WorkLedgerStore.isDelivered: "has the model already been told",
      // read straight off the gate — an unknown row was never told.
      isDelivered: async (id: string) => rows.get(id)?.deliveredAt != null,
      deleteRow: async (id: string) => void rows.delete(id),
    },
  };
}

/**
 * A `ThreadComputeService` bound to a SHARED store but otherwise fresh —
 * standing in for what `resolveComputeService(...)` actually does: construct
 * a brand-new service instance on every call, backed by the same durable
 * store. Used to prove the nonce survives (and is not re-written) across
 * instances, since it is persisted per-container, not per-instance.
 */
function makeServiceOnSharedStore(input: {
  backend: FakeComputeBackend;
  store: ThreadComputeStoreLike;
  now: { value: number };
  attachedRuntime?: BackendReference;
  workLedger?: ReturnType<typeof createLedgerSpy>["sink"];
}): ThreadComputeService {
  return new ThreadComputeService({
    backend: input.backend,
    store: input.store,
    config: CONFIG,
    ...(input.workLedger ? { workLedger: input.workLedger } : {}),
    environmentId: "thread_test",
    env: {},
    setAlarm: async () => {},
    now: () => input.now.value,
    supportsProcessMonitor: true,
    ...(input.attachedRuntime ? { attachedRuntime: input.attachedRuntime } : {}),
  });
}

const generationWrites = (backend: FakeComputeBackend) =>
  backend.writeFileCalls.filter((call) => call.path === GENERATION_PATH).length;

function createService(input: {
  backend: FakeComputeBackend;
  now: { value: number };
  /** Wire the ledger horizon in, exactly as ThinkThreadAgent.sandboxHostDeps does. */
  foldWorkHorizon?: boolean;
  deliverSystemReminder?: (body: string, mode: "proactive" | "deferred") => Promise<void>;
}) {
  const ledger = createLedgerSpy();
  const alarms: number[] = [];
  const service = new ThreadComputeService({
    backend: input.backend,
    store: createMemoryComputeStore(),
    config: CONFIG,
    environmentId: "thread_test",
    env: {},
    setAlarm: async (timestamp) => void alarms.push(timestamp),
    now: () => input.now.value,
    supportsProcessMonitor: true,
    workLedger: ledger.sink,
    ...(input.deliverSystemReminder ? { deliverSystemReminder: input.deliverSystemReminder } : {}),
    // The agent supplies `nextSweepAt(workLedger.listOpen())`; mirror that over
    // the spy's rows so the fold is exercised against real horizons.
    ...(input.foldWorkHorizon
      ? { getWorkHorizon: async () => nextSweepAt([...ledger.rows.values()]) }
      : {}),
  });
  return { service, ledger, alarms };
}

describe("watcher liveness stamping", () => {
  it("stamps liveness on a successful poll", async () => {
    const backend = new FakeComputeBackend();
    const now = { value: 1_000 };
    const { service, ledger } = createService({ backend, now });

    const started = await service.execStart({ command: "sleep 60", label: "long" });
    await service.execWatch({ processId: started.processId });
    now.value = 2_000;
    await service.runComputeTick();

    expect(ledger.stamps.some((s) => s.id === started.processId && s.at === 2_000)).toBe(true);
  });

  it("does NOT stamp liveness when the poll throws process_missing", async () => {
    const backend = new FakeComputeBackend();
    const now = { value: 1_000 };
    const { service, ledger } = createService({ backend, now });

    const started = await service.execStart({ command: "sleep 60", label: "long" });
    await service.execWatch({ processId: started.processId });
    // The sandbox reset: the container came back empty, so the process record
    // is gone and every subsequent status read throws.
    backend.getProcessStatus = async () => {
      throw new ComputeError("process_missing", "cloudflare_process_not_found");
    };

    now.value = 2_000;
    await service.runComputeTick();
    now.value = 3_000;
    await service.runComputeTick();

    expect(ledger.stamps.filter((s) => s.id === started.processId && s.at >= 2_000)).toEqual([]);
  });

  it("registers a ledger row when a watcher is attached", async () => {
    const backend = new FakeComputeBackend();
    const now = { value: 1_000 };
    const { service, ledger } = createService({ backend, now });

    const started = await service.execStart({ command: "sleep 60", label: "long" });
    await service.execWatch({ processId: started.processId });

    const row = ledger.rows.get(started.processId);
    expect(row?.kind).toBe("process");
    expect(row?.terminal).toBeNull();
  });

  it("observes the container's ACTUAL nonce after a reset, not the one we wrote", async () => {
    const backend = new FakeComputeBackend();
    const now = { value: 1_000 };
    const { service } = createService({ backend, now });

    const started = await service.execStart({ command: "sleep 60", label: "long" });
    await service.execWatch({ processId: started.processId });
    const written = await service.getGeneration();
    expect(written).not.toBeNull();

    // The container OOM'd and came back fresh: same id, empty filesystem, so
    // the process record is gone and the nonce file no longer exists.
    backend.getProcessStatus = async () => {
      throw new ComputeError("process_missing", "cloudflare_process_not_found");
    };
    backend.readFile = async () => {
      throw new ComputeError("provider_transient", "fake_file_not_found");
    };

    now.value = 2_000;
    await service.runComputeTick();

    // If this still returns the written nonce, the reaper compares a value
    // against itself and sandbox_reset can never fire.
    expect(await service.getGeneration()).toBeNull();
  });

  it("a poll that throws never escapes runComputeTick", async () => {
    const backend = new FakeComputeBackend();
    const now = { value: 1_000 };
    const { service } = createService({ backend, now });

    const started = await service.execStart({ command: "sleep 60", label: "long" });
    await service.execWatch({ processId: started.processId });
    backend.getProcessStatus = async () => {
      throw new Error("container is gone");
    };

    now.value = 2_000;
    await expect(service.runComputeTick()).resolves.not.toThrow();
  });
});

/**
 * The reaper must only ever see work that is genuinely still open. Settled work
 * is closed by the compute layer at the moment it settles, because `pollWatcher`
 * deletes the watcher and stops stamping: a row left open there goes silent and
 * is reaped ~21s later as a `no_liveness` fault. That would (a) dominate the
 * dark ship's telemetry with false faults for healthy work — measuring the
 * opposite of what it exists to measure — and (b) burn the exactly-once gate, so
 * a clean exit gets reported to the model as "no liveness signal; torn down".
 */
describe("settled work closes its own ledger row (I-1)", () => {
  /** Stand in for the reaper: the pure classification it performs on a row. */
  const reap = (row: WorkRow, now: number) =>
    classifyWork({ row, currentGeneration: { kind: "unknown" }, now });

  it("a cleanly exited process closes as exited/process_exit, and the reaper never re-faults it", async () => {
    const backend = new FakeComputeBackend();
    const now = { value: 1_000 };
    const { service, ledger } = createService({ backend, now });

    const started = await service.execStart({ command: "sleep 300", label: "build" });
    const watched = await service.execWatch({ processId: started.processId });
    expect(watched.watching).toBe(true);

    const listed = await service.execList({ status: "all", limit: 10 });
    const ref = listed.processes.find((p) => p.id === started.processId)?.backendProcessRef;
    if (!ref) throw new Error("expected a backend process reference");
    backend.finishProcess(ref, "exited", 0);

    now.value += CONFIG.monitorPollIntervalMs;
    await service.runComputeTick();

    const row = ledger.rows.get(started.processId);
    expect(row?.terminal).toEqual({
      outcome: "exited",
      reason: "process_exit",
      at: now.value,
      detail: "process exited",
      exitCode: 0,
    });

    // Now let the stale threshold pass with no further stamps — precisely the
    // window in which the reaper used to fault this healthy, finished process.
    const later = now.value + PROCESS_STALE_AFTER_MS + 1_000;
    expect(reap(row as WorkRow, later).state).toBe("alive");
    // And the exactly-once gate is spent by the EXIT, not by the reaper: a
    // later terminalize (Task 6's delivery trigger) must not fire.
    expect(
      await ledger.sink.terminalize(started.processId, {
        outcome: "fault",
        reason: "no_liveness",
        at: later,
        detail: "reaper",
      }),
    ).toBe(false);
    expect(ledger.rows.get(started.processId)?.terminal?.outcome).toBe("exited");
  });

  it("closes the row even when DELIVERY throws (the terminal is written first)", async () => {
    const backend = new FakeComputeBackend();
    const now = { value: 1_000 };
    const { service, ledger } = createService({
      backend,
      now,
      deliverSystemReminder: async () => {
        throw new Error("injection buffer write failed");
      },
    });

    const started = await service.execStart({ command: "sleep 300", label: "build" });
    await service.execWatch({ processId: started.processId });
    const listed = await service.execList({ status: "all", limit: 10 });
    const ref = listed.processes.find((p) => p.id === started.processId)?.backendProcessRef;
    if (!ref) throw new Error("expected a backend process reference");
    backend.finishProcess(ref, "exited", 0);

    now.value += CONFIG.monitorPollIntervalMs;
    await service.runComputeTick();

    // The funnel is: write the terminal, THEN deliver, THEN tear down. Teardown
    // or delivery failure cannot suppress the terminal, because the terminal is
    // already written. Behind the delivery this row stayed open and the reaper
    // reaped a cleanly exited process as a `no_liveness` fault ~21s later.
    expect(ledger.rows.get(started.processId)?.terminal).toMatchObject({
      outcome: "exited",
      reason: "process_exit",
    });
    expect(reap(ledger.rows.get(started.processId) as WorkRow, now.value + 60_000).state).toBe(
      "alive",
    );
  });

  it("a stopped process closes its row as STOPPED, not as a clean exit", async () => {
    const backend = new FakeComputeBackend();
    const now = { value: 1_000 };
    const { service, ledger } = createService({ backend, now });

    const started = await service.execStart({ command: "sleep 300", label: "long" });
    await service.execWatch({ processId: started.processId });

    // What a turn cancel does: stopAllRunningProcesses funnels every running
    // process through execStop.
    now.value += 500;
    await service.stopAllRunningProcesses();

    // Enum honesty. Once terminals are DELIVERED, the outcome is what the model
    // is told, and "exited" for a process someone killed is a lie the model
    // would act on (it would read a partial output tail as the whole result).
    const row = ledger.rows.get(started.processId);
    expect(row?.terminal?.outcome).toBe("stopped");
    expect(row?.terminal?.reason).toBe("process_stopped");
    // Still a terminal, so the reaper leaves it alone either way.
    expect(reap(row as WorkRow, now.value + PROCESS_STALE_AFTER_MS + 1_000).state).toBe("alive");
  });

  /**
   * `execUnwatch` is the model saying "stop telling me about this". There is no
   * honest terminal to write — the process was not stopped, did not exit, and
   * did not fault — so the row is DELETED. Leaving it open faults it as
   * `no_liveness` ~21s later (nothing stamps an unwatched process), which with
   * enforcement on reports "torn down" for a process the model deliberately
   * walked away from and that is very likely still running.
   */
  it("execUnwatch deletes the row: no terminal, nothing to deliver", async () => {
    const backend = new FakeComputeBackend();
    const now = { value: 1_000 };
    const { service, ledger } = createService({ backend, now });

    const started = await service.execStart({ command: "sleep 300", label: "long" });
    await service.execWatch({ processId: started.processId });
    expect(ledger.rows.has(started.processId)).toBe(true);

    now.value += 500;
    const result = await service.execUnwatch({ processId: started.processId });
    expect(result.unwatched).toBe(true);

    // Gone, not closed: a terminal here would be delivered, and there is
    // nothing truthful to say.
    expect(ledger.rows.has(started.processId)).toBe(false);
    expect(ledger.terminalized).toEqual([]);
  });

  it("leaves a still-running watched process's row OPEN (only settled work closes)", async () => {
    const backend = new FakeComputeBackend();
    const now = { value: 1_000 };
    const { service, ledger } = createService({ backend, now });

    const started = await service.execStart({ command: "sleep 300", label: "long" });
    await service.execWatch({ processId: started.processId });
    now.value += CONFIG.monitorPollIntervalMs;
    await service.runComputeTick();

    // Still running: the row must stay open (and stamped) so the reaper retains
    // its power to fault it if the sandbox really does die.
    expect(ledger.rows.get(started.processId)?.terminal).toBeNull();
  });
});

/**
 * C-1: the reaper piggybacks the sandbox's SINGLE alarm. A Durable Object has
 * exactly one, and `setAlarm` SETS it, so anything arming its own alarm for the
 * ledger horizon does not add a wake — it REPLACES the watcher poll.
 * Since a healthy poll stamps liveness immediately before the horizon is
 * computed, that horizon is always LATER (stamp + 21s vs stamp + 7s), so a
 * separate arm could only ever delay the poll — tripling completion latency.
 */
describe("the ledger horizon is min-folded into the single alarm (C-1)", () => {
  it("never delays a due watcher's poll: the alarm is the next poll, not the ledger horizon", async () => {
    const backend = new FakeComputeBackend();
    const now = { value: 1_000 };
    const { service, alarms } = createService({ backend, now, foldWorkHorizon: true });

    const started = await service.execStart({ command: "sleep 300", label: "long" });
    await service.execWatch({ processId: started.processId });

    now.value += CONFIG.monitorPollIntervalMs;
    alarms.length = 0;
    await service.runComputeTick();

    // The poll just stamped the row, so the horizon sits at now + 21s while the
    // next poll is due at now + 100ms (this config's interval). The alarm must
    // be the poll.
    expect(alarms.at(-1)).toBe(now.value + CONFIG.monitorPollIntervalMs);
    expect(alarms.at(-1)).not.toBe(now.value + PROCESS_STALE_AFTER_MS);
  });

  it("uses the ledger horizon when it falls EARLIER than the next watcher poll", async () => {
    const backend = new FakeComputeBackend();
    const now = { value: 1_000 };
    const { service, ledger, alarms } = createService({ backend, now, foldWorkHorizon: true });

    const started = await service.execStart({ command: "sleep 300", label: "long" });
    await service.execWatch({ processId: started.processId });

    // A row that will go stale BEFORE the next poll is due — e.g. a subagent
    // row, whose horizon is not tied to the watcher cadence at all. The reaper
    // must get its wake, or the fold is a one-way ratchet that silently drops it.
    const row = ledger.rows.get(started.processId) as WorkRow;
    ledger.rows.set(started.processId, { ...row, deadlineAt: now.value + 10 });

    // The watcher is NOT due yet (next poll is now + 100ms), so this tick only
    // re-arms — it neither polls nor re-registers the row.
    alarms.length = 0;
    await service.runComputeTick();

    expect(alarms.at(-1)).toBe(now.value + 10);
  });
});

describe("sandbox generation nonce persistence (per-container, not per-instance)", () => {
  it("a second service instance over a LIVE container writes nothing (the nonce is per-container, written only at provision)", async () => {
    const backend = new FakeComputeBackend();
    const store = createMemoryComputeStore();
    const now = { value: 1_000 };

    const serviceA = makeServiceOnSharedStore({ backend, store, now });
    await serviceA.execStart({ command: "pwd" });
    const written = await serviceA.getGeneration();
    expect(written).not.toBeNull();
    expect(generationWrites(backend)).toBe(1);

    // A BRAND-NEW service instance touching the same still-active container —
    // exactly what `resolveComputeService(...)` constructs on every call. It
    // never re-provisions, so it must never write: a write here would clobber
    // a perfectly healthy nonce and mismatch every ledger row already
    // registered against the old one (a false sandbox_reset fault).
    const serviceB = makeServiceOnSharedStore({ backend, store, now });
    await serviceB.execStart({ command: "pwd" });

    expect(await serviceB.getGeneration()).toBe(written);
    expect(generationWrites(backend)).toBe(1);
  });

  it("REGRESSION (C1): a recovery RESTORE writes a FRESH nonce and never reuses the pre-release one", async () => {
    const backend = new FakeComputeBackend();
    const store = createMemoryComputeStore();
    const now = { value: 1_000 };

    // `releaseIfReclaimable` ALWAYS takes the recoverable path (never a
    // discard — a reclaim is not the thread's own decision), so `generation`
    // survives active→releasing→recoverable untouched.
    const serviceA = makeServiceOnSharedStore({ backend, store, now });
    await serviceA.execStart({ command: "pwd" });
    const preRelease = await serviceA.getGeneration();
    expect(preRelease).not.toBeNull();
    expect(generationWrites(backend)).toBe(1);

    now.value += 10 * 60_000;
    expect(await serviceA.releaseIfReclaimable()).toBe(true);
    expect(store.getComputeState()?.status).toBe("recoverable");
    // The nonce is deliberately still persisted here: nothing on the recovery
    // path clears it (no markAcquiring), which is exactly the trap.
    expect(store.getComputeState()?.generation).toBe(preRelease);

    // Restore. On Cloudflare this is a genuinely NEW container: release()
    // backed up /workspace and then DESTROYED the sandbox, so /tmp — and the
    // nonce in it — is gone. If the restored container adopts `preRelease`
    // instead of writing a fresh nonce, the store agrees with every stale
    // ledger row and sandbox_reset can never fire.
    const serviceB = makeServiceOnSharedStore({ backend, store, now });
    await serviceB.execStart({ command: "pwd" });
    expect(backend.acquireCalls.at(-1)?.recovery).toBeDefined();

    expect(generationWrites(backend)).toBe(2);
    expect(await serviceB.getGeneration()).not.toBeNull();
    expect(await serviceB.getGeneration()).not.toBe(preRelease);
    expect(store.getComputeState()?.generation).toBe(await serviceB.getGeneration());
  });

  it("REGRESSION (C2): a transient probe failure never licenses a nonce overwrite on a live container", async () => {
    const backend = new FakeComputeBackend();
    const store = createMemoryComputeStore();
    const now = { value: 1_000 };

    const serviceA = makeServiceOnSharedStore({ backend, store, now });
    const started = await serviceA.execStart({ command: "sleep 60", label: "long" });
    await serviceA.execWatch({ processId: started.processId });
    expect(generationWrites(backend)).toBe(1);

    // The container is FINE; the poll and the nonce read both blip once. The
    // probe honestly persists what it saw — null, meaning "unknown".
    const realStatus = backend.getProcessStatus.bind(backend);
    const realRead = backend.readFile.bind(backend);
    backend.getProcessStatus = async () => {
      throw new ComputeError("provider_transient", "fake_blip");
    };
    backend.readFile = async () => {
      throw new ComputeError("provider_transient", "fake_blip");
    };
    now.value = 2_000;
    await serviceA.runComputeTick();
    expect(store.getComputeState()?.generation).toBeNull();
    // And it must not be recorded as an ABSENCE either: the nonce is right
    // there, the read merely failed. Calling that a reset tells the model its
    // work is lost when it is not — strictly worse than saying nothing.
    expect(store.getComputeState()?.generationAbsentAt).toBeNull();
    expect(await serviceA.getGenerationView()).toEqual({ kind: "unknown" });

    // The blip passes. A later service instance must NOT read that persisted
    // null as "this container has no nonce, write one" — the container is
    // live and every open ledger row still carries the original nonce, so a
    // write here mass-faults all of them with a bogus sandbox_reset.
    backend.getProcessStatus = realStatus;
    backend.readFile = realRead;
    const serviceB = makeServiceOnSharedStore({ backend, store, now });
    await serviceB.execStart({ command: "pwd" });

    expect(generationWrites(backend)).toBe(1);
  });

  it("REGRESSION (I4): an ATTACHED runtime never writes a nonce into the container it attached to", async () => {
    const backend = new FakeComputeBackend();
    const parentStore = createMemoryComputeStore();
    const now = { value: 1_000 };

    const parent = makeServiceOnSharedStore({ backend, store: parentStore, now });
    await parent.execStart({ command: "pwd" });
    const parentNonce = await parent.getGeneration();
    expect(generationWrites(backend)).toBe(1);
    const attachedRuntime = parentStore.getComputeState()?.runtimeRef;
    expect(attachedRuntime).toBeDefined();

    // An attached SubAgent has its OWN store (so its own `generation` is null)
    // but SHARES the parent's container. It never provisions, so it must never
    // write — a second nonce here would land in the parent's live container and
    // fault every row the parent registered.
    const subagent = makeServiceOnSharedStore({
      backend,
      store: createMemoryComputeStore(),
      now,
      ...(attachedRuntime ? { attachedRuntime } : {}),
    });
    await subagent.execStart({ command: "pwd" });

    expect(generationWrites(backend)).toBe(1);
    expect(parentStore.getComputeState()?.generation).toBe(parentNonce);
  });

  it("a probe's observed generation is visible to a DIFFERENT service instance (the reaper's own resolve)", async () => {
    const backend = new FakeComputeBackend();
    const store = createMemoryComputeStore();
    const now = { value: 1_000 };

    const serviceA = makeServiceOnSharedStore({ backend, store, now });
    const started = await serviceA.execStart({ command: "sleep 60", label: "long" });
    await serviceA.execWatch({ processId: started.processId });
    const written = await serviceA.getGeneration();
    expect(written).not.toBeNull();

    // Stand in for the reaper: a completely separate service instance,
    // resolved independently, must see the SAME persisted nonce. Before the
    // fix this always read null on any instance other than the one that
    // wrote it, which is exactly why `ThinkThreadAgent.getCurrentGeneration()`
    // (which resolves a fresh service every call) never saw a value and the
    // sandbox_reset branch of `classifyWork` was dead code in production.
    const serviceB = makeServiceOnSharedStore({ backend, store, now });
    expect(await serviceB.getGeneration()).not.toBeNull();
    expect(await serviceB.getGeneration()).toBe(written);
  });

  // The 2026-07-16 live finding: after a destroy/OOM Cloudflare silently hands
  // back a WORKING container on the same sandbox id. Nothing throws
  // SandboxNotFound, so the DO never re-provisions and the nonce never diverges
  // — a live container whose nonce file is GONE is the only evidence left, and
  // it has to be enough or sandbox_reset is unreachable in production.
  it("the poll-failure probe RESTORES the nonce so a DIFFERENT instance can classify the reset", async () => {
    const backend = new FakeComputeBackend();
    const store = createMemoryComputeStore();
    const now = { value: 1_000 };
    const ledger = createLedgerSpy();

    const serviceA = makeServiceOnSharedStore({ backend, store, now, workLedger: ledger.sink });
    const started = await serviceA.execStart({ command: "sleep 60", label: "long" });
    await serviceA.execWatch({ processId: started.processId });
    const preWipeNonce = await serviceA.getGeneration();
    expect(ledger.rows.get(started.processId)?.generation).toBe(preWipeNonce);
    expect(generationWrites(backend)).toBe(1);

    // The container is reset under us: its filesystem is wiped but it still
    // ANSWERS. The old process is gone, so the watcher's poll fails.
    const runtime = store.getComputeState()?.runtimeRef;
    expect(runtime).toBeDefined();
    if (runtime) await backend.deletePath(runtime, GENERATION_PATH);
    backend.getProcessStatus = async () => {
      throw new ComputeError("provider_transient", "process is gone");
    };

    now.value = 2_000;
    await serviceA.runComputeTick();

    // The probe found the container answering with its nonce GONE — positive
    // evidence — and restored the invariant that a live container carries one.
    // NO re-provision: Cloudflare handed the same working container back.
    const serviceB = makeServiceOnSharedStore({ backend, store, now });
    const view = await serviceB.getGenerationView();
    expect(view.kind).toBe("known");
    expect(view.kind === "known" && view.nonce).not.toBe(preWipeNonce);
    expect(generationWrites(backend)).toBe(2);
    expect(backend.acquireCalls).toHaveLength(1);

    // Stand in for the reaper: the pre-wipe row's nonce no longer matches, so
    // it is still classified as the reset it is — the live-verified path.
    const openRow = ledger.rows.get(started.processId);
    expect(openRow?.terminal).toBeNull();
    expect(classifyWork({ row: openRow!, currentGeneration: view, now: 2_100 })).toEqual({
      state: "fault",
      outcome: "fault",
      reason: "sandbox_reset",
    });
  });

  /**
   * THE SEAM (composition of two individually-correct rules). Task 5 wrote the
   * nonce only at genuine provision; Task 9b made absent-but-answered the reset
   * evidence. Together, on the live-established premise that Cloudflare hands
   * back a WORKING container on the same sandbox id after a wipe — so
   * `readOrAcquireRuntime` early-returns on `status === "active"` and never
   * re-provisions — the container stayed nonce-less FOREVER. Every later
   * non-wipe poll failure re-probed, re-stamped `observedAt = now`, and the
   * absent arm (`startedAt < observedAt`, which never looks at `row.generation`)
   * then told healthy post-wipe work its filesystem was empty.
   *
   * This is the flagship incident's own profile: an OOM-prone container OOMing
   * twice. The second OOM must not be reported as a reset of work it did not
   * touch.
   */
  it("SEAM: work started after a wipe is NOT reported as reset by a later non-wipe poll failure", async () => {
    const backend = new FakeComputeBackend();
    const store = createMemoryComputeStore();
    const now = { value: 1_000 };
    const ledger = createLedgerSpy();

    const serviceA = makeServiceOnSharedStore({ backend, store, now, workLedger: ledger.sink });
    const doomed = await serviceA.execStart({ command: "sleep 60", label: "pre-wipe" });
    await serviceA.execWatch({ processId: doomed.processId });

    // T: a REAL wipe. The container answers; its filesystem is empty.
    const runtime = store.getComputeState()?.runtimeRef;
    if (runtime) await backend.deletePath(runtime, GENERATION_PATH);
    const originalStatus = backend.getProcessStatus.bind(backend);
    backend.getProcessStatus = async () => {
      throw new ComputeError("provider_transient", "process is gone");
    };
    now.value = 2_000;
    await serviceA.runComputeTick();

    // The pre-wipe row is correctly faulted; the model is told to redo the work.
    expect(
      classifyWork({
        row: ledger.rows.get(doomed.processId)!,
        currentGeneration: await serviceA.getGenerationView(),
        now: 2_100,
      }),
    ).toEqual({ state: "fault", outcome: "fault", reason: "sandbox_reset" });

    // T+60: the model redoes the work on the same healthy, post-wipe container.
    backend.getProcessStatus = originalStatus;
    now.value = 3_000;
    const redone = await serviceA.execStart({ command: "sleep 60", label: "post-wipe" });
    await serviceA.execWatch({ processId: redone.processId });

    // T+300: ANY later non-wipe poll failure — a second OOM killing only this
    // process, a transient blip. The nonce is still whatever the container has.
    backend.getProcessStatus = async () => {
      throw new ComputeError("provider_transient", "process is gone");
    };
    now.value = 9_000;
    await serviceA.runComputeTick();

    // The post-wipe filesystem is INTACT. Telling this row its files are gone
    // is the false fault the design calls worse than the hang it replaces.
    const serviceB = makeServiceOnSharedStore({ backend, store, now });
    const classified = classifyWork({
      row: ledger.rows.get(redone.processId)!,
      currentGeneration: await serviceB.getGenerationView(),
      now: 9_100,
    });
    expect(classified).not.toEqual({ state: "fault", outcome: "fault", reason: "sandbox_reset" });
  });

  it("an UNREADABLE probe never licenses a nonce write (the standing rule)", async () => {
    const backend = new FakeComputeBackend();
    const store = createMemoryComputeStore();
    const now = { value: 1_000 };

    const ledger = createLedgerSpy();
    const serviceA = makeServiceOnSharedStore({ backend, store, now, workLedger: ledger.sink });
    const started = await serviceA.execStart({ command: "sleep 60", label: "long" });
    await serviceA.execWatch({ processId: started.processId });
    expect(generationWrites(backend)).toBe(1);

    // The container is perfectly healthy — we simply cannot reach it. This is
    // the case the standing rule exists for: `unreadable` is the ABSENCE of
    // evidence, and a nonce written on it would clobber a live one and
    // mass-fault every open row. Only positive `absent` evidence may write.
    backend.getProcessStatus = async () => {
      throw new ComputeError("provider_transient", "unreachable");
    };
    // `listDirectory` is the probe's only seam: it answers or throws, and a
    // throw is `unreadable` no matter what caused it.
    backend.listDirectory = async () => {
      throw new ComputeError("provider_transient", "unreachable");
    };

    now.value = 2_000;
    await serviceA.runComputeTick();

    // Nothing was written to the container, and the blip cannot be read as a
    // reset: the row degrades to the under-informative no_liveness path, which
    // is the trade the design takes over a false "your files are gone".
    expect(generationWrites(backend)).toBe(1);
    expect(await serviceA.getGenerationView()).toEqual({ kind: "unknown" });
    expect(
      classifyWork({
        row: ledger.rows.get(started.processId)!,
        currentGeneration: await serviceA.getGenerationView(),
        now: 2_000 + PROCESS_STALE_AFTER_MS + 1,
      }),
    ).toEqual({ state: "stale", outcome: "fault", reason: "no_liveness" });
  });

  it("a failed restore records the absence ONCE and never re-stamps it", async () => {
    const backend = new FakeComputeBackend();
    const store = createMemoryComputeStore();
    const now = { value: 1_000 };

    const serviceA = makeServiceOnSharedStore({ backend, store, now });
    const started = await serviceA.execStart({ command: "sleep 60", label: "long" });
    await serviceA.execWatch({ processId: started.processId });

    const runtime = store.getComputeState()?.runtimeRef;
    if (runtime) await backend.deletePath(runtime, GENERATION_PATH);
    backend.getProcessStatus = async () => {
      throw new ComputeError("provider_transient", "process is gone");
    };
    // The restore itself cannot land, so the container stays nonce-less.
    backend.writeFile = async () => {
      throw new ComputeError("provider_transient", "read-only filesystem");
    };

    now.value = 2_000;
    await serviceA.runComputeTick();
    expect(await serviceA.getGenerationView()).toEqual({ kind: "absent", observedAt: 2_000 });

    // A later probe of the SAME unresolved absence must not manufacture a
    // fresh wipe timestamp — that is what made every later row look reset.
    now.value = 9_000;
    await serviceA.runComputeTick();
    expect(await serviceA.getGenerationView()).toEqual({ kind: "absent", observedAt: 2_000 });
  });

  /**
   * CLOSES the window this file used to pin as an accepted residual ("an
   * unbounded, un-probed window").
   *
   * The probe used to fire only on a poll FAILURE, so a wipe that happened while
   * no watcher was armed was probed by nothing: the store kept advertising the
   * stale nonce, work registered afterwards inherited it, and its polls SUCCEEDED
   * against the healthy (wiped) container. At the first later `absent` probe —
   * possibly hours later — the restore wrote a fresh nonce and that intact work
   * faulted `sandbox_reset`. The window was unbounded until the next poll failure.
   *
   * `refreshGeneration` on the registration path closes it: registration is the
   * one moment that can distinguish "registered before the wipe" from "registered
   * after it but before anyone noticed", because it is the moment the row's
   * generation is decided.
   */
  it("spares work registered after a wipe is observed", async () => {
    const backend = new FakeComputeBackend();
    const store = createMemoryComputeStore();
    const now = { value: 1_000 };
    const ledger = createLedgerSpy();

    // Provision (gen-a) via a process with NO watcher — nothing polls, so under
    // the old design nothing could ever probe.
    const serviceA = makeServiceOnSharedStore({ backend, store, now, workLedger: ledger.sink });
    const preWipe = await serviceA.execStart({ command: "sleep 60", label: "pre-wipe" });
    await serviceA.execWatch({ processId: preWipe.processId });
    const genA = await serviceA.getGeneration();
    expect(genA).not.toBeNull();

    // T: a REAL wipe, unwitnessed. The container answers; its nonce is gone.
    const runtime = store.getComputeState()?.runtimeRef;
    if (runtime) await backend.deletePath(runtime, GENERATION_PATH);

    // T+2s: new work registers. The registration probe sees `absent` and
    // restores the nonce, so the row is stamped against what the container
    // ACTUALLY carries (gen-b) rather than the stale advertisement (gen-a).
    now.value = 3_000;
    const intact = await serviceA.execStart({ command: "sleep 60", label: "post-wipe" });
    await serviceA.execWatch({ processId: intact.processId });
    const view = await serviceA.getGenerationView();
    expect(view.kind).toBe("known");
    expect(view.kind === "known" && view.nonce).not.toBe(genA);
    expect(ledger.rows.get(intact.processId)?.generation).toBe(
      view.kind === "known" ? view.nonce : null,
    );

    // Its work is on the healthy post-wipe filesystem: faulting it would be the
    // false fault this design calls worse than the hang it replaces.
    expect(
      classifyWork({
        row: ledger.rows.get(intact.processId)!,
        currentGeneration: view,
        now: 3_100,
      }),
    ).toEqual({ state: "alive" });

    // Anti-vacuity: the genuinely pre-wipe row still reports the real reset, so
    // the sparing above is not detection being switched off.
    expect(
      classifyWork({
        row: ledger.rows.get(preWipe.processId)!,
        currentGeneration: view,
        now: 3_100,
      }),
    ).toEqual({ state: "fault", outcome: "fault", reason: "sandbox_reset" });
  });

  /**
   * The other half of the bound: a registration probe must not become an amnesty.
   * Work that predates the wipe really did lose its files.
   */
  it("still faults work that genuinely predates the observed wipe", async () => {
    const backend = new FakeComputeBackend();
    const store = createMemoryComputeStore();
    const now = { value: 1_000 };
    const ledger = createLedgerSpy();

    const serviceA = makeServiceOnSharedStore({ backend, store, now, workLedger: ledger.sink });
    const doomed = await serviceA.execStart({ command: "sleep 60", label: "pre-wipe" });
    await serviceA.execWatch({ processId: doomed.processId });
    const genA = await serviceA.getGeneration();

    const runtime = store.getComputeState()?.runtimeRef;
    if (runtime) await backend.deletePath(runtime, GENERATION_PATH);

    // A later registration probes and restores; the pre-wipe row still carries
    // gen-a and diverges from the restored nonce.
    now.value = 5_000;
    const later = await serviceA.execStart({ command: "sleep 60", label: "post-wipe" });
    await serviceA.execWatch({ processId: later.processId });

    const view = await serviceA.getGenerationView();
    expect(view.kind === "known" && view.nonce).not.toBe(genA);
    expect(ledger.rows.get(doomed.processId)?.generation).toBe(genA);
    expect(
      classifyWork({
        row: ledger.rows.get(doomed.processId)!,
        currentGeneration: view,
        now: 5_100,
      }),
    ).toEqual({ state: "fault", outcome: "fault", reason: "sandbox_reset" });
  });

  /**
   * `readGeneration` is answers-or-throws internally and never throws OUT, so an
   * unreadable listing is the shape a "probe threw" takes here. It must record
   * `unknown` — the registering row then carries `UNKNOWN_GENERATION`, which
   * `classifyWork` never reads as a mismatch, so it degrades to `no_liveness`
   * instead of inventing a reset.
   */
  it("degrades to UNKNOWN_GENERATION when the probe throws", async () => {
    const backend = new FakeComputeBackend();
    const store = createMemoryComputeStore();
    const now = { value: 1_000 };
    const ledger = createLedgerSpy();

    const serviceA = makeServiceOnSharedStore({ backend, store, now, workLedger: ledger.sink });
    await serviceA.execStart({ command: "echo provision", label: "provision" });
    expect(await serviceA.getGeneration()).not.toBeNull();

    // The probe cannot get an answer. Nothing was learned.
    backend.listDirectory = async () => {
      throw new ComputeError("provider_transient", "container unreachable");
    };
    now.value = 3_000;
    const started = await serviceA.execStart({ command: "sleep 60", label: "blind" });
    await serviceA.execWatch({ processId: started.processId });

    expect(await serviceA.getGenerationView()).toEqual({ kind: "unknown" });
    expect(ledger.rows.get(started.processId)?.generation).toBe(UNKNOWN_GENERATION);

    // Under-informative beats a false fault: never `sandbox_reset`.
    expect(
      classifyWork({
        row: ledger.rows.get(started.processId)!,
        currentGeneration: { kind: "known", nonce: "gen-later" },
        now: 3_000 + PROCESS_STALE_AFTER_MS + 1,
      }),
    ).toEqual({ state: "stale", outcome: "fault", reason: "no_liveness" });
  });

  /**
   * `observedAt` means "when the wipe was FIRST seen". A registration probe runs
   * far more often than a poll failure, so re-stamping here would be the same
   * false-fault seam at higher frequency: CF hands back a WORKING container after
   * a wipe, so a container can stay nonce-less for its whole life, and a fresh
   * `observedAt` per probe would make healthy post-wipe work look like it
   * predated a brand-new reset.
   */
  it("does not re-stamp an absence that is already recorded", async () => {
    const backend = new FakeComputeBackend();
    const store = createMemoryComputeStore();
    const now = { value: 1_000 };
    const ledger = createLedgerSpy();

    const serviceA = makeServiceOnSharedStore({ backend, store, now, workLedger: ledger.sink });
    await serviceA.execStart({ command: "echo provision", label: "provision" });

    const runtime = store.getComputeState()?.runtimeRef;
    if (runtime) await backend.deletePath(runtime, GENERATION_PATH);
    // The restore can never land, so the container stays nonce-less and every
    // later probe re-observes the SAME unresolved absence.
    backend.writeFile = async () => {
      throw new ComputeError("provider_transient", "read-only filesystem");
    };

    now.value = 2_000;
    const first = await serviceA.execStart({ command: "sleep 60", label: "first" });
    await serviceA.execWatch({ processId: first.processId });
    expect(await serviceA.getGenerationView()).toEqual({ kind: "absent", observedAt: 2_000 });

    now.value = 9_000;
    const second = await serviceA.execStart({ command: "sleep 60", label: "second" });
    await serviceA.execWatch({ processId: second.processId });
    expect(await serviceA.getGenerationView()).toEqual({ kind: "absent", observedAt: 2_000 });

    // The row registered during the absence carries the placeholder, so the
    // preserved `observedAt` cannot fault it either.
    expect(ledger.rows.get(second.processId)?.generation).toBe(UNKNOWN_GENERATION);
  });

  /**
   * R2 + R3 composed across a RETRY, at the service level. A restore that fails
   * leaves the store nonce-less, so work registered next carries
   * `UNKNOWN_GENERATION`. When a later restore succeeds, that placeholder must
   * not become evidence of a mismatch against the freshly restored nonce.
   */
  it("a failed restore, then a successful one: rows registered in between are never faulted", async () => {
    const backend = new FakeComputeBackend();
    const store = createMemoryComputeStore();
    const now = { value: 1_000 };
    const ledger = createLedgerSpy();

    const serviceA = makeServiceOnSharedStore({ backend, store, now, workLedger: ledger.sink });
    const preWipe = await serviceA.execStart({ command: "sleep 60", label: "pre-wipe" });
    await serviceA.execWatch({ processId: preWipe.processId });
    const genA = await serviceA.getGeneration();

    const runtime = store.getComputeState()?.runtimeRef;
    if (runtime) await backend.deletePath(runtime, GENERATION_PATH);
    const originalStatus = backend.getProcessStatus.bind(backend);
    const failStatus = async (): Promise<never> => {
      throw new ComputeError("provider_transient", "process is gone");
    };
    backend.getProcessStatus = failStatus;
    const originalWriteFile = backend.writeFile.bind(backend);
    backend.writeFile = async () => {
      throw new ComputeError("provider_transient", "read-only filesystem");
    };

    // The restore write fails: the absence is recorded, the container stays
    // nonce-less, and the store's `generation` is null.
    now.value = 2_000;
    await serviceA.runComputeTick();
    expect(await serviceA.getGenerationView()).toEqual({ kind: "absent", observedAt: 2_000 });

    // The model redoes the work on the same live (wiped) container. There is no
    // nonce to observe, so the row carries the placeholder.
    now.value = 3_000;
    backend.getProcessStatus = originalStatus;
    const duringAbsence = await serviceA.execStart({ command: "sleep 60", label: "during" });
    await serviceA.execWatch({ processId: duringAbsence.processId });
    expect(ledger.rows.get(duringAbsence.processId)?.generation).toBe(UNKNOWN_GENERATION);

    // The next probe's restore lands, moving the store to `known`.
    backend.getProcessStatus = failStatus;
    backend.writeFile = originalWriteFile;
    now.value = 4_000;
    await serviceA.runComputeTick();
    const view = await serviceA.getGenerationView();
    expect(view.kind).toBe("known");
    expect(view.kind === "known" && view.nonce).not.toBe(genA);

    // R3: the placeholder is the ABSENCE of evidence, never evidence of a
    // MISMATCH. This row degrades to no_liveness rather than a false reset.
    expect(
      classifyWork({
        row: ledger.rows.get(duringAbsence.processId)!,
        currentGeneration: view,
        now: 4_000 + PROCESS_STALE_AFTER_MS + 1,
      }),
    ).toEqual({ state: "stale", outcome: "fault", reason: "no_liveness" });

    // Anti-vacuity: the genuinely pre-wipe row still reports the real reset.
    expect(
      classifyWork({
        row: ledger.rows.get(preWipe.processId)!,
        currentGeneration: view,
        now: 4_100,
      }),
    ).toEqual({ state: "fault", outcome: "fault", reason: "sandbox_reset" });
  });

  it("a genuinely new container does NOT inherit the previous container's nonce", async () => {
    const backend = new FakeComputeBackend();
    const store = createMemoryComputeStore();
    const now = { value: 1_000 };

    const serviceA = makeServiceOnSharedStore({ backend, store, now });
    await serviceA.execStart({ command: "pwd" });
    const oldNonce = await serviceA.getGeneration();
    expect(oldNonce).not.toBeNull();

    // The container is destroyed outright (e.g. exec_shutdown, or a discard
    // release) — a real "no container exists now" transition.
    await serviceA.execShutdown({ confirm: true });
    expect(store.getComputeState()?.generation).toBeNull();

    // The next service instance provisions a genuinely NEW container.
    const serviceB = makeServiceOnSharedStore({ backend, store, now });
    await serviceB.execStart({ command: "pwd" });
    const newNonce = await serviceB.getGeneration();
    expect(newNonce).not.toBeNull();
    expect(newNonce).not.toBe(oldNonce);
  });
});

/**
 * THE constraint this whole project exists to protect, pinned mechanically
 * rather than by comment.
 *
 * `refreshGeneration` makes a backend call. It belongs on the REGISTRATION path
 * only — a model turn, human present, the backend already being called. The
 * sweep/alarm classification path must stay backend-free: a backend call there
 * can wedge the entire Durable Object (`blockConcurrencyWhile() waited for too
 * long; the Durable Object was reset`), which is the original production
 * incident. `getGenerationView` is the sweep's ONLY generation source and is a
 * pure store read; a future refactor that "helpfully" freshens it by probing
 * would reintroduce the wedge, and this test is what stops it.
 */
describe("the sweep's generation source never touches the backend", () => {
  /** Every backend method throws AND counts: any call at all is a failure. */
  function tripwireBackend(backend: FakeComputeBackend) {
    const calls: string[] = [];
    for (const method of [
      "listDirectory",
      "readFile",
      "writeFile",
      "getProcessStatus",
      "execStart",
      "createDirectory",
      "stopProcess",
    ] as const) {
      (backend as unknown as Record<string, unknown>)[method] = async (...args: unknown[]) => {
        calls.push(method);
        void args;
        throw new ComputeError("provider_transient", `tripwire: ${method} must not be called`);
      };
    }
    return calls;
  }

  it("getGenerationView reads the store only — the reaper cannot block on a dead sandbox", async () => {
    const backend = new FakeComputeBackend();
    const store = createMemoryComputeStore();
    const now = { value: 1_000 };

    // Provision normally, so the store carries a real nonce and a live runtime.
    const serviceA = makeServiceOnSharedStore({ backend, store, now });
    await serviceA.execStart({ command: "pwd" });
    const nonce = await serviceA.getGeneration();
    expect(nonce).not.toBeNull();

    // The sweep resolves its OWN service instance over the same store.
    const calls = tripwireBackend(backend);
    const sweepService = makeServiceOnSharedStore({ backend, store, now });
    expect(await sweepService.getGenerationView()).toEqual({ kind: "known", nonce });
    expect(calls).toEqual([]);

    // Anti-vacuity: the tripwire is live. The REGISTRATION probe does call the
    // backend on this very instance — so the empty list above is the sweep path
    // genuinely not probing, not a tripwire that never fires.
    await sweepService.refreshGeneration();
    expect(calls).toContain("listDirectory");
  });
});

/**
 * Record every backend call the reaper could possibly make, WITHOUT changing
 * behavior — the point is to prove the calls do not happen, so the real
 * implementations still run underneath.
 */
function recordBackendCalls(backend: FakeComputeBackend) {
  const createDirectory: string[] = [];
  const stopProcess: string[] = [];
  const originalCreateDirectory = backend.createDirectory.bind(backend);
  backend.createDirectory = async (runtime, path) => {
    createDirectory.push(path);
    return originalCreateDirectory(runtime, path);
  };
  // `stopProcess` is overloaded (a legacy handle shape sits last), so the
  // inferred param types for a bare arrow bind to the wrong overload. The
  // service only ever calls the BackendReference one — pin the wrapper to it.
  type StopProcess = (
    runtime: BackendReference,
    process: BackendProcessReference,
    mode: StopMode,
  ) => Promise<ProcessStatus>;
  const originalStopProcess = backend.stopProcess.bind(backend) as StopProcess;
  backend.stopProcess = (async (
    runtime: BackendReference,
    process: BackendProcessReference,
    mode: StopMode,
  ) => {
    stopProcess.push(mode);
    return originalStopProcess(runtime, process, mode);
  }) as typeof backend.stopProcess;
  return { createDirectory, stopProcess, acquires: () => backend.acquireCalls.length };
}

/**
 * Start a watched process on one service, then hand back a SEPARATE service on
 * the same store — which is what the reaper actually holds. That instance is
 * freshly constructed, so `workspaceRootEnsured` is false and anything routed
 * through `ensureRuntime` would issue a `createDirectory` before doing its job.
 */
async function watchedProcessForReap() {
  const backend = new FakeComputeBackend();
  const store = createMemoryComputeStore();
  const now = { value: 1_000 };
  const starter = makeServiceOnSharedStore({ backend, store, now });
  const started = await starter.execStart({ command: "sleep 60", label: "long" });
  await starter.execWatch({ processId: started.processId });
  expect(store.listWatchers()).toHaveLength(1);
  // The sweep's service: same durable store, brand-new instance.
  const reaper = makeServiceOnSharedStore({ backend, store, now });
  return { backend, store, now, reaper, processId: started.processId };
}

describe("reapProcess — the reaper never blocks on a dead sandbox", () => {
  it("drops the watcher and touches NO backend when the runtime is not active", async () => {
    const { backend, store, reaper, processId } = await watchedProcessForReap();
    // The container is gone — which is the whole reason a fault fired.
    store.markAbsent(1_000);
    const calls = recordBackendCalls(backend);
    const acquiresBefore = calls.acquires();

    await reaper.reapProcess(processId, { kill: true });

    expect(calls.createDirectory).toEqual([]);
    expect(calls.stopProcess).toEqual([]);
    expect(calls.acquires()).toBe(acquiresBefore);
    // The watcher still goes: a dead watcher left armed is what kept the
    // thread polling a corpse forever.
    expect(store.listWatchers()).toEqual([]);
  });

  it("drops the watcher and touches NO backend when asked not to kill", async () => {
    const { backend, store, reaper, processId } = await watchedProcessForReap();
    const calls = recordBackendCalls(backend);
    const acquiresBefore = calls.acquires();

    // A live, ACTIVE runtime with a running process — so only `kill: false`
    // can be what keeps the backend untouched here.
    expect(store.getComputeState()?.status).toBe("active");
    await reaper.reapProcess(processId, { kill: false });

    expect(calls.createDirectory).toEqual([]);
    expect(calls.stopProcess).toEqual([]);
    expect(calls.acquires()).toBe(acquiresBefore);
    expect(store.listWatchers()).toEqual([]);
  });

  it("stops a live process WITHOUT provisioning or ensuring the workspace root", async () => {
    const { backend, store, reaper, processId } = await watchedProcessForReap();
    const calls = recordBackendCalls(backend);
    const acquiresBefore = calls.acquires();

    await reaper.reapProcess(processId, { kill: true });

    expect(calls.stopProcess).toEqual(["terminate"]);
    // The load-bearing assertion: routing through `execStop`/`ensureRuntime`
    // would mkdir the workspace root INSIDE `blockConcurrencyWhile` on this
    // fresh instance — an unbudgeted call on a sandbox that, by the time a
    // fault fires, has already stopped answering. That wedges the whole DO.
    expect(calls.createDirectory).toEqual([]);
    expect(calls.acquires()).toBe(acquiresBefore);
    expect(store.listWatchers()).toEqual([]);
    expect(store.getProcess(processId)?.status).toBe("stopped");
  });

  it("does not throw when the stop itself fails", async () => {
    const { backend, store, reaper, processId } = await watchedProcessForReap();
    backend.stopProcess = async () => {
      throw new ComputeError("provider_transient", "fake_backend_unreachable");
    };

    // Teardown is best-effort: the terminal is already written and the model
    // already told, so a failed stop must not escape.
    await expect(reaper.reapProcess(processId, { kill: true })).resolves.toBeUndefined();
    expect(store.listWatchers()).toEqual([]);
  });
});

/**
 * A `FakeComputeBackend` that also declares `workHold`, the way
 * `SpritesComputeBackend` does. `releaseFor` records the id it derived from
 * the REFERENCE's own `processId` — the backend's internal id, never the
 * ledger row's id — so these tests can catch exactly the round-1 defect:
 * `thread-service` computing a hold id itself from the wrong id space
 * instead of asking the reference what it is.
 */
class FakeBackendWithHold extends FakeComputeBackend {
  readonly released: string[] = [];
  readonly workHold = {
    acquireFor: (process: BackendProcessReference) => `acquire:${this.holdIdOf(process)}`,
    refreshFor: (process: BackendProcessReference) => `refresh:${this.holdIdOf(process)}`,
    releaseFor: (process: BackendProcessReference): string => {
      const id = this.holdIdOf(process);
      this.released.push(id);
      return `release:${id}`;
    },
  };

  private holdIdOf(process: BackendProcessReference): string {
    const payload = process.payload as { processId?: unknown };
    if (typeof payload.processId !== "string") {
      throw new Error("fake_process_reference_invalid");
    }
    return `nadi-work-${payload.processId}`;
  }
}

/** The backend's OWN process id off a stored reference — never the ledger row's `processId`. */
function backendProcessId(ref: BackendProcessReference): string {
  const payload = ref.payload as { processId?: unknown };
  if (typeof payload.processId !== "string") throw new Error("expected a processId on payload");
  return payload.processId;
}

/**
 * Task 2: a hold with no release path leaks an awake, billing sprite on the
 * first fault — so every path that terminalises a process row must also
 * release its hold.
 */
describe("work-hold release on terminal (Task 2)", () => {
  it("releases the hold when pollWatcher observes a clean exit", async () => {
    const backend = new FakeBackendWithHold();
    const now = { value: 1_000 };
    const { service } = createService({ backend, now });

    const started = await service.execStart({ command: "sleep 300", label: "build" });
    await service.execWatch({ processId: started.processId });
    const listed = await service.execList({ status: "all", limit: 10 });
    const ref = listed.processes.find((p) => p.id === started.processId)?.backendProcessRef;
    if (!ref) throw new Error("expected a backend process reference");
    backend.finishProcess(ref, "exited", 0);

    now.value += CONFIG.monitorPollIntervalMs;
    await service.runComputeTick();

    // The fake's own process id is a DIFFERENT string from the ledger row's
    // id (`fake_proc_N` vs the store's own `id`) — exactly like sprites'
    // `crypto.randomUUID()` processId vs thread-service's `proc_<uuid>` row
    // id. This is the discriminator round 1 was missing.
    expect(started.processId).not.toBe(backendProcessId(ref));
    expect(backend.released).toContain(`nadi-work-${backendProcessId(ref)}`);
  });

  it("releases the hold when the watch times out on a still-running process", async () => {
    const backend = new FakeBackendWithHold();
    const now = { value: 1_000 };
    const { service } = createService({ backend, now });

    // The fake never settles a `sleep` command on its own, so this process is
    // still "running" when the watcher's absolute cap passes.
    const started = await service.execStart({ command: "sleep 6000", label: "long build" });
    await service.execWatch({ processId: started.processId });
    const listed = await service.execList({ status: "all", limit: 10 });
    const ref = listed.processes.find((p) => p.id === started.processId)?.backendProcessRef;
    if (!ref) throw new Error("expected a backend process reference");

    now.value += WATCH_ABSOLUTE_TIMEOUT_MS + CONFIG.monitorPollIntervalMs;
    await service.runComputeTick();

    expect(backend.released).toContain(`nadi-work-${backendProcessId(ref)}`);
    // Released exactly once: `pollWatcher` releases only when IT closed the
    // ledger row (`closed === true`), never as a second, redundant release
    // behind a reaper that got there first.
    expect(
      backend.released.filter((id) => id === `nadi-work-${backendProcessId(ref)}`),
    ).toHaveLength(1);
  });

  it("releases the hold on the reaper's fault arm", async () => {
    const backend = new FakeBackendWithHold();
    const store = createMemoryComputeStore();
    const now = { value: 1_000 };
    const starter = makeServiceOnSharedStore({ backend, store, now });
    const started = await starter.execStart({ command: "sleep 60", label: "long" });
    await starter.execWatch({ processId: started.processId });
    const ref = store.getProcess(started.processId)?.backendProcessRef;
    if (!ref) throw new Error("expected a backend process reference");
    const reaper = makeServiceOnSharedStore({ backend, store, now });

    await reaper.reapProcess(started.processId, { kill: true });

    expect(backend.released).toContain(`nadi-work-${backendProcessId(ref)}`);
  });

  it("releases AFTER the kill, not before, on the reaper's fault arm", async () => {
    // If the refresher survived the kill signal it could `PUT` the hold back
    // after a release that ran too early. Recording call ORDER (not just
    // occurrence) proves the fix holds the line, not just that both calls
    // eventually happen.
    const backend = new FakeBackendWithHold();
    const store = createMemoryComputeStore();
    const now = { value: 1_000 };
    const starter = makeServiceOnSharedStore({ backend, store, now });
    const started = await starter.execStart({ command: "sleep 60", label: "long" });
    await starter.execWatch({ processId: started.processId });
    const reaper = makeServiceOnSharedStore({ backend, store, now });

    const order: string[] = [];
    const originalStopProcess = backend.stopProcess.bind(backend);
    backend.stopProcess = (async (...args: Parameters<typeof backend.stopProcess>) => {
      order.push("stop");
      return (originalStopProcess as typeof backend.stopProcess)(...args);
    }) as typeof backend.stopProcess;
    const originalRunCommand = backend.runCommand.bind(backend);
    backend.runCommand = (async (...args: Parameters<typeof backend.runCommand>) => {
      order.push("release");
      return originalRunCommand(...args);
    }) as typeof backend.runCommand;

    await reaper.reapProcess(started.processId, { kill: true });

    expect(order).toEqual(["stop", "release"]);
  });

  it("swallows a throwing release — best-effort, never blocks the terminal", async () => {
    const backend = new FakeBackendWithHold();
    const originalRunCommand = backend.runCommand.bind(backend);
    let releaseAttempted = false;
    backend.runCommand = (async (
      ...args: Parameters<typeof backend.runCommand>
    ): ReturnType<typeof backend.runCommand> => {
      const [, input] = args;
      if (input.command.startsWith("release:")) {
        releaseAttempted = true;
        throw new Error("sprite unreachable");
      }
      return originalRunCommand(...args);
    }) as typeof backend.runCommand;
    const now = { value: 1_000 };
    const { service, ledger } = createService({ backend, now });

    const started = await service.execStart({ command: "sleep 300", label: "build" });
    await service.execWatch({ processId: started.processId });
    const listed = await service.execList({ status: "all", limit: 10 });
    const ref = listed.processes.find((p) => p.id === started.processId)?.backendProcessRef;
    if (!ref) throw new Error("expected a backend process reference");
    backend.finishProcess(ref, "exited", 0);

    now.value += CONFIG.monitorPollIntervalMs;
    await expect(service.runComputeTick()).resolves.not.toThrow();

    expect(releaseAttempted).toBe(true);
    // The terminal — the caller's actual obligation — must still land.
    expect(ledger.rows.get(started.processId)?.terminal?.outcome).toBe("exited");
  });
});

/**
 * Two watched processes on one service, then a SEPARATE service on the same
 * store — what `resolveComputeService` actually hands the cancel path. That
 * instance has never ensured the workspace root, so any route through
 * `ensureRuntime` shows up as a `createDirectory` inside `blockConcurrencyWhile`.
 */
async function watchedProcessesForCancel() {
  const backend = new FakeComputeBackend();
  const store = createMemoryComputeStore();
  const now = { value: 1_000 };
  const ledger = createLedgerSpy();
  const starter = makeServiceOnSharedStore({ backend, store, now, workLedger: ledger.sink });
  const a = await starter.execStart({ command: "sleep 60", label: "a" });
  const b = await starter.execStart({ command: "sleep 60", label: "b" });
  await starter.execWatch({ processId: a.processId });
  await starter.execWatch({ processId: b.processId });
  const canceller = makeServiceOnSharedStore({ backend, store, now, workLedger: ledger.sink });
  return { backend, store, now, ledger, canceller, a: a.processId, b: b.processId };
}

describe("stopAllRunningProcesses — turn cancel never blocks on a dead sandbox", () => {
  it("stops every running process without reaching ensureRuntime", async () => {
    const { backend, store, canceller, a, b } = await watchedProcessesForCancel();
    const calls = recordBackendCalls(backend);
    const acquiresBefore = calls.acquires();

    const { stopped, failed } = await canceller.stopAllRunningProcesses();

    expect(stopped.sort()).toEqual([a, b].sort());
    expect(failed).toEqual([]);
    expect(calls.stopProcess).toEqual(["terminate", "terminate"]);
    // THE assertion. `status === "active"` is bookkeeping, not evidence the
    // container answers; routing through `execStop`/`ensureRuntime` would mkdir
    // the workspace root on this fresh instance and block the teardown path on a
    // hung sandbox.
    expect(calls.createDirectory).toEqual([]);
    expect(calls.acquires()).toBe(acquiresBefore);
    expect(store.getProcess(a)?.status).toBe("stopped");
    expect(store.getProcess(b)?.status).toBe("stopped");
    expect(store.listWatchers()).toEqual([]);
  });

  it("keeps stopping the rest when one process fails to stop", async () => {
    const { backend, store, canceller, a, b } = await watchedProcessesForCancel();
    const failing = JSON.stringify(store.getProcess(a)!.backendProcessRef);
    const original = backend.stopProcess.bind(backend);
    backend.stopProcess = (async (
      runtime: BackendReference,
      process: BackendProcessReference,
      mode: StopMode,
    ) => {
      if (JSON.stringify(process) === failing)
        throw new ComputeError("provider_transient", "fake_backend_unreachable");
      return (
        original as (
          r: BackendReference,
          p: BackendProcessReference,
          m: StopMode,
        ) => Promise<ProcessStatus>
      )(runtime, process, mode);
    }) as typeof backend.stopProcess;

    const { stopped, failed } = await canceller.stopAllRunningProcesses();

    expect(failed).toEqual([a]);
    expect(stopped).toEqual([b]);
    expect(store.getProcess(b)?.status).toBe("stopped");
    // A process we cannot stop still loses its watcher — otherwise the thread
    // polls a corpse forever.
    expect(store.listWatchers()).toEqual([]);
  });

  it("writes a stopped terminal when a process fails to stop", async () => {
    const { backend, ledger, canceller, a } = await watchedProcessesForCancel();
    backend.stopProcess = async () => {
      throw new ComputeError("provider_transient", "fake_backend_unreachable");
    };

    await canceller.stopAllRunningProcesses();

    // Item 9: an OPEN row here gets faulted `no_liveness` ~21s later, telling
    // the model a USER-CANCELLED process "showed no liveness signal".
    const row = ledger.rows.get(a);
    expect(row?.terminal?.outcome).toBe("stopped");
    expect(row?.terminal?.reason).toBe("process_stopped");
    // This path delivers nothing; the gate is stamped to declare that intent.
    expect(row?.deliveredAt).toBe(1_000);
  });

  it("terminalizes and stamps the delivery gate on the success branch", async () => {
    const { ledger, canceller, a, b } = await watchedProcessesForCancel();

    await canceller.stopAllRunningProcesses();

    for (const id of [a, b]) {
      const row = ledger.rows.get(id);
      expect(row?.terminal?.outcome).toBe("stopped");
      expect(row?.terminal?.reason).toBe("process_stopped");
      // Unstamped, the sweep would start injecting a "stopped" card that never
      // existed before — and a later prune could never remove the row.
      expect(row?.deliveredAt).toBe(1_000);
    }
    expect(ledger.terminalized.sort()).toEqual([a, b].sort());
  });

  it("does not stamp a delivery the reaper already owed", async () => {
    const { ledger, canceller, a } = await watchedProcessesForCancel();
    // The reaper closed this row first and may still genuinely owe its card.
    await ledger.sink.terminalize(a, {
      outcome: "fault",
      reason: "no_liveness",
      at: 900,
      detail: "faulted",
    });

    await canceller.stopAllRunningProcesses();

    const row = ledger.rows.get(a);
    expect(row?.terminal?.reason).toBe("no_liveness");
    expect(row?.deliveredAt).toBeNull();
  });

  // Resurrecting a released sandbox to kill processes that died with it would
  // be absurd — and would bill the user for a container on a cancel.
  it("never provisions a runtime just to stop things", async () => {
    const { backend, store, canceller } = await watchedProcessesForCancel();
    store.markAbsent(1_000);
    const calls = recordBackendCalls(backend);
    const acquiresBefore = calls.acquires();

    const { stopped, failed } = await canceller.stopAllRunningProcesses();

    expect(stopped).toEqual([]);
    expect(failed).toEqual([]);
    expect(calls.stopProcess).toEqual([]);
    expect(calls.createDirectory).toEqual([]);
    expect(calls.acquires()).toBe(acquiresBefore);
  });
});

/**
 * A teardown is not a reset. Every path that tears the container down stops the
 * processes running in it, and each of those processes owns an OPEN ledger row.
 * If the teardown walks away from that row, the next acquire writes a fresh
 * nonce and the reaper reads the divergence as `sandbox_reset` — telling the
 * model its files are gone and blaming an OOM, after a shutdown the model
 * itself requested or a release whose entire purpose was to PRESERVE the files.
 *
 * Observed in production on thr_9f89fe2e: four rows, all `sandbox_reset`, all
 * within seconds of a teardown. The one process killed via `exec_stop` — the
 * single path that already closes its own rows — was the only one classified
 * honestly.
 */
describe("teardown closes its own ledger rows", () => {
  it("exec_shutdown closes a watched process's row as stopped, not as a reset", async () => {
    const backend = new FakeComputeBackend();
    const store = createMemoryComputeStore();
    const ledger = createLedgerSpy();
    const now = { value: 1_000 };

    const serviceA = makeServiceOnSharedStore({ backend, store, now, workLedger: ledger.sink });
    const started = await serviceA.execStart({ command: "sleep 300", label: "long" });
    await serviceA.execWatch({ processId: started.processId });
    expect(ledger.rows.get(started.processId)?.terminal).toBeNull();

    await serviceA.execShutdown({ confirm: true });

    const terminal = ledger.rows.get(started.processId)?.terminal;
    expect(terminal?.outcome).toBe("stopped");
    expect(terminal?.reason).toBe("process_stopped");

    // The next command provisions a genuinely new container with a new nonce.
    // A row left open here is what the reaper mis-reads as a reset.
    const serviceB = makeServiceOnSharedStore({ backend, store, now, workLedger: ledger.sink });
    now.value = 2_000;
    await serviceB.execStart({ command: "pwd" });

    expect(
      classifyWork({
        row: ledger.rows.get(started.processId)!,
        currentGeneration: await serviceB.getGenerationView(),
        now: 3_000,
      }),
    ).toEqual({ state: "alive" });
  });

  it("a preserving idle release does not report the preserved work as a reset", async () => {
    const backend = new FakeComputeBackend();
    const store = createMemoryComputeStore();
    const ledger = createLedgerSpy();
    const now = { value: 1_000 };

    const serviceA = makeServiceOnSharedStore({ backend, store, now, workLedger: ledger.sink });
    const started = await serviceA.execStart({ command: "sleep 300", label: "long" });
    await serviceA.execWatch({ processId: started.processId });

    // No cleanliness deps wired => probe_failed => preserve, which is the
    // DEFAULT disposition since #38 and so the common path, not an edge case.
    now.value = 1_000 + CONFIG.idleTimeoutMs + 1;
    await serviceA.releaseIfIdle();
    expect(store.getComputeState()?.status).toBe("recoverable");

    const terminal = ledger.rows.get(started.processId)?.terminal;
    expect(terminal?.outcome).toBe("stopped");
    expect(terminal?.reason).toBe("process_stopped");

    // Restoring the backup writes a fresh nonce by design. The preserved row
    // must not be re-read as "the filesystem is gone" — the files are the one
    // thing this path guaranteed.
    const serviceB = makeServiceOnSharedStore({ backend, store, now, workLedger: ledger.sink });
    now.value += 1_000;
    await serviceB.execStart({ command: "pwd" });

    expect(
      classifyWork({
        row: ledger.rows.get(started.processId)!,
        currentGeneration: await serviceB.getGenerationView(),
        now: now.value + 60_000,
      }),
    ).toEqual({ state: "alive" });
  });
});
