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
      environmentEditableEnv: {},
      environmentSecretEnvNames: [],
    },
    environmentId: "deadline_test",
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
 * The one thing `blockConcurrencyWhile` was genuinely protecting.
 *
 * A recovery RESTORE does not move the persisted status off `recoverable` while
 * it runs — `markAcquiring` fires only on the fresh-acquire branch, by design.
 * The gate used to make that safe by queueing every other DO event behind the
 * acquisition. Without it, an alarm landing mid-restore reaches
 * `cleanupExpiredRecovery`, finds the TTL expired, and destroys the very
 * snapshot the restore is reading — losing the workspace.
 *
 * Not hypothetical bookkeeping: `backend.destroy` on the recovery ref is what
 * makes the files unrecoverable.
 */
describe("recovery cleanup vs an in-flight restore", () => {
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
        environmentEditableEnv: {},
        environmentSecretEnvNames: [],
      },
      environmentId: "recovery_test",
      env: {},
      setAlarm: async () => {},
      now: () => clock,
    });

    // Recoverable, and NOT yet expired — the restore is legitimate when it
    // starts. The expiry lands while it is still running.
    store.markRecoverable("recovery-ref" as never, clock, clock + 100);
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

    // The TTL lapses mid-restore, then an unrelated event sweeps recoveries.
    advance(1_000);
    await service.cleanupExpiredRecoverableCompute();
    expect(destroyed).toEqual([]);

    release?.();
    await restoring;
  });

  it("still destroys an expired snapshot when nothing is restoring", async () => {
    const { service, destroyed, advance } = recoverableService();
    advance(1_000);
    await service.cleanupExpiredRecoverableCompute();
    // The guard is scoped to a live acquisition, not a blanket exemption —
    // an expired recovery with no restore in flight must still be reclaimed.
    expect(destroyed).toEqual(["recovery-ref"]);
  });
});
