export type ComputeProviderId = "daytona" | "cloudflare" | (string & {});
export type ComputeResourceProfile = "small" | "medium";
export type ReleaseDisposition = "discard" | "recoverable";
export type StopMode = "interrupt" | "terminate" | "kill";

export interface BackendReference<P = unknown> {
  provider: ComputeProviderId;
  version: 1;
  payload: P;
}

export interface ComputeSpec {
  environmentId: string;
  profile: ComputeResourceProfile;
  workspaceRoot: "/workspace";
  env: Record<string, string>;
  maxProcessRuntimeMs: number;
  allowedHosts: string[] | null;
}

export type BackendProcessReference = BackendReference;

export interface StartProcessInput {
  command: string;
  cwd?: string;
  env?: Record<string, string>;
  stdin?: string;
  timeoutMs: number;
  /**
   * A complete shell fragment, already carrying a signed completion token,
   * that reports this process's own exit code back to
   * `POST /api/compute/completion` — the push half of completion delivery
   * (see `src/compute/completion-token.ts`). Built by `ThreadComputeService`,
   * which owns the Worker-side secret and base URL; a backend never mints its
   * own token.
   *
   * The fragment references the env var `$NADI_EXIT_CODE` for the exit code
   * rather than embedding a value itself — the CALLER cannot know the exit
   * code before the process has run, and a backend that tracks completion via
   * its own sentinel (sprites' rc file) is the only thing that can supply the
   * value that was actually recorded, not a second, possibly different,
   * observation. A backend that consumes this fragment MUST set
   * `NADI_EXIT_CODE` to that recorded value immediately before running it.
   *
   * Optional, and silently ignorable: a backend with no wrapper to insert a
   * shell fragment into simply never reads this field. Sprites and Cloudflare
   * both wrap it in (`buildSpritesWrapper`, `buildCompletionCallbackWrapper`);
   * Daytona does not and is not expected to grow one — it is being phased out
   * over its network-allowlist behavior. Absent whenever the caller has no
   * base URL to call back to — see `ThreadComputeService`'s
   * `buildCompletionCallback`.
   */
  completionCallback?: string;
}

export interface RunCommandInput {
  command: string;
  cwd?: string;
  env?: Record<string, string>;
  timeoutMs: number;
}

export interface RunCommandResult {
  status: "exited" | "failed";
  exitCode: number;
  stdout: string;
  stderr: string;
  /**
   * `true` when the backend KNOWS `stdout` is a prefix of what the command
   * wrote. Optional and absent by default: a backend that cannot tell must not
   * claim `false`, and `ThreadComputeService` already treats the default as
   * "complete". Today only the sprites backend sets it, from the server's own
   * 64KiB replay-cap notice.
   */
  stdoutTruncated?: boolean;
}

export interface ProcessStatus {
  status: "running" | "exited" | "failed" | "stopped";
  exitCode?: number;
}

export interface StartProcessResult extends ProcessStatus {
  process: BackendProcessReference;
  stdout?: string;
  stderr?: string;
}

export interface ProcessOutput {
  stdout?: string;
  stderr?: string;
}

export interface ProcessOutputSink {
  stdout(chunk: string): void | Promise<void>;
  stderr(chunk: string): void | Promise<void>;
}

export interface PathInfo {
  /**
   * `"symlink"` is PROVIDER-DEPENDENT and best-effort. Daytona's `getFileDetails`
   * follows links (verified live, 2026-07-10), so a link reports as its target's
   * type and never as `"symlink"`. The containment guard's symlink rejection is
   * therefore INERT on Daytona. Do not treat it as a security boundary: the
   * sandbox is the boundary, and `exec` already grants a shell inside it. What is
   * genuinely enforced is the provider-independent syntactic rejection of
   * absolute, empty, NUL, and `..` traversal paths.
   */
  type: "file" | "directory" | "symlink";
  size: number;
  /**
   * The path with symlinks resolved, when the provider can resolve them.
   * Providers are NOT required to — some (e.g. Daytona) echo the input path
   * unchanged. Containment checks MUST NOT rely on `resolvedPath` alone; the
   * `type === "symlink"` rejection is the real guard against escaping paths.
   */
  resolvedPath: string;
}

/**
 * One entry in a directory listing.
 *
 * `type` widens `PathInfo["type"]` by exactly one member: a listing reports
 * whatever the directory holds, and a socket/device/fifo is a real entry a
 * `stat` of a single path would never be asked about. It is carried rather than
 * filtered out because a caller matching a name against the listing must see
 * every name that is there — silently dropping one would read a present entry
 * as absent.
 */
export interface DirEntry {
  name: string;
  type: PathInfo["type"] | "other";
}

export interface ReadFileResult {
  bytes: ArrayBuffer;
  /** Provider-supplied mime type, when available; absent otherwise. */
  mimeType?: string;
}

export interface WriteFileOptions {
  createParents: boolean;
  overwrite: boolean;
}

export interface ReleaseOptions {
  disposition: ReleaseDisposition;
  recoveryTtlMs?: number;
}

export interface ComputeBackend {
  readonly id: ComputeProviderId;
  /**
   * The provider suspends an idle runtime on its own, so the service does not
   * need to discard early to stop billing.
   *
   * Optional and absent by default. Daytona (`autoStopInterval: 0`) and
   * Cloudflare (`keepAlive: true`) deliberately DISABLE native idle handling,
   * so an idle runtime there bills continuously and discarding on the idle
   * timer is what stops the meter. Sprites hibernates ~30s after activity with
   * no way to disable it, so by the time our 15-minute timer fires compute
   * billing has long since stopped and an INFERRED discard buys only disk —
   * paid for by destroying work.
   *
   * A NEW BACKEND MUST DECIDE THIS. Omitting it is not a neutral default: it
   * opts the provider into the inferred discards, so a backend that does
   * suspend itself and forgets to declare it will have idle sandboxes deleted
   * on a guess, which is how a real user lost work.
   */
  readonly nativeIdleSuspend?: boolean;
  /**
   * Whether this backend actually assembles `StartProcessInput.completionCallback`
   * into what it runs. Absent means the field is silently ignored, so a missing
   * or unreachable callback origin is NOT a reason to refuse backgrounding here
   * — completion comes from the poll, as it always has.
   *
   * A NEW BACKEND MUST DECIDE THIS. It is the predicate
   * `ThreadComputeService.shouldRefuseBackgrounding` is derived from; a
   * provider-id allow-list drifted the moment a provider gained or lost the
   * wrapper. True today for sprites and Cloudflare (both assemble the
   * fragment into what they run); false for Daytona, which is being phased
   * out over its network-allowlist behavior and is not expected to grow one.
   *
   * ACCEPTED CONSEQUENCE: with this `true`, `shouldRefuseBackgrounding` fires
   * whenever the caller has no reachable base URL to call back to — which is
   * exactly local dev's loopback `APP_BASE_URL` against a real Cloudflare
   * container. Backgrounding is refused there, so a long command runs
   * synchronously and can hit the exec timeout instead. This is the design
   * working as intended (no delivery path ⇒ do not pretend to watch), the
   * ordinary local default is the in-process `mock` provider and is
   * unaffected, and testing push against real containers locally requires a
   * reachable origin anyway.
   */
  readonly consumesCompletionCallback?: boolean;
  /**
   * Shell fragments that pin the runtime awake while background work runs, and
   * release it afterwards.
   *
   * A NEW BACKEND MUST DECIDE THIS. Absent means "this provider executes while
   * idle", which is not a neutral default: a provider that starves idle work and
   * omits this will make no progress on every backgrounded command, and will
   * report the starvation as a `watch_timeout` an hour later. Measured on
   * sprites.dev 2026-08-12: 2% duty cycle unheld, 99% held.
   *
   * Fragments rather than methods because the only place a hold can be taken on
   * sprites is INSIDE the sandbox — its Tasks API is served on a unix socket the
   * Worker cannot reach, and the public REST surface has no tasks resource.
   *
   * Keyed by the `BackendProcessReference` `startProcess` returns, NOT by a
   * caller-chosen id: the hold name must be derivable from whatever identifies
   * the process to THIS provider, and only the provider knows what that is (on
   * sprites it is the same uuid the wrapper's sentinel files are keyed by). A
   * provider-neutral caller (`ThreadComputeService`) must never compute a
   * provider-specific hold name itself — that would mean importing a concrete
   * backend module from the neutral layer, which is exactly the layering
   * violation this shape avoids.
   */
  readonly workHold?: {
    acquireFor(process: BackendProcessReference): string;
    refreshFor(process: BackendProcessReference): string;
    releaseFor(process: BackendProcessReference): string;
  };
  /**
   * Whether this backend's ONLY observable completion signal is the wrapped
   * command's own exit — so the completion callback runs *before* completion
   * can be observed at all, and its latency is added to every command's
   * OBSERVED runtime.
   *
   * Meaningful only alongside `consumesCompletionCallback`. True for
   * Cloudflare: `waitForProcessExit` settles when the process log stream
   * closes, which is the wrapper exiting, and the callback sits inside the
   * wrapper before `exit "$__nadi_rc"`. Absent for sprites, which writes its
   * rc sentinel BEFORE the callback, so a status poll observes the terminal
   * no matter how long the callback takes.
   *
   * The consequence is a tighter `curl` bound for this backend's fragment
   * (see `COMPLETION_CALLBACK_CURL_TIMEOUT_SECS` in `thread-service.ts`):
   * `exec()`'s foreground window is 10s, so a callback allowed 25s here would
   * make a sub-second command report as `"backgrounded"` whenever the origin
   * is slow to answer from inside a container.
   */
  readonly completionCallbackDelaysCompletion?: boolean;
  /**
   * One shell command that answers the same question the watcher poll needs
   * (has this process recorded an exit yet?) and, ONLY when it has not,
   * re-asserts `workHold` for it in the same breath. Optional, and
   * meaningful only alongside `workHold`: a backend with no hold has nothing
   * to reassert, and `ThreadComputeService.pollProcessStatus` falls back to
   * plain `getProcessStatus` when this is absent.
   *
   * Exists because a lost hold (its in-sandbox refresher died) is invisible
   * from the Worker — the Tasks API `workHold` talks to is reachable only
   * from inside the sandbox — and presents as work that simply never
   * finishes. The periodic poll is the only thing that can notice and repair
   * it, and it must not pay for that repair with a SECOND EXEC: on sprites,
   * an exec risks waking a hibernated VM, and the reassert is only ever
   * needed on the branch where the process might still be running anyway.
   *
   * Re-asserting is conditional on there being no rc yet, not unconditional:
   * a process that already exited already released its own hold (see
   * `buildSpritesWrapper`), and re-creating a 5-minute hold on a finished,
   * abandoned process bills a VM awake for no reason — repeatedly, once per
   * poll, for as long as nothing else ever releases it.
   *
   * Contract for the returned command's stdout: it either contains a marked
   * line `nadi-rc:<n>` (an integer, being that exit code) when the rc
   * sentinel was found, or it does not — never a bare, unmarked number that
   * could be confused with warning text a provider's fast-path replay may
   * have merged onto the same stream ahead of the intended output (see
   * `parseStat` in sprites.ts for the same hazard). Absence of the marker
   * means "no answer yet", the same "never exit code 0" rule `readRcOnce`
   * already applies — `pollProcessStatus` falls back to `getProcessStatus`
   * in that case, which is exactly the branch where the acquire above ran.
   *
   * `process` is a `BackendProcessReference`, never a caller-built string —
   * the backend owns the naming scheme for both the hold and its own
   * sentinel path, same reasoning as `workHold` above.
   */
  buildBackstopProbe?(process: BackendProcessReference): string;
  acquire(spec: ComputeSpec, recovery?: BackendReference): Promise<BackendReference>;
  release(runtime: BackendReference, options: ReleaseOptions): Promise<BackendReference | null>;
  destroy(reference: BackendReference): Promise<void>;
  startProcess(runtime: BackendReference, input: StartProcessInput): Promise<StartProcessResult>;
  /**
   * Run a command to completion in one call, letting the provider report the
   * exit itself. Optional: a backend that omits it falls back to
   * startProcess + status polling.
   *
   * Prefer this wherever a caller must wait out a command it cannot bound to a
   * few seconds. On Cloudflare, `run_skill_script`'s long-lived status poll
   * (upload -> startProcess -> poll getProcess, all in one Durable Object
   * invocation) reliably wedged: some getProcess call blocked ~10 minutes and
   * then threw. Every cadence tried failed — 1000ms, 2000ms, and 500ms — so
   * there is no interval that makes that shape safe.
   *
   * The exact trigger is NOT established. It is not simply "polling across the
   * exit": `exec()`'s bounded 10s/500ms foreground poll observes exits fine in
   * production (verified live, with and without prior uploads). Whatever the
   * cause, `runCommand` sidesteps it by never asking for a status at all.
   */
  runCommand?(runtime: BackendReference, input: RunCommandInput): Promise<RunCommandResult>;
  /**
   * Wait for a started process to settle without repeatedly polling its status.
   * Cloudflare implements this through its process-log stream, which closes
   * when the command exits. Keeping the process handle lets a turn cancel
   * terminate the command while it is being awaited.
   */
  waitForProcessExit?(
    runtime: BackendReference,
    process: BackendProcessReference,
    sink: ProcessOutputSink,
  ): Promise<ProcessStatus>;
  getProcessStatus(
    runtime: BackendReference,
    process: BackendProcessReference,
  ): Promise<ProcessStatus>;
  readProcessOutput(
    runtime: BackendReference,
    process: BackendProcessReference,
  ): Promise<ProcessOutput>;
  streamProcessOutput?(
    runtime: BackendReference,
    process: BackendProcessReference,
    sink: ProcessOutputSink,
  ): Promise<void>;
  stopProcess(
    runtime: BackendReference,
    process: BackendProcessReference,
    mode: StopMode,
  ): Promise<ProcessStatus>;
  inspectPath(runtime: BackendReference, path: string): Promise<PathInfo | null>;
  /**
   * Whether `path` exists.
   *
   * Contract: an implementation MUST answer or throw. There is no "unknown"
   * arm — a provider failure, whether thrown or reported IN BAND (the
   * Cloudflare SDK returns `{ success: false }` without raising), MUST become a
   * throw and MUST NOT be reported as `false`.
   *
   * This is deliberately stricter than `inspectPath`, which maps both "the
   * provider answered, nothing there" and "the provider failed in band" to
   * `null`. Callers use `pathExists` to decide whether writing to `path` would
   * destroy existing content, so a `false` that merely means "could not tell"
   * is a data-loss bug rather than a degraded answer: it is what let an
   * `apply_patch` `add` op silently overwrite a user's file.
   */
  pathExists(runtime: BackendReference, path: string): Promise<boolean>;
  /**
   * List `path`'s immediate entries, dot-prefixed ones included.
   *
   * Contract: an implementation MUST answer or throw. There is no null arm and
   * no not-found mapping — a missing directory is a THROW, and so is any other
   * provider failure. It MUST NOT report a directory it could not list as an
   * empty (or partial) listing.
   *
   * This is deliberately stricter than `inspectPath`, which returns null for
   * both "the provider answered, nothing there" and "the provider threw
   * something that reads like not-found". `readGeneration` depends on the
   * difference: a listing that ANSWERED is the only positive evidence that a
   * container's filesystem was wiped under it, and it is read as exactly that.
   * A backend that swallowed a failed listing into `[]` would make the probe
   * tell a model its intact work is gone.
   */
  listDirectory(runtime: BackendReference, path: string): Promise<DirEntry[]>;
  /**
   * Read a file's bytes plus, when the provider can supply one, its mime type.
   * The mime rides with the read (not `inspectPath`/`PathInfo`) because it is a
   * property of the content being returned, and providers that expose it do so
   * on the download response. Absent mime → caller falls back (octet-stream).
   *
   * Contract: if the file exceeds `maxBytes`, an implementation MUST throw
   * `ComputeError("compute_file_too_large")` and MUST NOT truncate and return
   * partial bytes. Callers hash the returned bytes for optimistic concurrency
   * (`ComputeFileService`); a truncating backend would make that hash describe
   * fewer bytes than are actually on disk, letting a later write pass a
   * staleness check against content that never matched.
   */
  readFile(runtime: BackendReference, path: string, maxBytes: number): Promise<ReadFileResult>;
  writeFile(
    runtime: BackendReference,
    path: string,
    bytes: ArrayBuffer,
    options: WriteFileOptions,
  ): Promise<void>;
  createDirectory(runtime: BackendReference, path: string): Promise<void>;
  deletePath(runtime: BackendReference, path: string): Promise<void>;
  /**
   * Move `from` to `to`.
   *
   * Contract: with `overwrite: true` an implementation MUST replace an existing
   * destination; with `overwrite: false` it MUST reject one (throw). Callers
   * rely on the overwrite guarantee for the temp-sibling commit in
   * `ComputeFileService` — the common in-place `apply_patch` update moves a temp
   * file over the destination it just read, which already exists. A backend
   * whose native move refuses an existing destination must delete it first.
   */
  movePath(runtime: BackendReference, from: string, to: string, overwrite: boolean): Promise<void>;
}
