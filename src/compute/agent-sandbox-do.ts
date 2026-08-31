import { DurableObject } from "cloudflare:workers";
import type { Env } from "../env";
import { registryDb } from "../db/client";
import { ThreadRepository } from "../db/repositories/threads";
import { resolveComputeService } from "../agent/compute-tools";
import { ThreadComputeStore } from "./thread-store";
import { createSandboxThreadHostDeps } from "./sandbox-thread-host";
import { createRepositoryPreparation } from "../agent/repository-preparation";
import { probeWorkspaceCleanliness } from "./workspace-cleanliness";
import type { ThreadComputeService } from "./thread-service";
import type { BackendReference } from "./backend";
import {
  SandboxSession,
  encodeSandboxError,
  sandboxFailure,
  type SandboxCallResult,
} from "./agent-sandbox-session";
import type { EffectiveComputeConfig } from "./types";
import { log } from "../log";

/**
 * Every method returns one of these. NOTHING throws across the RPC boundary:
 * a throw over DO RPC reaches the caller as a phantom rejection it cannot
 * attribute to a call, so failures are encoded and re-thrown on the near side.
 *
 * Defined alongside {@link SandboxSession} — the session target is the largest
 * consumer of the convention — and re-exported here because every existing
 * caller (`sandbox-thread-host.ts`, `think-thread-agent.ts`) names it off this
 * module.
 */
export type { SandboxCallResult, SandboxCallError } from "./agent-sandbox-session";

/**
 * Owns a compute sandbox and the SQLite that tracks it — the store, processes,
 * output chunks and watchers that used to live in each thread's own Durable
 * Object. The thread DO keeps the conversation; this owns the machine.
 *
 * Keyed by `threadId`, so behaviour matches the thread-local path it replaces.
 * P3 re-keys it to `agentId`.
 */
export class AgentSandbox extends DurableObject<Env> {
  /**
   * The capabilities that stayed on the thread DO — transcript reminders, the
   * idle-eviction schedule, the work ledger, the child-subagent lease and the
   * "workspace verified clean" bit — reached by RPC. Best-effort by
   * construction, with ONE deliberate exception on the watcher-poll reminder:
   * see `createSandboxThreadHostDeps`.
   */
  private threadHostDeps(threadId: string) {
    return createSandboxThreadHostDeps(this.env, threadId);
  }

  /**
   * Builds the compute service against THIS DO's storage.
   *
   * `supportsProcessMonitor` is a REQUIRED caller-supplied value, never a
   * default. It is the flag that admits background work at all: with it false
   * `execWatch` throws `compute_process_monitor_unavailable`
   * (`thread-service.ts:1660`), a long-running `exec` is backgrounded WITHOUT a
   * watcher (`:1189`), and `autoWatchRunningProcesses` returns an empty list
   * (`:1893`). None of that FAILS — the tool surface merely changes shape — so a
   * wrong value here turns background work off silently, with every test still
   * green. Making it required is what stops a caller acquiring that behaviour by
   * forgetting to state it; the thread DO's real value is
   * `ThinkThreadAgent.processMonitorEnabled()`, threaded through
   * `sandboxHostDeps()`.
   */
  private async resolveService(
    threadId: string,
    options: { supportsProcessMonitor: boolean; attachedRuntime?: BackendReference },
  ) {
    // The two deps that must run against THIS DO's own service rather than
    // round-tripping through `resolveComputeService` again.
    //
    // `onFreshRuntimeAcquired` is wired to `createRepositoryPreparation`, which
    // takes a `resolveComputeService`. On the thread DO that closed over
    // `sandboxHostDeps()`; here the same shape would re-enter this very DO —
    // and it fires from INSIDE `readOrAcquireRuntime`, i.e. from inside a
    // method of the service being resolved, so the re-entrant call would sit
    // behind the same DO's input lock waiting for the acquire that is waiting
    // for it. `probeWorkspaceCleanliness` has the identical shape (it exec-runs
    // git against the sandbox) and the identical hazard.
    //
    // Both are broken by a holder rather than a second resolve: the local
    // service is stamped in once `resolveComputeService` returns, and NEITHER
    // dep can fire before then — `onFreshRuntimeAcquired` only from
    // `readOrAcquireRuntime`, `probeWorkspaceCleanliness` only from
    // `resolveIdleDisposition`, both service methods that cannot be called
    // until the caller holds the service. A null holder is therefore
    // unreachable, and both arms below say what they would mean if it were.
    const local: { service: ThreadComputeService | null } = { service: null };
    const prepareRepositories = createRepositoryPreparation({
      env: this.env,
      threadId,
      resolveComputeService: async () => (local.service ? { service: local.service } : null),
    });
    const resolved = await resolveComputeService({
      env: this.env,
      threadId,
      storage: this.ctx.storage,
      resolveRuntimeConfig: async () => {
        const thread = await new ThreadRepository(registryDb(this.env)).getById(threadId);
        if (!thread) throw new Error(`thread_not_found: ${threadId}`);
        return { workspaceId: thread.workspaceId, agentId: thread.agentId };
      },
      ...this.threadHostDeps(threadId),
      supportsProcessMonitor: options.supportsProcessMonitor,
      // NOT on the plan's list of thread-bound deps, and it had to be: the
      // thread DO supplies `processMonitorEnabled && !attachedRuntime`, while
      // `resolveComputeService` defaults an omitted value to `!attachedRuntime`
      // alone. Leaving it out would let a runtime that cannot deliver a
      // completion reminder background a long-running exec anyway — background
      // work turned back ON silently, the mirror image of the
      // `supportsProcessMonitor` trap above. It is a pure function of the two
      // values the caller already states, so it is derived here rather than
      // added as a third input a caller could forget.
      backgroundLongRunningExec: options.supportsProcessMonitor && !options.attachedRuntime,
      // Plain serializable data, not a capability: an attached subagent's
      // parent runtime reference travels as an RPC INPUT. Nothing to relocate.
      ...(options.attachedRuntime ? { attachedRuntime: options.attachedRuntime } : {}),
      probeWorkspaceCleanliness: async () => {
        if (!local.service) return { state: "probe_failed", reason: "no_compute_service" };
        return probeWorkspaceCleanliness((command, timeoutMs) =>
          local.service!.execRun({ command, timeoutMs, label: "workspace cleanliness" }),
        );
      },
      onFreshRuntimeAcquired: async () => {
        const result = await prepareRepositories();
        // A SKIP is not an error, so nothing throws and the `catch` around this
        // call never fires — which is exactly how a provider-contract mismatch
        // left every workbench sandbox with an empty /workspace while the logs
        // stayed clean. Skips are the interesting outcome here; say so, or the
        // next such break is invisible too.
        if (result.skipped?.length) {
          log.warn("compute.repository_preparation_skipped", {
            threadId,
            skipped: result.skipped.map((entry) => `${entry.name}: ${entry.reason}`),
          });
        }
      },
    });
    local.service = resolved?.service ?? null;
    return resolved;
  }

  /**
   * Opens a per-turn session: ONE resolved {@link ThreadComputeService} wrapped
   * in an {@link SandboxSession} `RpcTarget`, so the several D1 reads and the
   * GitHub App token mint `resolveComputeService` costs are paid once for the
   * turn — matching the thread DO's own memoization at
   * `think-thread-agent.ts:1418`, which is why a flat method-per-operation
   * surface was rejected.
   *
   * `workspaceId` and `config` ride along because every consumer of
   * `resolveComputeService` needs them beside the service (tool gating reads
   * `config.allowedHosts`, `config.secretEnvNames`, `config.editableEnv`) and
   * they are plain JSON, so shipping them with the session costs nothing and
   * saves a second round trip.
   *
   * `value: null` means compute is DISABLED for this thread — the same signal
   * `resolveComputeService` gives by returning `null`, which callers must treat
   * as "hide every compute tool, schedule no eviction alarm". That is distinct
   * from `ok: false`, which means the resolve itself failed.
   */
  async session(input: {
    threadId: string;
    /** Required — see {@link resolveService}. The caller states it; no default. */
    supportsProcessMonitor: boolean;
    /** An attached subagent's parent runtime, when this thread shares a machine. */
    attachedRuntime?: BackendReference;
  }): Promise<
    SandboxCallResult<{
      session: SandboxSession;
      workspaceId: string;
      config: EffectiveComputeConfig;
    } | null>
  > {
    try {
      const resolved = await this.resolveService(input.threadId, {
        supportsProcessMonitor: input.supportsProcessMonitor,
        ...(input.attachedRuntime ? { attachedRuntime: input.attachedRuntime } : {}),
      });
      if (!resolved) return { ok: true, value: null };
      return {
        ok: true,
        value: {
          session: new SandboxSession(resolved.service),
          workspaceId: resolved.workspaceId,
          config: resolved.config,
        },
      };
    } catch (error) {
      log.warn("agent_sandbox.session_failed", {
        threadId: input.threadId,
        error: String(error),
      });
      // The ENCODER, not `sandboxFailure`: a `ComputeError` thrown out of the
      // resolve would otherwise reach the near side as an anonymous error with
      // its code buried in a `session_failed:`-prefixed message, and
      // `toErrorResult` would show the model a string it cannot act on.
      // Latent today — `resolveComputeService` has no throw of its own — but
      // this is the one place in the module that was not using the encoder it
      // sits next to.
      return { ok: false, error: encodeSandboxError(error) };
    }
  }

  async runCommand(input: {
    threadId: string;
    command: string;
    /** Required — see {@link resolveService}. The caller states it; no default. */
    supportsProcessMonitor: boolean;
    /** An attached subagent's parent runtime, when this thread shares a machine. */
    attachedRuntime?: BackendReference;
    cwd?: string;
    timeoutMs?: number;
  }): Promise<SandboxCallResult<{ exitCode: number; stdout: string; stderr: string }>> {
    try {
      const resolved = await this.resolveService(input.threadId, {
        supportsProcessMonitor: input.supportsProcessMonitor,
        ...(input.attachedRuntime ? { attachedRuntime: input.attachedRuntime } : {}),
      });
      if (!resolved)
        return sandboxFailure("compute_disabled", "compute is not enabled for this thread");
      const result = await resolved.service.execRun({
        command: input.command,
        ...(input.cwd === undefined ? {} : { cwd: input.cwd }),
        ...(input.timeoutMs === undefined ? {} : { timeoutMs: input.timeoutMs }),
      });
      return {
        ok: true,
        value: {
          exitCode: result.exitCode,
          stdout: result.stdout,
          stderr: result.stderr,
        },
      };
    } catch (error) {
      log.warn("agent_sandbox.run_command_failed", {
        threadId: input.threadId,
        error: String(error),
      });
      return sandboxFailure("run_command_failed", String(error));
    }
  }

  async getComputeStateView(input: {
    threadId: string;
    /** Required — see {@link resolveService}. The caller states it; no default. */
    supportsProcessMonitor: boolean;
    /** An attached subagent's parent runtime, when this thread shares a machine. */
    attachedRuntime?: BackendReference;
  }): Promise<SandboxCallResult<{ status: string; provider: string | null } | null>> {
    try {
      const resolved = await this.resolveService(input.threadId, {
        supportsProcessMonitor: input.supportsProcessMonitor,
        ...(input.attachedRuntime ? { attachedRuntime: input.attachedRuntime } : {}),
      });
      if (!resolved)
        return sandboxFailure("compute_disabled", "compute is not enabled for this thread");
      // `ThreadComputeService` exposes no public state getter — the store it
      // wraps holds `getComputeState()`. Rebuilding it against the SAME
      // storage/limits `resolveComputeService` just used is cheap (`migrate()`
      // is idempotent, `CREATE TABLE IF NOT EXISTS`) and is this repo's real
      // seam for reading state outside the service.
      const store = new ThreadComputeStore(this.ctx.storage, resolved.config.limits);
      store.migrate();
      const state = store.getComputeState();
      if (!state) return { ok: true, value: null };
      return { ok: true, value: { status: state.status, provider: state.provider ?? null } };
    } catch (error) {
      return sandboxFailure("get_state_failed", String(error));
    }
  }
}
