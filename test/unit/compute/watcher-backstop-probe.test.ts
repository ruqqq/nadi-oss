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

/**
 * These tests exercise `ThreadComputeService.pollProcessStatus`'s WIRING —
 * dispatch to the combined probe, the fallback, the exec-count invariant —
 * against a deliberately thin fake. The probe's actual shell command shape
 * (the conditional acquire, the `nadi-rc:` marker, ordering) is tested
 * against the REAL `SpritesComputeBackend.buildBackstopProbe` in
 * `sprites-work-hold.test.ts` instead: a hand-rolled lookalike here would
 * agree with whatever this file asserts by construction, which is exactly
 * what let the marker-less, unconditional first version of this probe pass
 * review.
 */

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
      register: async (row: WorkRow) => void rows.set(row.id, row),
      stampAlive: async () => {},
      terminalize: async (id: string, terminal: WorkTerminal) => {
        const row = rows.get(id);
        if (!row || row.terminal) return false;
        rows.set(id, { ...row, terminal });
        terminalized.push(id);
        return true;
      },
      markDelivered: async (id: string, at: number) => {
        const row = rows.get(id);
        if (!row?.terminal || row.deliveredAt !== null) return false;
        rows.set(id, { ...row, deliveredAt: at });
        return true;
      },
      isDelivered: async (id: string) => rows.get(id)?.deliveredAt != null,
      deleteRow: async (id: string) => void rows.delete(id),
    },
  };
}

/**
 * A backend declaring `workHold` + `buildBackstopProbe` (the sprites SHAPE,
 * not its real command string — see this file's top comment). `runCommand`'s
 * reply is steered per-test via `nextRcStdout`, using the same `nadi-rc:<n>`
 * marker format the real probe emits, so `parseBackstopRc`'s own contract is
 * exercised end to end.
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
    `if [ -f /tmp/.nadi-rc-${this.pidOf(process)} ]; then printf 'nadi-rc:%s\\n' "$(cat /tmp/.nadi-rc-${this.pidOf(process)})"; ` +
    `else ${this.workHold.acquireFor(process)} || true; fi`;

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
  const store = createMemoryComputeStore();
  const service = new ThreadComputeService({
    backend,
    store,
    config: CONFIG,
    environmentId: "thread_test",
    env: {},
    setAlarm: async () => {},
    now: () => now.value,
    supportsProcessMonitor: true,
    workLedger: ledger.sink,
  });
  return { service, ledger, store };
}

describe("pollWatcher backstop probe (wiring)", () => {
  it("uses the combined probe (one runCommand call) when there is no rc yet, reasserting the hold", async () => {
    const backend = new HoldBackedBackend();
    const now = { value: 1_000 };
    const { service } = createService(backend, now);

    const started = await service.execStart({ command: "sleep 30", label: "long" });
    await service.execWatch({ processId: started.processId });
    backend.runCommandCalls.length = 0; // clear anything execStart/execWatch issued

    backend.nextRcStdout = ""; // no rc, no marker: still running
    now.value = 2_000;
    await service.runComputeTick();

    // Exactly one exec carried the hold reassert, regardless of whether the
    // fallback (a control-plane call, not an exec) also ran.
    expect(backend.runCommandCalls).toHaveLength(1);
    const command = backend.runCommandCalls[0]?.command ?? "";
    expect(command).toContain("/tasks/nadi-work-");
  });

  it("skips the fallback entirely when the probe reports a real rc (marked, from the end of stdout)", async () => {
    const backend = new HoldBackedBackend();
    const now = { value: 1_000 };
    const { service, ledger } = createService(backend, now);

    const started = await service.execStart({ command: "sleep 30", label: "long" });
    await service.execWatch({ processId: started.processId });
    const baselineStatusCalls = backend.getProcessStatusCalls;

    // A stray line ahead of the marker (the fast-path-replay hazard) must not
    // shift which line is read — the marker, not position, decides.
    backend.nextRcStdout = "warning: something unrelated\nnadi-rc:0\n";
    now.value = 2_000;
    await service.runComputeTick();

    expect(ledger.terminalized).toContain(started.processId);
    // Never fell back to getProcessStatus: the marker alone was authoritative.
    expect(backend.getProcessStatusCalls).toBe(baselineStatusCalls);
  });

  it("treats an unmarked/empty stdout as no answer, never exit code 0", async () => {
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

  it("falls back to getProcessStatus (control-plane, no second exec) when the probe has no answer yet", async () => {
    const backend = new HoldBackedBackend();
    const now = { value: 1_000 };
    const { service, ledger, store } = createService(backend, now);

    const started = await service.execStart({ command: "sleep 30", label: "long" });
    await service.execWatch({ processId: started.processId });

    // The probe reports no rc (still the common "hold needs a nudge" case),
    // but the process actually died WITHOUT ever recording an exit — the one
    // case the marker probe alone cannot see. Without the fallback this
    // watcher would sit "running" until the 1h absolute timeout; the
    // fallback must catch it via `getProcessStatus`'s session check instead.
    const ref = store.getProcess(started.processId)!.backendProcessRef!;
    backend.finishProcess(ref, "failed");
    backend.nextRcStdout = "";

    now.value = 2_000;
    await service.runComputeTick();

    expect(ledger.terminalized).toContain(started.processId);
  });
});
