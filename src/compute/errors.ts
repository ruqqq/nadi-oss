export const COMPUTE_ERROR_CODES = [
  "compute_unavailable",
  "runtime_missing",
  "process_missing",
  "quota_exhausted",
  "policy_rejected",
  "recovery_failed",
  "provider_transient",
  "compute_invalid_path",
  "compute_path_escape",
  "compute_binary_file",
  "compute_file_too_large",
  "compute_patch_malformed",
  "compute_patch_duplicate_path",
  "compute_patch_hunk_mismatch",
  "compute_patch_hunk_overlap",
  "compute_patch_missing_file",
  "compute_patch_file_exists",
  "compute_stale_file",
  "compute_partial_write",
] as const;

export type ComputeErrorCode = (typeof COMPUTE_ERROR_CODES)[number];

export class ComputeError extends Error {
  readonly code: ComputeErrorCode;

  constructor(code: ComputeErrorCode, message: string = code) {
    super(message);
    this.name = "ComputeError";
    this.code = code;
  }
}

/**
 * A cross-file `apply_patch` commit that failed partway through. Validation is
 * atomic, but the commit (temp writes → moves → deletes) is not — so on an
 * infrastructure failure mid-commit the workspace may be inconsistent.
 * `affectedPaths` lists (sorted) the workspace-relative paths whose on-disk
 * state may have changed.
 */
export class ComputePartialWriteError extends ComputeError {
  readonly affectedPaths: string[];

  constructor(affectedPaths: string[], message = "compute_partial_write") {
    super("compute_partial_write", message);
    this.name = "ComputePartialWriteError";
    this.affectedPaths = affectedPaths;
  }
}

/**
 * A stale optimistic-concurrency check on `writeFile` or `applyPatch`: the
 * caller's `expectedHash` (or an `expectedHashes` entry) no longer matches the
 * live on-disk content. `path` and `currentHash` let the model retarget its
 * retry instead of guessing which of potentially many hashes was wrong.
 */
export class ComputeStaleFileError extends ComputeError {
  readonly path: string;
  readonly currentHash: string;

  constructor(path: string, currentHash: string, message = "compute_stale_file") {
    super("compute_stale_file", message);
    this.name = "ComputeStaleFileError";
    this.path = path;
    this.currentHash = currentHash;
  }
}

export function isComputeErrorCode(value: unknown): value is ComputeErrorCode {
  return typeof value === "string" && COMPUTE_ERROR_CODES.includes(value as ComputeErrorCode);
}
