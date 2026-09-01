import { posix } from "node:path";
import type { BackendReference, ComputeBackend } from "../backend";
import { ComputeError } from "../errors";

/**
 * The root a relative path resolves against.
 *
 * REQUIRED at every call site, and not for taste. Since P3 the sandbox is shared
 * by every thread of an agent and each thread works in its own
 * `/workspace/threads/<threadId>` worktree, so `src/app.ts` names a DIFFERENT
 * file per thread. A default here would have compiled everywhere and silently
 * resolved every thread's file tools into the agent's shared clone — the same
 * directory `git worktree` owns — which corrupts the checkout backing every
 * OTHER thread. There is no safe default, so there is no default.
 */
export type WorkspacePathRoot = string;

/**
 * Normalizes a root-relative path into an absolute path under `root`.
 * Rejects absolute input, empty input, NUL bytes, and traversal that would
 * escape the root.
 */
export function normalizeWorkspacePath(path: string, root: WorkspacePathRoot): string {
  if (typeof path !== "string" || path.length === 0) {
    throw new ComputeError("compute_invalid_path");
  }
  if (path.includes("\0")) {
    throw new ComputeError("compute_invalid_path");
  }
  if (posix.isAbsolute(path)) {
    throw new ComputeError("compute_invalid_path");
  }

  const joined = posix.normalize(posix.join(root, path));
  // `posix.normalize` keeps a trailing slash, so "src/" and "src" would diverge.
  const normalized = joined.length > 1 ? joined.replace(/\/+$/, "") : joined;
  if (normalized !== root && !normalized.startsWith(`${root}/`)) {
    throw new ComputeError("compute_invalid_path");
  }

  return normalized;
}

/**
 * Validates that a normalized workspace path stays inside `root` by
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
  root: WorkspacePathRoot,
): Promise<string> {
  const normalized = normalizeWorkspacePath(path, root);

  for (const prefix of workspacePrefixes(normalized, root)) {
    const info = await backend.inspectPath(runtime, prefix);
    if (!info) {
      // Nothing deeper can exist; remaining components are new (create case).
      // But the root itself must exist — a missing root is a fail-closed.
      if (prefix === root) {
        throw new ComputeError("compute_unavailable", "workspace_root_missing");
      }
      return normalized;
    }
    if (info.type === "symlink") {
      throw new ComputeError("compute_path_escape");
    }
    assertResolvedPathContained(info.resolvedPath, root);
  }

  return normalized;
}

/** Every path prefix from `root` down to `normalized`, inclusive. */
function workspacePrefixes(normalized: string, root: WorkspacePathRoot): string[] {
  const prefixes = [root];
  if (normalized === root) return prefixes;
  let current = root;
  for (const segment of normalized.slice(root.length + 1).split("/")) {
    current = `${current}/${segment}`;
    prefixes.push(current);
  }
  return prefixes;
}

function assertResolvedPathContained(resolvedPath: string, root: WorkspacePathRoot): void {
  if (resolvedPath !== root && !resolvedPath.startsWith(`${root}/`)) {
    throw new ComputeError("compute_path_escape");
  }
}
