/**
 * Provisioning is bounded so one slow backend cannot hang a tool call forever —
 * a single `exec` once ran 154s — and bounded WITHOUT asking the backend for a
 * second sandbox, because a slow provider is the last thing that should be
 * handed duplicate work.
 *
 * It is serialized by the `acquisitionInFlight` latch alone. It used to also run
 * inside `ctx.blockConcurrencyWhile`; see `ensureRuntime` for why that is gone,
 * and the bottom of this file for the one exclusion that had to be restated
 * explicitly once it was.
 */
import { describe, expect, it, vi } from "vitest";
import { FakeComputeBackend } from "../../../src/compute/backends/fake";
import { DEFAULT_COMPUTE_LIMITS } from "../../../src/compute/config";
import { ComputeError } from "../../../src/compute/errors";
import { ThreadComputeService } from "../../../src/compute/thread-service";
import { createMemoryComputeStore } from "./helpers/memory-store";

function setup(options: { acquireDeadlineMs?: number; onAcquire?: () => Promise<void> } = {}) {
  const backend = new FakeComputeBackend();
  const acquires: number[] = [];
  if (options.onAcquire) {
    const original = backend.acquire.bind(backend);
    vi.spyOn(backend, "acquire").mockImplementation(async (...args) => {
      acquires.push(Date.now());
      await options.onAcquire!();
      return original(...args);
    });
  } else {
    const original = backend.acquire.bind(backend);
    vi.spyOn(backend, "acquire").mockImplementation(async (...args) => {
      acquires.push(Date.now());
      return original(...args);
    });
  }

  const service = new ThreadComputeService({
    backend,
    store: createMemoryComputeStore(),
    config: {
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
    },
    environmentId: "deadline_test",
    threadId: "thr_thread_service_acquire_deadline",
    env: {},
    setAlarm: async () => {},
    now: () => Date.now(),
    ...(options.acquireDeadlineMs === undefined
      ? {}
      : { acquireDeadlineMs: options.acquireDeadlineMs }),
  });
  return { service, backend, acquires };
}

describe("acquisition deadline", () => {
  it("fails with a tool error instead of overrunning the gate", async () => {
    // Longer than any deadline we would set, standing in for a backend call
    // that is bounded on its own but not in aggregate.
    const { service } = setup({
      acquireDeadlineMs: 20,
      onAcquire: () => new Promise((resolve) => setTimeout(resolve, 5_000)),
    });

    const error = await service.execRun({ command: "true" }).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(ComputeError);
    expect((error as ComputeError).message).toContain("sandbox_acquire_deadline");
    // `provider_transient` and not a hard failure: the sandbox may well still
    // be coming up, so the turn should be retryable.
    expect((error as ComputeError).code).toBe("provider_transient");
  });

  it("does not ask the backend for a second sandbox after the deadline fires", async () => {
    let release: (() => void) | undefined;
    const { service, acquires } = setup({
      acquireDeadlineMs: 20,
      onAcquire: () =>
        new Promise<void>((resolve) => {
          release = resolve;
        }),
    });

    await service.execRun({ command: "true" }).catch(() => undefined);
    // A retry lands while the first acquisition is STILL running. Starting a
    // second create here is the thing that would hand an already-slow backend
    // duplicate work, so the retry must attach to the in-flight one.
    await service.execRun({ command: "true" }).catch(() => undefined);
    expect(acquires).toHaveLength(1);

    release?.();
  });

  it("returns the runtime normally when acquisition beats the deadline", async () => {
    const { service, acquires } = setup({ acquireDeadlineMs: 5_000 });
    const result = await service.execRun({ command: "true" });
    expect(result).toBeDefined();
    expect(acquires).toHaveLength(1);
  });
});

/**
 * P3: THERE IS NO RECOVERY EXPIRY, so nothing is left that can destroy a
 * recovery reference on a timer.
 *
 * `blockConcurrencyWhile` used to be justified here by one real hazard — a
 * restore does not move the persisted status off `recoverable` while it runs,
 * so an alarm landing mid-restore reached `cleanupExpiredRecovery`, found the
 * TTL expired, and destroyed the very snapshot the restore was reading. That
 * function is gone: the box belongs to the agent and persists until the agent
 * is deleted.
 *
 * These pin the ABSENCE. `backend.destroy` on the recovery ref is what makes a
 * user's files unrecoverable, and no amount of elapsed time may reach it.
 */
describe("a recoverable box is never destroyed on a timer", () => {
  function recoverableService(options: { onAcquire?: () => Promise<void> } = {}) {
    const backend = new FakeComputeBackend();
    const destroyed: string[] = [];
    vi.spyOn(backend, "destroy").mockImplementation(async (reference) => {
      destroyed.push(String(reference));
    });
    if (options.onAcquire) {
      const original = backend.acquire.bind(backend);
      vi.spyOn(backend, "acquire").mockImplementation(async (...args) => {
        await options.onAcquire!();
        return original(...args);
      });
    }

    const store = createMemoryComputeStore();
    let clock = 1_000;
    const service = new ThreadComputeService({
      backend,
      store,
      config: {
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
      },
      environmentId: "recovery_test",
      threadId: "thr_thread_service_acquire_deadline",
      env: {},
      setAlarm: async () => {},
      now: () => clock,
    });

    // Recoverable, and NOT yet expired — the restore is legitimate when it
    // starts. The expiry lands while it is still running.
    store.markRecoverable("recovery-ref" as never, clock);
    return { service, destroyed, advance: (ms: number) => (clock += ms) };
  }

  it("does not destroy the snapshot a restore is reading", async () => {
    let release: (() => void) | undefined;
    const { service, destroyed, advance } = recoverableService({
      onAcquire: () =>
        new Promise<void>((resolve) => {
          release = resolve;
        }),
    });

    const restoring = service.execRun({ command: "true" }).catch(() => undefined);
    await vi.waitFor(() => expect(release).toBeDefined());

    // Long past what used to be the TTL, with an unrelated tick landing on top.
    advance(1_000_000);
    await service.runComputeTick();
    expect(destroyed).toEqual([]);

    release?.();
    await restoring;
  });

  it("REGRESSION: does not destroy an idle snapshot however long it sits", async () => {
    const { service, destroyed, advance } = recoverableService();
    // Far beyond `recoveryTtlMs`, across several ticks. The old code destroyed
    // here; the whole persistence feature is that this now does nothing.
    advance(1_000_000);
    await service.runComputeTick();
    advance(1_000_000);
    await service.runComputeTick();
    expect(destroyed).toEqual([]);
  });
});
