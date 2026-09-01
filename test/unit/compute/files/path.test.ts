import { describe, expect, it } from "vitest";
import type { ComputeSpec } from "../../../../src/compute/backend";
import { FakeComputeBackend } from "../../../../src/compute/backends/fake";
import { assertPathContained, normalizeWorkspacePath } from "../../../../src/compute/files/path";
import { sha256Hex } from "../../../../src/compute/files/hash";
import { threadWorkRoot } from "../../../../src/compute/workspace-layout";

const TEST_SPEC: ComputeSpec = {
  environmentId: "files-test",
  profile: "small",
  workspaceRoot: "/workspace",
  env: {},
  maxProcessRuntimeMs: 1_000,
  allowedHosts: null,
};

// The root the file tools actually run with since P3: a THREAD's working
// directory inside the agent's shared box, not `/workspace`.
const THREAD_ROOT = threadWorkRoot("thr_00000000-0000-4000-8000-000000000001");

describe("normalizeWorkspacePath", () => {
  it("normalizes a relative path under the root it is given", () => {
    expect(normalizeWorkspacePath("src/app.ts", THREAD_ROOT)).toBe(`${THREAD_ROOT}/src/app.ts`);
  });

  /**
   * The whole point of the required root. `src/app.ts` names a DIFFERENT file
   * per thread now, and the box's other threads' worktrees — plus the agent's
   * canonical clones under `/workspace/repos`, which `git worktree` owns — sit
   * beside this one. A root that silently fell back to `/workspace` would still
   * "contain" every one of them.
   */
  it("resolves the same relative path to different files for different threads", () => {
    const other = threadWorkRoot("thr_00000000-0000-4000-8000-000000000002");
    expect(normalizeWorkspacePath("src/app.ts", THREAD_ROOT)).not.toBe(
      normalizeWorkspacePath("src/app.ts", other),
    );
  });

  it("normalizes the empty-relative path to the root", () => {
    expect(normalizeWorkspacePath(".", THREAD_ROOT)).toBe(THREAD_ROOT);
  });

  it("rejects traversal that escapes the root", () => {
    expect(() => normalizeWorkspacePath("../secret", THREAD_ROOT)).toThrow("compute_invalid_path");
  });

  /**
   * `/workspace/repos/<name>` is the agent's canonical clone and the object
   * `git worktree` maintains for every thread. A thread reaching it through
   * `../../repos/...` would be editing the checkout that backs every OTHER
   * thread's worktree — allowed under a `/workspace` root, rejected under this
   * one.
   */
  it("rejects traversal out of the thread root into the agent's clones", () => {
    expect(() => normalizeWorkspacePath("../../repos/nadi/src/app.ts", THREAD_ROOT)).toThrow(
      "compute_invalid_path",
    );
  });

  it("rejects absolute paths", () => {
    expect(() => normalizeWorkspacePath("/etc/passwd", THREAD_ROOT)).toThrow(
      "compute_invalid_path",
    );
  });

  it("rejects empty paths", () => {
    expect(() => normalizeWorkspacePath("", THREAD_ROOT)).toThrow("compute_invalid_path");
  });

  it("rejects paths containing NUL", () => {
    expect(() => normalizeWorkspacePath("src/app\0.ts", THREAD_ROOT)).toThrow(
      "compute_invalid_path",
    );
  });

  it("normalizes a trailing slash to the same path as without", () => {
    expect(normalizeWorkspacePath("src/", THREAD_ROOT)).toBe(`${THREAD_ROOT}/src`);
    expect(normalizeWorkspacePath("src", THREAD_ROOT)).toBe(`${THREAD_ROOT}/src`);
  });
});

describe("assertPathContained", () => {
  it("accepts a path fully inside the root", async () => {
    const backend = new FakeComputeBackend();
    const runtime = await backend.acquire(TEST_SPEC);
    await backend.createDirectory(runtime, THREAD_ROOT);
    backend.seedFile(runtime, `${THREAD_ROOT}/src/app.ts`, new Uint8Array([1]), "text/plain");

    await expect(assertPathContained(backend, runtime, "src/app.ts", THREAD_ROOT)).resolves.toBe(
      `${THREAD_ROOT}/src/app.ts`,
    );
  });

  it("accepts a new path whose nearest existing ancestor is contained", async () => {
    const backend = new FakeComputeBackend();
    const runtime = await backend.acquire(TEST_SPEC);
    await backend.createDirectory(runtime, THREAD_ROOT);

    await expect(assertPathContained(backend, runtime, "new-file.ts", THREAD_ROOT)).resolves.toBe(
      `${THREAD_ROOT}/new-file.ts`,
    );
  });

  // These two prove the guard against a backend that REPORTS symlinks. They say
  // nothing about production: Daytona's getFileDetails follows links, so
  // inspectPath never returns type "symlink" there and the guard is inert
  // (verified live, 2026-07-10). See the note on `assertPathContained`.
  it("rejects a path whose ancestor symlink resolves outside the root", async () => {
    const backend = new FakeComputeBackend();
    const runtime = await backend.acquire(TEST_SPEC);
    await backend.createDirectory(runtime, THREAD_ROOT);
    backend.seedSymlink(runtime, `${THREAD_ROOT}/link`, "/etc");

    await expect(assertPathContained(backend, runtime, "link/passwd", THREAD_ROOT)).rejects.toThrow(
      "compute_path_escape",
    );
  });

  it("rejects an existing path that is itself a symlink resolving outside the root", async () => {
    const backend = new FakeComputeBackend();
    const runtime = await backend.acquire(TEST_SPEC);
    await backend.createDirectory(runtime, THREAD_ROOT);
    backend.seedSymlink(runtime, `${THREAD_ROOT}/passwd`, "/etc/passwd");

    await expect(assertPathContained(backend, runtime, "passwd", THREAD_ROOT)).rejects.toThrow(
      "compute_path_escape",
    );
  });

  /**
   * A symlink pointing at the agent's shared clone is INSIDE `/workspace` and
   * would have been accepted by the old root. The resolved-path containment
   * check is measured against the thread's root now, so it is not.
   */
  it("rejects a symlink that resolves into the agent's shared clones", async () => {
    const backend = new FakeComputeBackend();
    const runtime = await backend.acquire(TEST_SPEC);
    await backend.createDirectory(runtime, THREAD_ROOT);
    backend.seedSymlink(runtime, `${THREAD_ROOT}/escape`, "/workspace/repos/nadi");

    await expect(
      assertPathContained(backend, runtime, "escape/app.ts", THREAD_ROOT),
    ).rejects.toThrow("compute_path_escape");
  });

  it("rejects a real file reached through an intermediate symlink component", async () => {
    // `<root>/a` is a symlink; `<root>/a/b` inspects as a plain file, so
    // only walking every component catches the symlink at `a`.
    const backend = new FakeComputeBackend();
    const runtime = await backend.acquire(TEST_SPEC);
    await backend.createDirectory(runtime, THREAD_ROOT);
    backend.seedSymlink(runtime, `${THREAD_ROOT}/a`, "/etc");
    backend.seedFile(runtime, `${THREAD_ROOT}/a/b`, new Uint8Array([1]), "text/plain");

    await expect(assertPathContained(backend, runtime, "a/b", THREAD_ROOT)).rejects.toThrow(
      "compute_path_escape",
    );
  });

  /**
   * Fail-closed on a missing root, and the root that must exist is the THREAD's
   * directory — not `/workspace`, which is provisioned by every acquire and so
   * would make this guard unfalsifiable on a box whose thread directory was
   * never created.
   */
  it("fails closed when the thread's own root is missing", async () => {
    const backend = new FakeComputeBackend();
    const runtime = await backend.acquire(TEST_SPEC);

    await expect(assertPathContained(backend, runtime, "new-file.ts", THREAD_ROOT)).rejects.toThrow(
      "workspace_root_missing",
    );
  });
});

describe("sha256Hex", () => {
  it("hashes bytes to a hex-encoded SHA-256 digest", async () => {
    const bytes = new TextEncoder().encode("hello").buffer;
    expect(await sha256Hex(bytes)).toBe(
      "2cf24dba5fb0a30e26e83b2ac5b9e29e1b161e5c1fa7425e73043362938b9824",
    );
  });
});
