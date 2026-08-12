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
  RunCommandInput,
  RunCommandResult,
  StartProcessInput,
  StartProcessResult,
  StopMode,
  WriteFileOptions,
} from "../backend";
import { ComputeError, type ComputeErrorCode } from "../errors";
import type {
  ClientDirectoryBackup,
  ClientProcessStatus,
  CloudflareSandbox,
  CloudflareSandboxFactory,
  CloudflareSandboxOptions,
} from "./cloudflare-client";

/**
 * getSandbox options for every resolve. `keepAlive: true` stops the container
 * auto-sleeping (the backend controls its lifetime via `release`/`destroy`);
 * `enableDefaultSession: false` runs each command as a fresh process with no
 * shared shell state, so a stray `cd` in one exec can't leak into the next.
 */
const SANDBOX_OPTIONS: CloudflareSandboxOptions = {
  enableDefaultSession: false,
  keepAlive: true,
};

/** The one directory the recoverable-release path backs up and restores. */
const WORKSPACE_DIR = "/workspace" as const;

/**
 * Recovery TTL policy bound: 1–168 hours. The provider's `ttl` is in SECONDS
 * (a `recoveryTtlMs` in milliseconds fed straight in would expire backups 1000×
 * too soon), so callers hand us milliseconds and we clamp + convert here.
 */
const MIN_RECOVERY_TTL_MS = 60 * 60 * 1_000; // 1 hour
const MAX_RECOVERY_TTL_MS = 168 * 60 * 60 * 1_000; // 168 hours
const DEFAULT_RECOVERY_TTL_MS = 24 * 60 * 60 * 1_000; // 24 hours

const runtimePayloadSchema = z.object({
  kind: z.literal("runtime"),
  sandboxId: z.string().min(1),
  profile: z.enum(["small", "medium"]),
});
const processPayloadSchema = z.object({
  kind: z.literal("process"),
  sandboxId: z.string().min(1),
  processId: z.string().min(1),
});
const referenceSchema = z.object({
  provider: z.literal("cloudflare"),
  version: z.literal(1),
  payload: z.discriminatedUnion("kind", [runtimePayloadSchema, processPayloadSchema]),
});

/**
 * Recoverable-release reference. `backup.id` is NOT a UUID (the SDK does not
 * document it as one) — `z.string().uuid()` would reject valid handles at
 * restore time and permanently strand a workspace. `expiresAt` is Nadi's own
 * bookkeeping (`now + ttl`), not a provider field.
 */
const backupPayloadSchema = z.object({
  kind: z.literal("backup"),
  // `localBucket` selects the SDK's restore path (local R2 binding vs production
  // presigned/FUSE). Dropping it restores a local-dev backup over the production
  // path and fails permanently — persist and replay it. Optional so pre-existing
  // references without it still parse (they default to the production path).
  backup: z.object({
    id: z.string().min(1),
    dir: z.literal(WORKSPACE_DIR),
    localBucket: z.boolean().optional(),
  }),
  profile: z.enum(["small", "medium"]),
  expiresAt: z.number().int().positive(),
});
const recoveryReferenceSchema = z.object({
  provider: z.literal("cloudflare"),
  version: z.literal(1),
  payload: backupPayloadSchema,
});

export interface CloudflareBindings {
  /** `env.NADI_SANDBOX_SMALL` / `env.NADI_SANDBOX_MEDIUM` — optional because the
   * generated `worker-configuration.d.ts` could not be regenerated here. */
  small?: unknown;
  medium?: unknown;
}

/** Cloudflare Sandbox implementation of the provider-neutral compute contract. */
export class CloudflareComputeBackend implements ComputeBackend {
  readonly id = "cloudflare" as const;
  // No `workHold`: this backend runs with `keepAlive: true`, so the container
  // executes while idle and needs no hold. See `ComputeBackend.workHold` — the
  // omission is a decision, not an oversight.
  private readonly factory: CloudflareSandboxFactory;
  private readonly bindings: CloudflareBindings;
  private readonly workspaceId: string;
  private readonly threadId: string;
  /**
   * `localBucket: true` makes the DO resolve the `BACKUP_BUCKET` R2 binding
   * directly (required in local dev). Production uses presigned URLs. Task 4
   * decides the value; the backend never reads `Env`.
   */
  private readonly useLocalBucket: boolean;
  /** Injected clock so `expiresAt` bookkeeping is testable. */
  private readonly now: () => number;

  constructor(input: {
    factory: CloudflareSandboxFactory;
    bindings: CloudflareBindings;
    workspaceId: string;
    threadId: string;
    useLocalBucket?: boolean;
    now?: () => number;
  }) {
    this.factory = input.factory;
    this.bindings = input.bindings;
    this.workspaceId = input.workspaceId;
    this.threadId = input.threadId;
    this.useLocalBucket = input.useLocalBucket ?? false;
    this.now = input.now ?? Date.now;
  }

  async acquire(spec: ComputeSpec, recovery?: BackendReference): Promise<BackendReference> {
    // @cloudflare/sandbox@0.12.3 has NO network-policy API. Fail closed on a
    // real host allowlist, BEFORE resolving any container, so a rejected acquire
    // leaks nothing. This must hold on BOTH the fresh and recovery paths. `null`
    // and `[]` both mean unrestricted (matches Daytona's
    // `spec.allowedHosts?.length ? {...} : {}`).
    if (spec.allowedHosts && spec.allowedHosts.length > 0) {
      throw new ComputeError("policy_rejected", "cloudflare_no_network_policy");
    }

    // The sandbox id IS the Durable Object instance identity: getSandbox(ns, id)
    // resolves exactly one container per id, so it MUST be unique per (workspace,
    // thread) — otherwise every Cloudflare thread at a profile shares one
    // filesystem and processes across workspaces. `spec.environmentId` is only a
    // TEMPLATE identifier (the constant `cloudflare:<profile>` for this provider,
    // the Daytona snapshot name for Daytona), never an instance identity, so it
    // deliberately does NOT participate here. The identity is injected per
    // (workspace, thread) at construction; Task 4 wires threadId into the builder.
    // Resolving it before any container also fails closed on a missing identity.
    const sandboxId = this.resolveSandboxId();

    if (recovery) return this.acquireFromRecovery(spec, recovery, sandboxId);

    const sandbox = this.sandbox(spec.profile, sandboxId);
    await this.guard(() => sandbox.setEnvVars(spec.env));
    // The base image ships `/workspace`, but mkdir -p is idempotent and keeps the
    // guarantee that file tools resolving against the root have it present.
    const madeRoot = await this.guard(() => sandbox.mkdir(spec.workspaceRoot, true));
    this.ensureSuccess(madeRoot, "provider_transient", "cloudflare_mkdir_failed");
    return this.runtimeReference(sandboxId, spec.profile);
  }

  /**
   * Restore a recoverable release. Restores the backup, then reapplies the
   * CURRENT `spec.env` (never anything captured in the recovery reference) and
   * re-asserts keep-alive before returning the active runtime.
   *
   * On a failed restore the caller's recovery reference MUST stay reusable: we
   * do not destroy the backup and do not mutate the reference, so a retry can
   * succeed.
   */
  private async acquireFromRecovery(
    spec: ComputeSpec,
    recovery: BackendReference,
    sandboxId: string,
  ): Promise<BackendReference> {
    const parsed = recoveryReferenceSchema.safeParse(recovery);
    if (!parsed.success) {
      throw new ComputeError("recovery_failed", "cloudflare_recovery_reference_invalid");
    }
    const { backup } = parsed.data.payload;
    // Replay `localBucket` (it selects the SDK's restore path). Build the handle
    // without an explicit `undefined` to satisfy exactOptionalPropertyTypes.
    const handle: ClientDirectoryBackup = {
      id: backup.id,
      dir: backup.dir,
      ...(backup.localBucket !== undefined ? { localBucket: backup.localBucket } : {}),
    };
    const sandbox = this.sandbox(spec.profile, sandboxId);
    let result;
    try {
      result = await sandbox.restoreBackup(handle);
    } catch (error) {
      if (error instanceof ComputeError) throw error;
      const message = error instanceof Error ? error.message : String(error);
      throw new ComputeError("recovery_failed", `cloudflare_restore_failed: ${message}`);
    }
    // A non-throwing `{ success: false }` means the container restored NOTHING. If
    // we proceeded, `markActive` would transition recoverable → active and discard
    // this recovery reference over an empty workspace, orphaning the backup until
    // its TTL GC — permanent, silent data loss. Reject BEFORE reapplying env or
    // keep-alive so the caller's reference stays untouched and a retry can succeed.
    if (result.success !== true) {
      throw new ComputeError("recovery_failed", "cloudflare_restore_unsuccessful");
    }
    await this.guard(() => sandbox.setEnvVars(spec.env));
    await this.guard(() => sandbox.setKeepAlive(true));
    return this.runtimeReference(sandboxId, spec.profile);
  }

  async release(
    runtime: BackendReference,
    options: ReleaseOptions,
  ): Promise<BackendReference | null> {
    const { sandboxId, profile } = this.runtimePayload(runtime);
    const sandbox = this.sandbox(profile, sandboxId);
    if (options.disposition === "discard") {
      await this.guard(() => sandbox.destroy());
      return null;
    }

    // ORDERING IS SAFETY: back up FIRST, and destroy the container ONLY after the
    // backup resolves. A backup failure that still destroyed the container would
    // be unrecoverable data loss, so a rejected createBackup throws
    // provider_transient and never reaches destroy.
    const ttlSeconds = this.recoveryTtlSeconds(options.recoveryTtlMs);
    let backup;
    try {
      backup = await sandbox.createBackup({
        dir: WORKSPACE_DIR,
        name: sandboxId,
        ttl: ttlSeconds,
        localBucket: this.useLocalBucket,
      });
    } catch (error) {
      if (error instanceof ComputeError) throw error;
      const message = error instanceof Error ? error.message : String(error);
      throw new ComputeError("provider_transient", `cloudflare_backup_failed: ${message}`);
    }
    await this.guard(() => sandbox.destroy());
    const expiresAt = this.now() + ttlSeconds * 1_000;
    return this.recoveryReference(backup, profile, expiresAt);
  }

  /** Clamp `recoveryTtlMs` to the 1–168h policy bound and convert to SECONDS. */
  private recoveryTtlSeconds(recoveryTtlMs: number | undefined): number {
    const requested = recoveryTtlMs ?? DEFAULT_RECOVERY_TTL_MS;
    const clamped = Math.min(Math.max(requested, MIN_RECOVERY_TTL_MS), MAX_RECOVERY_TTL_MS);
    return Math.round(clamped / 1_000);
  }

  async destroy(reference: BackendReference): Promise<void> {
    const parsed = this.parseReference(reference);
    if (parsed.payload.kind !== "runtime") {
      throw new ComputeError("runtime_missing", "cloudflare_runtime_reference_invalid");
    }
    const sandbox = this.sandbox(parsed.payload.profile, parsed.payload.sandboxId);
    await this.guard(() => sandbox.destroy());
  }

  async runCommand(runtime: BackendReference, input: RunCommandInput): Promise<RunCommandResult> {
    const { sandboxId, profile } = this.runtimePayload(runtime);
    const sandbox = this.sandbox(profile, sandboxId);
    const result = await this.guard(() =>
      sandbox.exec(input.command, {
        ...(input.cwd !== undefined ? { cwd: input.cwd } : {}),
        ...(input.env !== undefined ? { env: input.env } : {}),
        timeoutMs: input.timeoutMs,
      }),
    );
    return {
      status: result.exitCode === 0 ? "exited" : "failed",
      exitCode: result.exitCode,
      stdout: result.stdout,
      stderr: result.stderr,
    };
  }

  async startProcess(
    runtime: BackendReference,
    input: StartProcessInput,
  ): Promise<StartProcessResult> {
    const { sandboxId, profile } = this.runtimePayload(runtime);
    const sandbox = this.sandbox(profile, sandboxId);
    const command = withStdin(input.command, input.stdin);
    const process = await this.guard(() =>
      sandbox.startProcess(command, {
        ...(input.cwd !== undefined ? { cwd: input.cwd } : {}),
        ...(input.env !== undefined ? { env: input.env } : {}),
        timeoutMs: input.timeoutMs,
        // Keep the process record after exit. The SDK default (autoCleanup:true)
        // deletes it on exit, so a command that finishes before we poll reports
        // as gone -> getProcessStatus throws process_missing and the turn hangs.
        // The per-thread container is destroyed on release, bounding record
        // accumulation to one thread's lifetime.
        autoCleanup: false,
      }),
    );
    const status = mapStatus(process.status);
    return {
      process: this.processReference(sandboxId, process.id),
      status,
      ...(process.exitCode === undefined ? {} : { exitCode: process.exitCode }),
    };
  }

  async getProcessStatus(
    runtime: BackendReference,
    process: BackendProcessReference,
  ): Promise<ProcessStatus> {
    const { sandbox, processId } = this.processContext(runtime, process);
    const info = await this.guard(() => sandbox.getProcess(processId));
    if (!info) throw new ComputeError("process_missing", "cloudflare_process_not_found");
    return toProcessStatus(info.status, info.exitCode);
  }

  async readProcessOutput(
    runtime: BackendReference,
    process: BackendProcessReference,
  ): Promise<ProcessOutput> {
    const { sandbox, processId } = this.processContext(runtime, process);
    const logs = await this.guard(() => sandbox.getProcessLogs(processId));
    return { stdout: logs.stdout, stderr: logs.stderr };
  }

  async streamProcessOutput(
    runtime: BackendReference,
    process: BackendProcessReference,
    sink: ProcessOutputSink,
  ): Promise<void> {
    const { sandbox, processId } = this.processContext(runtime, process);
    await this.guard(() =>
      sandbox.streamProcessLogs(
        processId,
        (chunk) => void sink.stdout(chunk),
        (chunk) => void sink.stderr(chunk),
      ),
    );
  }

  async waitForProcessExit(
    runtime: BackendReference,
    process: BackendProcessReference,
    sink: ProcessOutputSink,
  ): Promise<ProcessStatus> {
    // The log stream closes when this process settles. This avoids a long-lived
    // getProcess polling loop, while retaining a process id that turn-cancel
    // can kill.
    await this.streamProcessOutput(runtime, process, sink);
    return this.getProcessStatus(runtime, process);
  }

  async stopProcess(
    runtime: BackendReference,
    process: BackendProcessReference,
    mode: StopMode,
  ): Promise<ProcessStatus> {
    const { sandbox, processId } = this.processContext(runtime, process);
    await this.guard(() => sandbox.killProcess(processId, signalFor(mode)));
    const info = await this.guard(() => sandbox.getProcess(processId));
    if (!info) return { status: "stopped" };
    return toProcessStatus(info.status, info.exitCode);
  }

  async inspectPath(runtime: BackendReference, path: string): Promise<PathInfo | null> {
    const sandbox = this.sandboxFor(runtime);
    const parent = parentPath(path);
    const name = baseName(path);
    // There is no `stat` in the SDK — derive metadata from the parent listing.
    let entries;
    try {
      // `includeHidden` is load-bearing: without it the container server omits
      // dot-prefixed entries, so `.git`, `.gitignore` and `.env` all report as
      // missing -- and `assertPathContained` walks every component through here.
      entries = (await sandbox.listFiles(parent, { includeHidden: true })).files;
    } catch (error) {
      if (isRuntimeGone(error)) {
        throw new ComputeError("runtime_missing", "cloudflare_runtime_not_found");
      }
      if (isPathNotFound(error)) return null; // missing parent → path can't exist
      throw toComputeError(error);
    }
    // `success` is NOT consulted here, and that is a KNOWN HAZARD left standing,
    // not a safe equivalence. The SDK can fail IN BAND (`{ success: false,
    // files: [] }`, no throw) on a perfectly healthy container, and this returns
    // `null` for it — indistinguishable from "the path does not exist".
    // `null` still conflates the two downstream, but the guards that could turn
    // that into DATA LOSS no longer read it: `ComputeFileService`'s two
    // "destination must be absent" checks consult `pathExists`, which answers or
    // throws. `listDirectory` throws on `success: false` for the same class of
    // reason.
    //
    // Of the two remaining consumers, ONLY ONE fails closed. Do not read this
    // comment as certifying both:
    //   - `ComputeFileService`'s type checks DO fail closed: a `null` leaf on an
    //     `update`/`delete` source raises `compute_patch_missing_file` (raised
    //     there, not here), so an in-band failure refuses the patch.
    //   - `assertPathContained`'s prefix walk is itself FAIL-OPEN. A `null` on an
    //     intermediate prefix is read as "nothing deeper exists" and RETURNS
    //     SUCCESSFULLY, skipping the `type === "symlink"` rejection and the
    //     containment assertion for every deeper component. Concretely: if
    //     `/workspace/link` is a symlink to `/etc` and the listing of
    //     `/workspace` fails in band, `assertPathContained("/workspace/link/x")`
    //     returns normally and the write lands outside the workspace.
    // That is tolerated only because the symlink rejection is documented as NOT
    // a security boundary (see `assertPathContained`: the sandbox is the
    // boundary; `exec` already grants a shell inside it) — not because the walk
    // is safe under an in-band failure. It is not.
    //
    // It stays because the behavior predates this branch (the old code ignored
    // `success` too) and `inspectPath` is on the hot containment path —
    // `assertPathContained` walks EVERY path component through here — so turning
    // an in-band failure into a throw is a behavior change across every file
    // tool's call sites, not a one-boolean fix. Fixing it means auditing those
    // call sites, which is its own task; do not read this comment as a blessing.
    const entry = entries.find((candidate) => candidate.name === name);
    if (!entry) return null;
    if (entry.type === "other") {
      // A socket/device/fifo — never mislabel it as a plain file.
      throw new ComputeError("compute_invalid_path", "cloudflare_unsupported_file_type");
    }
    // The SDK's `listFiles` exposes no link target, so `resolvedPath` echoes the
    // input; the `type === "symlink"` rejection is the real containment guard.
    return { type: entry.type, size: entry.size, resolvedPath: path };
  }

  async pathExists(runtime: BackendReference, path: string): Promise<boolean> {
    const sandbox = this.sandboxFor(runtime);
    // A real stat, NOT `inspectPath`'s parent-listing derivation: this answer
    // decides whether a write would destroy existing content, so it must come
    // from a probe that can distinguish "absent" from "could not tell".
    return this.existsProbe(sandbox, path);
  }

  /**
   * One validated `exists` probe, shared by every caller that turns the answer
   * into a write decision. The SDK's typings are compile-time; the container's
   * JSON is what actually arrives, so each field this answer rests on is checked
   * at runtime. Checked here, in this order:
   *   - `success !== true` (via `ensureSuccess`) — an in-band `{ success: false }`,
   *     and also a response that omits `success`, since `undefined !== true`.
   *   - `path` is not a string — an omitted or non-string echo.
   *   - `path` is a string echoing a DIFFERENT path than the one asked about.
   *   - `exists` is not a boolean — an omitted `exists` arrives as `undefined`,
   *     which is falsy, so returning it unchecked hands every caller "proven
   *     absent" for a file that may be real. That is the write decision itself,
   *     so it is validated exactly as strictly as the echo beside it.
   * That enumeration is what this function checks. It is deliberately NOT a
   * claim that no other malformed response can get through: a resolved value
   * that is not an object at all still dereferences inside `ensureSuccess` and
   * surfaces as a raw `TypeError`, outside the ComputeError taxonomy.
   *
   * The echo check mirrors `listDirectory`'s `cloudflare_list_files_path_mismatch`
   * and exists for the same reason: a route/proxy mixup can answer for a
   * DIFFERENT path without ever failing `success`, and here that lands as
   * `exists: false` — "proven absent", which callers read as permission to
   * overwrite. A mismatch is a failure to answer, not an answer. Only a trailing
   * slash is normalized away; both sides are always absolute.
   */
  private async existsProbe(sandbox: CloudflareSandbox, path: string): Promise<boolean> {
    const result = await this.guard(() => sandbox.exists(path));
    this.ensureSuccess(result, "provider_transient", "cloudflare_exists_unsuccessful");
    // `path` is typed `string`, but the typings are compile-time and the
    // container's JSON is what decides. An omitted `path` would reach
    // `stripTrailingSlash` as `undefined` and throw a raw `TypeError` — outside
    // the ComputeError taxonomy, so callers that map provider failures would not
    // recognise it. Fail closed INSIDE the taxonomy instead: no echo is a
    // failure to answer, exactly like a mismatched echo.
    if (typeof result.path !== "string") {
      throw new ComputeError("provider_transient", "cloudflare_exists_path_missing");
    }
    if (stripTrailingSlash(result.path) !== stripTrailingSlash(path)) {
      throw new ComputeError("provider_transient", "cloudflare_exists_path_mismatch");
    }
    // The field that actually decides the write. Same reasoning as the `path`
    // guard above, applied where it costs data: `exists` is typed `boolean`, but
    // a `{ success: true, path: "<matching>" }` that simply omits it yields
    // `undefined`, and `undefined` is falsy — so `pathExists`,
    // `writeFile(overwrite:false)` and `movePath` would all read a failure to
    // answer as "proven absent" and overwrite a real file. Fail closed.
    if (typeof result.exists !== "boolean") {
      throw new ComputeError("provider_transient", "cloudflare_exists_missing");
    }
    return result.exists;
  }

  async listDirectory(runtime: BackendReference, path: string): Promise<DirEntry[]> {
    const sandbox = this.sandboxFor(runtime);
    let result;
    try {
      // `includeHidden` is load-bearing here too: the container server omits
      // dot-prefixed entries without it, and the reset nonce is `.nadi-generation`.
      result = await sandbox.listFiles(path, { includeHidden: true });
    } catch (error) {
      if (isRuntimeGone(error)) {
        throw new ComputeError("runtime_missing", "cloudflare_runtime_not_found");
      }
      // Deliberately NOT `isPathNotFound`, unlike `inspectPath`: this contract
      // answers or throws, so a missing directory is just a throw. That regex
      // matches raw SDK prose and cannot tell a wiped directory from a route
      // 404 — mapping either to a value here is what let a healthy container's
      // failed listing be read as a reset.
      throw toComputeError(error);
    }
    // The SDK can report failure IN BAND: `{ success: false, files: [] }` with
    // no throw. Answering `[]` there would hand `readGeneration` an empty
    // listing of a healthy container's `/tmp` — a false `sandbox_reset` on
    // every tick. Only a listing that says it succeeded is an answer.
    if (result.success !== true) {
      throw new ComputeError("provider_transient", "cloudflare_list_files_unsuccessful");
    }
    // `success: true` alone doesn't prove the listing is OF `path`: a
    // route/proxy mixup could answer for a different directory (e.g. `/`)
    // without ever failing `success`. `path` is the SDK's own echo of what it
    // actually listed, so a mismatch here is not a healthy answer — treat it
    // as unreadable rather than trust entries that may belong to `/`. Only a
    // trailing slash is normalized away first: both sides are always absolute
    // (callers never pass a relative path), so that's the only benign
    // spelling difference a comparison here could otherwise misfire on.
    if (stripTrailingSlash(result.path) !== stripTrailingSlash(path)) {
      throw new ComputeError("provider_transient", "cloudflare_list_files_path_mismatch");
    }
    return result.files.map((entry) => ({ name: entry.name, type: entry.type }));
  }

  async readFile(
    runtime: BackendReference,
    path: string,
    maxBytes: number,
  ): Promise<ReadFileResult> {
    const sandbox = this.sandboxFor(runtime);
    const result = await this.guard(() => sandbox.readFile(path));
    if (result.bytes.byteLength > maxBytes) {
      // Oversize is permanent, not transient; and NEVER truncate — callers hash
      // the returned bytes for optimistic concurrency.
      throw new ComputeError("compute_file_too_large");
    }
    return { bytes: result.bytes, ...(result.mimeType ? { mimeType: result.mimeType } : {}) };
  }

  async writeFile(
    runtime: BackendReference,
    path: string,
    bytes: ArrayBuffer,
    options: WriteFileOptions,
  ): Promise<void> {
    const sandbox = this.sandboxFor(runtime);
    if (!options.overwrite) {
      if (await this.existsProbe(sandbox, path)) {
        throw new ComputeError("provider_transient", "cloudflare_file_already_exists");
      }
    }
    if (options.createParents) {
      const made = await this.guard(() => sandbox.mkdir(parentPath(path), true));
      this.ensureSuccess(made, "provider_transient", "cloudflare_mkdir_failed");
    }
    const written = await this.guard(() => sandbox.writeFile(path, bytes));
    this.ensureSuccess(written, "provider_transient", "cloudflare_write_failed");
  }

  async createDirectory(runtime: BackendReference, path: string): Promise<void> {
    const sandbox = this.sandboxFor(runtime);
    const made = await this.guard(() => sandbox.mkdir(path, true));
    this.ensureSuccess(made, "provider_transient", "cloudflare_mkdir_failed");
  }

  async deletePath(runtime: BackendReference, path: string): Promise<void> {
    const sandbox = this.sandboxFor(runtime);
    const deleted = await this.guard(() => sandbox.deleteFile(path));
    this.ensureSuccess(deleted, "provider_transient", "cloudflare_delete_failed");
  }

  async movePath(
    runtime: BackendReference,
    from: string,
    to: string,
    overwrite: boolean,
  ): Promise<void> {
    const sandbox = this.sandboxFor(runtime);
    // Resolve the destination's presence FIRST so a `deleteFile` failure can't be
    // confused with a not-found: a `{ success: false }` delete is indistinguishable
    // from "already absent" in the response, so we only delete when we KNOW the
    // destination exists and treat a false result there as a hard error. Deleting
    // blindly and moving anyway is exactly the unverified-overwrite hole the delete
    // is meant to close.
    const destExists = await this.existsProbe(sandbox, to);
    if (destExists) {
      if (!overwrite) {
        throw new ComputeError("provider_transient", "cloudflare_move_destination_exists");
      }
      // UNVERIFIED: `moveFile`/`renameFile` are thin POSTs to `/api/move` and
      // `/api/rename` on a compiled server baked into the container image. Whether
      // that server replaces an existing destination is unknowable statically and
      // untestable here (no Docker). We delete the destination first so the
      // `overwrite: true` contract holds regardless of the server's behavior. This
      // is the exact bug that shipped once on Daytona: a native move that silently
      // refused an existing destination corrupted every in-place apply_patch update
      // while all fakes passed. Real `/api/move` semantics remain unverified until
      // the Task 7 live smoke run.
      const deleted = await this.guard(() => sandbox.deleteFile(to));
      this.ensureSuccess(deleted, "provider_transient", "cloudflare_move_overwrite_delete_failed");
    }
    const moved = await this.guard(() => sandbox.moveFile(from, to));
    this.ensureSuccess(moved, "provider_transient", "cloudflare_move_failed");
  }

  /**
   * The per-(workspace, thread) sandbox id. An absent or empty identity would
   * collapse to a colliding id, so fail closed rather than mint a shared
   * container.
   */
  private resolveSandboxId(): string {
    if (!this.workspaceId || !this.threadId) {
      throw new ComputeError("compute_unavailable", "cloudflare_missing_thread_identity");
    }
    return deriveSandboxId(this.workspaceId, this.threadId);
  }

  private sandbox(profile: "small" | "medium", sandboxId: string): CloudflareSandbox {
    return this.factory.get(this.bindingFor(profile), sandboxId, {
      ...SANDBOX_OPTIONS,
      labels: { workspaceId: this.workspaceId, threadId: this.threadId },
    });
  }

  private sandboxFor(runtime: BackendReference): CloudflareSandbox {
    const { sandboxId, profile } = this.runtimePayload(runtime);
    return this.sandbox(profile, sandboxId);
  }

  private bindingFor(profile: "small" | "medium"): unknown {
    const binding = profile === "small" ? this.bindings.small : this.bindings.medium;
    if (!binding) {
      throw new ComputeError("compute_unavailable", `cloudflare_binding_missing_${profile}`);
    }
    return binding;
  }

  private processContext(
    runtime: BackendReference,
    process: BackendProcessReference,
  ): { sandbox: CloudflareSandbox; processId: string } {
    const { sandboxId, profile } = this.runtimePayload(runtime);
    const payload = this.processPayload(process);
    if (payload.sandboxId !== sandboxId) {
      throw new ComputeError("process_missing", "cloudflare_process_runtime_mismatch");
    }
    return { sandbox: this.sandbox(profile, sandboxId), processId: payload.processId };
  }

  private parseReference(reference: BackendReference): z.infer<typeof referenceSchema> {
    const parsed = referenceSchema.safeParse(reference);
    if (!parsed.success) {
      throw new ComputeError("runtime_missing", "cloudflare_runtime_reference_invalid");
    }
    return parsed.data;
  }

  private runtimePayload(reference: BackendReference): {
    sandboxId: string;
    profile: "small" | "medium";
  } {
    const parsed = this.parseReference(reference);
    if (parsed.payload.kind !== "runtime") {
      throw new ComputeError("runtime_missing", "cloudflare_runtime_reference_invalid");
    }
    return { sandboxId: parsed.payload.sandboxId, profile: parsed.payload.profile };
  }

  private processPayload(reference: BackendProcessReference): {
    sandboxId: string;
    processId: string;
  } {
    const parsed = this.parseReference(reference);
    if (parsed.payload.kind !== "process") {
      throw new ComputeError("process_missing", "cloudflare_process_reference_invalid");
    }
    return { sandboxId: parsed.payload.sandboxId, processId: parsed.payload.processId };
  }

  private runtimeReference(sandboxId: string, profile: "small" | "medium"): BackendReference {
    return { provider: this.id, version: 1, payload: { kind: "runtime", sandboxId, profile } };
  }

  private recoveryReference(
    backup: ClientDirectoryBackup,
    profile: "small" | "medium",
    expiresAt: number,
  ): BackendReference {
    // Plain JSON only — persisted and JSON round-tripped. Store the handle fields
    // the restore path needs, INCLUDING `localBucket`: the SDK picks its restore
    // path from it, so a local-dev backup restored with it dropped takes the
    // production presigned/FUSE path and fails permanently. Do not carry an SDK object.
    return {
      provider: this.id,
      version: 1,
      payload: {
        kind: "backup",
        backup: {
          id: backup.id,
          dir: WORKSPACE_DIR,
          ...(backup.localBucket !== undefined ? { localBucket: backup.localBucket } : {}),
        },
        profile,
        expiresAt,
      },
    };
  }

  private processReference(sandboxId: string, processId: string): BackendProcessReference {
    return { provider: this.id, version: 1, payload: { kind: "process", sandboxId, processId } };
  }

  /**
   * Reject a non-throwing `{ success: false }` from an SDK file op. The container
   * server can report failure in-band without raising, so an unchecked result
   * silently proceeds over an unmodified filesystem.
   */
  private ensureSuccess(
    result: { success: boolean },
    code: ComputeErrorCode,
    reason: string,
  ): void {
    if (result.success !== true) throw new ComputeError(code, reason);
  }

  /** Run an SDK call, translating any escaping error to the compute taxonomy. */
  private async guard<T>(fn: () => Promise<T>): Promise<T> {
    try {
      return await fn();
    } catch (error) {
      throw toComputeError(error);
    }
  }
}

/**
 * Stable Durable Object id from the (workspace, thread) identity. This id names
 * the DO-backed container instance, so it must be unique per (workspace, thread)
 * — see `acquire`.
 *
 * BOUNDED LENGTH BY CONSTRUCTION (45 chars max; shorter ids yield shorter
 * fragments, so it is bounded rather than fixed), because the SDK rejects over
 * 63 (`sanitizeSandboxId`, a DNS-label limit) and the previous format blew past
 * it. It concatenated both ids verbatim — `ws_<workspaceId>_<threadId>` — but
 * `workspaceId` is already `ws_<uuid>` (39) and `threadId` is `thr_<uuid>` (40),
 * so real ids came to 83 and EVERY Cloudflare sandbox call threw. It survived
 * only because the sole workspace short enough to fit is the seeded `default`.
 *
 * Two UUIDs cannot fit: 64 hex chars plus a separator is 65 > 63. So the id
 * cannot carry both ids in full, and uniqueness rests on `pairDigest` over the
 * whole pair. The leading fragments are DEBUGGING AFFORDANCE ONLY — they make a
 * container identifiable in a dashboard the SDK cannot enumerate — and carry no
 * uniqueness burden, so truncating them is safe.
 */
export function deriveSandboxId(workspaceId: string, threadId: string): string {
  const workspaceFragment = sanitizeIdPart(workspaceId).slice(0, 8);
  const threadFragment = sanitizeIdPart(threadId).slice(0, 8);
  return `ws_${workspaceFragment}_${threadFragment}_${pairDigest(workspaceId, threadId)}`;
}

function sanitizeIdPart(value: string): string {
  return value.replace(/[^A-Za-z0-9_-]/g, "_");
}

/**
 * 96-bit digest of the (workspace, thread) pair as 24 hex chars.
 *
 * FNV-1a rather than SHA-256 because `deriveSandboxId` is synchronous and
 * `crypto.subtle` is not; making it async would ripple through every call site
 * that resolves a container identity. That trade is sound here only because
 * both inputs are server-minted UUIDs — no caller chooses them — so this needs
 * good distribution, not collision resistance against an adversary. A collision
 * would mean two threads sharing one filesystem and processes, so the whole
 * pair is hashed (never a truncation of it) and the parts are separated by NUL
 * so ("ab","c") and ("a","bc") cannot collapse to the same digest.
 */
function pairDigest(workspaceId: string, threadId: string): string {
  const input = `${workspaceId}\0${threadId}`;
  // Three independent FNV-1a-64 passes with distinct offset bases; 32 bits of
  // each are kept, for 96 bits total.
  const bases = [0xcbf29ce484222325n, 0x9e3779b97f4a7c15n, 0xff51afd7ed558ccdn];
  return bases
    .map((offset) => {
      let hash = offset;
      for (let index = 0; index < input.length; index += 1) {
        hash ^= BigInt(input.charCodeAt(index));
        hash = BigInt.asUintN(64, hash * 0x100000001b3n);
      }
      // Fold the high half into the low half so every input bit reaches the
      // 32 bits actually emitted.
      const folded = BigInt.asUintN(32, hash ^ (hash >> 32n));
      return folded.toString(16).padStart(8, "0");
    })
    .join("");
}

/**
 * The SDK's background-process API exposes no stdin channel, so stdin is fed via
 * a base64 pipe with fixed command text (model data never lands unquoted in the
 * command). Best-effort and UNVERIFIED live: it assumes `base64` is on PATH (it
 * is in the Ubuntu base image) and that the pipeline's exit code is the wrapped
 * command's, which is standard shell behavior.
 */
function withStdin(command: string, stdin: string | undefined): string {
  if (stdin === undefined) return command;
  return `printf %s '${base64FromString(stdin)}' | base64 -d | ${command}`;
}

function base64FromString(value: string): string {
  const bytes = new TextEncoder().encode(value);
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary);
}

function mapStatus(status: ClientProcessStatus): ProcessStatus["status"] {
  switch (status) {
    case "starting":
    case "running":
      return "running";
    case "completed":
      return "exited";
    case "killed":
      return "stopped";
    case "failed":
    case "error":
      return "failed";
  }
}

function toProcessStatus(status: ClientProcessStatus, exitCode: number | undefined): ProcessStatus {
  return {
    status: mapStatus(status),
    ...(exitCode === undefined ? {} : { exitCode }),
  };
}

function signalFor(mode: StopMode): string {
  switch (mode) {
    case "interrupt":
      return "SIGINT";
    case "terminate":
      return "SIGTERM";
    case "kill":
      return "SIGKILL";
  }
}

function parentPath(path: string): string {
  const lastSlash = path.lastIndexOf("/");
  return lastSlash <= 0 ? "/" : path.slice(0, lastSlash);
}

function baseName(path: string): string {
  return path.slice(path.lastIndexOf("/") + 1);
}

/** Strips a single trailing slash, leaving root (`/`) alone. */
export function stripTrailingSlash(path: string): string {
  return path.length > 1 && path.endsWith("/") ? path.slice(0, -1) : path;
}

/** A destroyed/absent sandbox (→ runtime_missing) vs a broken request. */
function isRuntimeGone(error: unknown): boolean {
  return errorName(error) === "SandboxNotFound";
}

/** An absent path (→ null / already-gone) vs a broken request. */
function isPathNotFound(error: unknown): boolean {
  if (errorName(error) === "PathNotFound") return true;
  const message = error instanceof Error ? error.message : String(error);
  return /not found|no such file|does not exist/i.test(message);
}

function errorName(error: unknown): string | undefined {
  return typeof error === "object" && error !== null && "name" in error
    ? String((error as { name: unknown }).name)
    : undefined;
}

/** Map any thrown value to a ComputeError; never let a raw SDK error escape. */
function toComputeError(error: unknown): ComputeError {
  if (error instanceof ComputeError) return error;
  if (isRuntimeGone(error)) {
    return new ComputeError("runtime_missing", "cloudflare_runtime_not_found");
  }
  const message = error instanceof Error ? error.message : String(error);
  return new ComputeError("provider_transient", `cloudflare_sdk_error: ${message}`);
}
