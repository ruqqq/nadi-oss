import { describe, expect, it } from "vitest";
import { FakeComputeBackend } from "../../../src/compute/backends/fake";
import { DEFAULT_COMPUTE_LIMITS } from "../../../src/compute/config";
import { ThreadComputeService } from "../../../src/compute/thread-service";
import type { EffectiveComputeConfig } from "../../../src/compute/types";
import type {
  BackendProcessReference,
  BackendReference,
  RunCommandInput,
  RunCommandResult,
} from "../../../src/compute/backend";
import type { WorkRow, WorkTerminal } from "../../../src/agent/work-ledger";
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

/** Minimal `WorkLedgerSink` spy — mirrors the one in watcher-fault.test.ts. */
function createLedgerSpy() {
  const rows = new Map<string, WorkRow>();
  const terminalized: string[] = [];
  return {
    terminalized,
    sink: {
      register: (row: WorkRow) => void rows.set(row.id, row),
      stampAlive: () => {},
      terminalize: (id: string, terminal: WorkTerminal) => {
        const row = rows.get(id);
        if (!row || row.terminal) return false;
        rows.set(id, { ...row, terminal });
        terminalized.push(id);
        return true;
      },
      markDelivered: (id: string, at: number) => {
        const row = rows.get(id);
        if (!row?.terminal || row.deliveredAt !== null) return false;
        rows.set(id, { ...row, deliveredAt: at });
        return true;
      },
      isDelivered: (id: string) => rows.get(id)?.deliveredAt != null,
      deleteRow: (id: string) => void rows.delete(id),
    },
  };
}

/**
 * A backend declaring `workHold` + `buildBackstopProbe` (the sprites shape).
 * `getProcessStatus` calls are counted (execWatch's own baseline read still
 * goes through it — that's a separate call site, not the poll) so a test can
 * assert `pollWatcher` itself never calls it when the combined probe is
 * available. `runCommand`'s reply is steered per-test via `nextRcStdout`.
 */
class HoldBackedBackend extends FakeComputeBackend {
  nextRcStdout = "";
  getProcessStatusCalls = 0;

  readonly workHold = {
    acquireFor: (process: BackendProcessReference): string =>
      `curl -sf -X POST /tasks/nadi-work-${this.pidOf(process)} >/dev/null 2>&1`,
    refreshFor: (process: BackendProcessReference): string =>
      `curl -sf -X PUT /tasks/nadi-work-${this.pidOf(process)} >/dev/null 2>&1`,
    releaseFor: (process: BackendProcessReference): string =>
      `curl -sf -X DELETE /tasks/nadi-work-${this.pidOf(process)} >/dev/null 2>&1`,
  };

  buildBackstopProbe = (process: BackendProcessReference): string =>
    `cat /tmp/.nadi-rc-${this.pidOf(process)} 2>/dev/null || true; ${this.workHold.acquireFor(process)} || true`;

  constructor() {
    super();
    // Wrap rather than `override`: the base method is overloaded (a legacy
    // shape plus the real one), and a fixed-signature override can't satisfy
    // both branches. Counting calls is all this test needs.
    const original = this.getProcessStatus.bind(this);
    this.getProcessStatus = ((...args: Parameters<typeof original>) => {
      this.getProcessStatusCalls += 1;
      return original(...args);
    }) as typeof original;
  }

  override async runCommand(
    _runtime: BackendReference,
    input: RunCommandInput,
  ): Promise<RunCommandResult> {
    this.runCommandCalls.push({ command: input.command });
    return { status: "exited", exitCode: 0, stdout: this.nextRcStdout, stderr: "" };
  }

  private pidOf(process: BackendProcessReference): string {
    const payload = process.payload as { processId?: string };
    return payload.processId ?? "unknown";
  }
}

function createService(backend: FakeComputeBackend, now: { value: number }) {
  const ledger = createLedgerSpy();
  const service = new ThreadComputeService({
    backend,
    store: createMemoryComputeStore(),
    config: CONFIG,
    environmentId: "thread_test",
    env: {},
    setAlarm: async () => {},
    now: () => now.value,
    supportsProcessMonitor: true,
    workLedger: ledger.sink,
  });
  return { service, ledger };
}

describe("pollWatcher backstop probe", () => {
  it("uses the combined probe (one runCommand call) instead of getProcessStatus, reasserting the hold", async () => {
    const backend = new HoldBackedBackend();
    const now = { value: 1_000 };
    const { service } = createService(backend, now);

    const started = await service.execStart({ command: "sleep 30", label: "long" });
    await service.execWatch({ processId: started.processId });
    backend.runCommandCalls.length = 0; // clear anything execStart/execWatch issued
    const baselineStatusCalls = backend.getProcessStatusCalls;

    backend.nextRcStdout = ""; // still running: no rc recorded yet
    now.value = 2_000;
    await service.runComputeTick();

    expect(backend.runCommandCalls).toHaveLength(1);
    const command = backend.runCommandCalls[0]?.command ?? "";
    expect(command).toContain("cat /tmp/.nadi-rc-");
    expect(command).toContain("/tasks/nadi-work-");
    // The poll used the combined probe, not a separate getProcessStatus call.
    expect(backend.getProcessStatusCalls).toBe(baselineStatusCalls);
  });

  it("treats an unparsable/empty rc as still running, never exit code 0", async () => {
    const backend = new HoldBackedBackend();
    const now = { value: 1_000 };
    const { service, ledger } = createService(backend, now);

    const started = await service.execStart({ command: "sleep 30", label: "long" });
    await service.execWatch({ processId: started.processId });

    backend.nextRcStdout = "";
    now.value = 2_000;
    await service.runComputeTick();

    expect(ledger.terminalized).not.toContain(started.processId);
  });

  it("closes the watcher when the probe's first stdout line is a real rc", async () => {
    const backend = new HoldBackedBackend();
    const now = { value: 1_000 };
    const { service, ledger } = createService(backend, now);

    const started = await service.execStart({ command: "sleep 30", label: "long" });
    await service.execWatch({ processId: started.processId });

    backend.nextRcStdout = "0\n";
    now.value = 2_000;
    await service.runComputeTick();

    expect(ledger.terminalized).toContain(started.processId);
  });
});
