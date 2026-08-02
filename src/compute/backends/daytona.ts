import { z } from "zod";
import type {
  BackendProcessReference,
  BackendReference,
  ComputeBackend,
  ComputeSpec,
  DirEntry,
  PathInfo,
  ProcessOutput,
  ProcessOutputSink,
  ProcessStatus,
  ReadFileResult,
  ReleaseOptions,
  StartProcessInput,
  StartProcessResult,
  StopMode,
  WriteFileOptions,
} from "../backend";
import { ComputeError } from "../errors";

/**
 * Where a session command writes its own exit code.
 *
 * Keyed by session id, which is minted fresh per command (`nadi-<uuid>`), so a
 * sentinel can never be read for the wrong process.
 */
export function exitSentinelPath(sessionId: string): string {
  return `/tmp/.nadi-rc-${sessionId}`;
}

/**
 * How long a sentinel probe may be skipped after the previous one, in ms.
 *
 * The synchronous exec path polls status every 500ms, and probing on every poll
 * would double Daytona API calls for every running command. Detecting an exit a
 * couple of seconds late is irrelevant next to the minutes this recovers.
 */
export const EXIT_SENTINEL_PROBE_INTERVAL_MS = 2_000;

/**
 * How long Daytona must have been silent about a command before the sentinel is
 * probed at all.
 *
 * The probe is an extra HTTP round-trip on a 500ms poll loop, and #85 ran it
 * from the very first silent poll. That taxed EVERY command, including the
 * overwhelming majority that Daytona reports normally within a second or two:
 * warm `echo` went from a 2.6-3.0s baseline to 6.5-25s in production.
 *
 * The sentinel exists solely to rescue commands wedged by an orphan holding the
 * session pipe — a condition that lasts as long as the orphan does, typically
 * minutes. Waiting ten seconds before the first probe therefore costs the
 * pathological case almost nothing (123s became ~11s instead of ~6s) and costs
 * the normal case nothing at all, because the probe never happens.
 */
export const EXIT_SENTINEL_GRACE_MS = 10_000;

/**
 * Append the exit-code sentinel to a command.
 *
 * WHY THIS EXISTS. Daytona reports a session command's `exitCode` only once
 * every descendant releases the session's stdout/stderr pipe — not when the
 * command itself exits. So `sleep 120 & echo hi` reads as `running` for 120
 * seconds although its shell finished immediately (measured live: 123.0s versus
 * 3.5s for the same command with the child's output redirected away). With
 * background work disabled the synchronous exec path blocks on that for up to
 * `maxProcessRuntimeMs` — ten minutes by default.
 *
 * The sentinel decouples exit detection from pipe closure: the shell writes its
 * own status the instant it finishes, and `getProcessStatus` reads that. Live
 * measurement of the wrapped form: sentinel readable at ≤10s where Daytona's own
 * `exitCode` arrived at 62.6s.
 *
 * SEMANTICS. `$?` is captured on the line immediately after the command, so it
 * is the status of the command's LAST element — exactly what the shell itself
 * would report, including `0` for a command ending in `&`. stderr from the write
 * is discarded so the sentinel can never appear in the command's own output.
 *
 * THE TRAILING `( exit "$__nadi_rc" )` IS LOAD-BEARING — do not drop it as dead
 * code. Daytona reports the exit status of the WHOLE script it was handed, which
 * is the status of its last command. Without this line that is the `printf`,
 * which essentially always succeeds, so every failing command came back
 * `exitCode: 0` — a silent failure-as-success, and far worse than the latency
 * this wrapper exists to fix. Shipped that way in #85 and caught in production;
 * the guard is "preserves the command's own exit status as the SCRIPT's status"
 * in `daytona-exit-sentinel.test.ts`, which asserts the spawned script's exit
 * code and not merely the sentinel's contents. A subshell rather than a bare
 * `exit`, because `exit` terminates the session shell itself.
 *
 * THE SUBSHELL AROUND THE COMMAND IS ALSO LOAD-BEARING. Daytona runs each
 * command inside a persistent session shell, so a bare `exit N` terminates that
 * SHELL — and Daytona then never records the command's completion at all.
 * Measured in production: `echo out; exit 7` ran for the full
 * `maxProcessRuntimeMs` and came back `status: "stopped", exitCode: -1` after
 * 606s. Running the command in `( ... )` confines `exit` to the subshell: the
 * session shell survives, `$?` is the real status, and the sentinel is written.
 * Verified live — `( echo out; echo err >&2; exit 7 )` returns in 5.1s with
 * exitCode 7 and both streams intact. It also rescues `exec`, which now replaces
 * only the subshell (`( exec sh -c "echo replaced; exit 5" )` -> exitCode 5).
 *
 * A subshell cannot change the session shell's own environment, which costs
 * nothing here: every exec gets a FRESH session, and the working directory is
 * set by a separate `cd` command before this one, so the subshell inherits it.
 * Confirmed live: `pwd` reports /workspace, `cd /tmp && pwd` reports /tmp, and a
 * heredoc survives.
 *
 * DEGRADATION. A command killed by a signal never reaches the trailing line. No
 * sentinel appears and behaviour falls back to exactly today's — whenever
 * Daytona's `exitCode` arrives. That is a missed improvement, never a regression.
 *
 * A command whose final line ends in a backslash continuation is left UNWRAPPED.
 * Appending to it would splice the sentinel into the user's own command line and
 * change what runs; refusing to wrap costs only the improvement.
 */
export function withExitSentinel(command: string, sessionId: string): string {
  if (/\\\s*$/.test(command)) return command;
  // `( )` with nothing in it is a syntax error, so a blank command must not be
  // wrapped — it would turn a harmless no-op into a failing one.
  if (!command.trim()) return command;
  const path = exitSentinelPath(sessionId);
  return (
    `(\n${command}\n)\n` +
    `__nadi_rc=$?\n` +
    `printf %s "$__nadi_rc" > ${path} 2>/dev/null\n` +
    `( exit "$__nadi_rc" )\n`
  );
}

type DaytonaClient = {
  create(input: Record<string, unknown> & { domainAllowList?: string }): Promise<{
    id?: string;
    name?: string;
    delete?: (timeout?: number) => Promise<void>;
  }>;
  get?(id: string): Promise<DaytonaSandboxLike>;
};

type DaytonaConstructor = new (input: {
  apiKey: string;
  apiUrl?: string;
  target?: string;
}) => DaytonaClient;

type DaytonaSandboxLike = {
  id?: string;
  delete?: (timeout?: number) => Promise<void>;
  stop?: (timeout?: number, force?: boolean) => Promise<void>;
  archive?: () => Promise<void>;
  start?: (timeout?: number) => Promise<void>;
  process: {
    createSession(sessionId: string): Promise<void>;
    deleteSession?(sessionId: string): Promise<void>;
    executeSessionCommand(
      sessionId: string,
      req: { command: string; runAsync?: boolean; suppressInputEcho?: boolean },
      timeout?: number,
    ): Promise<{ cmdId?: string; exitCode?: number; stdout?: string; stderr?: string }>;
    getSessionCommand?(
      sessionId: string,
      commandId: string,
    ): Promise<{ exitCode?: number; command?: string }>;
    getSessionCommandLogs(
      sessionId: string,
      commandId: string,
      onStdout?: (chunk: string) => void,
      onStderr?: (chunk: string) => void,
    ): Promise<{ stdout?: string; stderr?: string; output?: string } | void>;
    sendSessionCommandInput?(sessionId: string, commandId: string, data: string): Promise<void>;
  };
  fs?: {
    uploadFile?(bytes: Uint8Array | ArrayBuffer, path: string): Promise<void>;
    downloadFile?(path: string): Promise<ArrayBuffer | Uint8Array>;
    createFolder?(path: string, mode: string): Promise<void>;
    deleteFile?(path: string, recursive?: boolean): Promise<void>;
    moveFiles?(source: string, destination: string): Promise<void>;
    getFileDetails?(
      path: string,
    ): Promise<{ isDir: boolean; size: number; permissions?: string; mode?: string }>;
    listFiles?(path: string): Promise<Array<{ name: string; isDir?: boolean }>>;
  };
};

interface LegacySandboxHandle {
  provider: string;
  providerSandboxId: string;
}

interface LegacyProcessHandle {
  sessionId?: string;
  commandId?: string;
}

type LegacyStartProcessInput = Omit<StartProcessInput, "stdin" | "timeoutMs"> & {
  timeoutMs?: number;
};

type LegacyStartProcessResult = Omit<StartProcessResult, "process" | "status"> & {
  process: LegacyProcessHandle;
  status: "running" | "exited" | "failed";
};

const runtimePayloadSchema = z.object({ kind: z.literal("runtime"), sandboxId: z.string().min(1) });
const recoveryPayloadSchema = z.object({
  kind: z.literal("recovery"),
  sandboxId: z.string().min(1),
});
const processPayloadSchema = z.object({
  kind: z.literal("process"),
  sandboxId: z.string().min(1),
  sessionId: z.string().min(1),
  commandId: z.string().min(1),
});
const daytonaReferenceSchema = z.discriminatedUnion("provider", [
  z.object({
    provider: z.literal("daytona"),
    version: z.literal(1),
    payload: z.discriminatedUnion("kind", [
      runtimePayloadSchema,
      recoveryPayloadSchema,
      processPayloadSchema,
    ]),
  }),
]);

/** Daytona implementation of the provider-neutral compute contract. */
export class DaytonaComputeBackend implements ComputeBackend {
  readonly id = "daytona" as const;
  /** Injected client (test seam). Readonly, so the lazy one lives separately. */
  private readonly client: DaytonaClient | undefined;
  private lazyClient: DaytonaClient | undefined;
  /**
   * `client.get(id)` is an HTTP round-trip, and one backend instance serves a
   * whole operation: `assertPathContained` inspects every path component, so a
   * multi-file `apply_patch` made ~O(paths x depth) identical calls. Invalidated
   * whenever we stop or destroy the sandbox the handle refers to.
   */
  private readonly sandboxCache = new Map<string, DaytonaSandboxLike>();
  /**
   * Per session: when Daytona was FIRST seen to be silent about the command, and
   * when the sentinel was last probed. Together they gate the extra file read on
   * the 500ms status poll — see {@link EXIT_SENTINEL_GRACE_MS} and
   * {@link EXIT_SENTINEL_PROBE_INTERVAL_MS}. Instance-scoped like
   * `sandboxCache`: losing it on a new backend instance restarts the grace
   * window, which costs a little latency and never correctness.
   */
  private readonly sentinelSilentSince = new Map<string, number>();
  private readonly sentinelProbedAt = new Map<string, number>();
  private readonly config: {
    apiKey: string;
    apiUrl?: string | null;
    target?: string | null;
  };
  private readonly source: { image?: string; snapshot?: string } | undefined;

  constructor(input: {
    apiKey: string;
    apiUrl?: string | null;
    target?: string | null;
    source?: { image?: string; snapshot?: string };
    client?: DaytonaClient;
  }) {
    this.client = input.client;
    this.source = input.source;
    this.config = {
      apiKey: input.apiKey,
      ...(input.apiUrl !== undefined ? { apiUrl: input.apiUrl } : {}),
      ...(input.target !== undefined ? { target: input.target } : {}),
    };
  }

  async acquire(spec: ComputeSpec, recovery?: BackendReference): Promise<BackendReference> {
    if (recovery) {
      const parsed = daytonaReferenceSchema.parse(recovery);
      if (parsed.payload.kind !== "recovery") {
        throw new ComputeError("recovery_failed", "daytona_recovery_reference_invalid");
      }
      const sandbox = await this.getSandbox(parsed.payload.sandboxId);
      if (!sandbox.start) throw new ComputeError("recovery_failed", "daytona_resume_unsupported");
      await sandbox.start();
      const runtime = this.runtimeReference(parsed.payload.sandboxId);
      await this.ensureWorkspaceRoot(runtime, spec.workspaceRoot);
      return runtime;
    }

    const sandbox = await (
      await this.getClient()
    ).create({
      ...this.sourceInput(this.source),
      envVars: spec.env,
      autoStopInterval: 0,
      ...(spec.allowedHosts?.length ? { domainAllowList: spec.allowedHosts.join(",") } : {}),
    });
    const sandboxId = sandbox.id ?? sandbox.name;
    if (!sandboxId) throw new ComputeError("provider_transient", "daytona_sandbox_id_missing");
    const runtime = this.runtimeReference(sandboxId);
    await this.ensureWorkspaceRoot(runtime, spec.workspaceRoot);
    return runtime;
  }

  // The sandbox boots at /root with no workspace root; create it here so every
  // runtime the backend hands out (fresh or resumed) has the directory that
  // file tools and relative-path exec resolve against. `createFolder` is
  // mkdir -p-shaped (idempotent), so re-running on a resumed sandbox is safe.
  private async ensureWorkspaceRoot(runtime: BackendReference, root: string): Promise<void> {
    await this.createDirectory(runtime, root);
  }

  async release(
    runtime: BackendReference,
    options: ReleaseOptions,
  ): Promise<BackendReference | null> {
    const sandboxId = this.runtimeId(runtime);
    const sandbox = await this.getSandbox(sandboxId);
    if (options.disposition === "discard") {
      await sandbox.delete?.();
      this.invalidateSandbox(sandboxId);
      return null;
    }
    if (!sandbox.stop) throw new ComputeError("provider_transient", "daytona_stop_unsupported");
    if (!sandbox.archive)
      throw new ComputeError("provider_transient", "daytona_archive_unsupported");
    await sandbox.stop();
    try {
      await sandbox.archive();
    } catch (error) {
      // The service rolls a failed release back to active. Restore that actual
      // provider state too; otherwise the next command targets a stopped
      // sandbox through an "active" runtime reference.
      await sandbox.start?.().catch(() => {});
      throw error;
    }
    // An archived sandbox's handle must not be reused: a later start re-fetches
    // it and lets Daytona restore the archived filesystem.
    this.invalidateSandbox(sandboxId);
    return this.recoveryReference(sandboxId);
  }

  async destroy(reference: BackendReference): Promise<void> {
    const parsed = daytonaReferenceSchema.parse(reference);
    if (parsed.payload.kind === "process") {
      throw new ComputeError("runtime_missing", "daytona_runtime_reference_invalid");
    }
    const sandbox = await this.getSandbox(parsed.payload.sandboxId);
    await sandbox.delete?.();
    this.invalidateSandbox(parsed.payload.sandboxId);
  }

  async startProcess(
    runtime: BackendReference,
    input: StartProcessInput,
  ): Promise<StartProcessResult>;
  async startProcess(
    runtime: LegacySandboxHandle,
    input: LegacyStartProcessInput,
  ): Promise<LegacyStartProcessResult>;
  async startProcess(
    runtime: BackendReference | LegacySandboxHandle,
    input: StartProcessInput | LegacyStartProcessInput,
  ): Promise<StartProcessResult | LegacyStartProcessResult> {
    const sandboxId = isBackendReference(runtime)
      ? this.runtimeId(runtime)
      : runtime.providerSandboxId;
    const result = await this.startDaytonaProcess(sandboxId, input);
    if (isBackendReference(runtime)) return result;
    return {
      ...result,
      process: {
        sessionId: this.processPayload(result.process).sessionId,
        commandId: this.processPayload(result.process).commandId,
      },
      status: result.status as "running" | "exited" | "failed",
    };
  }

  async getProcessStatus(
    runtime: BackendReference,
    process: BackendProcessReference,
  ): Promise<ProcessStatus>;
  async getProcessStatus(
    runtime: LegacySandboxHandle,
    process: LegacyProcessHandle,
  ): Promise<ProcessStatus>;
  async getProcessStatus(
    runtime: BackendReference | LegacySandboxHandle,
    process: BackendProcessReference | LegacyProcessHandle,
  ): Promise<ProcessStatus> {
    const sandboxId = isBackendReference(runtime)
      ? this.runtimeId(runtime)
      : runtime.providerSandboxId;
    const processPayload = isBackendReference(process)
      ? this.processPayload(process)
      : this.legacyProcessPayload(sandboxId, process);
    this.requireProcessRuntime(sandboxId, processPayload.sandboxId);
    const sandbox = await this.getSandbox(sandboxId);
    const command = await sandbox.process.getSessionCommand?.(
      processPayload.sessionId,
      processPayload.commandId,
    );
    const sessionId = processPayload.sessionId;
    if (command?.exitCode !== undefined) {
      this.forgetSentinelState(sessionId);
      return { status: "exited", exitCode: command.exitCode };
    }
    // Daytona says nothing, which means either "still running" or "finished, but
    // an orphaned child still holds the session pipe". Only the sentinel can
    // tell those apart — but it is an extra HTTP round-trip on a 500ms poll
    // loop, so it is worth paying only once Daytona's silence has lasted long
    // enough to look like the wedged case rather than an ordinary command.
    if (!isBackendReference(runtime)) return { status: "running" };
    const now = Date.now();
    const silentSince = this.sentinelSilentSince.get(sessionId);
    if (silentSince === undefined) {
      this.sentinelSilentSince.set(sessionId, now);
      return { status: "running" };
    }
    if (now - silentSince < EXIT_SENTINEL_GRACE_MS) return { status: "running" };
    const lastProbe = this.sentinelProbedAt.get(sessionId);
    if (lastProbe !== undefined && now - lastProbe < EXIT_SENTINEL_PROBE_INTERVAL_MS) {
      return { status: "running" };
    }
    this.sentinelProbedAt.set(sessionId, now);
    const sentinelExitCode = await this.readExitSentinel(runtime, sessionId);
    if (sentinelExitCode === undefined) return { status: "running" };
    this.forgetSentinelState(sessionId);
    return { status: "exited", exitCode: sentinelExitCode };
  }

  async readProcessOutput(
    runtime: BackendReference,
    process: BackendProcessReference,
  ): Promise<ProcessOutput>;
  async readProcessOutput(
    runtime: LegacySandboxHandle,
    process: LegacyProcessHandle,
  ): Promise<ProcessOutput>;
  async readProcessOutput(
    runtime: BackendReference | LegacySandboxHandle,
    process: BackendProcessReference | LegacyProcessHandle,
  ): Promise<ProcessOutput> {
    const sandboxId = isBackendReference(runtime)
      ? this.runtimeId(runtime)
      : runtime.providerSandboxId;
    const processPayload = isBackendReference(process)
      ? this.processPayload(process)
      : this.legacyProcessPayload(sandboxId, process);
    this.requireProcessRuntime(sandboxId, processPayload.sandboxId);
    const sandbox = await this.getSandbox(sandboxId);
    const output = await sandbox.process.getSessionCommandLogs(
      processPayload.sessionId,
      processPayload.commandId,
    );
    return output ?? {};
  }

  async streamProcessOutput(
    runtime: BackendReference,
    process: BackendProcessReference,
    sink: ProcessOutputSink,
  ): Promise<void>;
  async streamProcessOutput(
    runtime: LegacySandboxHandle,
    process: LegacyProcessHandle,
    sink: ProcessOutputSink,
  ): Promise<void>;
  async streamProcessOutput(
    runtime: BackendReference | LegacySandboxHandle,
    process: BackendProcessReference | LegacyProcessHandle,
    sink: ProcessOutputSink,
  ): Promise<void> {
    const sandboxId = isBackendReference(runtime)
      ? this.runtimeId(runtime)
      : runtime.providerSandboxId;
    const processPayload = isBackendReference(process)
      ? this.processPayload(process)
      : this.legacyProcessPayload(sandboxId, process);
    this.requireProcessRuntime(sandboxId, processPayload.sandboxId);
    const sandbox = await this.getSandbox(sandboxId);
    await sandbox.process.getSessionCommandLogs(
      processPayload.sessionId,
      processPayload.commandId,
      (chunk) => void sink.stdout(chunk),
      (chunk) => void sink.stderr(chunk),
    );
  }

  async stopProcess(
    runtime: BackendReference,
    process: BackendProcessReference,
    mode: StopMode,
  ): Promise<ProcessStatus>;
  async stopProcess(
    runtime: LegacySandboxHandle,
    process: LegacyProcessHandle,
    mode: StopMode,
  ): Promise<ProcessStatus & { appliedMode: "terminate_session" }>;
  async stopProcess(
    runtime: BackendReference | LegacySandboxHandle,
    process: BackendProcessReference | LegacyProcessHandle,
    mode: StopMode,
  ): Promise<ProcessStatus & { appliedMode: "terminate_session" }> {
    void mode;
    const sandboxId = isBackendReference(runtime)
      ? this.runtimeId(runtime)
      : runtime.providerSandboxId;
    const processPayload = isBackendReference(process)
      ? this.processPayload(process)
      : this.legacyProcessPayload(sandboxId, process);
    this.requireProcessRuntime(sandboxId, processPayload.sandboxId);
    const sandbox = await this.getSandbox(sandboxId);
    await sandbox.process.deleteSession?.(processPayload.sessionId);
    return { status: "stopped", appliedMode: "terminate_session" };
  }

  /** DEBUG: the provider's unmodified file details, to verify what it reports. */
  async debugRawFileDetails(runtime: BackendReference, path: string): Promise<unknown> {
    const sandbox = await this.getSandbox(this.runtimeId(runtime));
    if (!sandbox.fs?.getFileDetails) return { error: "unsupported" };
    try {
      return await sandbox.fs.getFileDetails(path);
    } catch (error) {
      return { error: error instanceof Error ? error.message : String(error) };
    }
  }

  async inspectPath(runtime: BackendReference, path: string): Promise<PathInfo | null> {
    const sandbox = await this.getSandbox(this.runtimeId(runtime));
    if (!sandbox.fs?.getFileDetails) {
      throw new ComputeError("compute_unavailable", "daytona_file_details_unsupported");
    }
    try {
      const details = await sandbox.fs.getFileDetails(path);
      // `resolvedPath` echoes the input: Daytona exposes no link target.
      //
      // KNOWN INERT ON DAYTONA (verified live, 2026-07-10): `getFileDetails`
      // FOLLOWS symlinks — a link to /etc comes back `isDir: true` with a
      // directory's mode — so no field survives to detect one, and this branch
      // never fires. Symlink detection is checked first anyway, so a provider
      // that does report a link type (Cloudflare?) gets a working guard. Callers
      // MUST NOT treat `type: "symlink"` rejection as a security boundary; the
      // sandbox is the boundary, and `exec` already grants a shell inside it.
      return {
        type: isSymlinkMode(details) ? "symlink" : details.isDir ? "directory" : "file",
        size: details.size,
        resolvedPath: path,
      };
    } catch (error) {
      if (isNotFoundError(error)) return null;
      throw error;
    }
  }

  async pathExists(runtime: BackendReference, path: string): Promise<boolean> {
    const sandbox = await this.getSandbox(this.runtimeId(runtime));
    if (!sandbox.fs?.getFileDetails) {
      throw new ComputeError("compute_unavailable", "daytona_file_details_unsupported");
    }
    try {
      await sandbox.fs.getFileDetails(path);
      return true;
    } catch (error) {
      // Only a numeric 404 may answer `false`. Every other error is a failure to
      // ANSWER, and `false` here is read downstream as "proven absent" =
      // permission to overwrite.
      //
      // What requiring the numeric status actually buys, precisely:
      //
      //   - A STATUSLESS error no longer answers. The SDK emits these for real:
      //     `DaytonaConnectionError` (network failure, no response) and the
      //     interceptor's non-axios fallback `new DaytonaError(message)` both
      //     carry `statusCode: undefined`. `isNotFoundError` would regex the
      //     MESSAGE (`/not found|status code 404/i`) for exactly those, so a
      //     dropped socket whose prose happens to say "not found" became `false`.
      //   - A NON-404 status no longer answers. A 5xx whose body echoes
      //     "not found" hits the same regex fallback under `isNotFoundError`.
      //
      // Both now THROW, which fails closed: apply_patch refuses rather than
      // clobbers. That leniency remains correct for `inspectPath` (fail-open by
      // design) and `getSandbox`, which is why they still use `isNotFoundError`.
      //
      // What it does NOT buy — do not read more into it than this:
      //
      //   - A vanished SANDBOX is not filtered out, on the one path that can
      //     reach here with one. `pathExists` calls `getSandbox` first, and on a
      //     cache MISS that throws `runtime_missing` before `files/info` is ever
      //     requested — so this case is reachable only through the sandbox CACHE,
      //     holding a handle to a sandbox that has since gone away. We must
      //     ASSUME the toolbox `files/info` route answers a missing sandbox with
      //     a genuine HTTP 404 (this is an assertion about a remote service, not
      //     something any source here verifies); if it does, it arrives as
      //     `DaytonaNotFoundError { statusCode: 404 }` and returns `false` just
      //     like an absent path. Same for a ROUTE-level 404 (the endpoint
      //     misrouted or versioned away). Nothing in the response distinguishes
      //     "this path is absent" from "this endpoint is gone" on this provider —
      //     Cloudflare closes that hazard by comparing the echoed `path` (see
      //     `existsProbe`), and Daytona's `files/info` 404 body carries no
      //     equivalent to compare against.
      //
      // The residual exposure is narrow rather than absent: when the sandbox or
      // the toolbox route is genuinely gone, the WRITE that this `false`
      // authorizes fails too, so the wrong answer does not survive into a
      // clobber. The hazard would need a 404 on `files/info` alongside a healthy
      // write path — a versioning skew between the two routes. Unmitigated, and
      // known.
      //
      // A second arm accepting `error.name === "DaytonaNotFoundError"` was here
      // and was REMOVED. Every filesystem 404 already carries `statusCode: 404`,
      // so it answered nothing the status arm did not, while widening "proven
      // absent" from *a 404* to *anything the SDK chooses to name NotFound* — and
      // the SDK does construct that class directly, with NO `statusCode`, for
      // purely client-side "local file does not exist" checks (`Image.js`,
      // `ObjectStorage.js`). None of those route through `fs.getFileDetails`
      // today, but the arm was a standing invitation for one to, in the single
      // function where a wrong `false` is a clobber.
      //
      // The check reads the shape the SDK REALLY throws: a flat `statusCode`.
      // An earlier revision matched only `status`/`response.status` — an axios
      // shape the interceptor guarantees we never see — so this branch was
      // unreachable in production and every `apply_patch` `add` on Daytona threw.
      if (extractHttpStatus(error) === 404) return false;
      // Don't leak a raw SDK error past the ComputeError taxonomy: this is now
      // the common production path for any provider hiccup during a write guard.
      throw new ComputeError(
        "provider_transient",
        `daytona_exists_unanswered: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  }

  async listDirectory(runtime: BackendReference, path: string): Promise<DirEntry[]> {
    const sandbox = await this.getSandbox(this.runtimeId(runtime));
    if (!sandbox.fs?.listFiles) {
      throw new ComputeError("compute_unavailable", "daytona_list_files_unsupported");
    }
    // No `isNotFoundError` mapping, unlike `inspectPath`: this contract answers
    // or throws, so a 404 propagates. Daytona reports only `isDir` — a symlink
    // comes back as its target's type, as with `getFileDetails` (verified live,
    // 2026-07-10) — so no entry is ever typed "symlink" here.
    const entries = await sandbox.fs.listFiles(path);
    // Array-ness and `name` are VALIDATED here, not assumed — `isDir` is not
    // (read as-is below). The typings say `FileInfo[]` with a basename `name`,
    // but typings are compile-time and what arrives from the Go-backed toolbox
    // API at runtime is what actually decides. The asymmetry is the reason: a
    // wrapper object fails safe (`.map` throws -> `unreadable`), while an
    // array whose basename sits under a different key, or is an absolute
    // path, throws NOTHING — the nonce match just misses and `readGeneration`
    // reads that as a wipe, faulting healthy work on every tick. Make every
    // `name` mismatch a throw so `readGeneration`'s "a container that cannot
    // serve the listing cannot produce a reset verdict" holds by construction.
    // `isDir` needs no such guard: only `name` drives the nonce match, and an
    // unrecognized `isDir` value (or a mistyped directory) just falls through
    // to `"file"` — a later `readFile` on it throws -> `unreadable`, never a
    // false `absent`.
    if (!Array.isArray(entries)) {
      throw new ComputeError("provider_transient", "daytona_list_files_unexpected_shape");
    }
    return entries.map((entry) => {
      const name = (entry as { name?: unknown } | null)?.name;
      if (typeof name !== "string" || name.length === 0 || name.includes("/")) {
        throw new ComputeError("provider_transient", "daytona_list_files_unexpected_shape");
      }
      return { name, type: entry.isDir === true ? "directory" : "file" };
    });
  }

  async readFile(
    runtime: BackendReference,
    path: string,
    maxBytes: number,
  ): Promise<ReadFileResult> {
    const sandbox = await this.getSandbox(this.runtimeId(runtime));
    // Daytona's `fs.downloadFile(path)` returns raw bytes only — no content-type
    // — so no mime is available here (matches legacy, which also derived none).
    const bytes = await sandbox.fs?.downloadFile?.(path);
    if (!bytes) throw new ComputeError("compute_unavailable", "daytona_download_unsupported");
    if (bytes.byteLength > maxBytes) {
      // Oversize is a permanent condition, not a transient one: retrying won't help.
      throw new ComputeError("compute_file_too_large");
    }
    return { bytes: toArrayBuffer(bytes) };
  }

  async writeFile(
    runtime: BackendReference,
    path: string,
    bytes: ArrayBuffer,
    options: WriteFileOptions,
  ): Promise<void> {
    // `pathExists`, NOT `inspectPath`: this probe decides a WRITE. `inspectPath`
    // is fail-open by design (a provider failure becomes `null`), and `null`
    // here reads as "proven absent" = permission to overwrite. Worse, the caller
    // above is already fail-open the same way — `ComputeFileService` derives
    // `overwrite: current !== null` from its own `inspectPath` — so two
    // fail-open probes over the same lying source stacked into an
    // unconditional `uploadFile` that destroyed the file. `pathExists` answers
    // or throws.
    if (!options.overwrite && (await this.pathExists(runtime, path))) {
      throw new ComputeError("provider_transient", "daytona_file_already_exists");
    }
    const sandbox = await this.getSandbox(this.runtimeId(runtime));
    if (options.createParents) await this.createParentDirectories(sandbox, path);
    if (!sandbox.fs?.uploadFile)
      throw new ComputeError("compute_unavailable", "daytona_upload_unsupported");
    await sandbox.fs.uploadFile(bytes, path);
  }

  async createDirectory(runtime: BackendReference, path: string): Promise<void> {
    const sandbox = await this.getSandbox(this.runtimeId(runtime));
    if (!sandbox.fs?.createFolder) {
      throw new ComputeError("compute_unavailable", "daytona_create_directory_unsupported");
    }
    await sandbox.fs.createFolder(path, "755");
  }

  async deletePath(runtime: BackendReference, path: string): Promise<void> {
    const sandbox = await this.getSandbox(this.runtimeId(runtime));
    if (!sandbox.fs?.deleteFile)
      throw new ComputeError("compute_unavailable", "daytona_delete_unsupported");
    await sandbox.fs.deleteFile(path, true);
  }

  async movePath(
    runtime: BackendReference,
    from: string,
    to: string,
    overwrite: boolean,
  ): Promise<void> {
    // Same reasoning as `writeFile`: a destination probe that decides whether to
    // refuse — and, below, whether to DELETE the destination — must answer or
    // throw. Only truthiness is read at either site, so a boolean loses nothing;
    // `PathInfo`'s `type`/`size` were never consulted here.
    const existing = await this.pathExists(runtime, to);
    if (existing && !overwrite) {
      throw new ComputeError("provider_transient", "daytona_move_destination_exists");
    }
    const sandbox = await this.getSandbox(this.runtimeId(runtime));
    if (!sandbox.fs?.moveFiles)
      throw new ComputeError("compute_unavailable", "daytona_move_unsupported");
    // Daytona's `moveFiles` overwrite behavior is unverified, so honor the
    // `overwrite: true` contract ourselves by removing the destination first.
    // The temp-sibling commit relies on this for every in-place update.
    if (existing && overwrite) {
      await this.deletePath(runtime, to);
    }
    await sandbox.fs.moveFiles(from, to);
  }

  async createSandbox(input: {
    image?: string;
    snapshot?: string;
    env?: Record<string, string>;
    idleTimeoutMs?: number;
    domainAllowlist?: string[];
  }): Promise<LegacySandboxHandle> {
    const sandbox = await (
      await this.getClient()
    ).create({
      ...this.sourceInput(input),
      ...(input.env ? { envVars: input.env } : {}),
      autoStopInterval: input.idleTimeoutMs
        ? Math.max(1, Math.ceil(input.idleTimeoutMs / 60_000))
        : 0,
      ...(input.domainAllowlist?.length
        ? { domainAllowList: input.domainAllowlist.join(",") }
        : {}),
    });
    const providerSandboxId = sandbox.id ?? sandbox.name;
    if (!providerSandboxId)
      throw new ComputeError("provider_transient", "daytona_sandbox_id_missing");
    return { provider: this.id, providerSandboxId };
  }

  async deleteSandbox(handle: LegacySandboxHandle): Promise<void> {
    await this.destroy(this.runtimeReference(handle.providerSandboxId));
  }

  async suspendSandbox(handle: LegacySandboxHandle): Promise<void> {
    await this.release(this.runtimeReference(handle.providerSandboxId), {
      disposition: "recoverable",
    });
  }

  async resumeSandbox(handle: LegacySandboxHandle): Promise<void> {
    await this.acquire(this.legacySpec(), this.recoveryReference(handle.providerSandboxId));
  }

  async writeProcessInput(
    handle: LegacySandboxHandle,
    process: LegacyProcessHandle,
    input: string,
  ): Promise<void> {
    const payload = this.legacyProcessPayload(handle.providerSandboxId, process);
    const sandbox = await this.getSandbox(handle.providerSandboxId);
    await sandbox.process.sendSessionCommandInput?.(payload.sessionId, payload.commandId, input);
  }

  async uploadFile(
    handle: LegacySandboxHandle,
    input: { destinationPath: string; bytes: ArrayBuffer; overwrite: boolean },
  ): Promise<void> {
    await this.writeFile(
      this.runtimeReference(handle.providerSandboxId),
      input.destinationPath,
      input.bytes,
      {
        createParents: false,
        overwrite: input.overwrite,
      },
    );
  }

  async downloadFile(
    handle: LegacySandboxHandle,
    input: { path: string; maxBytes: number },
  ): Promise<{ bytes: ArrayBuffer; filename?: string; mimeType?: string }> {
    const { bytes, mimeType } = await this.readFile(
      this.runtimeReference(handle.providerSandboxId),
      input.path,
      input.maxBytes,
    );
    const filename = input.path.split("/").pop();
    return { bytes, ...(filename ? { filename } : {}), ...(mimeType ? { mimeType } : {}) };
  }

  async debugRawCommand(
    handle: LegacySandboxHandle,
    process: LegacyProcessHandle,
  ): Promise<unknown> {
    const payload = this.legacyProcessPayload(handle.providerSandboxId, process);
    const sandbox = await this.getSandbox(handle.providerSandboxId);
    return {
      getSessionCommand: await sandbox.process.getSessionCommand?.(
        payload.sessionId,
        payload.commandId,
      ),
    };
  }

  /**
   * Read the sentinel exit code for a session, or `undefined` when there is
   * none to read.
   *
   * Every failure mode collapses to `undefined` — no file yet, an unreadable
   * one, a partial write, a sandbox that has gone away. `undefined` means "no
   * answer", which leaves the caller reporting `running` exactly as it did
   * before this existed. The sentinel may only ever bring an exit FORWARD in
   * time; it must never be able to invent one.
   */
  private forgetSentinelState(sessionId: string): void {
    this.sentinelSilentSince.delete(sessionId);
    this.sentinelProbedAt.delete(sessionId);
  }

  private async readExitSentinel(
    runtime: BackendReference,
    sessionId: string,
  ): Promise<number | undefined> {
    let text: string;
    try {
      const { bytes } = await this.readFile(runtime, exitSentinelPath(sessionId), 64);
      text = new TextDecoder().decode(bytes).trim();
    } catch {
      return undefined;
    }
    if (!/^-?\d+$/.test(text)) return undefined;
    const code = Number.parseInt(text, 10);
    return Number.isSafeInteger(code) ? code : undefined;
  }

  private async startDaytonaProcess(
    sandboxId: string,
    input: StartProcessInput | LegacyStartProcessInput,
  ): Promise<StartProcessResult> {
    const sandbox = await this.getSandbox(sandboxId);
    const sessionId = `nadi-${crypto.randomUUID()}`;
    await sandbox.process.createSession(sessionId);
    if (input.cwd) {
      await sandbox.process.executeSessionCommand(sessionId, {
        command: `cd ${shellQuote(input.cwd)}`,
        suppressInputEcho: true,
      });
    }
    const timeoutSeconds = input.timeoutMs
      ? Math.max(1, Math.ceil(input.timeoutMs / 1_000))
      : undefined;
    const result = await sandbox.process.executeSessionCommand(
      sessionId,
      {
        command: withExitSentinel(input.command, sessionId),
        runAsync: true,
        suppressInputEcho: true,
      },
      timeoutSeconds,
    );
    if (!result.cmdId) throw new ComputeError("provider_transient", "daytona_command_id_missing");
    if ("stdin" in input && input.stdin) {
      await sandbox.process.sendSessionCommandInput?.(sessionId, result.cmdId, input.stdin);
    }
    return {
      process: this.processReference(sandboxId, sessionId, result.cmdId),
      status: "running",
      ...(result.stdout === undefined ? {} : { stdout: result.stdout }),
      ...(result.stderr === undefined ? {} : { stderr: result.stderr }),
    };
  }

  private runtimeId(reference: BackendReference): string {
    const parsed = daytonaReferenceSchema.parse(reference);
    if (parsed.payload.kind !== "runtime") {
      throw new ComputeError("runtime_missing", "daytona_runtime_reference_invalid");
    }
    return parsed.payload.sandboxId;
  }

  private processPayload(process: BackendProcessReference) {
    const parsed = daytonaReferenceSchema.parse(process);
    if (parsed.payload.kind !== "process") {
      throw new ComputeError("process_missing", "daytona_process_reference_invalid");
    }
    return parsed.payload;
  }

  private legacyProcessPayload(sandboxId: string, process: LegacyProcessHandle) {
    if (!process.sessionId || !process.commandId) {
      throw new ComputeError("process_missing", "daytona_process_handle_invalid");
    }
    return {
      kind: "process" as const,
      sandboxId,
      sessionId: process.sessionId,
      commandId: process.commandId,
    };
  }

  private requireProcessRuntime(runtimeId: string, processSandboxId: string): void {
    if (runtimeId !== processSandboxId) {
      throw new ComputeError("process_missing", "daytona_process_runtime_mismatch");
    }
  }

  private runtimeReference(sandboxId: string): BackendReference {
    return { provider: this.id, version: 1, payload: { kind: "runtime", sandboxId } };
  }

  private recoveryReference(sandboxId: string): BackendReference {
    return { provider: this.id, version: 1, payload: { kind: "recovery", sandboxId } };
  }

  private processReference(
    sandboxId: string,
    sessionId: string,
    commandId: string,
  ): BackendProcessReference {
    return {
      provider: this.id,
      version: 1,
      payload: { kind: "process", sandboxId, sessionId, commandId },
    };
  }

  private sourceInput(
    source: { image?: string; snapshot?: string } | undefined,
  ): Record<string, string> {
    if (source?.snapshot) return { snapshot: source.snapshot };
    return source?.image ? { image: source.image } : {};
  }

  private async createParentDirectories(sandbox: DaytonaSandboxLike, path: string): Promise<void> {
    if (!sandbox.fs?.createFolder) {
      throw new ComputeError("compute_unavailable", "daytona_create_directory_unsupported");
    }
    const parts = path.split("/").filter(Boolean);
    parts.pop();
    let current = "";
    for (const part of parts) {
      current += `/${part}`;
      await sandbox.fs.createFolder(current, "755");
    }
  }

  private legacySpec(): ComputeSpec {
    return {
      environmentId: "legacy",
      profile: "small",
      workspaceRoot: "/workspace",
      env: {},
      maxProcessRuntimeMs: 0,
      allowedHosts: null,
    };
  }

  private async getClient(): Promise<DaytonaClient> {
    if (this.client) return this.client;
    if (this.lazyClient) return this.lazyClient;
    const { Daytona } = (await import("@daytona/sdk")) as { Daytona: DaytonaConstructor };
    this.lazyClient = new Daytona({
      apiKey: this.config.apiKey,
      ...(this.config.apiUrl ? { apiUrl: this.config.apiUrl } : {}),
      ...(this.config.target ? { target: this.config.target } : {}),
    });
    return this.lazyClient;
  }

  /** Drop a cached handle whose sandbox we just stopped or destroyed. */
  private invalidateSandbox(sandboxId: string): void {
    this.sandboxCache.delete(sandboxId);
  }

  private async getSandbox(sandboxId: string): Promise<DaytonaSandboxLike> {
    const cached = this.sandboxCache.get(sandboxId);
    if (cached) return cached;
    const client = await this.getClient();
    if (!client.get) throw new ComputeError("compute_unavailable", "daytona_get_unsupported");
    try {
      const sandbox = await client.get(sandboxId);
      this.sandboxCache.set(sandboxId, sandbox);
      return sandbox;
    } catch (error) {
      if (isNotFoundError(error))
        throw new ComputeError("runtime_missing", "daytona_runtime_not_found");
      throw error;
    }
  }
}

function isBackendReference(value: unknown): value is BackendReference {
  return (
    typeof value === "object" && value !== null && (value as { version?: unknown }).version === 1
  );
}

/**
 * Whether an error means "the path/runtime is absent" (→ treat as null) rather
 * than "the request broke" (→ propagate). The Daytona client is axios-shaped: a
 * genuine 404 carries a numeric HTTP status but stringifies to "Request failed
 * with status code 404", which does NOT match /not found/i. So the HTTP status
 * is the primary signal; the message regex is a fallback for shapes without one.
 * A 403/500 or a network error (no status, no "not found") must still propagate,
 * or "absent" would mask "broken".
 */
/**
 * A symlink per Go's `FileMode.String()` ("Lrwxrwxrwx") or a POSIX `ls -l`
 * type char ("lrwxrwxrwx"). Verified against a live sandbox: `permissions`
 * carries no type char, so checking it alone let a symlink to /etc through.
 */
export function isSymlinkMode(details: { permissions?: string; mode?: string }): boolean {
  return /^l/i.test(details.mode ?? "") || /^l/i.test(details.permissions ?? "");
}

export function isNotFoundError(error: unknown): boolean {
  // A 404 status is a POSITIVE signal only: it can prove not-found, it may not
  // disprove it. Deliberately not `if (status !== undefined) return status === 404` —
  // that would let the newly-visible `statusCode` (see `extractHttpStatus`) turn
  // a 5xx whose body echoes "not found" from absent into a throw, silently
  // tightening `inspectPath`, which is fail-open BY DESIGN. Everything this
  // returned true for before still returns true; real 404s whose prose doesn't
  // happen to say "not found" now do too.
  if (extractHttpStatus(error) === 404) return true;
  const message = error instanceof Error ? error.message : String(error);
  return /not found|status code 404/i.test(message);
}

/**
 * The status carried by an error the Daytona SDK actually throws.
 *
 * `statusCode` is the load-bearing one. `@daytona/sdk` installs an axios
 * response interceptor (`Daytona.createAxiosInstance`) that converts EVERY
 * `AxiosError` into a `DaytonaError` via `createAxiosDaytonaError`, and
 * `DaytonaError` carries a FLAT `statusCode` — no `status`, no `response`.
 * `Sandbox` builds its `FileSystemApi` on that same intercepted instance, so
 * nothing reaching us from `fs.*` ever has an axios shape. `status` /
 * `response.status` are kept for a client passed in by a caller that does not
 * route through the interceptor.
 */
function extractHttpStatus(error: unknown): number | undefined {
  if (typeof error !== "object" || error === null) return undefined;
  const record = error as {
    statusCode?: unknown;
    status?: unknown;
    response?: { status?: unknown };
  };
  if (typeof record.statusCode === "number") return record.statusCode;
  if (typeof record.status === "number") return record.status;
  if (typeof record.response?.status === "number") return record.response.status;
  return undefined;
}

function toArrayBuffer(bytes: ArrayBuffer | Uint8Array): ArrayBuffer {
  return bytes instanceof ArrayBuffer
    ? bytes
    : (bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer);
}

function shellQuote(value: string): string {
  return `'${value.replace(/'/g, `'\\''`)}'`;
}
