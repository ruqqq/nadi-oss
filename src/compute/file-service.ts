import type {
  BackendReference,
  ComputeBackend,
  ComputeProviderId,
  ComputeResourceProfile,
  PathInfo,
} from "./backend";
import { ComputeError, ComputePartialWriteError, ComputeStaleFileError } from "./errors";
import { assertPathContained } from "./files/path";
import { applyPatchToFiles, parsePatch } from "./files/patch";
import { sha256Hex } from "./files/hash";
import { decodeTextFile } from "./files/text";
import { recordComputeEvent, type ComputeEvent } from "./observability";

export interface ComputeFileServiceDeps {
  backend: ComputeBackend;
  /** Bounds `readFile` output only — that content goes into the model's context. */
  readMaxBytes: number;
  readMaxLines: number;
  /**
   * Bounds source reads never shown to the model: `applyPatch`'s hunk-matching
   * reads and `writeFile`'s pre-write hash read of the file it is replacing.
   */
  maxDownloadBytes: number;
  /** Bounds the content `writeFile` is about to write. */
  maxUploadBytes: number;
  provider: ComputeProviderId;
  profile: ComputeResourceProfile;
  /** Acquire/restore compute and return the active runtime reference. */
  resolveRuntime: () => Promise<BackendReference>;
  /** Refresh the environment lease (touch last-used + re-arm release). */
  refreshLease: () => Promise<void>;
  /** Clears the "workspace verified clean" bit. Optional — see thread-service.ts. */
  markDirty?: () => Promise<void>;
  now: () => number;
  recordEvent?: (event: ComputeEvent) => void;
}

export interface ReadFileInput {
  path: string;
  startLine?: number;
  maxLines?: number;
}

export interface ReadFileResult {
  path: string;
  startLine: number;
  endLine: number;
  truncated: boolean;
  content: string;
  hash: string;
}

export interface WriteFileInput {
  path: string;
  content: string;
  expectedHash?: string;
  createParents?: boolean;
}

export interface WriteFileResult {
  path: string;
  hash: string;
  bytesWritten: number;
}

export interface ApplyPatchInput {
  patch: string;
  expectedHashes: Record<string, string>;
}

export interface ApplyPatchResult {
  operations: number;
  written: number;
  deleted: number;
}

/**
 * A workspace path resolved once per operation: contained + its leaf state.
 *
 * `leaf` MUST NOT be used to decide that a path is ABSENT. It comes from
 * `inspectPath`, which is fail-open: a provider failure arrives as `null`,
 * indistinguishable from "does not exist" (see the hazard comment on
 * `CloudflareComputeBackend.inspectPath`). A `null` read as permission to write
 * is exactly how apply_patch silently clobbered a real file. Absence decisions
 * go through `backend.pathExists`, which answers or throws. `leaf` is legitimate
 * only for POSITIVE facts — "present, and of type X" — and the cache is kept
 * because `commit()` needs `normalized`.
 */
interface ResolvedPath {
  normalized: string;
  leaf: PathInfo | null;
}

/**
 * Model-native, optimistic file operations over the provider-neutral compute
 * backend. Reads are line-numbered and bounded; writes and patches validate
 * every path, hash, and hunk before the first mutation.
 *
 * Validation is atomic. The `apply_patch` commit is NOT a filesystem
 * transaction — it writes temporary siblings, moves them into place, then
 * deletes, and can fail partway (see `ComputePartialWriteError`).
 */
export class ComputeFileService {
  constructor(private readonly deps: ComputeFileServiceDeps) {}

  async readFile(input: ReadFileInput): Promise<ReadFileResult> {
    const runtime = await this.deps.resolveRuntime();
    const normalized = await assertPathContained(this.deps.backend, runtime, input.path);
    const { bytes } = await this.deps.backend.readFile(runtime, normalized, this.deps.readMaxBytes);
    const content = decodeTextFile(bytes);
    const hash = await sha256Hex(bytes);
    await this.deps.refreshLease();

    const lines = splitLines(content);
    const startLine = Math.max(1, input.startLine ?? 1);
    const maxLines = Math.min(
      Math.max(0, input.maxLines ?? this.deps.readMaxLines),
      this.deps.readMaxLines,
    );
    const from = startLine - 1;
    const to = Math.min(from + maxLines, lines.length);
    const selected = from < lines.length ? lines.slice(from, to) : [];
    const numbered = selected.map((text, index) => `${startLine + index}: ${text}`).join("\n");

    return {
      path: input.path,
      startLine,
      endLine: startLine + selected.length - 1,
      truncated: to < lines.length,
      content: numbered,
      hash,
    };
  }

  async writeFile(input: WriteFileInput): Promise<WriteFileResult> {
    await this.deps.markDirty?.();
    const start = this.deps.now();
    const bytes = encodeUtf8(input.content);
    // Reject an oversize upload before compute is even acquired: no runtime
    // resolution, no lease refresh, no mutation attempt. Still emit the failure —
    // provider and profile are known without a runtime, and a rejected upload is
    // exactly the kind of thing worth seeing in telemetry.
    if (bytes.byteLength > this.deps.maxUploadBytes) {
      this.emitMutation("failure", start, bytes.byteLength, 1);
      throw new ComputeError("compute_file_too_large");
    }
    try {
      const runtime = await this.deps.resolveRuntime();
      const normalized = await assertPathContained(this.deps.backend, runtime, input.path);
      const current = await this.readCurrent(runtime, normalized);
      // Optimistic concurrency: an existing file requires a matching hash; a
      // fresh path must not carry an expected hash (its target is gone/absent).
      if (current) {
        if (input.expectedHash === undefined || input.expectedHash !== current.hash) {
          // Carry the live hash so the caller can retry without a re-read.
          throw new ComputeStaleFileError(input.path, current.hash);
        }
      } else if (input.expectedHash !== undefined) {
        // No live file to report a hash for: the caller's target doesn't exist.
        throw new ComputeError("compute_stale_file");
      }

      await this.deps.backend.writeFile(runtime, normalized, bytes, {
        createParents: input.createParents ?? false,
        overwrite: current !== null,
      });
      await this.deps.refreshLease();

      const hash = await sha256Hex(bytes);
      this.emitMutation("success", start, bytes.byteLength, 1);
      return { path: input.path, hash, bytesWritten: bytes.byteLength };
    } catch (error) {
      this.emitMutation("failure", start, bytes.byteLength, 1);
      throw error;
    }
  }

  async applyPatch(input: ApplyPatchInput): Promise<ApplyPatchResult> {
    await this.deps.markDirty?.();
    const start = this.deps.now();
    // Known once parsing succeeds; 0 only if parsing itself is what failed.
    let operationCount = 0;
    try {
      const runtime = await this.deps.resolveRuntime();
      const operations = parsePatch(input.patch);
      operationCount = operations.length;

      // Resolve every unique path exactly once: contained-walk + one leaf
      // inspect. Reused for source reads and destination-absence checks.
      const resolved = new Map<string, ResolvedPath>();
      const resolve = async (rel: string): Promise<ResolvedPath> => {
        const cached = resolved.get(rel);
        if (cached) return cached;
        const normalized = await assertPathContained(this.deps.backend, runtime, rel);
        const leaf = await this.deps.backend.inspectPath(runtime, normalized);
        const entry: ResolvedPath = { normalized, leaf };
        resolved.set(rel, entry);
        return entry;
      };

      // Prevalidate: read + hash-check every source; require destinations absent.
      const files = new Map<string, string>();
      for (const op of operations) {
        if (op.kind === "add") {
          const entry = await resolve(op.path);
          // NOT `entry.leaf`: a fail-open `inspectPath` reports a provider
          // failure as `null`, and this guard would read that as permission to
          // write — commit() moves with `overwrite: true`, so the existing file
          // would be gone with no error. `pathExists` answers or throws.
          if (await this.deps.backend.pathExists(runtime, entry.normalized)) {
            throw new ComputeError("compute_patch_file_exists");
          }
          continue;
        }
        // update or delete: source must exist as a text file with a live hash.
        const entry = await resolve(op.path);
        if (!entry.leaf || entry.leaf.type !== "file") {
          throw new ComputeError("compute_patch_missing_file");
        }
        // Source content is only matched against patch hunks, never shown to
        // the model — bound it by the (larger) download limit, not readMaxBytes.
        const current = await this.readTextFile(
          runtime,
          entry.normalized,
          this.deps.maxDownloadBytes,
        );
        const expected = input.expectedHashes[op.path];
        if (expected === undefined || expected !== current.hash) {
          // Name the offending path and its live hash: a multi-file patch can
          // have many expectedHashes entries, only one of which is wrong.
          throw new ComputeStaleFileError(op.path, current.hash);
        }
        files.set(op.path, current.content);

        if (op.kind === "update" && op.moveTo !== undefined) {
          const destination = await resolve(op.moveTo);
          // Same fail-open hazard as the `add` guard above.
          if (await this.deps.backend.pathExists(runtime, destination.normalized)) {
            throw new ComputeError("compute_patch_file_exists");
          }
        }
      }

      // Pure hunk algebra over the in-memory snapshot. Throws before any write.
      const { writes, deletes } = applyPatchToFiles(operations, files);

      await this.commit(runtime, resolved, writes, deletes);
      await this.deps.refreshLease();

      const byteCount = [...writes.values()].reduce(
        (total, content) => total + encodeUtf8(content).byteLength,
        0,
      );
      this.emitMutation("success", start, byteCount, operationCount);
      return { operations: operationCount, written: writes.size, deleted: deletes.size };
    } catch (error) {
      this.emitMutation("failure", start, 0, operationCount);
      throw error;
    }
  }

  /**
   * Commit stage. Writes each new content to a temporary sibling, moves the
   * siblings into place, then applies deletes last. Not transactional: on an
   * infrastructure failure we best-effort remove leftover temp files and raise
   * `ComputePartialWriteError` naming every path whose state may have changed.
   *
   * If the very first temp write fails, nothing has touched the workspace yet,
   * so the underlying error is propagated unchanged instead of being wrapped —
   * `ComputePartialWriteError` is reserved for once a mutation has actually
   * been attempted (a temp write succeeded, or a move/delete was attempted).
   */
  private async commit(
    runtime: BackendReference,
    resolved: Map<string, ResolvedPath>,
    writes: Map<string, string>,
    deletes: Set<string>,
  ): Promise<void> {
    const staged: Array<{ temp: string; destination: string; rel: string }> = [];
    const affected = new Set<string>();
    for (const rel of writes.keys()) affected.add(rel);
    for (const rel of deletes) affected.add(rel);

    let mutationAttempted = false;
    try {
      for (const [rel, content] of writes) {
        const destination = this.require(resolved, rel).normalized;
        const temp = `${destination}.nadi-tmp-${crypto.randomUUID()}`;
        await this.deps.backend.writeFile(runtime, temp, encodeUtf8(content), {
          createParents: true,
          overwrite: false,
        });
        mutationAttempted = true;
        staged.push({ temp, destination, rel });
      }
      for (const { temp, destination } of staged) {
        mutationAttempted = true;
        await this.deps.backend.movePath(runtime, temp, destination, true);
      }
      for (const rel of deletes) {
        mutationAttempted = true;
        await this.deps.backend.deletePath(runtime, this.require(resolved, rel).normalized);
      }
    } catch (error) {
      for (const { temp } of staged) {
        try {
          await this.deps.backend.deletePath(runtime, temp);
        } catch {
          // Best effort: the commit already failed; a stray temp is the lesser harm.
        }
      }
      if (!mutationAttempted) throw error;
      const cause = error instanceof Error ? error.message : String(error);
      throw new ComputePartialWriteError([...affected].sort(), `compute_partial_write: ${cause}`);
    }
  }

  private async readCurrent(
    runtime: BackendReference,
    normalized: string,
  ): Promise<{ content: string; hash: string } | null> {
    const info = await this.deps.backend.inspectPath(runtime, normalized);
    if (!info || info.type !== "file") return null;
    // This read is of the file writeFile is about to replace, never shown to
    // the model — it needs applyPatch's reach (maxDownloadBytes), not readMaxBytes.
    return this.readTextFile(runtime, normalized, this.deps.maxDownloadBytes);
  }

  private async readTextFile(
    runtime: BackendReference,
    normalized: string,
    maxBytes: number,
  ): Promise<{ content: string; hash: string }> {
    const { bytes } = await this.deps.backend.readFile(runtime, normalized, maxBytes);
    return { content: decodeTextFile(bytes), hash: await sha256Hex(bytes) };
  }

  private require(resolved: Map<string, ResolvedPath>, rel: string): ResolvedPath {
    const entry = resolved.get(rel);
    if (!entry) throw new ComputeError("compute_invalid_path");
    return entry;
  }

  private emitMutation(
    outcome: ComputeEvent["outcome"],
    startedAt: number,
    byteCount: number,
    operationCount: number,
  ): void {
    // Deliberately carries only provider-neutral counters — never paths,
    // contents, hashes, or patch text.
    const event: ComputeEvent = {
      event: "file_mutation",
      provider: this.deps.provider,
      profile: this.deps.profile,
      durationMs: Math.max(0, this.deps.now() - startedAt),
      byteCount,
      operationCount,
      outcome,
    };
    if (this.deps.recordEvent) this.deps.recordEvent(event);
    else recordComputeEvent(event);
  }
}

function encodeUtf8(content: string): ArrayBuffer {
  const bytes = new TextEncoder().encode(content);
  return bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer;
}

/** Splits into logical lines, dropping the trailing empty element a final newline adds. */
function splitLines(content: string): string[] {
  if (content === "") return [];
  const lines = content.split("\n");
  if (lines.length > 0 && lines[lines.length - 1] === "") lines.pop();
  return lines;
}
