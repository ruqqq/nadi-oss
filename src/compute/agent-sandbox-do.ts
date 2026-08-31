import { DurableObject } from "cloudflare:workers";
import type { Env } from "../env";
import { registryDb } from "../db/client";
import { ThreadRepository } from "../db/repositories/threads";
import { resolveComputeService } from "../agent/compute-tools";
import { ThreadComputeStore } from "./thread-store";
import { createSandboxThreadHostDeps } from "./sandbox-thread-host";
import { log } from "../log";

/**
 * Every method returns one of these. NOTHING throws across the RPC boundary:
 * a throw over DO RPC reaches the caller as a phantom rejection it cannot
 * attribute to a call, so failures are encoded and re-thrown on the near side.
 */
export type SandboxCallResult<T> =
  | { ok: true; value: T }
  | { ok: false; error: { code: string; message: string } };

function failure(code: string, message: string): SandboxCallResult<never> {
  return { ok: false, error: { code, message } };
}

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
   * The capabilities that stayed on the thread DO — transcript reminders and
   * the idle-eviction schedule — reached by RPC. Best-effort by construction:
   * see `createSandboxThreadHostDeps`.
   */
  private threadHostDeps(threadId: string) {
    return createSandboxThreadHostDeps(this.env, threadId);
  }

  /** Builds the compute service against THIS DO's storage. */
  private async resolveService(threadId: string) {
    return resolveComputeService({
      env: this.env,
      threadId,
      storage: this.ctx.storage,
      resolveRuntimeConfig: async () => {
        const thread = await new ThreadRepository(registryDb(this.env)).getById(threadId);
        if (!thread) throw new Error(`thread_not_found: ${threadId}`);
        return { workspaceId: thread.workspaceId, agentId: thread.agentId };
      },
      ...this.threadHostDeps(threadId),
      supportsProcessMonitor: false,
    });
  }

  async runCommand(input: {
    threadId: string;
    command: string;
    cwd?: string;
    timeoutMs?: number;
  }): Promise<SandboxCallResult<{ exitCode: number; stdout: string; stderr: string }>> {
    try {
      const resolved = await this.resolveService(input.threadId);
      if (!resolved) return failure("compute_disabled", "compute is not enabled for this thread");
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
      return failure("run_command_failed", String(error));
    }
  }

  async getComputeStateView(input: {
    threadId: string;
  }): Promise<SandboxCallResult<{ status: string; provider: string | null } | null>> {
    try {
      const resolved = await this.resolveService(input.threadId);
      if (!resolved) return failure("compute_disabled", "compute is not enabled for this thread");
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
      return failure("get_state_failed", String(error));
    }
  }
}
