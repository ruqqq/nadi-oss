import { describe, expect, it } from "vitest";
import type { ComputeSpec } from "../../../../src/compute/backend";
import { FakeComputeBackend } from "../../../../src/compute/backends/fake";
import { assertPathContained, normalizeWorkspacePath } from "../../../../src/compute/files/path";
import { sha256Hex } from "../../../../src/compute/files/hash";

const TEST_SPEC: ComputeSpec = {
  environmentId: "files-test",
  profile: "small",
  workspaceRoot: "/workspace",
  env: {},
  maxProcessRuntimeMs: 1_000,
  allowedHosts: null,
};

describe("normalizeWorkspacePath", () => {
  it("normalizes a relative path under /workspace", () => {
    expect(normalizeWorkspacePath("src/app.ts")).toBe("/workspace/src/app.ts");
  });

  it("normalizes the empty-relative path to the workspace root", () => {
    expect(normalizeWorkspacePath(".")).toBe("/workspace");
  });

  it("rejects traversal that escapes the workspace root", () => {
    expect(() => normalizeWorkspacePath("../secret")).toThrow("compute_invalid_path");
  });

  it("rejects absolute paths", () => {
    expect(() => normalizeWorkspacePath("/etc/passwd")).toThrow("compute_invalid_path");
  });

  it("rejects empty paths", () => {
    expect(() => normalizeWorkspacePath("")).toThrow("compute_invalid_path");
  });

  it("rejects paths containing NUL", () => {
    expect(() => normalizeWorkspacePath("src/app\0.ts")).toThrow("compute_invalid_path");
  });

  it("normalizes a trailing slash to the same path as without", () => {
    expect(normalizeWorkspacePath("src/")).toBe("/workspace/src");
    expect(normalizeWorkspacePath("src")).toBe("/workspace/src");
  });
});

describe("assertPathContained", () => {
  it("accepts a path fully inside the workspace", async () => {
    const backend = new FakeComputeBackend();
    const runtime = await backend.acquire(TEST_SPEC);
    backend.seedFile(runtime, "/workspace/src/app.ts", new Uint8Array([1]), "text/plain");

    await expect(assertPathContained(backend, runtime, "src/app.ts")).resolves.toBe(
      "/workspace/src/app.ts",
    );
  });

  it("accepts a new path whose nearest existing ancestor is contained", async () => {
    const backend = new FakeComputeBackend();
    const runtime = await backend.acquire(TEST_SPEC);

    await expect(assertPathContained(backend, runtime, "new-file.ts")).resolves.toBe(
      "/workspace/new-file.ts",
    );
  });

  // These two prove the guard against a backend that REPORTS symlinks. They say
  // nothing about production: Daytona's getFileDetails follows links, so
  // inspectPath never returns type "symlink" there and the guard is inert
  // (verified live, 2026-07-10). See the note on `assertPathContained`.
  it("rejects a path whose ancestor symlink resolves outside /workspace", async () => {
    const backend = new FakeComputeBackend();
    const runtime = await backend.acquire(TEST_SPEC);
    backend.seedSymlink(runtime, "/workspace/link", "/etc");

    await expect(assertPathContained(backend, runtime, "link/passwd")).rejects.toThrow(
      "compute_path_escape",
    );
  });

  it("rejects an existing path that is itself a symlink resolving outside /workspace", async () => {
    const backend = new FakeComputeBackend();
    const runtime = await backend.acquire(TEST_SPEC);
    backend.seedSymlink(runtime, "/workspace/passwd", "/etc/passwd");

    await expect(assertPathContained(backend, runtime, "passwd")).rejects.toThrow(
      "compute_path_escape",
    );
  });

  it("rejects a real file reached through an intermediate symlink component", async () => {
    // `/workspace/a` is a symlink; `/workspace/a/b` inspects as a plain file, so
    // only walking every component catches the symlink at `a`.
    const backend = new FakeComputeBackend();
    const runtime = await backend.acquire(TEST_SPEC);
    backend.seedSymlink(runtime, "/workspace/a", "/etc");
    backend.seedFile(runtime, "/workspace/a/b", new Uint8Array([1]), "text/plain");

    await expect(assertPathContained(backend, runtime, "a/b")).rejects.toThrow(
      "compute_path_escape",
    );
  });

  it("fails closed when the workspace root itself is missing", async () => {
    const backend = new FakeComputeBackend();
    const runtime = await backend.acquire(TEST_SPEC);
    await backend.deletePath(runtime, "/workspace");

    await expect(assertPathContained(backend, runtime, "new-file.ts")).rejects.toThrow(
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
