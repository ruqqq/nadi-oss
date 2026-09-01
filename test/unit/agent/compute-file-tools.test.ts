import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it, vi } from "vitest";
import { buildComputeFileToolDefs } from "../../../src/agent/compute-file-tools";
import { FILE_TOOLS_GUIDANCE } from "../../../src/agent/system-prompt";
import { FakeComputeBackend } from "../../../src/compute/backends/fake";
import type { BackendReference } from "../../../src/compute/backend";
import { ComputeFileService } from "../../../src/compute/file-service";
import { sha256Hex } from "../../../src/compute/files/hash";

function toArrayBuffer(bytes: Uint8Array): ArrayBuffer {
  return bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer;
}

async function acquireRuntime(backend: FakeComputeBackend): Promise<BackendReference> {
  return backend.acquire({
    environmentId: "file_tool_test",
    profile: "small",
    workspaceRoot: "/workspace",
    env: {},
    maxProcessRuntimeMs: 0,
    allowedHosts: null,
  });
}

async function seedText(
  backend: FakeComputeBackend,
  runtime: BackendReference,
  relPath: string,
  text: string,
): Promise<string> {
  const bytes = new TextEncoder().encode(text);
  const absolute = `/workspace/${relPath}`;
  await backend.createDirectory(runtime, absolute.slice(0, absolute.lastIndexOf("/")));
  backend.seedFile(runtime, absolute, bytes, "text/plain");
  return sha256Hex(toArrayBuffer(bytes));
}

async function readBackendText(
  backend: FakeComputeBackend,
  runtime: BackendReference,
  relPath: string,
): Promise<string> {
  const { bytes } = await backend.readFile(runtime, `/workspace/${relPath}`, 1_000_000);
  return new TextDecoder().decode(bytes);
}

async function setup(overrides?: Partial<{ maxUploadBytes: number }>) {
  const backend = new FakeComputeBackend();
  const runtime = await acquireRuntime(backend);
  const service = new ComputeFileService({
    backend,
    readMaxBytes: 64_000,
    readMaxLines: 500,
    maxDownloadBytes: 25_000_000,
    maxUploadBytes: overrides?.maxUploadBytes ?? 25_000_000,
    provider: backend.id,
    profile: "small",
    // These suites seed and read absolute /workspace paths, so the root under
    // test is /workspace itself. That the root is honoured at all is proved in
    // `file-service.test.ts` ("resolves relative paths against the root it is
    // given") and in `files/path.test.ts`.
    workspaceRoot: "/workspace",
    resolveRuntime: async () => runtime,
    refreshLease: async () => {},
    now: () => 1_000,
    recordEvent: () => {},
  });
  const tools = buildComputeFileToolDefs(async () => service);
  return { backend, runtime, service, tools };
}

function exec(tool: unknown, input: unknown): Promise<any> {
  return (tool as { execute: (i: unknown) => Promise<any> }).execute(input);
}

describe("buildComputeFileToolDefs", () => {
  it("exposes exactly read_file, write_file, and apply_patch", async () => {
    const { tools } = await setup();
    expect(Object.keys(tools).sort()).toEqual(["apply_patch", "read_file", "write_file"]);
  });

  it("resolves an empty patch as a no-op success", async () => {
    const { tools } = await setup();
    await expect(
      exec(tools.apply_patch, { patch: "*** Begin Patch\n*** End Patch", expectedHashes: {} }),
    ).resolves.toEqual(
      expect.objectContaining({ ok: true, operations: 0, written: 0, deleted: 0 }),
    );
  });

  it("reads a bounded, line-numbered window with a content hash", async () => {
    const { backend, runtime, tools } = await setup();
    const hash = await seedText(backend, runtime, "src/a.ts", "one\ntwo\nthree\n");
    const result = await exec(tools.read_file, { path: "src/a.ts", startLine: 1, maxLines: 2 });
    expect(result).toEqual(
      expect.objectContaining({ ok: true, content: "1: one\n2: two", truncated: true, hash }),
    );
  });

  it("writes a new file and reports the written hash", async () => {
    const { backend, runtime, tools } = await setup();
    const result = await exec(tools.write_file, {
      path: "src/new.ts",
      content: "hello\n",
      createParents: true,
    });
    expect(result).toEqual(
      expect.objectContaining({
        ok: true,
        hash: await sha256Hex(new TextEncoder().encode("hello\n").buffer as ArrayBuffer),
      }),
    );
    expect(await readBackendText(backend, runtime, "src/new.ts")).toBe("hello\n");
  });

  it("returns the current on-disk hash on a stale write so the model can retry", async () => {
    const { backend, runtime, tools } = await setup();
    // The file is untouched, so its seed hash IS the live on-disk hash.
    const liveHash = await seedText(backend, runtime, "src/a.ts", "original\n");
    // Overwrite attempt with no expectedHash → stale.
    const result = await exec(tools.write_file, { path: "src/a.ts", content: "changed\n" });
    expect(result.ok).toBe(false);
    expect(result.error).toBe("compute_stale_file");
    // The returned hash must match the actual current on-disk content so the
    // model can re-read and retry with the right optimistic-concurrency token.
    expect(result.currentHash).toBe(liveHash);
    expect(result.currentHash).toBe(
      await sha256Hex(new TextEncoder().encode("original\n").buffer as ArrayBuffer),
    );
    // Guard: the file was not modified.
    expect(await readBackendText(backend, runtime, "src/a.ts")).toBe("original\n");
  });

  it("surfaces compute_file_too_large as a permanent, non-retryable structured error", async () => {
    const { tools } = await setup({ maxUploadBytes: 100 });
    const result = await exec(tools.write_file, {
      path: "src/big.ts",
      content: "x".repeat(200),
      createParents: true,
    });
    // Structured, not thrown; the code is the permanent one and carries no
    // transient/retry marker for the model to loop on.
    expect(result).toMatchObject({ ok: false, error: "compute_file_too_large" });
    expect(result).not.toHaveProperty("currentHash");
    expect(result).not.toHaveProperty("affectedPaths");
  });

  it("surfaces a sorted affectedPaths list on a partial write", async () => {
    const { backend, runtime, tools } = await setup();
    const hashA = await seedText(backend, runtime, "src/a.ts", "alpha\nbeta\ngamma\n");
    const hashB = await seedText(backend, runtime, "src/b.ts", "beta\nalpha\ngamma\n");
    const patch = [
      "*** Begin Patch",
      "*** Update File: src/a.ts",
      "@@",
      " alpha",
      "-beta",
      "+BETA",
      " gamma",
      "*** Update File: src/b.ts",
      "@@",
      " beta",
      "-alpha",
      "+ALPHA",
      " gamma",
      "*** End Patch",
    ].join("\n");
    backend.failNextMovePath(new Error("injected move failure"));

    const result = await exec(tools.apply_patch, {
      patch,
      expectedHashes: { "src/a.ts": hashA, "src/b.ts": hashB },
    });
    expect(result).toEqual(
      expect.objectContaining({
        ok: false,
        error: "compute_partial_write",
        affectedPaths: ["src/a.ts", "src/b.ts"],
      }),
    );
  });

  it("returns the offending path and its live on-disk hash on a multi-file apply_patch with one stale source", async () => {
    const { backend, runtime, tools } = await setup();
    const hashA = await seedText(backend, runtime, "src/a.ts", "alpha\nbeta\ngamma\n");
    await seedText(backend, runtime, "src/b.ts", "beta\nalpha\ngamma\n");
    const patch = [
      "*** Begin Patch",
      "*** Update File: src/a.ts",
      "@@",
      " alpha",
      "-beta",
      "+BETA",
      " gamma",
      "*** Update File: src/b.ts",
      "@@",
      " beta",
      "-alpha",
      "+ALPHA",
      " gamma",
      "*** End Patch",
    ].join("\n");

    const result = await exec(tools.apply_patch, {
      patch,
      // src/a.ts's hash is correct; src/b.ts's is stale (caller sent a wrong value).
      expectedHashes: { "src/a.ts": hashA, "src/b.ts": "stale-hash" },
    });

    expect(result.ok).toBe(false);
    expect(result.error).toBe("compute_stale_file");
    // Names the offending path out of the 10-entry map, not just "some hash mismatched".
    expect(result.path).toBe("src/b.ts");
    // Reports the live on-disk hash, not the stale value the caller supplied.
    expect(result.currentHash).toBe(
      await sha256Hex(new TextEncoder().encode("beta\nalpha\ngamma\n").buffer as ArrayBuffer),
    );
    expect(result.currentHash).not.toBe("stale-hash");
    expect(backend.writeFileCalls).toHaveLength(0);
  });

  it("maps a hunk mismatch to a structured error without writing", async () => {
    const { backend, runtime, tools } = await setup();
    const hashA = await seedText(backend, runtime, "src/a.ts", "alpha\nDIFFERENT\ngamma\n");
    const patch = [
      "*** Begin Patch",
      "*** Update File: src/a.ts",
      "@@",
      " alpha",
      "-beta",
      "+BETA",
      " gamma",
      "*** End Patch",
    ].join("\n");
    const result = await exec(tools.apply_patch, {
      patch,
      expectedHashes: { "src/a.ts": hashA },
    });
    expect(result).toMatchObject({ ok: false, error: "compute_patch_hunk_mismatch" });
    expect(backend.writeFileCalls).toHaveLength(0);
  });

  it("passes an unexpected error through the sanitized tool-error helper", async () => {
    const service = {
      readFile: vi.fn().mockRejectedValue(new Error("boom")),
    } as unknown as ComputeFileService;
    const tools = buildComputeFileToolDefs(async () => service);
    const result = await exec(tools.read_file, { path: "src/a.ts" });
    expect(result).toEqual({ ok: false, error: "boom" });
  });

  it("returns a ComputeError code and detail for an escaping path", async () => {
    const { tools } = await setup();
    const result = await exec(tools.read_file, { path: "../escape.txt" });
    expect(result).toMatchObject({ ok: false, error: "compute_invalid_path" });
    expect(result.detail).toBeDefined();
  });
});

describe("compute file tools guidance", () => {
  // Read the source text directly: importing the module pulls in
  // "@cloudflare/think" (a `cloudflare:` specifier the node unit project can't load).
  const body = readFileSync(
    fileURLToPath(new URL("../../../src/agent/skills/builtin-skill-source.ts", import.meta.url)),
    "utf8",
  );

  it("tells the model to prefer read_file/apply_patch while keeping rg, fd, git via exec", () => {
    expect(FILE_TOOLS_GUIDANCE).toContain("read_file");
    expect(FILE_TOOLS_GUIDANCE).toContain("apply_patch");
    expect(FILE_TOOLS_GUIDANCE).toContain("write_file");
    expect(FILE_TOOLS_GUIDANCE).toContain("rg, fd, git");
    // The old shell-edit affordance is gone.
    expect(body).not.toContain("edit through the shell");
  });

  it("sources the skill body's file-tools sentence from the shared constant, not a hand-copied paragraph", () => {
    // Finding 2 drift guard: the skill body must reference system-prompt.ts's
    // single shared constant instead of restating the guidance itself. If a
    // future edit hardcodes its own copy here, this interpolation site
    // disappears and the test goes red.
    expect(body).toContain("${FILE_TOOLS_GUIDANCE}");
    expect(body).not.toContain("Use read_file for focused repository");
  });
});
