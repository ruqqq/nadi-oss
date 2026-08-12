import { env, runInDurableObject } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import type { ThinkThreadAgent } from "../../../src/agent/think-thread-agent";
import { WorkLedgerStore } from "../../../src/agent/work-ledger-store";
import { PROCESS_STALE_AFTER_MS, type WorkRow } from "../../../src/agent/work-ledger";
import { FakeComputeBackend } from "../../../src/compute/backends/fake";
import { DEFAULT_COMPUTE_LIMITS } from "../../../src/compute/config";
import { ThreadComputeService } from "../../../src/compute/thread-service";
import type { EffectiveComputeConfig } from "../../../src/compute/types";
import { createMemoryComputeStore } from "../../unit/compute/helpers/memory-store";

const COMPUTE_CONFIG: EffectiveComputeConfig = {
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

/**
 * `listBackgroundWork` — the background-work dock's one RPC over the ledger.
 * These exercises drive the REAL DO/RPC method (not just the store), because
 * Important 1's bug (an owed row silently dropping out of the dock) lives in
 * `WorkLedgerStore.listRecent`, which `listBackgroundWork` calls with no
 * filtering of its own — coverage at the store level alone would not have
 * proven the RPC surfaces what the store returns.
 *
 * `_turnRuntimeConfig` is set directly (bypassing `resolveRuntimeConfigForThink`,
 * which requires a D1-registered thread) because `backgroundWorkAdmissionEnabled`
 * reads it before ever touching D1 when it is set — the same escape hatch a
 * real turn uses via `beforeTurn`. Only `backgroundWorkEnabled` is read off it
 * here, so a minimal cast is enough.
 */

// A standalone shape, deliberately NOT `ThinkThreadAgent & {...}` — intersecting
// with the real class collapses `_turnRuntimeConfig` to `never` under strict
// typecheck (it exists on the class as a PRIVATE member, and TS refuses to
// widen a private field via intersection). Same standalone-cast pattern
// `work-ledger-store.test.ts`'s `SweepAgent` uses for the same reason.
//
// The RPC's return type is DERIVED from the real method rather than mirrored by
// hand. A hand-written copy silently goes stale: this one still described the
// pre-`subagentStatus` shape, so the tests below type-checked against a row
// shape the DO had stopped returning — and a field the client depends on could
// have been dropped from the RPC without a single test noticing.
type TestableAgent = {
  _turnRuntimeConfig: { backgroundWorkEnabled: boolean } | null;
  listBackgroundWork(): ReturnType<ThinkThreadAgent["listBackgroundWork"]>;
  stampSubagentAlive: ThinkThreadAgent["stampSubagentAlive"];
  readBackgroundWorkOutput(processId: string): Promise<{
    head: string[];
    tail: string[];
    hiddenLines: number;
    truncated: boolean;
  } | null>;
  cancelBackgroundWork(id: string): Promise<{ ok: boolean; reason?: string }>;
  clearFinishedBackgroundWork(): Promise<{ cleared: number }>;
};

function row(overrides?: Partial<WorkRow>): WorkRow {
  return {
    id: "p1",
    kind: "process",
    startedAt: 0,
    lastAliveAt: 1_000,
    staleAfterMs: PROCESS_STALE_AFTER_MS,
    deadlineAt: 100_000,
    generation: "gen-a",
    terminal: null,
    deliveredAt: null,
    ...overrides,
  };
}

async function withAgent(
  fn: (input: { instance: TestableAgent; store: WorkLedgerStore }) => void | Promise<void>,
) {
  const id = env.THINK_THREAD_AGENT.idFromName(`bgwork-${crypto.randomUUID()}`);
  const stub = env.THINK_THREAD_AGENT.get(id);
  await runInDurableObject(stub, async (instance, state) => {
    const store = new WorkLedgerStore(state.storage);
    store.migrate();
    await fn({ instance: instance as unknown as TestableAgent, store });
  });
}

describe("ThinkThreadAgent.listBackgroundWork", () => {
  it("returns [] when background work is disabled, even with open rows", async () => {
    await withAgent(async ({ instance, store }) => {
      store.register(row({ id: "p1" }));
      instance._turnRuntimeConfig = { backgroundWorkEnabled: false };
      expect(await instance.listBackgroundWork()).toEqual([]);
    });
  });

  it("returns open rows and terminal rows with their outcome, newest first", async () => {
    await withAgent(async ({ instance, store }) => {
      instance._turnRuntimeConfig = { backgroundWorkEnabled: true };
      const now = Date.now();
      store.register(row({ id: "p1", kind: "process", startedAt: now - 2_000 }));
      store.register(row({ id: "s1", kind: "subagent", startedAt: now - 1_000 }));
      store.terminalize("s1", {
        outcome: "exited",
        reason: "process_exit",
        at: now - 500,
        detail: "code 0",
      });
      store.markDelivered("s1", now - 500);

      const rows = await instance.listBackgroundWork();
      expect(rows.map((r) => r.id)).toEqual(["s1", "p1"]);
      const byId = Object.fromEntries(rows.map((r) => [r.id, r]));
      expect(byId.p1).toMatchObject({ kind: "process", terminal: null });
      expect(byId.s1).toMatchObject({
        kind: "subagent",
        terminal: { outcome: "exited", reason: "process_exit" },
      });
    });
  });

  /**
   * I1 at the RPC boundary: a delivery that threw leaves the row terminal
   * with `deliveredAt` still null. The dock must keep showing it, not drop
   * it — this is the same case `listRecent`'s own test proves at the store
   * level, asserted again here because the RPC is a second place a filter
   * could have been (re)introduced.
   */
  it("includes an owed row — terminal with no delivery yet", async () => {
    await withAgent(async ({ instance, store }) => {
      instance._turnRuntimeConfig = { backgroundWorkEnabled: true };
      const terminalAt = Date.now() - 20 * 60_000;
      store.register(row({ id: "owed", startedAt: terminalAt }));
      store.terminalize("owed", {
        outcome: "fault",
        reason: "no_liveness",
        at: terminalAt,
        detail: "delivery threw",
      });
      const rows = await instance.listBackgroundWork();
      expect(rows.map((r) => r.id)).toEqual(["owed"]);
      expect(rows[0]?.terminal).toEqual({
        outcome: "fault",
        reason: "no_liveness",
        exitCode: null,
        subagentStatus: null,
        at: terminalAt,
      });
    });
  });

  /**
   * "Waiting for the first update" forever, at its source. The progress a
   * subagent reports through the SDK's `reportProgress` persists to the CHILD
   * facet's own storage, so the parent's `inspectAgentToolRun` — which reads the
   * parent's copy of that table — can never see it. Progress therefore has to be
   * PUSHED to the parent, which is what `stampSubagentAlive` now carries.
   */
  it("reports a running subagent's pushed progress", async () => {
    await withAgent(async ({ instance, store }) => {
      instance._turnRuntimeConfig = { backgroundWorkEnabled: true };
      store.register(row({ id: "s1", kind: "subagent" }));
      await instance.stampSubagentAlive("s1", {
        phase: "working",
        message: "working (step 3)",
        at: 4_242,
      });
      const rows = await instance.listBackgroundWork();
      expect(rows[0]!.progress).toEqual({
        phase: "working",
        message: "working (step 3)",
        at: 4_242,
      });
    });
  });

  it("drops progress once the row is terminal, and never reports it for a process", async () => {
    await withAgent(async ({ instance, store }) => {
      instance._turnRuntimeConfig = { backgroundWorkEnabled: true };
      store.register(row({ id: "s1", kind: "subagent" }));
      await instance.stampSubagentAlive("s1", { phase: "working", message: "step 3", at: 4_242 });
      store.register(row({ id: "p1", kind: "process" }));

      store.terminalize("s1", {
        outcome: "exited",
        reason: "process_exit",
        at: Date.now(),
        detail: "completed",
      });
      const byId = Object.fromEntries((await instance.listBackgroundWork()).map((r) => [r.id, r]));
      // A finished run's last step is stale by definition; its result renders
      // inline in the transcript instead.
      expect(byId.s1!.progress).toBeNull();
      expect(byId.p1!.progress).toBeNull();
    });
  });

  it("keeps liveness working when a child stamps without progress", async () => {
    await withAgent(async ({ instance, store }) => {
      instance._turnRuntimeConfig = { backgroundWorkEnabled: true };
      store.register(row({ id: "s1", kind: "subagent", lastAliveAt: 1_000 }));
      // An older child facet mid-deploy sends no progress — the liveness stamp
      // it exists for must still land, or the reaper would fault a healthy run.
      await instance.stampSubagentAlive("s1");
      expect(store.get("s1")!.lastAliveAt).toBeGreaterThan(1_000);
      expect((await instance.listBackgroundWork())[0]!.progress).toBeNull();
    });
  });

  /**
   * The mirror image of the exit-code bug, for the other kind. A subagent has
   * NO exit code, and `onAgentToolFinish` maps `completed`, `error` AND
   * `interrupted` all onto `outcome: "exited"` — so neither field the process
   * path relies on can tell a successful subagent from a crashed one. Without
   * `subagentStatus` the client read every finished subagent as a failure
   * ("1 failed", "Exit unknown"), which is what this proves is fixed.
   */
  it("reports the subagent terminal status, which its outcome cannot express", async () => {
    await withAgent(async ({ instance, store }) => {
      instance._turnRuntimeConfig = { backgroundWorkEnabled: true };
      const now = Date.now();
      for (const [id, detail] of [
        ["ok", "completed"],
        ["bad", "error"],
      ] as const) {
        store.register(row({ id, kind: "subagent" }));
        // `detail` is exactly what `onAgentToolFinish` writes: `result.status`.
        store.terminalize(id, { outcome: "exited", reason: "process_exit", at: now, detail });
      }
      const byId = Object.fromEntries((await instance.listBackgroundWork()).map((r) => [r.id, r]));
      expect(byId.ok!.terminal).toMatchObject({ outcome: "exited", subagentStatus: "completed" });
      expect(byId.bad!.terminal).toMatchObject({ outcome: "exited", subagentStatus: "error" });
      // Both indistinguishable on the fields the process path uses:
      expect(byId.ok!.terminal!.exitCode).toBeNull();
      expect(byId.bad!.terminal!.exitCode).toBeNull();
      expect(byId.ok!.terminal!.outcome).toBe(byId.bad!.terminal!.outcome);
    });
  });

  it("leaves subagentStatus null for a process row and for an unrecognized status", async () => {
    await withAgent(async ({ instance, store }) => {
      instance._turnRuntimeConfig = { backgroundWorkEnabled: true };
      const now = Date.now();
      store.register(row({ id: "p1", kind: "process" }));
      store.terminalize("p1", {
        outcome: "exited",
        reason: "process_exit",
        at: now,
        detail: "exit code 0",
        exitCode: 0,
      });
      store.register(row({ id: "s1", kind: "subagent" }));
      // A status this build does not know — a future SDK value. It must read as
      // unknown, never as success.
      store.terminalize("s1", {
        outcome: "exited",
        reason: "process_exit",
        at: now,
        detail: "vanished",
      });
      const byId = Object.fromEntries((await instance.listBackgroundWork()).map((r) => [r.id, r]));
      expect(byId.p1!.terminal!.subagentStatus).toBeNull();
      expect(byId.s1!.terminal!.subagentStatus).toBeNull();
    });
  });

  /**
   * The green-✓-on-exit-7 bug at its source: `outcome` alone cannot tone a
   * chip on failure ("exited" covers every exit code identically), so the
   * dock needs the code itself.
   */
  it("reports the exit code so the client can tone on failure", async () => {
    await withAgent(async ({ instance, store }) => {
      instance._turnRuntimeConfig = { backgroundWorkEnabled: true };
      store.register(row({ id: "p1", kind: "process" }));
      store.terminalize("p1", {
        outcome: "exited",
        reason: "process_exit",
        at: Date.now(),
        detail: "exit code 7",
        exitCode: 7,
      });
      const rows = await instance.listBackgroundWork();
      expect(rows[0]!.terminal).toMatchObject({ outcome: "exited", exitCode: 7 });
    });
  });

  it("falls back to parsing `detail` for a row terminalized before the structured exitCode field existed", async () => {
    await withAgent(async ({ instance, store }) => {
      instance._turnRuntimeConfig = { backgroundWorkEnabled: true };
      store.register(row({ id: "p1", kind: "process" }));
      // No `exitCode` on this terminal — the legacy shape.
      store.terminalize("p1", {
        outcome: "exited",
        reason: "process_exit",
        at: Date.now(),
        detail: "exit code 7",
      });
      const rows = await instance.listBackgroundWork();
      expect(rows[0]!.terminal).toMatchObject({ outcome: "exited", exitCode: 7 });
    });
  });

  /**
   * The reviewer's concern verified end-to-end: our production incident data
   * shows a poll-closed (backstop) terminal wrote `detail: "process exited"`
   * — NO code in the string — unlike the push path's `"exit code 0"`. So the
   * fallback-parse alone would return `null` here; the only thing that can
   * make this survive is `pollWatcher` actually carrying the provider's
   * `status.exitCode` into `terminalize`'s structured field. This drives the
   * REAL `pollWatcher` (via `ThreadComputeService.runComputeTick`, wired to
   * this DO's own `WorkLedgerStore` — the same storage `listBackgroundWork`
   * reads) against a process that exits 7, and asserts the code survives all
   * the way through the RPC.
   */
  it("a non-zero exit closed by the POLL path (not the push callback) still reports its exit code through listBackgroundWork", async () => {
    await withAgent(async ({ instance, store }) => {
      instance._turnRuntimeConfig = { backgroundWorkEnabled: true };

      const backend = new FakeComputeBackend();
      // Real wall-clock time, not an arbitrary small number: `listRecent()`
      // (called with no args by `listBackgroundWork`) windows "recent" off
      // `Date.now()`, so a `delivered_at` stamped from a toy clock would fall
      // outside that window and the row would vanish from the RPC for a
      // reason that has nothing to do with the exit-code plumbing this test
      // is actually proving.
      const now = { value: Date.now() };
      const service = new ThreadComputeService({
        backend,
        store: createMemoryComputeStore(),
        config: COMPUTE_CONFIG,
        environmentId: "thread_test",
        env: {},
        setAlarm: async () => {},
        now: () => now.value,
        supportsProcessMonitor: true,
        // The SAME storage `instance.listBackgroundWork()` reads — this is
        // what proves the poll path's write is visible to the RPC, not just
        // to a private test double.
        workLedger: store,
      });

      const started = await service.execStart({ command: "sleep 300", label: "build" });
      await service.execWatch({ processId: started.processId });
      const listed = await service.execList({ status: "all", limit: 10 });
      const ref = listed.processes.find((p) => p.id === started.processId)?.backendProcessRef;
      if (!ref) throw new Error("expected a backend process reference");
      // Non-zero exit, closed by the poll — never touches
      // `reportProcessCompletion`'s push path at all.
      backend.finishProcess(ref, "exited", 7);

      now.value += COMPUTE_CONFIG.monitorPollIntervalMs;
      await service.runComputeTick();

      const rows = await instance.listBackgroundWork();
      const found = rows.find((r) => r.id === started.processId);
      expect(found?.terminal).toMatchObject({ outcome: "exited", exitCode: 7 });
    });
  });

  it("reports a null exit code for a fault, which has none", async () => {
    await withAgent(async ({ instance, store }) => {
      instance._turnRuntimeConfig = { backgroundWorkEnabled: true };
      store.register(row({ id: "p1", kind: "process" }));
      store.terminalize("p1", {
        outcome: "fault",
        reason: "no_liveness",
        at: Date.now(),
        detail: "delivery threw",
      });
      const rows = await instance.listBackgroundWork();
      expect(rows[0]!.terminal).toMatchObject({ outcome: "fault", exitCode: null });
    });
  });

  it("labels fall back to the row id when no richer label can be resolved", async () => {
    await withAgent(async ({ instance, store }) => {
      instance._turnRuntimeConfig = { backgroundWorkEnabled: true };
      // Neither a real compute backend nor a real SDK run is wired up in this
      // DO, so `workFacts` for both kinds falls back to the id — proving the
      // RPC never throws (never rejects) even when its label lookup fails.
      store.register(row({ id: "p1", kind: "process" }));
      store.register(row({ id: "s1", kind: "subagent" }));
      const rows = await instance.listBackgroundWork();
      expect(rows.find((r) => r.id === "p1")?.label).toBe("p1");
      expect(rows.find((r) => r.id === "s1")?.label).toBe("s1");
    });
  });
});

describe("ThinkThreadAgent.readBackgroundWorkOutput", () => {
  it("returns null when background work is disabled", async () => {
    await withAgent(async ({ instance, store }) => {
      store.register(row({ id: "p1", kind: "process" }));
      instance._turnRuntimeConfig = { backgroundWorkEnabled: false };
      expect(await instance.readBackgroundWorkOutput("p1")).toBeNull();
    });
  });

  it("returns null for a subagent id — a subagent has no process output", async () => {
    await withAgent(async ({ instance, store }) => {
      instance._turnRuntimeConfig = { backgroundWorkEnabled: true };
      store.register(row({ id: "s1", kind: "subagent" }));
      expect(await instance.readBackgroundWorkOutput("s1")).toBeNull();
    });
  });

  it("returns null for an unknown id, never throws", async () => {
    await withAgent(async ({ instance }) => {
      instance._turnRuntimeConfig = { backgroundWorkEnabled: true };
      await expect(instance.readBackgroundWorkOutput("nope")).resolves.toBeNull();
    });
  });

  it("returns null for a process id when no compute service resolves (no sandbox wired up in this DO)", async () => {
    await withAgent(async ({ instance, store }) => {
      instance._turnRuntimeConfig = { backgroundWorkEnabled: true };
      store.register(row({ id: "p1", kind: "process" }));
      await expect(instance.readBackgroundWorkOutput("p1")).resolves.toBeNull();
    });
  });
});

describe("ThinkThreadAgent.cancelBackgroundWork", () => {
  it("returns ok:false when background work is disabled", async () => {
    await withAgent(async ({ instance, store }) => {
      store.register(row({ id: "p1", kind: "process" }));
      instance._turnRuntimeConfig = { backgroundWorkEnabled: false };
      expect(await instance.cancelBackgroundWork("p1")).toEqual({
        ok: false,
        reason: "background_work_disabled",
      });
    });
  });

  it("returns ok:false for an unknown id, never throws", async () => {
    await withAgent(async ({ instance }) => {
      instance._turnRuntimeConfig = { backgroundWorkEnabled: true };
      expect(await instance.cancelBackgroundWork("nope")).toEqual({
        ok: false,
        reason: "unknown_id",
      });
    });
  });

  it("returns ok:false for a row that is already terminal", async () => {
    await withAgent(async ({ instance, store }) => {
      instance._turnRuntimeConfig = { backgroundWorkEnabled: true };
      store.register(row({ id: "p1", kind: "process" }));
      store.terminalize("p1", {
        outcome: "exited",
        reason: "process_exit",
        at: Date.now(),
        detail: "exit code 0",
        exitCode: 0,
      });
      expect(await instance.cancelBackgroundWork("p1")).toEqual({
        ok: false,
        reason: "already_terminal",
      });
    });
  });

  it("cancels an open subagent row via cancelSubagentRun (idempotent, no-op for an unknown run)", async () => {
    await withAgent(async ({ instance, store }) => {
      instance._turnRuntimeConfig = { backgroundWorkEnabled: true };
      store.register(row({ id: "s1", kind: "subagent" }));
      expect(await instance.cancelBackgroundWork("s1")).toEqual({ ok: true });
    });
  });

  it("returns ok:false with a closed-set reason for an open process row this DO cannot actually cancel", async () => {
    await withAgent(async ({ instance, store }) => {
      instance._turnRuntimeConfig = { backgroundWorkEnabled: true };
      store.register(row({ id: "p1", kind: "process" }));
      // Discriminating on the exact reason, not just `ok === false` — a test
      // asserting only the latter would keep passing even if the process
      // branch were deleted outright. This bare test DO has no real sandbox
      // wired to "p1" specifically, so either `resolveComputeService` finds
      // nothing (`sandbox_disabled`) or it resolves and `execStop` itself
      // then fails to find the process (`cancel_failed`) — both are valid,
      // CLOSED-set outcomes; raw error text (`String(error)`) must never leak
      // through here.
      expect(await instance.cancelBackgroundWork("p1")).toEqual({
        ok: false,
        reason: expect.stringMatching(/^(sandbox_disabled|cancel_failed)$/),
      });
    });
  });
});

describe("ThinkThreadAgent.clearFinishedBackgroundWork", () => {
  it("returns cleared:0 when background work is disabled", async () => {
    await withAgent(async ({ instance }) => {
      instance._turnRuntimeConfig = { backgroundWorkEnabled: false };
      expect(await instance.clearFinishedBackgroundWork()).toEqual({ cleared: 0 });
    });
  });

  /**
   * Non-destructive by construction: the row must survive as a row (just
   * excluded from `listRecent`), because deleting it would reintroduce the
   * false `no_liveness` fault `WORK_ROW_RETENTION_MS` exists to prevent (a
   * pruned id, re-registered later, comes back as a fresh OPEN row).
   */
  it("marks delivered terminal rows so listBackgroundWork stops returning them, without deleting them", async () => {
    await withAgent(async ({ instance, store }) => {
      instance._turnRuntimeConfig = { backgroundWorkEnabled: true };
      store.register(row({ id: "p1", kind: "process" }));
      store.terminalize("p1", {
        outcome: "exited",
        reason: "process_exit",
        at: Date.now(),
        detail: "exit code 0",
        exitCode: 0,
      });
      store.markDelivered("p1", Date.now());

      expect(await instance.clearFinishedBackgroundWork()).toEqual({ cleared: 1 });
      expect(await instance.listBackgroundWork()).toEqual([]);
      // Still a real row in the store — cleared, not deleted.
      expect(store.get("p1")).not.toBeNull();

      // A repeat call finds nothing left to clear.
      expect(await instance.clearFinishedBackgroundWork()).toEqual({ cleared: 0 });
    });
  });

  it("leaves an open row and an owed (undelivered terminal) row alone", async () => {
    await withAgent(async ({ instance, store }) => {
      instance._turnRuntimeConfig = { backgroundWorkEnabled: true };
      store.register(row({ id: "open", kind: "process" }));
      store.register(row({ id: "owed", kind: "process" }));
      store.terminalize("owed", {
        outcome: "fault",
        reason: "no_liveness",
        at: Date.now(),
        detail: "delivery threw",
      });

      expect(await instance.clearFinishedBackgroundWork()).toEqual({ cleared: 0 });
      const rows = await instance.listBackgroundWork();
      expect(rows.map((r) => r.id).sort()).toEqual(["open", "owed"]);
    });
  });
});
