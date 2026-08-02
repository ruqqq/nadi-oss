import { posix } from "node:path";
import type { BackendReference, ComputeBackend } from "../backend";
import { ComputeError } from "../errors";

const WORKSPACE_ROOT = "/workspace";

/**
 * Normalizes a workspace-relative path into an absolute `/workspace/...` path.
 * Rejects absolute input, empty input, NUL bytes, and traversal that would
 * escape the workspace root.
 */
export function normalizeWorkspacePath(path: string): string {
  if (typeof path !== "string" || path.length === 0) {
    throw new ComputeError("compute_invalid_path");
  }
  if (path.includes("\0")) {
    throw new ComputeError("compute_invalid_path");
  }
  if (posix.isAbsolute(path)) {
    throw new ComputeError("compute_invalid_path");
  }

  const joined = posix.normalize(posix.join(WORKSPACE_ROOT, path));
  // `posix.normalize` keeps a trailing slash, so "src/" and "src" would diverge.
  const normalized = joined.length > 1 ? joined.replace(/\/+$/, "") : joined;
  if (normalized !== WORKSPACE_ROOT && !normalized.startsWith(`${WORKSPACE_ROOT}/`)) {
    throw new ComputeError("compute_invalid_path");
  }

  return normalized;
}

/**
 * Validates that a normalized workspace path stays inside `/workspace` by
 * walking every component from the root down to the target.
 *
 * A symlink at any inspected component is rejected outright: providers are not
 * required to resolve links (see `PathInfo.resolvedPath`), so we cannot trust an
 * unresolved target and fail closed — even when the target happens to be inside
 * the workspace. The `resolvedPath` containment check still runs on every
 * component as defense in depth for backends that can resolve.
 *
 * NOT A SECURITY BOUNDARY. Verified live (2026-07-10): Daytona's `getFileDetails`
 * follows symlinks, so `inspectPath` reports a link as its target's type and the
 * symlink branch never fires there — `read_file` on a link to /etc succeeds. The
 * guard is real only on a provider that reports link types. What IS enforced
 * everywhere is `normalizeWorkspacePath`'s syntactic rejection of absolute,
 * empty, NUL, and `..` paths. The sandbox is the boundary; `exec` already grants
 * a shell inside it, so this guard buys tidiness, not containment.
 */
export async function assertPathContained(
  backend: ComputeBackend,
  runtime: BackendReference,
  path: string,
): Promise<string> {
  const normalized = normalizeWorkspacePath(path);

  for (const prefix of workspacePrefixes(normalized)) {
    const info = await backend.inspectPath(runtime, prefix);
    if (!info) {
      // Nothing deeper can exist; remaining components are new (create case).
      // But `/workspace` itself must exist — a missing root is a fail-closed.
      if (prefix === WORKSPACE_ROOT) {
        throw new ComputeError("compute_unavailable", "workspace_root_missing");
      }
      return normalized;
    }
    if (info.type === "symlink") {
      throw new ComputeError("compute_path_escape");
    }
    assertResolvedPathContained(info.resolvedPath);
  }

  return normalized;
}

/** Every path prefix from `/workspace` down to `normalized`, inclusive. */
function workspacePrefixes(normalized: string): string[] {
  const prefixes = [WORKSPACE_ROOT];
  if (normalized === WORKSPACE_ROOT) return prefixes;
  let current = WORKSPACE_ROOT;
  for (const segment of normalized.slice(WORKSPACE_ROOT.length + 1).split("/")) {
    current = `${current}/${segment}`;
    prefixes.push(current);
  }
  return prefixes;
}

function assertResolvedPathContained(resolvedPath: string): void {
  if (resolvedPath !== WORKSPACE_ROOT && !resolvedPath.startsWith(`${WORKSPACE_ROOT}/`)) {
    throw new ComputeError("compute_path_escape");
  }
}
