import { describe, expect, it, vi } from "vitest";
import { FakeComputeBackend } from "../../../src/compute/backends/fake";
import { DEFAULT_COMPUTE_LIMITS } from "../../../src/compute/config";
import {
  ThreadComputeService,
  type ThreadComputeStoreLike,
} from "../../../src/compute/thread-service";
import type { EffectiveComputeConfig } from "../../../src/compute/types";
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
};

// A minimal "Add File" patch: no existing file or expected hash needed, so it
// exercises applyPatch without depending on writeFile/readFile behavior.
const SAMPLE_PATCH = ["*** Begin Patch", "*** Add File: a.txt", "+hello", "*** End Patch"].join(
  "\n",
);

function createService(input?: {
  markSandboxDirty?: () => Promise<void>;
  backend?: FakeComputeBackend;
  store?: ThreadComputeStoreLike;
}) {
  const backend = input?.backend ?? new FakeComputeBackend();
  const store = input?.store ?? createMemoryComputeStore();
  const now = { value: 1_000 };
  const alarms: number[] = [];
  const service = new ThreadComputeService({
    backend,
    store,
    config: CONFIG,
    environmentId: "thread_test",
    threadId: "thr_thread_service_dirty_tracking",
    env: {},
    setAlarm: async (timestamp) => void alarms.push(timestamp),
    now: () => now.value,
    ...(input?.markSandboxDirty ? { markSandboxDirty: input.markSandboxDirty } : {}),
  });
  return { service, backend, store };
}

describe("sandbox dirty tracking", () => {
  // Every method here can mutate the sandbox filesystem. A command passed to
  // exec can always write, so all three exec entry points count.
  const MUTATING = ["exec", "execStart", "execRun"] as const;

  for (const method of MUTATING) {
    it(`clears the declared-clean bit on ${method}`, async () => {
      const markSandboxDirty = vi.fn().mockResolvedValue(undefined);
      const { service } = createService({ markSandboxDirty });

      await service[method]({ command: "true" });

      expect(markSandboxDirty).toHaveBeenCalled();
    });
  }

  it("clears the bit on writeFile", async () => {
    const markSandboxDirty = vi.fn().mockResolvedValue(undefined);
    const { service } = createService({ markSandboxDirty });

    await service.files.writeFile({ path: "a.txt", content: "hi" });

    expect(markSandboxDirty).toHaveBeenCalled();
  });

  it("clears the bit on applyPatch", async () => {
    const markSandboxDirty = vi.fn().mockResolvedValue(undefined);
    const { service } = createService({ markSandboxDirty });

    await service.files.applyPatch({ patch: SAMPLE_PATCH, expectedHashes: {} });

    expect(markSandboxDirty).toHaveBeenCalled();
  });

  it("clears the bit on execUploadFile", async () => {
    const markSandboxDirty = vi.fn().mockResolvedValue(undefined);
    const { service } = createService({ markSandboxDirty });

    await service.execUploadFile({
      destinationPath: "a.txt",
      bytes: new TextEncoder().encode("hi").buffer,
    });

    expect(markSandboxDirty).toHaveBeenCalled();
  });

  it("does NOT clear the bit on execDownloadFile", async () => {
    // Seed the file with a separate service instance sharing the same
    // backend + store, so the actual download under test starts with a clean spy.
    const backend = new FakeComputeBackend();
    const store = createMemoryComputeStore();
    const seeder = createService({ backend, store }).service;
    await seeder.execUploadFile({
      destinationPath: "a.txt",
      bytes: new TextEncoder().encode("hi").buffer,
    });

    const markSandboxDirty = vi.fn().mockResolvedValue(undefined);
    const { service } = createService({ markSandboxDirty, backend, store });

    await service.execDownloadFile({ path: "a.txt", maxBytes: 1_000 });

    expect(markSandboxDirty).not.toHaveBeenCalled();
  });

  it("does NOT clear the bit on readFile", async () => {
    // Seed the file with a separate service instance sharing the same
    // backend + store, so the actual read under test starts with a clean spy.
    const backend = new FakeComputeBackend();
    const store = createMemoryComputeStore();
    const seeder = createService({ backend, store }).service;
    await seeder.files.writeFile({ path: "a.txt", content: "hi" });

    const markSandboxDirty = vi.fn().mockResolvedValue(undefined);
    const { service } = createService({ markSandboxDirty, backend, store });

    await service.files.readFile({ path: "a.txt" });

    expect(markSandboxDirty).not.toHaveBeenCalled();
  });
});
