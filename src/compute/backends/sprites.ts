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

/**
 * How many extra times `getProcessStatus` re-reads the rc sentinel once the
 * session has LEFT the listing without one, and how long it waits between
 * reads.
 *
 * LIVE (2026-08-04): the two observations are not simultaneous. A `sleep 8;
 * echo done` was seen with its stdout sentinel already written, its session
 * still listed, and NO rc file — and then, ~200ms later, rc `0`. A single read
 * that lands in that window sees "no exit recorded, session gone" and, without
 * this grace, reports a perfectly successful process as `failed` — which is
 * exactly what the smoke's step 4b did.
 */
const RC_SETTLE_ATTEMPTS = 3;
const RC_SETTLE_INTERVAL_MS = 300;

/**
 * What one read of the rc sentinel established.
 *
 * The distinction that matters is `absent` vs `unknown`: a 404 whose body says
 * the FILE is missing is evidence, a read that threw or a file whose content
 * does not parse (a `printf` caught mid-write) is not. Collapsing both to
 * "no answer" is what let a transient read failure become a `failed` verdict.
 */
type RcRead =
  | { kind: "code"; code: number }
  | { kind: "absent" }
  | { kind: "unknown"; detail: string };

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
  /** Keys the /tmp sentinel files (stdout/stderr/rc/stdin). */
  processId: z.string().min(1),
  /**
   * The server's own id for the detached session, captured from `session_info`
   * at launch. Required: without it a process is unaddressable — the session
   * listing reports the inner argv, so nothing we embedded in the wrapper is
   * findable, and both liveness and kill would silently no-op.
   */
  sessionId: z.string().min(1),
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
  /**
   * A sprite hibernates on its own ~30s after activity stops and there is no
   * way to turn that off, so compute billing has already stopped long before
   * the service's idle timer fires. See `ComputeBackend.nativeIdleSuspend`.
   */
  readonly nativeIdleSuspend = true;
  private readonly client: SpritesClient;
  /**
   * The runtime's environment, carried on EVERY exec.
   *
   * LIVE (2026-08-04): `createSprite`'s `environment` does not reach a command.
   * A sprite created with `{PROBE_ENV:"reached-the-command"}` ran
   * `echo "[$PROBE_ENV]"` and printed `[]`. Sending the same pair as the exec
   * `env` query param printed the value. So the create-time environment is,
   * for our purposes, write-only — and passing `spec.env` to `createSprite`
   * (the only place it went before) meant workbench env vars and the GitHub
   * App's minted `GH_TOKEN` reached NO command at all. A private-repo clone
   * would have failed as an auth error with nothing pointing at the cause.
   *
   * Held in the INSTANCE, never in the persisted `BackendReference`: the
   * reference is written to durable storage and these values are secrets. The
   * registry constructs a backend per operation and passes the same resolved
   * env the service holds, and `acquire` folds in `spec.env` for callers that
   * construct the backend directly (the live smoke, tests).
   */
  private runtimeEnv: Record<string, string>;

  constructor(input: { client: SpritesClient; env?: Record<string, string> }) {
    this.client = input.client;
    this.runtimeEnv = { ...(input.env ?? {}) };
  }

  async acquire(spec: ComputeSpec, recovery?: BackendReference): Promise<BackendReference> {
    // Fold the spec's env into what every later exec carries. The registry
    // normally supplies the same values at construction; this covers the
    // direct-construction callers (the live smoke, tests) and keeps a
    // recovered runtime carrying the CURRENT spec rather than whatever was
    // baked in at create time — which, per `runtimeEnv`, was nothing.
    this.runtimeEnv = { ...this.runtimeEnv, ...spec.env };
    if (recovery) {
      const parsed = spritesReferenceSchema.safeParse(recovery);
      if (!parsed.success || parsed.data.payload.kind !== "recovery") {
        throw new ComputeError("recovery_failed", "sprites_recovery_reference_invalid");
      }
      // A hibernated sprite still exists and wakes on the first API call, so
      // there is nothing to create or start — just re-apply the policies and
      // make sure the workspace root is there.
      //
      // Recovery DOES pick up a changed `spec.env`, unlike Daytona (whose env
      // is baked into the sandbox at creation): nothing here is baked in, the
      // env rides on each exec, and the fold above already took the current
      // spec's values.
      const spriteName = parsed.data.payload.spriteName;
      await this.prepare(spriteName, spec);
      return this.runtimeReference(spriteName);
    }

    const spriteName = `nadi-${crypto.randomUUID()}`;
    // Deliberately created with NO `environment`. It does not reach commands
    // (see `runtimeEnv`), so sending it would write every workbench secret and
    // the minted `GH_TOKEN` into a provider-side record that nothing ever
    // reads. The env is carried per-exec instead.
    await this.client.createSprite(spriteName, {});
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
    const env = this.execEnv(input.env);
    const result = await this.client.execCollect(spriteName, {
      argv: ["bash", "-c", input.command],
      dir: input.cwd ?? WORKSPACE_ROOT,
      ...(env === undefined ? {} : { env }),
      timeoutMs: input.timeoutMs,
    });
    return {
      status: "exited",
      exitCode: result.exitCode,
      stdout: result.stdout,
      stderr: result.stderr,
      // The 64KiB fast-path replay cap, when the server said it applied. The
      // exposed caller is the foreground `exec` tool, whose stdout a MODEL acts
      // on — a silently halved `git diff` is a wrong-answer generator, so the
      // cut is reported rather than hidden. See `execCollect`'s doc.
      ...(result.truncated === true ? { stdoutTruncated: true } : {}),
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
    //
    // The rc write is a write-then-RENAME, not a plain redirect: `> rc` creates
    // the file before `printf` fills it, so a status poll landing in that window
    // reads an empty file. `readRcOnce` treats unparsable content as "no
    // answer", so the empty read is not mistaken for an exit code — but the
    // rename removes the window entirely, and it is one extra word.
    const wrapper =
      `cd ${shellQuote(input.cwd ?? WORKSPACE_ROOT)} && ` +
      `timeout ${timeoutSecs} bash -c ${shellQuote(input.command)} ` +
      `< ${stdinPath} > ${outPath} 2> ${errPath}; ` +
      `printf %s "$?" > ${rcPath}.tmp && mv -f ${rcPath}.tmp ${rcPath}`;
    // The env rides in the `env` query param, NOT as `export` lines inside the
    // wrapper. Neither is secret-safe against a server that logs its request
    // line — the wrapper itself is sent as repeated `cmd` params on the same
    // URL, so `export GH_TOKEN=…` would sit in exactly the same place, just
    // harder to read and one shell-quoting bug away from a broken script. One
    // mechanism for both exec paths is the cheaper thing to keep correct.
    const env = this.execEnv(input.env);
    const sessionId = await this.client.execDetached(spriteName, {
      argv: ["bash", "-c", wrapper],
      detachable: true,
      // Outlive the command's own timeout, so the wrapper always gets to write
      // its rc file rather than being reaped mid-exit.
      maxRunAfterDisconnect: `${timeoutSecs + 60}s`,
      ...(env === undefined ? {} : { env }),
    });

    const process = this.processReference(spriteName, processId, sessionId);
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
    const rc = await this.readRcOnce(spriteName, payload.processId);
    if (rc.kind === "code") return { status: "exited", exitCode: rc.code };
    const sessions = await this.client.listSessions(spriteName);
    // Presence of the session id is the ONLY liveness signal. Not the row's
    // `is_active` (live, that read `false` for a running `sleep 120` — it means
    // "a client is attached"), and never a substring of `command`, which carries
    // the inner process's argv rather than our wrapper.
    if (sessions.some((session) => session.sessionId === payload.sessionId)) {
      return { status: "running" };
    }
    // No session and no exit code — but the two reads happened at different
    // moments, and live the rc file has been seen landing ~200ms AFTER the
    // process was otherwise finished. Re-read before answering, or a successful
    // run that merely settled between the two calls is reported `failed`.
    let last: RcRead = rc;
    for (let attempt = 0; attempt < RC_SETTLE_ATTEMPTS; attempt += 1) {
      await delay(RC_SETTLE_INTERVAL_MS);
      last = await this.readRcOnce(spriteName, payload.processId);
      if (last.kind === "code") return { status: "exited", exitCode: last.code };
    }
    if (last.kind === "unknown") {
      // The rc file could not be READ (the sprite answered `listSessions`, so it
      // is alive and this is transient). That is not evidence the process died,
      // and `failed` is a terminal verdict callers stop polling on — so report
      // the non-terminal answer and let the next poll decide.
      return { status: "running" };
    }
    // Positively absent, three times, with the session gone: the process went
    // away without recording an exit — killed by a signal the wrapper never
    // saw, or a cold sprite restart. `failed` is the honest answer; inventing
    // an exit code is not.
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
    // Read the rc sentinel FIRST, the same ordering `getProcessStatus` uses,
    // and for a sharper reason here.
    //
    // A session id is a small per-sprite counter, not a uuid — live ids were
    // "15", "332", "333", "346" — and nothing establishes that the counter does
    // not reset when a sprite restarts or wakes from hibernation. If ids
    // recycle, a stale process reference matching by equality below would kill
    // an UNRELATED process. The rc sentinel is keyed by a per-launch uuid and
    // cannot be confused: when it says this process already recorded an exit,
    // there is nothing to signal, so we never look at the session listing and
    // the recycled-id kill is unreachable for every already-finished process
    // (which is the overwhelmingly common case for a stale reference).
    //
    // Not a full identity fix — a reference to a still-RUNNING process whose id
    // was recycled remains theoretically exposed. See docs/operations/sprites.md.
    const recorded = await this.readRc(spriteName, payload.processId);
    if (recorded !== undefined) return { status: "exited", exitCode: recorded };
    const sessions = await this.client.listSessions(spriteName);
    const session = sessions.find((entry) => entry.sessionId === payload.sessionId);
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
    // The client resolved the entry's own `type` string; a symlink stays a
    // symlink here rather than being flattened into a file.
    return entries.map((entry) => ({ name: entry.name, type: entry.type }));
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
    // `createParents:false` is a request the server does not honour — it creates
    // parents either way (live probe). See `fsWrite`; we do not simulate the
    // constraint locally rather than pretend it is enforced.
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
    // Matched against BOTH streams: a session that has already exited replays
    // through the server's "fast_path", where stdout and stderr arrive MERGED on
    // stream 1 and no stream-2 frame is sent at all (live, 2026-08-04, for this
    // exact `stat`). Reading `stderr` alone turned "absent" into
    // `sprites_stat_unanswered`, breaking `pathExists`, `writeFile({overwrite:
    // false})`, `movePath` and `inspectPath`. When we attach before the exit,
    // stderr does arrive on stream 2 — both shapes must answer.
    if (/No such file/i.test(`${result.stdout}\n${result.stderr}`)) return null;
    throw new ComputeError(
      "provider_transient",
      `sprites_stat_unanswered: exit ${result.exitCode} ${(result.stderr.trim() || result.stdout.trim()).slice(0, 200)}`,
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
    const rc = await this.readRcOnce(spriteName, processId);
    return rc.kind === "code" ? rc.code : undefined;
  }

  /**
   * One read of the rc sentinel, keeping "proven absent" separate from "could
   * not tell". See `RcRead` — `getProcessStatus` is the only caller that needs
   * the distinction, and it is the caller that can turn a wrong guess into a
   * terminal `failed` verdict.
   */
  private async readRcOnce(spriteName: string, processId: string): Promise<RcRead> {
    let raw: string;
    try {
      const result = await this.client.fsRead(spriteName, sentinelPath("rc", processId));
      if (!result) return { kind: "absent" };
      raw = new TextDecoder().decode(result.bytes).trim();
    } catch (error) {
      return { kind: "unknown", detail: error instanceof Error ? error.message : String(error) };
    }
    if (!/^-?\d+$/.test(raw)) {
      // Content that does not parse means the write is still in flight (or the
      // file is corrupt) — NOT that no exit happened.
      return { kind: "unknown", detail: `unparsable rc ${JSON.stringify(raw.slice(0, 40))}` };
    }
    const code = Number.parseInt(raw, 10);
    if (!Number.isSafeInteger(code)) {
      return { kind: "unknown", detail: `rc out of range ${JSON.stringify(raw.slice(0, 40))}` };
    }
    return { kind: "code", code };
  }

  /**
   * The environment for one exec: the runtime's env, with any per-call env
   * layered on top. `undefined` when there is nothing to send, so an exec with
   * no env keeps the sprite's own default environment rather than replacing it
   * with a one-entry one (the `env` param REPLACES; see `DEFAULT_EXEC_PATH` in
   * the client, which is where the PATH-preservation lives — it is not
   * duplicated here).
   */
  private execEnv(callerEnv?: Record<string, string>): Record<string, string> | undefined {
    const merged = { ...this.runtimeEnv, ...(callerEnv ?? {}) };
    return Object.keys(merged).length > 0 ? merged : undefined;
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
    // A malformed reference is a `process_missing` ComputeError, not a raw
    // ZodError: callers key on the compute taxonomy, and a ZodError escaping
    // here reaches the model as an unmapped stack-shaped blob.
    const parsed = spritesReferenceSchema.safeParse(process);
    if (!parsed.success) {
      throw new ComputeError("process_missing", "sprites_process_reference_invalid");
    }
    if (parsed.data.payload.kind !== "process") {
      throw new ComputeError("process_missing", "sprites_process_reference_invalid");
    }
    return parsed.data.payload;
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

  private processReference(
    spriteName: string,
    processId: string,
    sessionId: string,
  ): BackendProcessReference {
    return {
      provider: this.id,
      version: 1,
      payload: { kind: "process", spriteName, processId, sessionId },
    };
  }
}

/**
 * Where a process's stdout/stderr/exit-code/stdin live. Keyed by a per-launch
 * uuid, so a sentinel can never be read for the wrong process.
 *
 * The id is NOT how the session is found: the listing reports the inner
 * process's argv, not our wrapper, so the session is addressed by the id the
 * server disclosed at launch (`sessionId` on the process reference).
 */
function sentinelPath(kind: "in" | "out" | "err" | "rc", processId: string): string {
  return `/tmp/.nadi-${kind}-${processId}`;
}

/**
 * `%F:%s` output, e.g. `regular file:120` / `directory:4096`.
 *
 * The LAST non-empty line, never the whole blob. On the server's fast_path
 * replay stderr is merged onto stdout, so a warning line can precede `stat`'s
 * own answer — and parsing the blob then takes `lastIndexOf(":")` across BOTH,
 * making `some warning\ndirectory:4096` read as a description of
 * `some warning\ndirectory`, i.e. type `file` for a directory. `pathExists`,
 * `movePath` and `inspectPath` all sit on that answer.
 */
function parseStat(stdout: string): { type: PathInfo["type"]; size: number } | null {
  const lines = stdout.split("\n").filter((line) => line.trim().length > 0);
  const trimmed = (lines[lines.length - 1] ?? "").trim();
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
