import { CloudflareComputeBackend } from "../../../../src/compute/backends/cloudflare";
import type {
  ClientCreateBackupOptions,
  ClientDeleteResult,
  ClientDirectoryBackup,
  ClientExistsResult,
  ClientFileEntry,
  ClientListFilesResult,
  ClientMkdirResult,
  ClientMoveResult,
  ClientExecOptions,
  ClientExecResult,
  ClientProcess,
  ClientReadResult,
  ClientRestoreResult,
  ClientStartProcessOptions,
  ClientWriteResult,
  CloudflareSandbox,
  CloudflareSandboxFactory,
  CloudflareSandboxOptions,
} from "../../../../src/compute/backends/cloudflare-client";

/**
 * A stateful in-memory stand-in for `@cloudflare/sandbox`. It models exactly
 * the seam the backend depends on. Two behaviors it CANNOT faithfully model
 * (and which therefore stay unverified until a live container run) are called
 * out where they occur:
 *   - a destroyed sandbox reports as gone (real `getSandbox` would recreate it),
 *   - `moveFile` overwrite semantics (the real container binary is unknown).
 */

/** Thrown when an op targets a destroyed sandbox → backend maps to runtime_missing. */
class SandboxNotFoundError extends Error {
  constructor(message = "sandbox not found") {
    super(message);
    this.name = "SandboxNotFound";
  }
}

/** Thrown when a path is absent → backend maps to null / provider_transient. */
class PathNotFoundError extends Error {
  constructor(message = "no such file or directory") {
    super(message);
    this.name = "PathNotFound";
  }
}

interface FakeProcess {
  id: string;
  status: ClientProcess["status"];
  exitCode?: number;
  stdout: string;
  stderr: string;
  autoCleanup: boolean;
}

/**
 * A snapshot of a directory subtree, held in the factory's shared store to
 * model R2 — backups must survive `destroy()` and be readable by a DIFFERENT
 * sandbox instance created for the same id on reacquisition.
 */
interface BackupSnapshot {
  files: Map<string, Uint8Array>;
  mimes: Map<string, string>;
  dirs: Set<string>;
}

export class FakeCloudflareSandbox implements CloudflareSandbox {
  destroyed = false;
  keepAlive = true;
  /** How many times `setKeepAlive` was invoked (default value is already true). */
  setKeepAliveCalls = 0;
  lastEnv: Record<string, string> | undefined;
  readonly calls: string[] = [];
  /** Backup/restore/destroy lifecycle events, in order (backup-ordering seam). */
  readonly events: string[] = [];
  /** One-shot failure injections (model R2 unavailable / restore error). */
  failNextBackup: Error | undefined;
  failNextRestore: Error | undefined;
  /** One-shot in-band failure: `restoreBackup` RESOLVES `{ success: false }`. */
  nextRestoreUnsuccessful = false;
  /** One-shot in-band failure: `deleteFile` RESOLVES `{ success: false }`. */
  nextDeleteUnsuccessful = false;
  /** The `ttl` (SECONDS) handed to the most recent `createBackup`. */
  lastBackupTtl: number | undefined;
  /** The backup handle passed to the most recent `restoreBackup` (localBucket seam). */
  lastRestoreBackup: ClientDirectoryBackup | undefined;

  private readonly files = new Map<string, Uint8Array>();
  private readonly mimes = new Map<string, string>();
  private readonly dirs = new Set<string>(["/", "/workspace"]);
  private readonly processes = new Map<string, FakeProcess>();
  private readonly specials = new Map<string, ClientFileEntry["type"]>();
  /** Paths whose listing reports in-band failure (`success: false`, no throw). */
  private readonly listFailsInBand = new Set<string>();
  /** Paths whose `exists` reports in-band failure (`success: false`, no throw). */
  private readonly existsFailsInBand = new Set<string>();
  /** Paths whose listing echoes a DIFFERENT `path` than requested (route/proxy mixup). */
  private readonly listPathMismatch = new Map<string, string>();
  /** Paths whose `exists` echoes a DIFFERENT `path` than requested (route/proxy mixup). */
  private readonly existsPathMismatch = new Map<string, string>();
  private readonly existsOmitsPath = new Set<string>();
  private readonly existsOmitsExists = new Set<string>();
  private readonly existsWrongType = new Map<string, unknown>();
  private processSeq = 0;

  /** `backups` is the factory-shared, R2-like store (survives destroy). */
  constructor(private readonly backups: Map<string, BackupSnapshot> = new Map()) {}

  async setEnvVars(env: Record<string, string>): Promise<void> {
    this.alive();
    this.lastEnv = { ...env };
  }

  async destroy(): Promise<void> {
    this.events.push("destroy");
    this.destroyed = true;
  }

  async createBackup(options: ClientCreateBackupOptions): Promise<ClientDirectoryBackup> {
    this.alive();
    this.events.push(`createBackup:${options.dir}`);
    // Record the provider-facing `ttl` so a seconds-vs-milliseconds regression is
    // observable: both `expiresAt` and this derive from the same source, so only
    // asserting `expiresAt` would let a millisecond `ttl` pass green.
    this.lastBackupTtl = options.ttl;
    if (this.failNextBackup) {
      const error = this.failNextBackup;
      this.failNextBackup = undefined;
      throw error;
    }
    const id = `backup-${crypto.randomUUID()}`;
    const prefix = `${options.dir}/`;
    const under = (path: string): boolean => path === options.dir || path.startsWith(prefix);
    const snapshot: BackupSnapshot = {
      files: new Map([...this.files].filter(([p]) => under(p)).map(([p, b]) => [p, b.slice(0)])),
      mimes: new Map([...this.mimes].filter(([p]) => under(p))),
      dirs: new Set([...this.dirs].filter((p) => under(p))),
    };
    this.backups.set(id, snapshot);
    return {
      id,
      dir: options.dir,
      ...(options.localBucket !== undefined ? { localBucket: options.localBucket } : {}),
    };
  }

  async restoreBackup(backup: ClientDirectoryBackup): Promise<ClientRestoreResult> {
    this.alive();
    this.events.push(`restoreBackup:${backup.id}`);
    this.lastRestoreBackup = backup;
    if (this.failNextRestore) {
      const error = this.failNextRestore;
      this.failNextRestore = undefined;
      throw error;
    }
    // In-band failure: the container reports the restore did NOT apply, WITHOUT
    // throwing and WITHOUT touching the filesystem. The backend must reject this.
    if (this.nextRestoreUnsuccessful) {
      this.nextRestoreUnsuccessful = false;
      return { success: false, dir: backup.dir, id: backup.id };
    }
    const snapshot = this.backups.get(backup.id);
    if (!snapshot) throw new PathNotFoundError("backup not found");
    for (const [path, bytes] of snapshot.files) this.files.set(path, bytes.slice(0));
    for (const [path, mime] of snapshot.mimes) this.mimes.set(path, mime);
    for (const dir of snapshot.dirs) this.dirs.add(dir);
    return { success: true, dir: backup.dir, id: backup.id };
  }

  async setKeepAlive(enabled: boolean): Promise<void> {
    this.alive();
    this.setKeepAliveCalls += 1;
    this.keepAlive = enabled;
  }

  /**
   * Runs to completion and returns the result — no process record is kept, which
   * is the point: `exec` never exposes a status to poll, so a caller cannot build
   * the long-lived getProcess poll loop that wedges on the real SDK.
   */
  async exec(command: string, options: ClientExecOptions): Promise<ClientExecResult> {
    this.alive();
    this.calls.push(`exec:${command}`);
    void options;
    const isEcho = command.startsWith("echo ");
    const failing = /(^|\s)(false|exit\s+[1-9])(\s|$)/.test(command);
    return {
      exitCode: failing ? 1 : 0,
      stdout: isEcho ? `${command.slice("echo ".length)}\n` : "",
      stderr: failing ? "boom\n" : "",
    };
  }

  async startProcess(command: string, options: ClientStartProcessOptions): Promise<ClientProcess> {
    this.alive();
    this.calls.push(`start:${command}`);
    this.processSeq += 1;
    const id = `proc-${this.processSeq}`;
    const isSleep = /^\s*sleep\b/.test(command);
    const isEcho = command.startsWith("echo ");
    const process: FakeProcess = {
      id,
      status: isSleep ? "running" : "completed",
      ...(isSleep ? {} : { exitCode: 0 }),
      stdout: isEcho ? `${command.slice("echo ".length)}\n` : "",
      stderr: "",
      // Models the SDK's ProcessOptions.autoCleanup (default true): once a
      // process reaches a terminal status its record is DELETED, so getProcess
      // and getProcessLogs return null afterwards. Verified live 2026-07-10: a
      // command that finished inside the foreground window threw process_missing
      // on the next poll and hung the turn. The backend must pass
      // autoCleanup:false to keep the record readable.
      autoCleanup: options.autoCleanup ?? true,
    };
    this.processes.set(id, process);
    return {
      id,
      status: process.status,
      ...(process.exitCode === undefined ? {} : { exitCode: process.exitCode }),
    };
  }

  /** Real SDK auto-deletes a terminal process record unless autoCleanup:false. */
  private reapIfAutoCleaned(id: string): FakeProcess | undefined {
    const process = this.processes.get(id);
    if (!process) return undefined;
    if (process.autoCleanup && process.status !== "running") {
      this.processes.delete(id);
      return undefined;
    }
    return process;
  }

  async getProcess(id: string): Promise<ClientProcess | null> {
    this.alive();
    const process = this.reapIfAutoCleaned(id);
    if (!process) return null;
    return {
      id,
      status: process.status,
      ...(process.exitCode === undefined ? {} : { exitCode: process.exitCode }),
    };
  }

  async killProcess(id: string): Promise<void> {
    this.alive();
    const process = this.processes.get(id);
    if (!process) throw new PathNotFoundError("process not found");
    process.status = "killed";
    process.exitCode = 137;
  }

  async getProcessLogs(id: string): Promise<{ stdout: string; stderr: string }> {
    this.alive();
    const process = this.reapIfAutoCleaned(id);
    if (!process) throw new PathNotFoundError("process not found");
    return { stdout: process.stdout, stderr: process.stderr };
  }

  async streamProcessLogs(
    id: string,
    onStdout: (chunk: string) => void,
    onStderr: (chunk: string) => void,
  ): Promise<void> {
    this.alive();
    const process = this.processes.get(id);
    if (!process) throw new PathNotFoundError("process not found");
    if (process.stdout) onStdout(process.stdout);
    if (process.stderr) onStderr(process.stderr);
  }

  async writeFile(path: string, bytes: ArrayBuffer): Promise<ClientWriteResult> {
    this.alive();
    this.calls.push(`write:${path}`);
    this.files.set(path, new Uint8Array(bytes.slice(0)));
    return { success: true, path };
  }

  async readFile(path: string): Promise<ClientReadResult> {
    this.alive();
    const file = this.files.get(path);
    if (!file) throw new PathNotFoundError();
    const bytes = file.buffer.slice(
      file.byteOffset,
      file.byteOffset + file.byteLength,
    ) as ArrayBuffer;
    const mimeType = this.mimes.get(path);
    return { bytes, ...(mimeType ? { mimeType } : {}) };
  }

  async mkdir(path: string, recursive: boolean): Promise<ClientMkdirResult> {
    this.alive();
    this.calls.push(`mkdir:${path}`);
    if (recursive) {
      let current = "";
      for (const segment of path.split("/").filter(Boolean)) {
        current += `/${segment}`;
        this.dirs.add(current);
      }
    } else {
      this.dirs.add(path);
    }
    return { success: true, path };
  }

  async deleteFile(path: string): Promise<ClientDeleteResult> {
    this.alive();
    // Recorded before the existence check because the backend may delete a path
    // it believes present, so the attempt is a real observable call.
    this.calls.push(`delete:${path}`);
    // In-band failure: the container reports the delete did NOT succeed, without
    // throwing. Leave the filesystem untouched so a caller that ignores the flag
    // is observably wrong (e.g. a move-over-existing that never removed the dest).
    if (this.nextDeleteUnsuccessful) {
      this.nextDeleteUnsuccessful = false;
      return { success: false, path };
    }
    const existed = this.files.delete(path) || this.dirs.delete(path);
    const childFiles = [...this.files.keys()].filter((key) => key.startsWith(`${path}/`));
    const childDirs = [...this.dirs].filter((dir) => dir.startsWith(`${path}/`));
    for (const key of childFiles) this.files.delete(key);
    for (const dir of childDirs) this.dirs.delete(dir);
    this.mimes.delete(path);
    // A not-found delete is reported in-band as `{ success: false }` (the real
    // container server does not throw for an absent path).
    return { success: existed, path };
  }

  async moveFile(from: string, to: string): Promise<ClientMoveResult> {
    this.alive();
    this.calls.push(`move:${from}->${to}`);
    const file = this.files.get(from);
    if (file === undefined) throw new PathNotFoundError();
    // NOTE: real container overwrite behavior is unknown; this fake always
    // overwrites. The backend never relies on that — it pre-deletes first.
    this.files.set(to, file);
    this.files.delete(from);
    const mime = this.mimes.get(from);
    if (mime !== undefined) {
      this.mimes.set(to, mime);
      this.mimes.delete(from);
    }
    return { success: true, path: from, newPath: to };
  }

  /**
   * Models the real container server: dot-prefixed entries are OMITTED unless
   * `includeHidden` is passed. Verified live on 2026-07-10 — `inspectPath` of
   * `/workspace/.nadi-cf-smoke` returned null because this filter is real. The
   * old fake listed hidden entries unconditionally, which is exactly why no unit
   * test could see the bug.
   */
  async listFiles(
    path: string,
    options?: { includeHidden?: boolean },
  ): Promise<ClientListFilesResult> {
    this.alive();
    if (this.listFailsInBand.has(path)) return { success: false, path, files: [] };
    if (!this.dirs.has(path)) throw new PathNotFoundError();
    const visible = (name: string) => options?.includeHidden === true || !name.startsWith(".");
    const entries: ClientFileEntry[] = [];
    for (const [filePath, bytes] of this.files) {
      if (parentPath(filePath) === path && visible(baseName(filePath))) {
        entries.push({ name: baseName(filePath), type: "file", size: bytes.byteLength });
      }
    }
    for (const dir of this.dirs) {
      if (dir !== path && parentPath(dir) === path && visible(baseName(dir))) {
        entries.push({ name: baseName(dir), type: "directory", size: 0 });
      }
    }
    for (const [specialPath, type] of this.specials) {
      if (parentPath(specialPath) === path && visible(baseName(specialPath))) {
        entries.push({ name: baseName(specialPath), type, size: 0 });
      }
    }
    const reportedPath = this.listPathMismatch.get(path) ?? path;
    return { success: true, path: reportedPath, files: entries };
  }

  async exists(path: string): Promise<ClientExistsResult> {
    this.alive();
    if (this.existsFailsInBand.has(path)) return { success: false, path, exists: false };
    const exists = this.files.has(path) || this.dirs.has(path);
    if (this.existsOmitsPath.has(path)) {
      // `path` is typed `string`, so the omission has to be cast in: the point
      // is precisely that the typings do not bind the container's JSON.
      return { success: true, exists } as unknown as ClientExistsResult;
    }
    if (this.existsOmitsExists.has(path)) {
      // Everything else about this response is healthy — `success: true` and a
      // MATCHING echo — so it clears every other guard. `exists` is typed
      // `boolean`, so the omission has to be cast in; that is the point.
      return { success: true, path } as unknown as ClientExistsResult;
    }
    if (this.existsWrongType.has(path)) {
      // `exists` is PRESENT but not a boolean — distinct from omission. A guard
      // narrowed to `result.exists === undefined` would let this through
      // unchecked; if the wrong-typed value is falsy (`null`, `0`) it reads as
      // "proven absent" exactly like omission does. `exists` is typed `boolean`,
      // so the wrong type has to be cast in; that is the point.
      return {
        success: true,
        path,
        exists: this.existsWrongType.get(path),
      } as unknown as ClientExistsResult;
    }
    const reportedPath = this.existsPathMismatch.get(path) ?? path;
    return { success: true, path: reportedPath, exists };
  }

  /**
   * Test seed: make `exists(path)` succeed with a matching echo but omit the
   * `exists` field entirely. It arrives as `undefined`, which is falsy, so an
   * unvalidated `return result.exists` reports a REAL file as proven absent —
   * the reviewer's clobber reproduction.
   */
  seedExistsOmitsExists(path: string): void {
    this.existsOmitsExists.add(path);
  }

  /**
   * Test seed: make `exists(path)` succeed with a matching echo but return a
   * PRESENT, wrong-typed `exists` — default `null`, which (like `undefined`) is
   * falsy. Distinct from `seedExistsOmitsExists`: a guard narrowed from
   * `typeof result.exists !== "boolean"` to `result.exists === undefined` would
   * still reject omission but let a falsy wrong-typed value through, reporting a
   * REAL file as proven absent.
   */
  seedExistsWrongType(path: string, value: unknown = null): void {
    this.existsWrongType.set(path, value);
  }

  /**
   * Test seed: make `exists(path)` succeed but omit `path` from the response
   * entirely. Without a guard this reaches `stripTrailingSlash(undefined)` and
   * throws a raw `TypeError` outside the ComputeError taxonomy.
   */
  seedExistsOmitsPath(path: string): void {
    this.existsOmitsPath.add(path);
  }

  /**
   * Test seed: make `exists(path)` succeed but echo a DIFFERENT `path` than
   * requested — models a route/proxy mixup (a redirect answers for another
   * path) that the SDK's `success` flag alone would not catch. Mirrors
   * `seedListPathMismatch`; the stakes are higher here, because a mixed-up
   * `exists: false` reads downstream as permission to overwrite.
   */
  seedExistsPathMismatch(path: string, reportedPath: string): void {
    this.existsPathMismatch.set(path, reportedPath);
  }

  /**
   * Test seed: make `exists(path)` report the SDK's in-band failure —
   * `{ success: false, exists: false }` with no throw. Mirrors
   * `seedListFailure`, and models the shape this codebase already caught
   * `restoreBackup` and `listFiles` producing.
   */
  seedExistsFailure(path: string): void {
    this.existsFailsInBand.add(path);
  }

  /** Test seed: place a file with a known mime (writeFile carries none). */
  seedFile(path: string, bytes: Uint8Array, mimeType?: string): void {
    this.files.set(path, bytes);
    if (mimeType) this.mimes.set(path, mimeType);
  }

  /**
   * Test seed: make `listFiles(path)` report the SDK's in-band failure —
   * `{ success: false, files: [] }` with no throw. Models the real shape the
   * codebase already caught `restoreBackup` doing.
   */
  seedListFailure(path: string): void {
    this.listFailsInBand.add(path);
  }

  /**
   * Test seed: make `listFiles(path)` succeed but echo a DIFFERENT `path` than
   * requested — models a route/proxy mixup (e.g. a redirect answers for `/`
   * instead of `/tmp`) that the SDK's `success` flag alone would not catch.
   */
  seedListPathMismatch(path: string, reportedPath: string): void {
    this.listPathMismatch.set(path, reportedPath);
  }

  /** Test seed: place a raw `listFiles` entry type the SDK can report. */
  seedEntry(path: string, type: ClientFileEntry["type"]): void {
    if (type === "directory") {
      this.dirs.add(path);
      return;
    }
    // Represent non-directory special types via a marker so listFiles reports it.
    this.specials.set(path, type);
  }

  private alive(): void {
    if (this.destroyed) throw new SandboxNotFoundError();
  }
}

export interface FakeCloudflareEnvironment {
  backend: CloudflareComputeBackend;
  factory: FakeCloudflareSandboxFactory;
  bindings: { small: object; medium: object };
  env: { NADI_SANDBOX_SMALL: object; NADI_SANDBOX_MEDIUM: object };
}

export interface RecordedGet {
  binding: unknown;
  id: string;
  options: CloudflareSandboxOptions;
}

export class FakeCloudflareSandboxFactory implements CloudflareSandboxFactory {
  readonly calls: RecordedGet[] = [];
  /** Shared R2-like backup store, readable across sandbox instances/ids. */
  readonly backups = new Map<string, BackupSnapshot>();
  /** The options passed to the most recent `get` call. */
  lastOptions: CloudflareSandboxOptions | undefined;
  private readonly sandboxes = new Map<string, FakeCloudflareSandbox>();
  private pendingRestoreFailure: Error | undefined;
  private pendingRestoreUnsuccessful = false;

  get(binding: unknown, id: string, options: CloudflareSandboxOptions): FakeCloudflareSandbox {
    this.calls.push({ binding, id, options });
    this.lastOptions = options;
    let sandbox = this.sandboxes.get(id);
    // Model real `getSandbox`: resolving a destroyed id does NOT report it gone —
    // it constructs a fresh, empty container behind the same id. (The unverified
    // divergence Task 7's live smoke run must confirm.)
    if (!sandbox || sandbox.destroyed) {
      sandbox = new FakeCloudflareSandbox(this.backups);
      if (this.pendingRestoreFailure) {
        sandbox.failNextRestore = this.pendingRestoreFailure;
        this.pendingRestoreFailure = undefined;
      }
      if (this.pendingRestoreUnsuccessful) {
        sandbox.nextRestoreUnsuccessful = true;
        this.pendingRestoreUnsuccessful = false;
      }
      this.sandboxes.set(id, sandbox);
    }
    return sandbox;
  }

  /**
   * Poison the NEXT sandbox created (e.g. the one a recovering acquire resolves)
   * so its first `restoreBackup` rejects once. Models an R2 restore failure.
   */
  failNextRestore(error: Error): void {
    this.pendingRestoreFailure = error;
  }

  /**
   * Poison the NEXT sandbox created so its first `restoreBackup` RESOLVES
   * `{ success: false }` (a non-throwing in-band failure — the container reports
   * it restored nothing). Models the silent-empty-container hazard.
   */
  failNextRestoreSuccess(): void {
    this.pendingRestoreUnsuccessful = true;
  }

  /** The (single) sandbox for an id, or undefined if never resolved. */
  peek(id: string): FakeCloudflareSandbox | undefined {
    return this.sandboxes.get(id);
  }
}

/**
 * Build a fresh backend wired to a fresh fake factory and sentinel bindings.
 * Identity defaults to `workspace-1` / `thread-1` (id `ws_workspace-1_thread-1`);
 * override per (workspace, thread) to exercise sandbox-id derivation.
 */
export function createFakeCloudflareBackend(
  identity: {
    workspaceId?: string;
    threadId?: string;
    useLocalBucket?: boolean;
    now?: () => number;
  } = {},
): FakeCloudflareEnvironment {
  const workspaceId = identity.workspaceId ?? "workspace-1";
  const threadId = identity.threadId ?? "thread-1";
  const env = { NADI_SANDBOX_SMALL: {}, NADI_SANDBOX_MEDIUM: {} };
  const bindings = { small: env.NADI_SANDBOX_SMALL, medium: env.NADI_SANDBOX_MEDIUM };
  const factory = new FakeCloudflareSandboxFactory();
  const backend = new CloudflareComputeBackend({
    factory,
    bindings,
    workspaceId,
    threadId,
    ...(identity.useLocalBucket !== undefined ? { useLocalBucket: identity.useLocalBucket } : {}),
    ...(identity.now !== undefined ? { now: identity.now } : {}),
  });
  return { backend, factory, bindings, env };
}

function parentPath(path: string): string {
  const lastSlash = path.lastIndexOf("/");
  return lastSlash <= 0 ? "/" : path.slice(0, lastSlash);
}

function baseName(path: string): string {
  return path.slice(path.lastIndexOf("/") + 1);
}
