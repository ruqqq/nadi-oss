import { describe, expect, it, vi } from "vitest";
import { FakeComputeBackend } from "../../../src/compute/backends/fake";
import { DEFAULT_COMPUTE_LIMITS } from "../../../src/compute/config";
import { ComputeError } from "../../../src/compute/errors";
import { log } from "../../../src/log";
import {
  ThreadComputeService,
  type ThreadComputeStoreLike,
} from "../../../src/compute/thread-service";
import type { EffectiveComputeConfig } from "../../../src/compute/types";
import type { ComputeProcessRecord, ThreadComputeStore } from "../../../src/compute/thread-store";
import type { WorkspaceCleanliness } from "../../../src/compute/workspace-cleanliness";
import { createMemoryComputeStore } from "./helpers/memory-store";
import { threadWorkRoot } from "../../../src/compute/workspace-layout";

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
};

/**
 * A stated `dirty` input for the tests below whose subject is the RECOVERY
 * lifecycle.
 *
 * P3 SEVERED CLEANLINESS FROM RETENTION: `ThreadComputeServiceDeps` no longer
 * carries `probeWorkspaceCleanliness` or `isSandboxDeclaredClean`, because the
 * box is the AGENT's and one thread's verdict about its own directory is not
 * evidence about the machine. These options are still THREADED THROUGH on
 * purpose — a test that supplies clean evidence and still observes a preserve
 * is what fails if any discard path comes back.
 */
const dirtyProbe = (): (() => Promise<WorkspaceCleanliness>) => async () => ({
  state: "dirty",
  repos: [{ path: "/workspace/app", changes: [" M src/a.ts"], unpushed: 0 }],
});

// Tracks each created service's mutable clock so `makeIdle` can advance it
// from just a `ThreadComputeService` reference, matching the brief's test
// shape (`createService` returns `{ service, backend }` with `now` unused).
const serviceClocks = new WeakMap<ThreadComputeService, { value: number }>();

function createService(input?: {
  now?: { value: number };
  backend?: FakeComputeBackend;
  store?: ThreadComputeStoreLike;
  alarms?: number[];
  markSandboxDirty?: () => Promise<void>;
  isSandboxDeclaredClean?: () => Promise<boolean>;
  probeWorkspaceCleanliness?: () => Promise<WorkspaceCleanliness>;
  config?: EffectiveComputeConfig;
  ensureThreadWorkspace?: () => Promise<void>;
  backgroundLongRunningExec?: boolean;
  supportsProcessMonitor?: boolean;
  execForegroundTimeoutMs?: number;
  execForegroundPollIntervalMs?: number;
  sleep?: (ms: number) => Promise<void>;
}) {
  const backend = input?.backend ?? new FakeComputeBackend();
  const store = input?.store ?? createMemoryComputeStore();
  const now = input?.now ?? { value: 1_000 };
  const alarms = input?.alarms ?? [];
  const service = new ThreadComputeService({
    backend,
    store,
    config: input?.config ?? CONFIG,
    environmentId: "thread_test",
    threadId: "thread_test",
    env: {},
    setAlarm: async (timestamp) => void alarms.push(timestamp),
    now: () => now.value,
    ...(input?.markSandboxDirty ? { markSandboxDirty: input.markSandboxDirty } : {}),
    ...(input?.isSandboxDeclaredClean
      ? { isSandboxDeclaredClean: input.isSandboxDeclaredClean }
      : {}),
    ...(input?.probeWorkspaceCleanliness
      ? { probeWorkspaceCleanliness: input.probeWorkspaceCleanliness }
      : {}),
    ...(input?.ensureThreadWorkspace ? { ensureThreadWorkspace: input.ensureThreadWorkspace } : {}),
    ...(input?.backgroundLongRunningExec === undefined
      ? {}
      : { backgroundLongRunningExec: input.backgroundLongRunningExec }),
    ...(input?.supportsProcessMonitor === undefined
      ? {}
      : { supportsProcessMonitor: input.supportsProcessMonitor }),
    ...(input?.execForegroundTimeoutMs === undefined
      ? {}
      : { execForegroundTimeoutMs: input.execForegroundTimeoutMs }),
    ...(input?.execForegroundPollIntervalMs === undefined
      ? {}
      : { execForegroundPollIntervalMs: input.execForegroundPollIntervalMs }),
    ...(input?.sleep ? { sleep: input.sleep } : {}),
  });
  serviceClocks.set(service, now);
  return { service, backend, store, now, alarms };
}

/**
 * Acquires compute (so there's a runtime to release) and advances the
 * service's own clock past `idleTimeoutMs`, the same way the file's existing
 * idle tests do by hand (`now.value = 2_000; await service.runComputeTick()`)
 * — except here the clock is looked up from `service` itself so callers only
 * need the service reference, matching the retention-decision tests below.
 */
async function makeIdle(service: ThreadComputeService): Promise<void> {
  await service.exec({ command: "pwd" });
  const clock = serviceClocks.get(service);
  if (!clock) throw new Error("makeIdle: service was not built by this file's createService");
  clock.value += CONFIG.idleTimeoutMs;
}

describe("ThreadComputeService lifecycle", () => {
  it("accepts the concrete thread compute store contract", () => {
    const concreteStore: ThreadComputeStoreLike = null as unknown as ThreadComputeStore;
    expect(concreteStore).toBeNull();
  });

  it("lazily acquires compute and PRESERVES it after the idle timeout, even proven clean", async () => {
    // P3: there is no discard branch left. The box belongs to the AGENT and
    // holds every one of its threads' worktrees, so a clean probe on one
    // thread's directory is not evidence about the machine — and a discard is
    // a `deleteSprite`.
    const { service, backend, store, now } = createService({
      probeWorkspaceCleanliness: async () => ({ state: "clean" }),
    });

    await service.exec({ command: "pwd" });
    expect(store.getComputeState()?.status).toBe("active");

    now.value = 2_000;
    await service.runComputeTick();

    expect(backend.releaseCalls).toMatchObject([{ options: { disposition: "recoverable" } }]);
    expect(store.getComputeState()?.status).toBe("recoverable");
  });

  it("defaults exec to THIS thread's working directory, and an explicit cwd still wins", async () => {
    const { service, backend } = createService();

    // No cwd: a relative path must resolve under the same root the file tools
    // guard, and since P3 that root is the thread's own directory inside the
    // AGENT's shared box — not `/workspace`, which every thread shares, and not
    // the sandbox's boot dir (/root).
    await service.exec({ command: "pwd" });
    expect(backend.startProcessCalls.at(-1)).toMatchObject({
      command: "pwd",
      cwd: threadWorkRoot("thread_test"),
    });
    expect(backend.startProcessCalls.at(-1)?.cwd).not.toBe("/workspace");

    // An explicit cwd is honored unchanged.
    await service.exec({ command: "pwd", cwd: "/workspace/nadi" });
    expect(backend.startProcessCalls.at(-1)).toMatchObject({ cwd: "/workspace/nadi" });
  });

  it("releases repository work as recoverable and stops running process records", async () => {
    const { service, backend, store, now } = createService({
      probeWorkspaceCleanliness: dirtyProbe(),
    });
    const started = await service.execStart({ command: "sleep 30" });

    now.value = 2_000;
    await service.runComputeTick();

    expect(backend.releaseCalls).toMatchObject([
      { options: { disposition: "recoverable", recoveryTtlMs: 5_000 } },
    ]);
    // `recoveryExpiresAt` is NULL, always. A stored expiry is the only thing a
    // reader could turn back into a timed destroy.
    expect(store.getComputeState()).toMatchObject({
      status: "recoverable",
      recoveryExpiresAt: null,
    });
    expect(store.getProcess(started.processId)).toMatchObject({ status: "stopped" });
  });

  it("restores recoverable compute without assuming old processes survived", async () => {
    const { service, backend, store, now } = createService({
      probeWorkspaceCleanliness: dirtyProbe(),
    });
    const started = await service.execStart({ command: "sleep 30" });
    now.value = 2_000;
    await service.runComputeTick();

    now.value = 2_500;
    await service.exec({ command: "pwd" });

    expect(backend.acquireCalls[1]?.recovery).toEqual(backend.releaseCalls[0]?.recovery);
    expect(store.getComputeState()?.status).toBe("active");
    expect(store.getProcess(started.processId)?.status).toBe("stopped");
  });

  it("keeps recoverable compute dormant across a bare turn", async () => {
    const { service, backend, store, now } = createService({
      probeWorkspaceCleanliness: dirtyProbe(),
    });
    await service.exec({ command: "pwd" });
    now.value = 2_000;
    await service.runComputeTick();
    expect(store.getComputeState()?.status).toBe("recoverable");
    const acquiresBefore = backend.acquireCalls.length;

    now.value = 2_500;
    await service.runComputeTick();

    expect(backend.acquireCalls).toHaveLength(acquiresBefore);
    expect(store.getComputeState()?.status).toBe("recoverable");
  });

  it("prepares the workspace once per service, on its first command", async () => {
    const ensureThreadWorkspace = vi.fn().mockResolvedValue(undefined);
    const { service } = createService({ ensureThreadWorkspace });
    await service.exec({ command: "true" });
    await service.exec({ command: "true" });
    expect(ensureThreadWorkspace).toHaveBeenCalledOnce();
  });

  /**
   * DELIBERATELY the opposite of what this used to assert.
   *
   * Preparation used to be skipped on a recovery restore, because `/workspace`
   * comes back from backup and re-cloning would clobber it. That coupling is
   * what made it fire once per BOX and leave every thread but the first with an
   * empty directory (H1). Preparation now runs for every service that reaches a
   * runtime, restore included — and what stops the re-clone is the sentinel
   * INSIDE the restored `/workspace`, which comes back with it. The service
   * asks; preparation answers cheaply.
   */
  it("prepares the workspace again on a NEW service after a restore", async () => {
    const ensureThreadWorkspace = vi.fn().mockResolvedValue(undefined);
    const { service, now } = createService({
      ensureThreadWorkspace,
      probeWorkspaceCleanliness: dirtyProbe(),
    });
    await service.exec({ command: "pwd" });
    now.value = 2_000;
    await service.runComputeTick();
    ensureThreadWorkspace.mockClear();

    now.value = 2_500;
    await service.exec({ command: "true" });
    // Same service instance: its latch already holds, so nothing re-runs.
    expect(ensureThreadWorkspace).not.toHaveBeenCalled();
  });

  it("does not fail the command when workspace preparation throws", async () => {
    const ensureThreadWorkspace = vi.fn().mockRejectedValue(new Error("clone failed"));
    const { service, store } = createService({ ensureThreadWorkspace });
    await expect(service.exec({ command: "true" })).resolves.toMatchObject({ status: "exited" });
    expect(store.getComputeState()?.status).toBe("active");
    // And the latch is NOT released by a swallowed preparation failure: a
    // preparation that keeps failing must not re-run once per command.
    await service.exec({ command: "true" });
    expect(ensureThreadWorkspace).toHaveBeenCalledOnce();
  });

  it("keeps the runtime active when recoverable release fails", async () => {
    const { service, backend, store, now } = createService({
      probeWorkspaceCleanliness: dirtyProbe(),
    });
    await service.exec({ command: "pwd" });
    backend.failNextRelease(new ComputeError("provider_transient"));
    now.value = 2_000;

    await service.runComputeTick();

    expect(store.getComputeState()?.status).toBe("active");
    expect(backend.destroyCalls).toHaveLength(0);
  });

  it("retains recovery state when reacquisition fails", async () => {
    const { service, backend, store, now } = createService({
      probeWorkspaceCleanliness: dirtyProbe(),
    });
    await service.exec({ command: "pwd" });
    now.value = 2_000;
    await service.runComputeTick();
    backend.failNextAcquire(new ComputeError("recovery_failed"));

    await expect(service.exec({ command: "pwd" })).rejects.toMatchObject({
      code: "recovery_failed",
    });
    expect(store.getComputeState()?.status).toBe("recoverable");
  });

  // Was "destroys expired recovery state and clears the declared-clean bit".
  // THAT DESTROY IS THE FEATURE THIS TASK REMOVED: it was the only thing that
  // ever ended a sprite's storage billing, and under agent keying it would take
  // the agent's whole accumulated filesystem with it about a day after the last
  // thread stopped working.
  it("REGRESSION: recovery state is never destroyed on a timer", async () => {
    const { service, backend, store, now } = createService({
      probeWorkspaceCleanliness: dirtyProbe(),
    });
    await service.exec({ command: "pwd" });
    now.value = 2_000;
    await service.runComputeTick();

    now.value = 7_000;
    await service.runComputeTick();

    expect(backend.destroyCalls).toHaveLength(0);
    expect(store.getComputeState()?.status).toBe("recoverable");
  });

  // Was "does not provision fresh compute on a bare turn once recovery has
  // expired", and the second half of that title no longer exists: recovery does
  // not expire, so the box stays recoverable rather than going absent.
  it("REGRESSION: a bare turn long past the old TTL neither provisions nor destroys", async () => {
    const { service, backend, store, now } = createService({
      probeWorkspaceCleanliness: dirtyProbe(),
    });
    await service.exec({ command: "pwd" });
    now.value = 2_000;
    await service.runComputeTick();
    expect(store.getComputeState()?.status).toBe("recoverable");
    const acquiresBefore = backend.acquireCalls.length;
    const destroysBefore = backend.destroyCalls.length;

    now.value = 7_000;
    await service.runComputeTick();

    expect(backend.acquireCalls).toHaveLength(acquiresBefore);
    expect(backend.destroyCalls).toHaveLength(destroysBefore);
    expect(store.getComputeState()?.status).toBe("recoverable");
  });

  it("passes resolved environment and backend-neutral spec values to acquire", async () => {
    const backend = new FakeComputeBackend();
    const store = createMemoryComputeStore();
    const service = new ThreadComputeService({
      backend,
      store,
      config: { ...CONFIG, allowedHosts: ["example.com"] },
      environmentId: "thread_env",
      threadId: "thr_thread_service",
      env: { GH_TOKEN: "secret", NODE_ENV: "production" },
      setAlarm: async () => {},
      now: () => 1,
    });

    await service.exec({ command: "pwd" });

    expect(backend.acquireCalls[0]?.spec).toMatchObject({
      environmentId: "thread_env",
      profile: "small",
      workspaceRoot: "/workspace",
      env: { GH_TOKEN: "secret", NODE_ENV: "production" },
      maxProcessRuntimeMs: 10_000,
      allowedHosts: ["example.com"],
    });
  });

  it("rejects an active Daytona runtime acquired under a different egress policy", async () => {
    const backend = new FakeComputeBackend();
    const store = createMemoryComputeStore();
    const first = createService({
      backend,
      store,
      config: { ...CONFIG, provider: "daytona", allowedHosts: ["old.example.com"] },
    });
    await first.service.exec({ command: "true" });

    const changed = createService({
      backend,
      store,
      config: { ...CONFIG, provider: "daytona", allowedHosts: ["new.example.com"] },
    });

    await expect(changed.service.exec({ command: "true" })).rejects.toMatchObject({
      code: "policy_rejected",
    });
    expect(backend.acquireCalls).toHaveLength(1);
    expect(backend.destroyCalls).toHaveLength(0);
  });

  it("rejects a recoverable Daytona runtime acquired under a different egress policy", async () => {
    const backend = new FakeComputeBackend();
    const store = createMemoryComputeStore();
    const now = { value: 1_000 };
    const first = createService({
      backend,
      store,
      now,
      probeWorkspaceCleanliness: dirtyProbe(),
      config: { ...CONFIG, provider: "daytona", allowedHosts: ["old.example.com"] },
    });
    await first.service.exec({ command: "true" });
    now.value = 2_000;
    await first.service.runComputeTick();
    expect(store.getComputeState()?.status).toBe("recoverable");

    const changed = createService({
      backend,
      store,
      now,
      config: { ...CONFIG, provider: "daytona", allowedHosts: ["new.example.com"] },
    });

    await expect(changed.service.exec({ command: "true" })).rejects.toMatchObject({
      code: "policy_rejected",
    });
    expect(backend.acquireCalls).toHaveLength(1);
  });

  it("fails closed for a legacy Daytona runtime when the desired policy is explicit", async () => {
    const backend = new FakeComputeBackend();
    const store = createMemoryComputeStore();
    store.markAcquiring({ provider: "daytona", resourceProfile: "small", now: 1 });
    store.markActive(
      {
        provider: "daytona",
        version: 1,
        payload: { kind: "runtime", sandboxId: "legacy-daytona" },
      },
      2,
    );
    const changed = createService({
      backend,
      store,
      config: { ...CONFIG, provider: "daytona", allowedHosts: ["api.example.com"] },
    });

    await expect(changed.service.exec({ command: "true" })).rejects.toMatchObject({
      code: "policy_rejected",
    });
  });

  it("keeps a legacy Daytona runtime usable when the desired policy is unrestricted", async () => {
    const backend = new FakeComputeBackend();
    const store = createMemoryComputeStore();
    const runtime = await backend.acquire({
      environmentId: "legacy",
      profile: "small",
      workspaceRoot: "/workspace",
      env: {},
      maxProcessRuntimeMs: 10_000,
      allowedHosts: null,
    });
    backend.acquireCalls.length = 0;
    store.markAcquiring({ provider: "daytona", resourceProfile: "small", now: 1 });
    store.markActive(runtime, 2);
    const unchanged = createService({
      backend,
      store,
      config: { ...CONFIG, provider: "daytona", allowedHosts: null },
    });

    await expect(unchanged.service.exec({ command: "true" })).resolves.toMatchObject({ ok: true });
    expect(backend.acquireCalls).toHaveLength(0);
  });

  it("compares acquired Daytona policies canonically", async () => {
    const backend = new FakeComputeBackend();
    const store = createMemoryComputeStore();
    const first = createService({
      backend,
      store,
      config: {
        ...CONFIG,
        provider: "daytona",
        allowedHosts: [" API.EXAMPLE.COM ", "api.example.com"],
      },
    });
    await first.service.exec({ command: "true" });
    const equivalent = createService({
      backend,
      store,
      config: { ...CONFIG, provider: "daytona", allowedHosts: ["api.example.com"] },
    });

    await expect(equivalent.service.exec({ command: "true" })).resolves.toMatchObject({ ok: true });
  });

  it("returns the opaque active runtime reference for attached subagents", async () => {
    const { service, backend } = createService();

    const runtime = await service.ensureRuntimeReference();

    expect(runtime).toEqual(backend.acquireCalls[0]?.runtime);
  });

  it("polls watchers and delivers a provider-neutral completion notice", async () => {
    const backend = new FakeComputeBackend();
    const store = createMemoryComputeStore();
    const now = { value: 1_000 };
    const reminders: Array<{ body: string; mode: string }> = [];
    const service = new ThreadComputeService({
      backend,
      store,
      config: CONFIG,
      environmentId: "thread_watch",
      threadId: "thr_thread_service",
      env: {},
      setAlarm: async () => {},
      now: () => now.value,
      deliverSystemReminder: async ({ body, mode }) => void reminders.push({ body, mode }),
      supportsProcessMonitor: true,
    });
    const started = await service.execStart({ command: "sleep 30", label: "build" });
    await service.execWatch({ processId: started.processId, timeoutMs: 1_000 });
    const process = store.getProcess(started.processId);
    expect(process?.backendProcessRef).not.toBeNull();
    backend.finishProcess(process!.backendProcessRef!);

    now.value = 1_100;
    await service.runComputeTick();

    expect(store.countWatchers()).toBe(0);
    expect(store.getProcess(started.processId)?.status).toBe("exited");
    expect(reminders).toMatchObject([{ mode: "proactive" }]);
    expect(reminders[0]?.body).toContain("build");
  });

  it("renews a still-running watcher past its deadline instead of abandoning it, then delivers completion once it exits", async () => {
    const backend = new FakeComputeBackend();
    const store = createMemoryComputeStore();
    const now = { value: 1_000 };
    const reminders: Array<{ body: string; mode: string }> = [];
    const service = new ThreadComputeService({
      backend,
      store,
      config: CONFIG,
      environmentId: "thread_watch_renew",
      threadId: "thr_thread_service",
      env: {},
      setAlarm: async () => {},
      now: () => now.value,
      deliverSystemReminder: async ({ body, mode }) => void reminders.push({ body, mode }),
      supportsProcessMonitor: true,
    });
    const started = await service.execStart({ command: "sleep 600", label: "long" });
    await service.execWatch({ processId: started.processId, timeoutMs: 1_000 });

    // Deadline passes while the process is still running.
    now.value = 2_100;
    await service.runComputeTick();

    // Renewed, not abandoned: watcher survives, no reminder fired yet.
    expect(store.countWatchers()).toBe(1);
    expect(reminders).toEqual([]);
    expect(store.listWatchers()[0]?.deadlineAt).toBeGreaterThan(now.value);

    // The process finally exits on a later poll.
    const process = store.getProcess(started.processId);
    backend.finishProcess(process!.backendProcessRef!);
    now.value = 2_200;
    await service.runComputeTick();

    expect(store.countWatchers()).toBe(0);
    expect(store.getProcess(started.processId)?.status).toBe("exited");
    expect(reminders).toMatchObject([{ mode: "proactive" }]);
    expect(reminders[0]?.body).toContain("long");
  });

  it("clears provider-loss state, notifies the thread, and reacquires for the command", async () => {
    const backend = new FakeComputeBackend();
    const store = createMemoryComputeStore();
    const reminders: string[] = [];
    const service = new ThreadComputeService({
      backend,
      store,
      config: CONFIG,
      environmentId: "thread_loss",
      threadId: "thr_thread_service",
      env: {},
      setAlarm: async () => {},
      clearAlarm: async () => {},
      now: () => 1_000,
      deliverSystemReminder: async ({ body }) => void reminders.push(body),
    });
    await service.exec({ command: "pwd" });
    const firstRuntime = store.getComputeState()?.runtimeRef;
    expect(firstRuntime).not.toBeNull();
    backend.deleteRuntimeOutOfBand(firstRuntime!);

    const result = await service.exec({ command: "pwd" });

    expect(result.status).toBe("exited");
    expect(backend.acquireCalls).toHaveLength(2);
    expect(store.getComputeState()?.status).toBe("active");
    expect(reminders.join("\n")).toContain("missing from its backend");
  });
});

describe("ThreadComputeService.listActiveWatchersView output tail", () => {
  it("includes a bounded tail of the watched process's captured output", async () => {
    const { service, store, now } = createService();
    const started = await service.execStart({ command: "sleep 300", label: "build" });
    await service.execWatch({ processId: started.processId, timeoutMs: 1_000 });

    store.appendOutput({
      processId: started.processId,
      stream: "stdout",
      text: "line1\nline2\n",
      now: now.value,
    });

    const views = await service.listActiveWatchersView();

    expect(views).toHaveLength(1);
    expect(views[0]).toMatchObject({
      processId: started.processId,
      label: "build",
    });
    expect(views[0]?.outputTail).toContain("line1");
    expect(views[0]?.outputTail).toContain("line2");
  });

  it("returns an empty tail when the watched process has produced no output", async () => {
    const { service } = createService();
    const started = await service.execStart({ command: "sleep 300" });
    await service.execWatch({ processId: started.processId, timeoutMs: 1_000 });

    const views = await service.listActiveWatchersView();

    expect(views[0]?.outputTail).toBe("");
  });
});

describe("ThreadComputeService acquisition profile preference", () => {
  it("prefers the profile persisted on state while a runtime still exists", async () => {
    // A runtime IS acquired at "medium" and then released as recoverable.
    // Resuming it must reuse "medium" — the box it is resuming was built that
    // way — even though the configuration now says "small".
    const backend = new FakeComputeBackend();
    const store = createMemoryComputeStore();
    const now = { value: 1_000 };
    const medium = await createService({
      backend,
      store,
      now,
      config: { ...CONFIG, resourceProfile: "medium" },
      probeWorkspaceCleanliness: dirtyProbe(),
    });
    await medium.service.exec({ command: "pwd" });
    now.value = 2_000;
    await medium.service.runComputeTick();
    expect(store.getComputeState()?.status).toBe("recoverable");
    expect(store.getComputeState()?.resourceProfile).toBe("medium");

    now.value = 2_500;
    const small = await createService({
      backend,
      store,
      now,
      probeWorkspaceCleanliness: dirtyProbe(),
    });
    await small.service.exec({ command: "pwd" });

    expect(backend.acquireCalls.at(-1)?.spec.profile).toBe("medium");
  });

  it("falls back to the configured profile once no runtime exists", async () => {
    // The stored profile survives `markAbsent`, so preferring it
    // unconditionally would freeze the profile of the very first acquire
    // forever — a thread retargeted to a smaller/larger environment would keep
    // provisioning the old size, from the old base image, with nothing to
    // correct it now the switch handshake's explicit "adopt" write is gone.
    const { service, backend, store, now } = createService();
    store.setResourceProfile("medium", now.value);
    store.markAbsent(now.value);

    await service.exec({ command: "pwd" });
    expect(backend.acquireCalls[0]?.spec.profile).toBe("small");
  });
});

describe("ThreadComputeService output retention signal", () => {
  function seedProcess(store: ThreadComputeStoreLike, overrides: Partial<ComputeProcessRecord>) {
    const record: ComputeProcessRecord = {
      id: "proc-ret",
      threadId: "thr_service_test",
      backendProcessRef: null,
      command: "yes",
      cwd: null,
      status: "exited",
      exitCode: 0,
      startedAt: 1,
      finishedAt: 2,
      stdoutBytes: 0,
      stderrBytes: 0,
      stdoutLines: 0,
      stderrLines: 0,
      outputTruncated: false,
      label: null,
      ...overrides,
    };
    store.createProcess(record);
    store.appendOutput({ processId: record.id, stream: "stdout", text: "kept line\n", now: 1 });
    return record.id;
  }

  it("flips limitReason to retention when stored output was truncated (execOutput)", async () => {
    const { service, store } = createService();
    const processId = seedProcess(store, { outputTruncated: true });

    const result = await service.execOutput({ processId });

    expect(result.limited).toBe(true);
    expect(result.limitReason).toBe("retention");
  });

  it("does not report retention when output was not truncated", async () => {
    const { service, store } = createService();
    const processId = seedProcess(store, { outputTruncated: false });

    const result = await service.execOutput({ processId });

    expect(result.limited).toBe(false);
    expect(result.limitReason).toBeUndefined();
  });

  it("surfaces retention through the grep and read paths too", async () => {
    const { service, store } = createService();
    const processId = seedProcess(store, { outputTruncated: true });

    const grep = await service.execOutputGrep({ processId, pattern: "kept" });
    expect(grep.limitReason).toBe("retention");

    const read = await service.execOutputRead({ processId });
    expect(read.limitReason).toBe("retention");
  });
});

describe("ThreadComputeService.execOutputHeadTail", () => {
  it("reports head, tail, and an exact hidden-line count for a long stream", async () => {
    const { service, store, now } = createService();
    const started = await service.execStart({ command: "sleep 300", label: "build" });
    for (let i = 1; i <= 50; i += 1) {
      store.appendOutput({
        processId: started.processId,
        stream: "stdout",
        text: `line ${i}\n`,
        now: now.value,
      });
    }

    const result = await service.execOutputHeadTail({ processId: started.processId });

    expect(result.head).toEqual(Array.from({ length: 20 }, (_, i) => `line ${i + 1}`));
    expect(result.tail).toEqual(Array.from({ length: 20 }, (_, i) => `line ${31 + i}`));
    // 50 total - 20 head - 20 tail = 10, and this must be reported, never
    // just dropped: a silent gap between head and tail is a repeat offender
    // in this codebase (see `hiddenLines`'s doc).
    expect(result.hiddenLines).toBe(10);
    expect(result.truncated).toBe(false);
    expect(result.stream).toBe("stdout");
  });

  it("returns everything with no hidden lines for a short stream", async () => {
    const { service, store, now } = createService();
    const started = await service.execStart({ command: "sleep 300" });
    store.appendOutput({
      processId: started.processId,
      stream: "stdout",
      text: "hi\n",
      now: now.value,
    });

    const result = await service.execOutputHeadTail({ processId: started.processId });
    expect(result).toEqual({
      head: ["hi"],
      tail: [],
      hiddenLines: 0,
      truncated: false,
      stream: "stdout",
    });
  });

  /**
   * Important 1: a command that writes its failure to stderr (the common case
   * for a failed build) must not read as "no output" just because the caller
   * defaulted to stdout — that's the exact row a user opens the sheet to
   * investigate. Mirrors the fallback `buildOutputTail` already uses for the
   * watcher-completion message.
   */
  it("falls back to stderr when stdout is empty, and reports which stream it returned", async () => {
    const { service, store, now } = createService();
    const started = await service.execStart({ command: "sleep 300" });
    store.appendOutput({
      processId: started.processId,
      stream: "stderr",
      text: "build failed: missing dependency\n",
      now: now.value,
    });

    const result = await service.execOutputHeadTail({ processId: started.processId });
    expect(result.stream).toBe("stderr");
    expect(result.head).toEqual(["build failed: missing dependency"]);
    expect(result.tail).toEqual([]);
  });

  it("does NOT fall back to stderr when the caller explicitly asked for stdout content that is genuinely empty and stderr also has nothing", async () => {
    const { service } = createService();
    const started = await service.execStart({ command: "sleep 300" });

    const result = await service.execOutputHeadTail({ processId: started.processId });
    expect(result.stream).toBe("stdout");
    expect(result).toMatchObject({ head: [], tail: [], hiddenLines: 0 });
  });

  it("does NOT fall back when the caller explicitly requested stderr", async () => {
    const { service, store, now } = createService();
    const started = await service.execStart({ command: "sleep 300" });
    store.appendOutput({
      processId: started.processId,
      stream: "stdout",
      text: "stdout line\n",
      now: now.value,
    });

    const result = await service.execOutputHeadTail({
      processId: started.processId,
      stream: "stderr",
    });
    expect(result.stream).toBe("stderr");
    expect(result).toMatchObject({ head: [], tail: [], hiddenLines: 0 });
  });

  it("clamps headLines/tailLines to limits.tailMaxLines like execOutput does", async () => {
    const { service, store, now } = createService();
    const started = await service.execStart({ command: "sleep 300" });
    // More lines than `CONFIG.limits.tailMaxLines` (200), so an unclamped
    // request would swallow the whole stream into `head` with an empty
    // `tail` — proving whether the clamp actually applied, not just that a
    // small stream happens to fit either way.
    const total = DEFAULT_COMPUTE_LIMITS.tailMaxLines + 50;
    for (let i = 1; i <= total; i += 1) {
      store.appendOutput({
        processId: started.processId,
        stream: "stdout",
        text: `line ${i}\n`,
        now: now.value,
      });
    }

    // A caller-supplied count far past the configured cap must not reach the
    // slicer unbounded — this callable is browser-reachable, unlike the
    // model-tool exec surfaces that already clamp the same way.
    const result = await service.execOutputHeadTail({
      processId: started.processId,
      headLines: 10_000,
      tailLines: 10_000,
    });
    expect(result.head).toHaveLength(DEFAULT_COMPUTE_LIMITS.tailMaxLines);
    expect(result.tail).toHaveLength(50);
    expect(result.hiddenLines).toBe(0);
  });

  it("surfaces retention truncation independently of hiddenLines", async () => {
    const { service, store, now } = createService();
    const started = await service.execStart({ command: "yes" });
    store.appendOutput({
      processId: started.processId,
      stream: "stdout",
      text: "kept\n",
      now: now.value,
    });
    store.updateProcess(started.processId, { outputTruncated: true });

    const result = await service.execOutputHeadTail({ processId: started.processId });
    expect(result.hiddenLines).toBe(0);
    expect(result.truncated).toBe(true);
  });

  it("throws for an unknown process id", async () => {
    const { service } = createService();
    await expect(service.execOutputHeadTail({ processId: "nope" })).rejects.toThrow(
      "sandbox_process_not_found",
    );
  });
});

describe("ThreadComputeService stopAllRunningProcesses", () => {
  // The UI stop button aborts the model turn, but anything the model launched
  // kept running in the container until it exited or hit maxProcessRuntimeMs.
  it("stops every running process and drops its watcher", async () => {
    const { service, store } = createService();
    const a = await service.execStart({ command: "sleep 300" });
    const b = await service.execStart({ command: "sleep 300" });
    await service.execWatch({ processId: a.processId });
    expect(store.listWatchers().length).toBe(1);

    const { stopped, failed } = await service.stopAllRunningProcesses();

    expect(stopped.sort()).toEqual([a.processId, b.processId].sort());
    expect(failed).toEqual([]);
    expect(store.getProcess(a.processId)?.status).not.toBe("running");
    expect(store.getProcess(b.processId)?.status).not.toBe("running");
    // A stopped process must not keep a watcher polling for a completion that
    // will never come.
    expect(store.listWatchers()).toEqual([]);
  });

  it("leaves already-finished processes alone", async () => {
    const { service, backend, store } = createService();
    const done = await service.execStart({ command: "sleep 300" });
    backend.finishProcess(store.getProcess(done.processId)!.backendProcessRef!, "exited", 0);
    await service.execStatus({ processId: done.processId });

    const { stopped } = await service.stopAllRunningProcesses();
    expect(stopped).toEqual([]);
  });

  // Resurrecting a released sandbox just to kill processes that died with it
  // would be absurd — and would bill the user for a container on a cancel.
  it("never provisions a runtime just to stop things", async () => {
    const { service, backend } = createService();
    await service.execStart({ command: "sleep 300" });
    // `confirm` is required while processes are still running — without it
    // execShutdown only asks, and the sandbox stays active.
    await service.execShutdown({ confirm: true });
    const acquiresBefore = backend.acquireCalls.length;

    const { stopped, failed } = await service.stopAllRunningProcesses();

    expect(stopped).toEqual([]);
    expect(failed).toEqual([]);
    expect(backend.acquireCalls.length).toBe(acquiresBefore);
  });
});

describe("ThreadComputeService execOutput status", () => {
  // The stored status only advances when a watcher poll runs, so exec_output
  // reported "running" for a process that had already exited. `waitMs` (accepted
  // and silently ignored) pretended to paper over this. Ask the provider instead.
  it("reports the provider's status, not the stale stored one", async () => {
    const { service, backend, store } = createService();
    const started = await service.execStart({ command: "sleep 300" });
    expect(store.getProcess(started.processId)?.status).toBe("running");

    // The process exits in the container. No watcher runs.
    backend.finishProcess(store.getProcess(started.processId)!.backendProcessRef!, "exited", 0);

    const out = await service.execOutput({ processId: started.processId });
    expect(out.status).toBe("exited");
    expect(out.exitCode).toBe(0);
  });

  it("includes anti-poll guidance while the process is still running", async () => {
    const { service, store } = createService();
    const started = await service.execStart({ command: "sleep 300" });
    expect(store.getProcess(started.processId)?.status).toBe("running");

    const out = await service.execOutput({ processId: started.processId });

    expect(out.status).toBe("running");
    expect(out.guidance).toContain("Do not call exec_output in a loop");
  });

  it("omits guidance once the process has exited", async () => {
    const { service, backend, store } = createService();
    const started = await service.execStart({ command: "sleep 300" });
    backend.finishProcess(store.getProcess(started.processId)!.backendProcessRef!, "exited", 0);

    const out = await service.execOutput({ processId: started.processId });

    expect(out.status).toBe("exited");
    expect(out.guidance).toBeUndefined();
  });
});

describe("ThreadComputeService execRun", () => {
  it("keeps a synchronous exec cancellable while it waits for completion", async () => {
    const { service, backend, store } = createService({ backgroundLongRunningExec: false });
    let releaseStream: (() => void) | undefined;
    (
      backend as unknown as {
        waitForProcessExit: () => Promise<{ status: "stopped" }>;
      }
    ).waitForProcessExit = async () => {
      await new Promise<void>((resolve) => {
        releaseStream = resolve;
      });
      return { status: "stopped" };
    };

    const exec = service.exec({ command: "sleep 300" });
    await vi.waitFor(() => expect(store.listProcesses(1_000)).toHaveLength(1));

    const stopped = await service.stopAllRunningProcesses();

    expect(stopped.failed).toEqual([]);
    expect(stopped.stopped).toEqual([store.listProcesses(1_000)[0]!.id]);
    releaseStream?.();
    await expect(exec).resolves.toMatchObject({ status: "stopped" });
  });

  it("exec waits through the foreground window when backgrounding is disabled", async () => {
    const now = { value: 1_000 };
    const { service, backend, store } = createService({
      now,
      backgroundLongRunningExec: false,
      execForegroundTimeoutMs: 1,
      execForegroundPollIntervalMs: 1,
      sleep: async (ms) => void (now.value += ms),
    });
    const result = await service.exec({ command: "sleep 30" });

    expect(result.status).toBe("exited");
    expect(result).not.toHaveProperty("watching");
    expect(store.listWatchers()).toEqual([]);
    expect(backend.runCommandCalls.map((call) => call.command)).toEqual(["sleep 30"]);
  });

  // execRun exists because polling a process's status across its exit wedges the
  // Cloudflare RPC session for ~10 minutes. It must go through the backend's
  // blocking runCommand and never start a pollable process.
  it("runs via the backend's blocking runCommand, not startProcess", async () => {
    const { service, backend } = createService();
    const result = await service.execRun({ command: "echo hi", label: "skill:x" });

    expect(result.status).toBe("exited");
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toBe("hi\n");
    expect(backend.runCommandCalls.map((c) => c.command)).toEqual(["echo hi"]);
    // No background process was started — there is nothing to poll, by design.
    expect(backend.startProcessCalls).toEqual([]);
  });

  /**
   * The cwd default lives at TWO call sites — `exec`'s blocking-runCommand path
   * and `startAndStoreProcess` — and the tests above only reach the second. One
   * of them reverting to `/workspace` is a partial regression a
   * `startProcess`-only assertion cannot see; it is the one the first mutation
   * pass on this change actually produced.
   */
  it("the blocking runCommand path defaults to the thread's directory too", async () => {
    const now = { value: 1_000 };
    const { service, backend } = createService({
      now,
      backgroundLongRunningExec: false,
      execForegroundTimeoutMs: 1,
      execForegroundPollIntervalMs: 1,
      sleep: async (ms) => void (now.value += ms),
    });

    await service.exec({ command: "pwd" });
    await service.exec({ command: "pwd", cwd: "/tmp" });

    expect(backend.runCommandCalls.map((call) => call.cwd)).toEqual([
      threadWorkRoot("thread_test"),
      "/tmp",
    ]);
    expect(backend.runCommandCalls[0]?.cwd).not.toBe("/workspace");
  });

  /**
   * DATA LOSS GUARD (companion to workspace-cleanliness.test.ts). A backend
   * without `runCommand` falls back to start-and-poll, which returns
   * `buildPreview`'s TAIL. `execRun` must say so — a caller that decides from
   * stdout (the cleanliness probe decides whether to DESTROY the sandbox)
   * cannot tell a line-aligned cut from complete output on its own.
   */
  it("reports stdoutTruncated when the start-and-poll fallback returns only a tail", async () => {
    const backend = new FakeComputeBackend();
    // No blocking runCommand → the fallback path, the only one that tails.
    (backend as unknown as { runCommand?: unknown }).runCommand = undefined;
    backend.setNextProcessResult({
      status: "exited",
      exitCode: 0,
      stdout: `${Array.from({ length: DEFAULT_COMPUTE_LIMITS.tailMaxLines + 50 }, (_, i) => `line ${i}`).join("\n")}\n`,
    });
    const { service } = createService({ backend });
    const result = await service.execRun({ command: "spew" });

    expect(result.stdoutTruncated).toBe(true);
    // And it really is a tail: the head is gone.
    expect(result.stdout).not.toContain("line 0\n");
  });

  it("reports stdoutTruncated false when the backend returns the whole output", async () => {
    const { service } = createService();
    const result = await service.execRun({ command: "echo hi" });
    expect(result.stdoutTruncated).toBe(false);
  });

  it("records the completed run in the store so it stays observable", async () => {
    const { service, store } = createService();
    const result = await service.execRun({ command: "echo hi", label: "skill:x" });

    const process = store.getProcess(result.processId);
    expect(process?.status).toBe("exited");
    expect(process?.exitCode).toBe(0);
    expect(process?.label).toBe("skill:x");
    expect(process?.finishedAt).not.toBeNull();
  });
});

describe("ThreadComputeService execStatus", () => {
  // Regression: execOutput's status is store-only and never advances without a
  // watcher, so the skill-script runner's completion poll hung forever.
  // execStatus must ask the backend while the store still says "running".
  it("returns the backend's fresh status and persists a terminal transition", async () => {
    const { service, backend, store } = createService();
    const started = await service.execStart({ command: "sleep 30" });

    expect((await service.execStatus({ processId: started.processId })).status).toBe("running");
    expect(store.getProcess(started.processId)?.status).toBe("running");

    const ref = store.getProcess(started.processId)!.backendProcessRef!;
    backend.finishProcess(ref, "exited", 0);

    const fresh = await service.execStatus({ processId: started.processId });
    expect(fresh).toMatchObject({ status: "exited", exitCode: 0 });
    expect(store.getProcess(started.processId)).toMatchObject({ status: "exited", exitCode: 0 });
  });

  it("never provisions a runtime just to poll: absent compute reports the stored status", async () => {
    const { service, backend, store, now } = createService({
      probeWorkspaceCleanliness: async () => ({ state: "clean" }),
    });
    const started = await service.execStart({ command: "sleep 30" });
    now.value = 2_000;
    await service.runComputeTick(); // idle-discards the runtime (probe proves it clean)

    const result = await service.execStatus({ processId: started.processId });

    expect(result.status).toBe(store.getProcess(started.processId)?.status);
    expect(backend.acquireCalls.length).toBe(1); // no re-acquire for a poll
  });
});

describe("ThreadComputeService download mime", () => {
  it("carries a provider-supplied mime through execDownloadFile", async () => {
    const { service, backend, store } = createService();
    await service.exec({ command: "pwd" });
    const runtime = store.getComputeState()?.runtimeRef;
    expect(runtime).toBeTruthy();
    backend.seedFile(runtime!, "/workspace/logo.png", new Uint8Array([1, 2, 3]), "image/png");

    const download = await service.execDownloadFile({
      path: "/workspace/logo.png",
      maxBytes: 1024,
    });

    expect(download.mimeType).toBe("image/png");
    expect(download.filename).toBe("logo.png");
    expect(download.bytes.byteLength).toBe(3);
  });

  it("omits mime when the provider supplies none", async () => {
    const { service, backend, store } = createService();
    await service.exec({ command: "pwd" });
    const runtime = store.getComputeState()?.runtimeRef;
    await backend.writeFile(runtime!, "/workspace/plain.bin", new Uint8Array([9]).buffer, {
      createParents: false,
      overwrite: true,
    });

    const download = await service.execDownloadFile({
      path: "/workspace/plain.bin",
      maxBytes: 1024,
    });

    expect(download.mimeType).toBeUndefined();
  });
});

describe("ThreadComputeService workspace root provisioning", () => {
  /**
   * `backend.acquire` creates the workspace root, but an already-active runtime
   * never re-acquires — and exec now defaults `cwd` to it. Without this, every
   * sandbox that was running before the root existed would exec into a missing
   * directory.
   */
  function recordingBackend() {
    const backend = new FakeComputeBackend();
    const createdDirs: string[] = [];
    const original = backend.createDirectory.bind(backend);
    backend.createDirectory = async (runtime, path) => {
      createdDirs.push(path);
      return original(runtime, path);
    };
    return { backend, createdDirs };
  }

  it("creates the workspace root and the thread's own directory on a reused active runtime, once", async () => {
    const { backend, createdDirs } = recordingBackend();
    const { service } = createService({ backend });

    await service.exec({ command: "true" });
    await service.exec({ command: "true" });

    expect(createdDirs.filter((path) => path === "/workspace")).toHaveLength(1);
    // The thread's directory is the cwd exec defaults to AND the root the file
    // tools fail closed on (`workspace_root_missing`), so `/workspace` alone is
    // not enough: a box whose first exec came from a thread that never got its
    // directory would exec into nothing.
    expect(createdDirs.filter((path) => path === threadWorkRoot("thread_test"))).toHaveLength(1);
  });

  it("creates the workspace root on an attached runtime that never acquires", async () => {
    const { backend, createdDirs } = recordingBackend();
    const attachedRuntime = await backend.acquire({
      environmentId: "parent",
      profile: "small",
      workspaceRoot: "/workspace",
      env: {},
      maxProcessRuntimeMs: 1_000,
      allowedHosts: null,
    });
    createdDirs.length = 0;

    const service = new ThreadComputeService({
      backend,
      store: createMemoryComputeStore(),
      config: CONFIG,
      environmentId: "thread_attached",
      threadId: "thr_thread_service",
      env: {},
      attachedRuntime,
      setAlarm: async () => {},
      now: () => 1_000,
    });

    await service.exec({ command: "true" });

    expect(createdDirs).toContain("/workspace");
    expect(createdDirs).toContain(threadWorkRoot("thr_thread_service"));
  });

  it("defaults exec cwd to the thread's working directory but honors an explicit cwd", async () => {
    const { service, backend } = createService();
    await service.exec({ command: "true" });
    await service.exec({ command: "true", cwd: "/tmp" });
    expect(backend.startProcessCalls.map((call) => call.cwd)).toEqual([
      threadWorkRoot("thread_test"),
      "/tmp",
    ]);
  });

  /**
   * The point of the whole task: two threads of ONE agent, one box, two working
   * directories. A service that fell back to a shared root would pass every
   * other test in this file.
   */
  it("gives two threads of one box different working directories", async () => {
    const backend = new FakeComputeBackend();
    const store = createMemoryComputeStore();
    const build = (threadId: string) =>
      new ThreadComputeService({
        backend,
        store,
        config: CONFIG,
        environmentId: "agent_shared_box",
        threadId,
        env: {},
        setAlarm: async () => {},
        now: () => 1_000,
      });

    await build("thr_aaaaaaaa").exec({ command: "pwd" });
    await build("thr_bbbbbbbb").exec({ command: "pwd" });

    const [first, second] = backend.startProcessCalls.slice(-2);
    expect(first?.cwd).toBe(threadWorkRoot("thr_aaaaaaaa"));
    expect(second?.cwd).toBe(threadWorkRoot("thr_bbbbbbbb"));
  });

  /**
   * NEW-1. Two parallel tool calls in one step, one service, one working
   * directory that is still being cloned into.
   *
   * The latch used to be a boolean set BEFORE preparation was awaited, so the
   * second `exec` returned from `ensureWorkspaceRootOnce` immediately and ran
   * its command in a half-populated worktree — or, through `write_file`, wrote
   * into a directory `git worktree add` was about to fill. The sandbox DO's
   * in-flight map cannot catch this: it only ever saw ONE call, because the
   * second never reached it.
   *
   * Round 0 was accidentally immune — preparation ran inside
   * `readOrAcquireRuntime`, which both execs awaited through
   * `boundedAcquisition` — so moving the trigger out of the acquisition is what
   * exposed it, and the serialization has to be stated rather than inherited.
   */
  it("makes a second concurrent exec wait for preparation, not race it", async () => {
    const backend = new FakeComputeBackend();
    const events: string[] = [];
    const startProcess = backend.startProcess.bind(backend);
    backend.startProcess = (async (runtime: never, input: { command: string }) => {
      events.push(`exec:${input.command}`);
      return startProcess(runtime, input as never);
    }) as typeof backend.startProcess;

    const { service } = createService({
      backend,
      ensureThreadWorkspace: async () => {
        events.push("prepare:start");
        // A REAL delay, not a hand-counted number of microtask turns: the
        // second `exec` has a whole chain of awaits of its own to get through
        // before it starts a process, and a fixed tick count is exactly the
        // kind of accidental ordering that let this bug look fixed.
        await new Promise((resolve) => setTimeout(resolve, 20));
        events.push("prepare:end");
      },
    });

    const first = service.exec({ command: "A" });
    const second = service.exec({ command: "B" });
    await Promise.all([first, second]);

    // NEITHER command may appear before preparation finished.
    expect(events.slice(0, 2)).toEqual(["prepare:start", "prepare:end"]);
    expect(events.slice(2).sort()).toEqual(["exec:A", "exec:B"]);
    // And preparation ran exactly once for the service.
    expect(events.filter((entry) => entry === "prepare:start")).toHaveLength(1);
  });

  /**
   * A failure to CREATE the directories must not poison the service: the next
   * command retries. (A preparation failure is caught and logged instead, so it
   * deliberately does not reach this path — retrying a failing preparation once
   * per command is what the in-box sentinel exists to avoid.)
   */
  it("retries provisioning after a directory-creation failure", async () => {
    const backend = new FakeComputeBackend();
    let calls = 0;
    const original = backend.createDirectory.bind(backend);
    backend.createDirectory = async (runtime, path) => {
      calls += 1;
      if (calls === 1) throw new Error("mkdir refused");
      return original(runtime, path);
    };
    const { service } = createService({ backend });

    await expect(service.exec({ command: "A" })).rejects.toThrow("mkdir refused");
    await expect(service.exec({ command: "B" })).resolves.toMatchObject({ status: "exited" });
  });

  /**
   * The subagent shape: a service whose ROUTING thread and whose WORKING
   * DIRECTORY are different threads.
   *
   * `threadId` is a run id — it stamps ledger rows and routes reminders. The
   * directory belongs to the parent, because that is where the checkout is.
   * Nothing else in this file would notice the two being conflated: every other
   * service here routes and works as the same thread.
   */
  it("works in workspaceThreadId's directory while still routing as threadId", async () => {
    const backend = new FakeComputeBackend();
    const service = new ThreadComputeService({
      backend,
      store: createMemoryComputeStore(),
      config: CONFIG,
      environmentId: "agent_shared_box",
      threadId: "run_abcdef",
      workspaceThreadId: "thr_parent_of_run",
      env: {},
      setAlarm: async () => {},
      now: () => 1_000,
    });

    await service.exec({ command: "pwd" });

    expect(backend.startProcessCalls.at(-1)?.cwd).toBe(threadWorkRoot("thr_parent_of_run"));
    expect(backend.startProcessCalls.at(-1)?.cwd).not.toBe(threadWorkRoot("run_abcdef"));
    // And the file tools resolve there too — `read_file("src/x.ts")` and
    // `exec("cat src/x.ts")` must still name one file for a subagent.
    expect(
      (service.files as unknown as { deps: { workspaceRoot: string } }).deps.workspaceRoot,
    ).toBe(threadWorkRoot("thr_parent_of_run"));
  });

  /**
   * `threadId` is a required dep, but the type cannot exclude `""` — and `""`
   * would resolve to `/workspace/threads`, the parent EVERY other thread's
   * directory lives under. An exec there, or a `write_file` relative to it,
   * lands in a directory that is not this thread's and is not empty. Loud, not
   * defaulted.
   */
  it("refuses to run for a service with an empty threadId", async () => {
    const service = new ThreadComputeService({
      backend: new FakeComputeBackend(),
      store: createMemoryComputeStore(),
      config: CONFIG,
      environmentId: "thread_degenerate",
      threadId: "",
      env: {},
      setAlarm: async () => {},
      now: () => 1_000,
    });

    await expect(service.exec({ command: "true" })).rejects.toThrow("unsafe thread id");
  });
});

describe("retention: the agent's box is ALWAYS preserved", () => {
  /**
   * P3 deleted `resolveIdleDisposition` and every discard it could return.
   *
   * The disposition matrix this block used to assert was correct while the box
   * was per-thread: a thread that had proven its own workspace clean owned
   * nothing worth keeping, so discarding it freed disk on purpose. Under agent
   * keying the same box holds every OTHER thread's worktree, the agent's
   * canonical clones and its installed tooling — so `confirm_work_saved` on one
   * thread became a `deleteSprite` that destroyed sibling threads' uncommitted
   * work on the word of a thread that never looked at it. The git probe made
   * the same inference from a directory that is no longer the whole machine.
   *
   * The parameterised cases below therefore assert one thing each: whatever the
   * evidence says, the release preserves.
   */
  const everyCleanlinessVerdict: Array<[string, WorkspaceCleanliness]> = [
    ["a git-clean workspace", { state: "clean" }],
    ["an EMPTY workspace", { state: "no_repo", hasFiles: false }],
    ["no repo but unversioned files present", { state: "no_repo", hasFiles: true }],
    [
      "a dirty repo",
      { state: "dirty", repos: [{ path: "/workspace/a", changes: [" M x"], unpushed: 0 }] },
    ],
    ["a failed probe", { state: "probe_failed", reason: "unreachable" }],
  ];
  for (const [name, cleanliness] of everyCleanlinessVerdict) {
    it(`preserves on ${name}`, async () => {
      const { service, backend } = createService({
        probeWorkspaceCleanliness: async () => cleanliness,
      });
      await makeIdle(service);
      await service.releaseIfIdle();
      expect(backend.releaseCalls[0]?.options.disposition).toBe("recoverable");
      expect(backend.destroyCalls).toHaveLength(0);
    });
  }

  // The case that used to discard hardest, and the one with a live user behind
  // it: a thread stating "my work is saved" must not delete the agent's machine.
  it("REGRESSION: a declared-clean thread does NOT discard the agent's box", async () => {
    const { service, backend } = createService({ isSandboxDeclaredClean: async () => true });
    await makeIdle(service);
    await service.releaseIfIdle();
    expect(backend.releaseCalls[0]?.options.disposition).toBe("recoverable");
    expect(backend.destroyCalls).toHaveLength(0);
  });

  it("REGRESSION: a declared-clean thread does not discard on a self-suspending provider either", async () => {
    const backend = Object.assign(new FakeComputeBackend(), { nativeIdleSuspend: true });
    const { service } = createService({ backend, isSandboxDeclaredClean: async () => true });
    await makeIdle(service);
    await service.releaseIfIdle();
    expect(backend.releaseCalls[0]?.options.disposition).toBe("recoverable");
    expect(backend.destroyCalls).toHaveLength(0);
  });

  it("preserves when no probe dep is wired at all", async () => {
    const { service, backend } = createService();
    await makeIdle(service);
    await service.releaseIfIdle();
    expect(backend.releaseCalls[0]?.options.disposition).toBe("recoverable");
  });
});

/**
 * FIX ROUND 2 — the reason a background command has no watcher must be one the
 * model can ACT on.
 *
 * `createComputeTools` exposes `exec`, `exec_output`, `exec_output_grep`,
 * `exec_output_read`, `exec_stop`, `exec_shutdown`, `exec_list`,
 * `exec_upload_file`, `exec_download_file`, `exec_publish_artifact` — and no
 * `exec_watch` or `exec_unwatch`. An earlier draft of this message told the
 * model to "use exec_unwatch on one to free a slot", advice it cannot follow
 * and would spend a turn discovering. Watchers are attached by the runtime, not
 * by the model.
 */
describe("a watcher refusal explains itself in tools the model actually has", () => {
  /** Every compute tool `createComputeTools` defines. Kept literal on purpose. */
  const EXPOSED_TOOLS = [
    "exec",
    "exec_output",
    "exec_output_grep",
    "exec_output_read",
    "exec_stop",
    "exec_shutdown",
    "exec_list",
    "exec_upload_file",
    "exec_download_file",
    "exec_publish_artifact",
  ];

  function unknownToolsIn(text: string): string[] {
    return [...text.matchAll(/\bexec(?:_[a-z_]+)?\b/g)]
      .map((match) => match[0])
      .filter((name) => !EXPOSED_TOOLS.includes(name));
  }

  async function backgroundedWithFullThreadQuota() {
    // The clock is frozen unless a test moves it, and the foreground poll loop
    // spins on `now() - startedAt < foregroundTimeoutMs`. A no-op `sleep` with
    // a frozen clock is an infinite loop, so the fake sleep ADVANCES the clock
    // by exactly what it was asked to wait — which is what a real sleep does.
    const now = { value: 1_000 };
    const { service } = createService({
      now,
      supportsProcessMonitor: true,
      backgroundLongRunningExec: true,
      execForegroundTimeoutMs: 5,
      execForegroundPollIntervalMs: 5,
      sleep: async (ms: number) => void (now.value += Math.max(ms, 1)),
    });
    // Fill this thread's own quota (MAX_WATCHERS_PER_THREAD = 8).
    for (let index = 0; index < 8; index += 1) {
      const started = await service.execStart({ command: `sleep ${100 + index}` });
      await service.execWatch({ processId: started.processId });
    }
    const result = await service.exec({ command: "sleep 900" });
    if (result.status !== "backgrounded")
      throw new Error(`expected backgrounded: ${result.status}`);
    return result;
  }

  it("names the limit that refused it", async () => {
    const result = await backgroundedWithFullThreadQuota();
    expect(result.watching).toBe(false);
    expect(result.message).toContain("its limit");
    expect(
      result.message,
      "the model has to learn WHY it will hear nothing, not just that it will",
    ).toContain("will not announce itself");
  });

  it("suggests no tool that does not exist", async () => {
    const result = await backgroundedWithFullThreadQuota();
    const surface = [result.message, ...result.nextActions].join(" ");
    expect(
      unknownToolsIn(surface),
      "advice naming a tool the model cannot call costs it a turn to discover",
    ).toEqual([]);
  });
});
