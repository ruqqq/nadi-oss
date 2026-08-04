import { z } from "zod";
import type {
  BackendProcessReference,
  BackendReference,
  ComputeBackend,
  ComputeResourceProfile,
  ComputeSpec,
  DirEntry,
  PathInfo,
  ProcessOutput,
  ProcessStatus,
  ReadFileResult,
  ReleaseOptions,
  RunCommandInput,
  RunCommandResult,
  StartProcessInput,
  StartProcessResult,
  StopMode,
  WriteFileOptions,
} from "../backend";
import { DEFAULT_COMPUTE_LIMITS } from "../config";
import { ComputeError } from "../errors";
import type { SpritesClient, SpritesSignal } from "./sprites-client";

/**
 * sprites.dev implementation of the provider-neutral compute contract.
 *
 * Two provider facts shape everything below:
 *
 *  - There is NO auto-destroy. A sprite lives until something DELETEs it, so
 *    every path that abandons one must delete it — including a fresh acquire
 *    that fails after `createSprite` succeeded.
 *  - Hibernation is automatic (~30s idle) and waking is implicit on the next
 *    API call, so a recoverable release is a genuine no-op: there is no archive
 *    step, and recovery reuses the same sprite name.
 *
 * Process bookkeeping is done in the sandbox's own filesystem rather than
 * through provider process records: `startProcess` launches a wrapper that
 * redirects stdout/stderr to sentinel files and writes the exit code to a third,
 * and `getProcessStatus` reads that rc file. Same reasoning as Daytona's exit
 * sentinel — the file may only bring an exit FORWARD, never invent one.
 */

export const SPRITES_PROFILE_MEMORY_MB: Record<ComputeResourceProfile, number> = {
  small: 2048,
  medium: 4096,
};

const WORKSPACE_ROOT = "/workspace";

/** Settle-quickly poll after launching a process: 10 attempts, 200ms apart. */
const SETTLE_POLL_ATTEMPTS = 10;
const SETTLE_POLL_INTERVAL_MS = 200;

/**
 * Budget for the backend's OWN exec calls — the `stat`/`mkdir`/`rm`/`mv` this
 * file issues, none of which take a caller-supplied timeout. `execCollect` only
 * arms its abort when a `timeoutMs` is passed, so without this an unanswered
 * WebSocket would hang these forever (and `statPath` backs `pathExists`, which
 * gates every fail-closed write). Passed explicitly at each call site rather
 * than defaulted in the client, so `runCommand`'s caller-supplied budget stays
 * the only thing that decides a user command's deadline.
 */
const INTERNAL_EXEC_TIMEOUT_MS = 60_000;

const runtimePayloadSchema = z.object({
  kind: z.literal("runtime"),
  spriteName: z.string().min(1),
});
const recoveryPayloadSchema = z.object({
  kind: z.literal("recovery"),
  spriteName: z.string().min(1),
});
const processPayloadSchema = z.object({
  kind: z.literal("process"),
  spriteName: z.string().min(1),
  processId: z.string().min(1),
});
const spritesReferenceSchema = z.object({
  provider: z.literal("sprites"),
  version: z.literal(1),
  payload: z.discriminatedUnion("kind", [
    runtimePayloadSchema,
    recoveryPayloadSchema,
    processPayloadSchema,
  ]),
});

const SIGNALS: Record<StopMode, SpritesSignal> = {
  interrupt: "SIGINT",
  terminate: "SIGTERM",
  kill: "SIGKILL",
};

export class SpritesComputeBackend implements ComputeBackend {
  readonly id = "sprites" as const;
  private readonly client: SpritesClient;

  constructor(input: { client: SpritesClient }) {
    this.client = input.client;
  }

  async acquire(spec: ComputeSpec, recovery?: BackendReference): Promise<BackendReference> {
    if (recovery) {
      const parsed = spritesReferenceSchema.safeParse(recovery);
      if (!parsed.success || parsed.data.payload.kind !== "recovery") {
        throw new ComputeError("recovery_failed", "sprites_recovery_reference_invalid");
      }
      // A hibernated sprite still exists and wakes on the first API call, so
      // there is nothing to create or start — just re-apply the policies and
      // make sure the workspace root is there.
      //
      // Note what recovery does NOT re-apply: `spec.env`. The environment is
      // fixed at `createSprite` and there is no route to amend it afterwards,
      // so a spec whose env changed between release and recovery keeps the
      // original values — same behaviour as Daytona, whose env is likewise
      // baked in at sandbox creation.
      const spriteName = parsed.data.payload.spriteName;
      await this.prepare(spriteName, spec);
      return this.runtimeReference(spriteName);
    }

    const spriteName = `nadi-${crypto.randomUUID()}`;
    await this.client.createSprite(spriteName, { environment: spec.env });
    try {
      await this.prepare(spriteName, spec);
    } catch (error) {
      // Nothing destroys a sprite on its own; an abandoned one bills forever.
      await this.client.deleteSprite(spriteName).catch(() => {});
      throw error;
    }
    return this.runtimeReference(spriteName);
  }

  async release(
    runtime: BackendReference,
    options: ReleaseOptions,
  ): Promise<BackendReference | null> {
    const spriteName = this.runtimeName(runtime);
    if (options.disposition === "discard") {
      await this.client.deleteSprite(spriteName);
      return null;
    }
    // Recoverable: NO provider call. Hibernation is automatic after ~30s idle,
    // and there is no archive to take. The service layer's TTL eviction later
    // calls `destroy()` on this reference, and that DELETE is the only thing
    // that ever stops storage billing.
    return this.recoveryReference(spriteName);
  }

  async destroy(reference: BackendReference): Promise<void> {
    const parsed = spritesReferenceSchema.parse(reference);
    if (parsed.payload.kind === "process") {
      throw new ComputeError("runtime_missing", "sprites_runtime_reference_invalid");
    }
    await this.client.deleteSprite(parsed.payload.spriteName);
  }

  /**
   * Run a command to completion in one call.
   *
   * `status` is `"exited"` whenever the provider reported an exit code —
   * a non-zero code is a command verdict, not a compute failure, and it rides in
   * `exitCode`. That matches the start-and-poll fallback in `thread-service`
   * (which reports `getProcessStatus`'s `"exited"` with a non-zero code) rather
   * than Cloudflare's `runCommand`, which maps non-zero to `"failed"`.
   *
   * Provider faults are NOT swallowed into a synthetic result: a `ComputeError`
   * (timeout, socket failure, missing sprite) propagates, because a caller that
   * saw a fabricated `exitCode: -1` could not tell a failed command from a
   * command that never ran.
   */
  async runCommand(runtime: BackendReference, input: RunCommandInput): Promise<RunCommandResult> {
    const spriteName = this.runtimeName(runtime);
    const result = await this.client.execCollect(spriteName, {
      argv: ["bash", "-c", input.command],
      dir: input.cwd ?? WORKSPACE_ROOT,
      ...(input.env === undefined ? {} : { env: input.env }),
      timeoutMs: input.timeoutMs,
    });
    return {
      status: "exited",
      exitCode: result.exitCode,
      stdout: result.stdout,
      stderr: result.stderr,
    };
  }

  async startProcess(
    runtime: BackendReference,
    input: StartProcessInput,
  ): Promise<StartProcessResult> {
    const spriteName = this.runtimeName(runtime);
    const processId = crypto.randomUUID();
    const outPath = sentinelPath("out", processId);
    const errPath = sentinelPath("err", processId);
    const rcPath = sentinelPath("rc", processId);
    let stdinPath = "/dev/null";
    if (input.stdin !== undefined) {
      stdinPath = sentinelPath("in", processId);
      const encoded = new TextEncoder().encode(input.stdin);
      await this.client.fsWrite(spriteName, stdinPath, toArrayBuffer(encoded), true);
    }

    const timeoutSecs = Math.max(1, Math.ceil(input.timeoutMs / 1000));
    // argv form sidesteps every quoting concern except the two values
    // interpolated into the script itself.
    const wrapper =
      `cd ${shellQuote(input.cwd ?? WORKSPACE_ROOT)} && ` +
      `timeout ${timeoutSecs} bash -c ${shellQuote(input.command)} ` +
      `< ${stdinPath} > ${outPath} 2> ${errPath}; ` +
      `printf %s "$?" > ${rcPath}`;
    await this.client.execDetached(spriteName, {
      argv: ["bash", "-c", wrapper],
      detachable: true,
      // Outlive the command's own timeout, so the wrapper always gets to write
      // its rc file rather than being reaped mid-exit.
      maxRunAfterDisconnect: `${timeoutSecs + 60}s`,
      ...(input.env === undefined ? {} : { env: input.env }),
    });

    const process = this.processReference(spriteName, processId);
    // Settle-quickly poll: most commands (an `echo`, a `git status`) are done
    // before the caller could poll, and reporting them `running` costs a whole
    // extra round-trip upstream.
    for (let attempt = 0; attempt < SETTLE_POLL_ATTEMPTS; attempt += 1) {
      const exitCode = await this.readRc(spriteName, processId);
      if (exitCode !== undefined) {
        const output = await this.readProcessOutput(runtime, process);
        return {
          process,
          status: "exited",
          exitCode,
          stdout: output.stdout ?? "",
          stderr: output.stderr ?? "",
        };
      }
      if (attempt < SETTLE_POLL_ATTEMPTS - 1) await delay(SETTLE_POLL_INTERVAL_MS);
    }
    return { process, status: "running" };
  }

  async getProcessStatus(
    runtime: BackendReference,
    process: BackendProcessReference,
  ): Promise<ProcessStatus> {
    const spriteName = this.runtimeName(runtime);
    const payload = this.processPayload(process);
    this.requireProcessRuntime(spriteName, payload.spriteName);
    const exitCode = await this.readRc(spriteName, payload.processId);
    if (exitCode !== undefined) return { status: "exited", exitCode };
    const sessions = await this.client.listSessions(spriteName);
    if (sessions.some((session) => session.command.includes(payload.processId))) {
      return { status: "running" };
    }
    // No session and no rc file: the process went away without recording an
    // exit — killed by a signal the wrapper never saw, or a cold sprite
    // restart. `failed` is the honest answer; inventing an exit code is not.
    return { status: "failed" };
  }

  async readProcessOutput(
    runtime: BackendReference,
    process: BackendProcessReference,
  ): Promise<ProcessOutput> {
    const spriteName = this.runtimeName(runtime);
    const payload = this.processPayload(process);
    this.requireProcessRuntime(spriteName, payload.spriteName);
    const [stdout, stderr] = await Promise.all([
      this.readSentinelText(spriteName, sentinelPath("out", payload.processId)),
      this.readSentinelText(spriteName, sentinelPath("err", payload.processId)),
    ]);
    return { stdout, stderr };
  }

  async stopProcess(
    runtime: BackendReference,
    process: BackendProcessReference,
    mode: StopMode,
  ): Promise<ProcessStatus> {
    const spriteName = this.runtimeName(runtime);
    const payload = this.processPayload(process);
    this.requireProcessRuntime(spriteName, payload.spriteName);
    const sessions = await this.client.listSessions(spriteName);
    const session = sessions.find((entry) => entry.command.includes(payload.processId));
    // No session: the command already exited. Nothing to signal.
    if (session) {
      try {
        await this.client.killSession(spriteName, session.sessionId, SIGNALS[mode]);
      } catch (error) {
        // The kill can race the exit: `listSessions` answered for this sprite a
        // moment ago, so the sprite is alive and a 404 here can only mean the
        // SESSION is gone — i.e. it exited on its own, which is the outcome we
        // asked for. The client cannot make this call itself (a 404 on any
        // sprite-scoped route looks identical to it, and a genuinely missing
        // sprite must keep reporting `runtime_missing`), so the disambiguation
        // belongs here, where the sprite is known alive.
        if (!(error instanceof ComputeError) || error.code !== "runtime_missing") throw error;
      }
    }
    return { status: "stopped" };
  }

  async inspectPath(runtime: BackendReference, path: string): Promise<PathInfo | null> {
    const info = await this.statPath(this.runtimeName(runtime), path);
    if (!info) return null;
    // `stat` without `-L` reports the LINK, not its target — so unlike Daytona,
    // `symlink` here is a real answer rather than an unreachable branch.
    return { type: info.type, size: info.size, resolvedPath: path };
  }

  async pathExists(runtime: BackendReference, path: string): Promise<boolean> {
    // `statPath` answers or throws, so the answer-or-throw contract holds by
    // construction: there is no arm that can degrade a failure into `false`.
    return (await this.statPath(this.runtimeName(runtime), path)) !== null;
  }

  async listDirectory(runtime: BackendReference, path: string): Promise<DirEntry[]> {
    // The client validates the shape and throws on a 404 or a malformed body —
    // it can never answer `[]` for a directory it failed to read.
    const entries = await this.client.fsList(this.runtimeName(runtime), path);
    return entries.map((entry) => ({
      name: entry.name,
      type: entry.isDir ? ("directory" as const) : ("file" as const),
    }));
  }

  async readFile(
    runtime: BackendReference,
    path: string,
    maxBytes: number,
  ): Promise<ReadFileResult> {
    const result = await this.client.fsRead(this.runtimeName(runtime), path);
    // `readFile` has no null arm; an absent path is a fault for this caller.
    if (!result) throw new ComputeError("provider_transient", `sprites_read_missing: ${path}`);
    if (result.bytes.byteLength > maxBytes) {
      // Never truncate: callers hash these bytes for optimistic concurrency.
      throw new ComputeError("compute_file_too_large", `sprites_file_too_large: ${path}`);
    }
    return result.mimeType === undefined
      ? { bytes: result.bytes }
      : { bytes: result.bytes, mimeType: result.mimeType };
  }

  async writeFile(
    runtime: BackendReference,
    path: string,
    bytes: ArrayBuffer,
    options: WriteFileOptions,
  ): Promise<void> {
    // Fail-closed probe, same reasoning as Daytona's: this decides a WRITE, and
    // `pathExists` answers or throws rather than reporting an unanswerable
    // probe as "proven absent" (which reads as permission to overwrite).
    if (!options.overwrite && (await this.pathExists(runtime, path))) {
      throw new ComputeError("provider_transient", "sprites_file_already_exists");
    }
    await this.client.fsWrite(this.runtimeName(runtime), path, bytes, options.createParents);
  }

  async createDirectory(runtime: BackendReference, path: string): Promise<void> {
    const spriteName = this.runtimeName(runtime);
    const result = await this.client.execCollect(spriteName, {
      argv: ["bash", "-c", `mkdir -p -- ${shellQuote(path)}`],
      timeoutMs: INTERNAL_EXEC_TIMEOUT_MS,
    });
    if (result.exitCode !== 0) {
      throw new ComputeError(
        "provider_transient",
        `sprites_mkdir_failed: ${result.stderr.trim() || result.exitCode}`,
      );
    }
  }

  async deletePath(runtime: BackendReference, path: string): Promise<void> {
    const spriteName = this.runtimeName(runtime);
    // `rm -rf` rather than the fs/delete route: deletion is recursive by
    // contract, and the route's recursion semantics are unverified.
    const result = await this.client.execCollect(spriteName, {
      argv: ["bash", "-c", `rm -rf -- ${shellQuote(path)}`],
      timeoutMs: INTERNAL_EXEC_TIMEOUT_MS,
    });
    if (result.exitCode !== 0) {
      throw new ComputeError(
        "provider_transient",
        `sprites_delete_failed: ${result.stderr.trim() || result.exitCode}`,
      );
    }
  }

  async movePath(
    runtime: BackendReference,
    from: string,
    to: string,
    overwrite: boolean,
  ): Promise<void> {
    const existing = await this.pathExists(runtime, to);
    if (existing && !overwrite) {
      throw new ComputeError("provider_transient", "sprites_move_destination_exists");
    }
    // Honor the overwrite contract ourselves; the temp-sibling commit in
    // `ComputeFileService` depends on it for every in-place update.
    if (existing && overwrite) await this.deletePath(runtime, to);
    const spriteName = this.runtimeName(runtime);
    const result = await this.client.execCollect(spriteName, {
      argv: ["bash", "-c", `mv -- ${shellQuote(from)} ${shellQuote(to)}`],
      timeoutMs: INTERNAL_EXEC_TIMEOUT_MS,
    });
    if (result.exitCode !== 0) {
      throw new ComputeError(
        "provider_transient",
        `sprites_move_failed: ${result.stderr.trim() || result.exitCode}`,
      );
    }
  }

  // ---- internals ----------------------------------------------------------

  /**
   * The three steps every acquire performs, fresh or recovered, in this order:
   * memory policy, then network policy, then the workspace root. The network
   * policy must be in place before anything can run, and the mkdir is the first
   * thing that runs.
   */
  private async prepare(spriteName: string, spec: ComputeSpec): Promise<void> {
    await this.client.setMemoryPolicy(spriteName, SPRITES_PROFILE_MEMORY_MB[spec.profile]);
    if (spec.allowedHosts && spec.allowedHosts.length > 0) {
      // Allow-list, then a catch-all deny. A null/empty `allowedHosts` posts NO
      // policy at all, which is unrestricted — today's Daytona-null semantics.
      await this.client.setNetworkPolicy(spriteName, [
        ...spec.allowedHosts.map((domain) => ({ domain, action: "allow" as const })),
        { domain: "*", action: "deny" as const },
      ]);
    }
    const result = await this.client.execCollect(spriteName, {
      argv: ["bash", "-c", `mkdir -p -- ${WORKSPACE_ROOT}`],
      timeoutMs: INTERNAL_EXEC_TIMEOUT_MS,
    });
    if (result.exitCode !== 0) {
      throw new ComputeError(
        "provider_transient",
        `sprites_workspace_root_failed: ${result.stderr.trim() || result.exitCode}`,
      );
    }
  }

  /**
   * `stat` a single path: answer, or THROW. There is no arm that turns a
   * provider failure into "absent" — `pathExists` is built on this, and a
   * wrong `false` there is a clobber.
   */
  private async statPath(
    spriteName: string,
    path: string,
  ): Promise<{ type: PathInfo["type"]; size: number } | null> {
    const result = await this.client.execCollect(spriteName, {
      argv: ["bash", "-c", `stat -c %F:%s -- ${shellQuote(path)}`],
      timeoutMs: INTERNAL_EXEC_TIMEOUT_MS,
    });
    if (result.exitCode === 0) {
      const parsed = parseStat(result.stdout);
      if (parsed) return parsed;
      throw new ComputeError(
        "provider_transient",
        `sprites_stat_unanswered: unparsable output ${JSON.stringify(result.stdout)}`,
      );
    }
    if (/No such file/i.test(result.stderr)) return null;
    throw new ComputeError(
      "provider_transient",
      `sprites_stat_unanswered: exit ${result.exitCode} ${result.stderr.trim()}`,
    );
  }

  /**
   * The exit code a finished wrapper recorded, or `undefined`.
   *
   * Every failure mode — no file yet, an unreadable one, a partial write, a
   * sprite that has gone away — collapses to `undefined`, i.e. "no answer".
   * The sentinel may only ever bring an exit FORWARD; it must never invent one.
   */
  private async readRc(spriteName: string, processId: string): Promise<number | undefined> {
    let raw: string;
    try {
      const result = await this.client.fsRead(spriteName, sentinelPath("rc", processId));
      if (!result) return undefined;
      raw = new TextDecoder().decode(result.bytes).trim();
    } catch {
      return undefined;
    }
    if (!/^-?\d+$/.test(raw)) return undefined;
    const code = Number.parseInt(raw, 10);
    return Number.isSafeInteger(code) ? code : undefined;
  }

  /**
   * Read one output sentinel, capped.
   *
   * The cap is PER STREAM, deliberately: stdout and stderr are separate files
   * read independently, so a process can return up to 2x
   * `maxProcessOutputBytes` from `readProcessOutput`. A shared budget would mean
   * a chatty stderr could starve stdout of its allowance, and the two reads
   * would have to be ordered — the tail limits that actually protect storage and
   * the model's context are applied above this, per stream, by
   * `ComputeThreadService`.
   *
   * The slice is a RAW BYTE cut, so a multi-byte codepoint straddling the
   * boundary decodes to a single U+FFFD. That is acceptable for a 20MB
   * truncation of program output (the alternative is scanning back for a
   * codepoint boundary, which buys one character), but it means the tail of a
   * capped stream is not guaranteed to be valid text.
   */
  private async readSentinelText(spriteName: string, path: string): Promise<string> {
    const result = await this.client.fsRead(spriteName, path);
    if (!result) return "";
    const limit = DEFAULT_COMPUTE_LIMITS.maxProcessOutputBytes;
    const bytes = result.bytes.byteLength > limit ? result.bytes.slice(0, limit) : result.bytes;
    return new TextDecoder().decode(bytes);
  }

  private runtimeName(reference: BackendReference): string {
    const parsed = spritesReferenceSchema.parse(reference);
    if (parsed.payload.kind !== "runtime") {
      throw new ComputeError("runtime_missing", "sprites_runtime_reference_invalid");
    }
    return parsed.payload.spriteName;
  }

  private processPayload(process: BackendProcessReference) {
    const parsed = spritesReferenceSchema.parse(process);
    if (parsed.payload.kind !== "process") {
      throw new ComputeError("process_missing", "sprites_process_reference_invalid");
    }
    return parsed.payload;
  }

  private requireProcessRuntime(runtimeName: string, processSpriteName: string): void {
    if (runtimeName !== processSpriteName) {
      throw new ComputeError("process_missing", "sprites_process_runtime_mismatch");
    }
  }

  private runtimeReference(spriteName: string): BackendReference {
    return { provider: this.id, version: 1, payload: { kind: "runtime", spriteName } };
  }

  private recoveryReference(spriteName: string): BackendReference {
    return { provider: this.id, version: 1, payload: { kind: "recovery", spriteName } };
  }

  private processReference(spriteName: string, processId: string): BackendProcessReference {
    return { provider: this.id, version: 1, payload: { kind: "process", spriteName, processId } };
  }
}

/**
 * Where a process's stdout/stderr/exit-code/stdin live. Keyed by a per-launch
 * uuid, so a sentinel can never be read for the wrong process — and the id's
 * presence inside the wrapper's own command string is what makes the session
 * findable in `listSessions`.
 */
function sentinelPath(kind: "in" | "out" | "err" | "rc", processId: string): string {
  return `/tmp/.nadi-${kind}-${processId}`;
}

/** `%F:%s` output, e.g. `regular file:120` / `directory:4096`. */
function parseStat(stdout: string): { type: PathInfo["type"]; size: number } | null {
  const trimmed = stdout.trim();
  const separator = trimmed.lastIndexOf(":");
  if (separator <= 0) return null;
  const description = trimmed.slice(0, separator).trim().toLowerCase();
  const size = Number.parseInt(trimmed.slice(separator + 1).trim(), 10);
  if (!Number.isSafeInteger(size)) return null;
  if (description === "symbolic link") return { type: "symlink", size };
  if (description === "directory") return { type: "directory", size };
  return { type: "file", size };
}

function shellQuote(value: string): string {
  return `'${value.replace(/'/g, `'\\''`)}'`;
}

function toArrayBuffer(bytes: Uint8Array): ArrayBuffer {
  return bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer;
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
