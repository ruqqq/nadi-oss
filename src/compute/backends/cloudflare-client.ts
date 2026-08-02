import { getSandbox, parseSSEStream, type LogEvent, type Sandbox } from "@cloudflare/sandbox";

/**
 * A narrow seam over `@cloudflare/sandbox`. `CloudflareComputeBackend` depends
 * ONLY on this interface, never on the SDK directly, so that:
 *   - persisted `BackendReference`s never capture an SDK `Sandbox`/`Process`
 *     object (references hold plain ids only),
 *   - the backend is unit-testable with an in-memory fake, and
 *   - SDK exceptions are translated to the compute error taxonomy in one place.
 *
 * The method set is deliberately minimal — exactly what the backend uses.
 */

/** SDK process lifecycle, surfaced verbatim so the backend owns the mapping. */
export type ClientProcessStatus =
  | "starting"
  | "running"
  | "completed"
  | "failed"
  | "killed"
  | "error";

export interface ClientProcess {
  id: string;
  status: ClientProcessStatus;
  exitCode?: number;
}

/** One `listFiles` entry, reduced to what `inspectPath` needs. */
export interface ClientFileEntry {
  name: string;
  type: "file" | "directory" | "symlink" | "other";
  size: number;
}

export interface ClientReadResult {
  bytes: ArrayBuffer;
  mimeType?: string;
}

/** A command run to completion by the container, in one blocking call. */
export interface ClientExecResult {
  exitCode: number;
  stdout: string;
  stderr: string;
}

export interface ClientExecOptions {
  cwd?: string;
  env?: Record<string, string>;
  timeoutMs?: number;
}

export interface ClientStartProcessOptions {
  cwd?: string;
  env?: Record<string, string>;
  timeoutMs?: number;
  /**
   * When false, the container KEEPS the process record after exit so status and
   * logs stay readable. The SDK default is true (auto-delete on exit), which
   * makes a completed process poll as gone -> the backend passes false.
   */
  autoCleanup?: boolean;
}

/** A stored directory backup handle — plain, serializable metadata only. */
export interface ClientDirectoryBackup {
  id: string;
  dir: string;
  localBucket?: boolean;
}

/**
 * The SDK's file-mutation methods return `{ success, ... }` result objects; a
 * container server can report `success: false` WITHOUT throwing. These seam
 * shapes mirror the SDK so the backend can inspect the flag rather than assume
 * success — silently discarding it is how a failed restore/delete corrupts a
 * workspace. Fields are reduced to what the backend reads.
 */
export interface ClientWriteResult {
  success: boolean;
  path: string;
}
export interface ClientMkdirResult {
  success: boolean;
  path: string;
}
export interface ClientDeleteResult {
  success: boolean;
  path: string;
}
export interface ClientMoveResult {
  success: boolean;
  path: string;
  newPath: string;
}
/** Result of `restoreBackup` — `success: false` means the restore did NOT apply. */
export interface ClientRestoreResult {
  success: boolean;
  dir: string;
  id: string;
}

/**
 * Result of `listFiles`. The SDK's real return (`{ success, path, files, ... }`)
 * is surfaced verbatim, as with `restoreBackup`: a container that reports
 * `success: false` without throwing has NOT listed the directory, and `files`
 * is then an empty array that means nothing. Callers for whom an empty listing
 * is costly (`listDirectory` -> `readGeneration`, where a missed match reads as
 * a wipe) MUST check `success`. `path` is surfaced for the same reason: it is
 * the one field that proves the listing is OF the directory that was asked
 * for, so those same callers MUST also check it against the requested path.
 */
export interface ClientListFilesResult {
  success: boolean;
  path: string;
  files: ClientFileEntry[];
}

/**
 * Result of `exists`. The SDK's `FileExistsResult` carries a `success` flag and
 * this surfaces it verbatim, as with `listFiles` and `restoreBackup`: a
 * container that reports `success: false` has NOT determined anything, and
 * `exists: false` is then meaningless. Callers for whom a false "absent" is
 * costly (anything deciding whether a write would destroy content) MUST check
 * `success`.
 */
export interface ClientExistsResult {
  success: boolean;
  path: string;
  exists: boolean;
}

export interface ClientCreateBackupOptions {
  /** Directory to back up. Must be under /workspace, /home, /tmp, /var/tmp, or /app. */
  dir: string;
  /** Human-readable label for the backup. */
  name?: string;
  /** Seconds until automatic garbage collection (SDK default 259200). */
  ttl?: number;
  /**
   * Resolve `BACKUP_BUCKET` as an R2 binding directly (required in local dev
   * where presigned URLs and FUSE are unavailable). Production uses presigned
   * URLs; Task 4 decides the value.
   */
  localBucket?: boolean;
}

export interface CloudflareSandbox {
  setEnvVars(env: Record<string, string>): Promise<void>;
  destroy(): Promise<void>;
  /**
   * Run `command` to completion in ONE blocking call and return its result.
   *
   * Not a convenience over startProcess + poll: a long-lived poll loop over
   * getProcess (as run_skill_script had) reliably wedges — some call blocks
   * ~10 minutes and then throws — and no poll interval avoids it. Here the
   * container reports completion itself, so there is no status to ask for.
   * See ComputeBackend.runCommand for what is and isn't established.
   */
  exec(command: string, options: ClientExecOptions): Promise<ClientExecResult>;
  startProcess(command: string, options: ClientStartProcessOptions): Promise<ClientProcess>;
  getProcess(id: string): Promise<ClientProcess | null>;
  killProcess(id: string, signal: string): Promise<void>;
  getProcessLogs(id: string): Promise<{ stdout: string; stderr: string }>;
  streamProcessLogs(
    id: string,
    onStdout: (chunk: string) => void,
    onStderr: (chunk: string) => void,
  ): Promise<void>;
  writeFile(path: string, bytes: ArrayBuffer): Promise<ClientWriteResult>;
  readFile(path: string): Promise<ClientReadResult>;
  mkdir(path: string, recursive: boolean): Promise<ClientMkdirResult>;
  deleteFile(path: string): Promise<ClientDeleteResult>;
  moveFile(from: string, to: string): Promise<ClientMoveResult>;
  /**
   * List `path`'s entries. `includeHidden` is NOT optional in spirit: the real
   * container server omits dot-prefixed entries without it, and `inspectPath`
   * derives every path's metadata from this listing.
   *
   * Answers with the SDK's `success` and `path` fields intact — see
   * `ClientListFilesResult`.
   */
  listFiles(path: string, options?: { includeHidden?: boolean }): Promise<ClientListFilesResult>;
  /** Answers with the SDK's `success` field intact — see `ClientExistsResult`. */
  exists(path: string): Promise<ClientExistsResult>;
  /** Persist `dir` to R2 and return a serializable handle. */
  createBackup(options: ClientCreateBackupOptions): Promise<ClientDirectoryBackup>;
  /**
   * Restore a previously created backup into this sandbox. The SDK's real return
   * (`{ success, dir, id }`) is surfaced verbatim: a container that reports
   * `success: false` without throwing must NOT be treated as a restore.
   */
  restoreBackup(backup: ClientDirectoryBackup): Promise<ClientRestoreResult>;
  /** Re-assert the keep-alive lease (used after a restore). */
  setKeepAlive(enabled: boolean): Promise<void>;
}

export interface CloudflareSandboxOptions {
  enableDefaultSession: boolean;
  keepAlive: boolean;
  /**
   * Attached to the underlying container for analytics/observability only.
   * NOT queryable: the instances listing returns no label field and there is no
   * filter-by-label API, and labels only apply on the next container start.
   * The cap does not and cannot rely on these.
   */
  labels?: Record<string, string>;
}

export interface CloudflareSandboxFactory {
  /**
   * Resolve the Durable-Object-backed sandbox for `id` on `binding`. `binding`
   * is opaque here (a `DurableObjectNamespace`) so tests can pass a sentinel;
   * the real factory casts it back for `getSandbox`.
   */
  get(binding: unknown, id: string, options: CloudflareSandboxOptions): CloudflareSandbox;
}

/** Production factory: wraps `getSandbox` and adapts the SDK surface. */
export function createCloudflareSandboxFactory(): CloudflareSandboxFactory {
  return {
    get(binding, id, options) {
      const sandbox = getSandbox(binding as DurableObjectNamespace<Sandbox>, id, options);
      return new SdkCloudflareSandbox(sandbox);
    },
  };
}

class SdkCloudflareSandbox implements CloudflareSandbox {
  constructor(private readonly sandbox: Sandbox) {}

  async setEnvVars(env: Record<string, string>): Promise<void> {
    await this.sandbox.setEnvVars(env);
  }

  async destroy(): Promise<void> {
    await this.sandbox.destroy();
  }

  async exec(command: string, options: ClientExecOptions): Promise<ClientExecResult> {
    const result = await this.sandbox.exec(command, {
      ...(options.cwd !== undefined ? { cwd: options.cwd } : {}),
      ...(options.env !== undefined ? { env: options.env } : {}),
      ...(options.timeoutMs !== undefined ? { timeout: options.timeoutMs } : {}),
    });
    return {
      exitCode: result.exitCode,
      stdout: result.stdout ?? "",
      stderr: result.stderr ?? "",
    };
  }

  async startProcess(command: string, options: ClientStartProcessOptions): Promise<ClientProcess> {
    const process = await this.sandbox.startProcess(command, {
      ...(options.cwd !== undefined ? { cwd: options.cwd } : {}),
      ...(options.env !== undefined ? { env: options.env } : {}),
      ...(options.timeoutMs !== undefined ? { timeout: options.timeoutMs } : {}),
      ...(options.autoCleanup !== undefined ? { autoCleanup: options.autoCleanup } : {}),
    });
    return toClientProcess(process.id, process.status, process.exitCode);
  }

  async getProcess(id: string): Promise<ClientProcess | null> {
    const process = await this.sandbox.getProcess(id);
    if (!process) return null;
    return toClientProcess(process.id, process.status, process.exitCode);
  }

  async killProcess(id: string, signal: string): Promise<void> {
    await this.sandbox.killProcess(id, signal);
  }

  async getProcessLogs(id: string): Promise<{ stdout: string; stderr: string }> {
    const logs = await this.sandbox.getProcessLogs(id);
    return { stdout: logs.stdout, stderr: logs.stderr };
  }

  async streamProcessLogs(
    id: string,
    onStdout: (chunk: string) => void,
    onStderr: (chunk: string) => void,
  ): Promise<void> {
    const stream = await this.sandbox.streamProcessLogs(id);
    for await (const event of parseSSEStream<LogEvent>(stream)) {
      if (event.type === "stdout") onStdout(event.data);
      else if (event.type === "stderr") onStderr(event.data);
    }
  }

  async writeFile(path: string, bytes: ArrayBuffer): Promise<ClientWriteResult> {
    // base64 keeps binary content intact across the container's text protocol.
    const result = await this.sandbox.writeFile(path, bytesToBase64(bytes), { encoding: "base64" });
    return { success: result.success, path: result.path };
  }

  async readFile(path: string): Promise<ClientReadResult> {
    const result = await this.sandbox.readFile(path, { encoding: "base64" });
    const bytes = base64ToBytes(result.content);
    return { bytes, ...(result.mimeType ? { mimeType: result.mimeType } : {}) };
  }

  async mkdir(path: string, recursive: boolean): Promise<ClientMkdirResult> {
    const result = await this.sandbox.mkdir(path, { recursive });
    return { success: result.success, path: result.path };
  }

  async deleteFile(path: string): Promise<ClientDeleteResult> {
    const result = await this.sandbox.deleteFile(path);
    return { success: result.success, path: result.path };
  }

  async moveFile(from: string, to: string): Promise<ClientMoveResult> {
    const result = await this.sandbox.moveFile(from, to);
    return { success: result.success, path: result.path, newPath: result.newPath };
  }

  async listFiles(
    path: string,
    options?: { includeHidden?: boolean },
  ): Promise<ClientListFilesResult> {
    const result = await this.sandbox.listFiles(path, options);
    return {
      success: result.success,
      path: result.path,
      files: result.files.map((file) => ({ name: file.name, type: file.type, size: file.size })),
    };
  }

  async exists(path: string): Promise<ClientExistsResult> {
    const result = await this.sandbox.exists(path);
    return { success: result.success, path: result.path, exists: result.exists };
  }

  async createBackup(options: ClientCreateBackupOptions): Promise<ClientDirectoryBackup> {
    const backup = await this.sandbox.createBackup({
      dir: options.dir,
      ...(options.name !== undefined ? { name: options.name } : {}),
      ...(options.ttl !== undefined ? { ttl: options.ttl } : {}),
      ...(options.localBucket !== undefined ? { localBucket: options.localBucket } : {}),
    });
    return {
      id: backup.id,
      dir: backup.dir,
      ...(backup.localBucket !== undefined ? { localBucket: backup.localBucket } : {}),
    };
  }

  async restoreBackup(backup: ClientDirectoryBackup): Promise<ClientRestoreResult> {
    // A rejection (BackupRestoreError etc.) propagates to the backend, which
    // maps it to recovery_failed and preserves the caller's recovery reference.
    // A non-throwing `{ success: false }` is surfaced verbatim so the backend can
    // reject it too — restoring over an empty container would strand the workspace.
    const result = await this.sandbox.restoreBackup(backup);
    return { success: result.success, dir: result.dir, id: result.id };
  }

  async setKeepAlive(enabled: boolean): Promise<void> {
    await this.sandbox.setKeepAlive(enabled);
  }
}

function toClientProcess(
  id: string,
  status: ClientProcessStatus,
  exitCode: number | undefined,
): ClientProcess {
  return { id, status, ...(exitCode === undefined ? {} : { exitCode }) };
}

function bytesToBase64(bytes: ArrayBuffer): string {
  const view = new Uint8Array(bytes);
  let binary = "";
  for (const byte of view) binary += String.fromCharCode(byte);
  return btoa(binary);
}

function base64ToBytes(value: string): ArrayBuffer {
  const binary = atob(value);
  const view = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index += 1) view[index] = binary.charCodeAt(index);
  return view.buffer;
}
