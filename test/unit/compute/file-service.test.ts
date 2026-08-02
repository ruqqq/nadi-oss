import { describe, expect, it } from "vitest";
import { FakeComputeBackend } from "../../../src/compute/backends/fake";
import type { BackendReference } from "../../../src/compute/backend";
import { ComputePartialWriteError } from "../../../src/compute/errors";
import { ComputeFileService } from "../../../src/compute/file-service";
import type { ComputeEvent } from "../../../src/compute/observability";
import { sha256Hex } from "../../../src/compute/files/hash";

function toArrayBuffer(bytes: Uint8Array): ArrayBuffer {
  return bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer;
}

async function acquireRuntime(backend: FakeComputeBackend): Promise<BackendReference> {
  return backend.acquire({
    environmentId: "file_test",
    profile: "small",
    workspaceRoot: "/workspace",
    env: {},
    maxProcessRuntimeMs: 0,
    allowedHosts: null,
  });
}

/** Seed a text file directly (bypasses writeFile call recording) and return its hash. */
async function seedText(
  backend: FakeComputeBackend,
  runtime: BackendReference,
  relPath: string,
  text: string,
): Promise<string> {
  const bytes = new TextEncoder().encode(text);
  const absolute = `/workspace/${relPath}`;
  const parent = absolute.slice(0, absolute.lastIndexOf("/"));
  // A real file implies its parent directory exists; the fake tracks that set.
  await backend.createDirectory(runtime, parent);
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

function makeService(
  backend: FakeComputeBackend,
  runtime: BackendReference,
  overrides?: Partial<{ readMaxBytes: number; maxDownloadBytes: number; maxUploadBytes: number }>,
) {
  const events: ComputeEvent[] = [];
  const lease = { count: 0 };
  const clock = { value: 1_000 };
  const service = new ComputeFileService({
    backend,
    readMaxBytes: overrides?.readMaxBytes ?? 64_000,
    readMaxLines: 500,
    maxDownloadBytes: overrides?.maxDownloadBytes ?? 25_000_000,
    maxUploadBytes: overrides?.maxUploadBytes ?? 25_000_000,
    provider: backend.id,
    profile: "small",
    resolveRuntime: async () => runtime,
    refreshLease: async () => void (lease.count += 1),
    now: () => clock.value,
    recordEvent: (event) => void events.push(event),
  });
  return { service, events, lease, clock };
}

async function setup(
  overrides?: Partial<{ readMaxBytes: number; maxDownloadBytes: number; maxUploadBytes: number }>,
) {
  const backend = new FakeComputeBackend();
  const runtime = await acquireRuntime(backend);
  return { backend, runtime, ...makeService(backend, runtime, overrides) };
}

describe("ComputeFileService.readFile", () => {
  it("returns a bounded, line-numbered window and flags truncation", async () => {
    const { backend, runtime, service, lease } = await setup();
    await seedText(backend, runtime, "src/a.ts", "first\nsecond\nthird\nfourth\n");

    const read = await service.readFile({ path: "src/a.ts", startLine: 2, maxLines: 2 });

    expect(read).toMatchObject({
      path: "src/a.ts",
      startLine: 2,
      endLine: 3,
      truncated: true,
    });
    expect(read.content).toBe("2: second\n3: third");
    expect(read.hash).toBe(
      await sha256Hex(
        new TextEncoder().encode("first\nsecond\nthird\nfourth\n").buffer as ArrayBuffer,
      ),
    );
    expect(lease.count).toBe(1);
  });

  it("reads a whole small file without truncation", async () => {
    const { backend, runtime, service } = await setup();
    await seedText(backend, runtime, "a.txt", "one\ntwo\n");

    const read = await service.readFile({ path: "a.txt" });

    expect(read).toMatchObject({ startLine: 1, endLine: 2, truncated: false });
    expect(read.content).toBe("1: one\n2: two");
  });

  it("rejects an escaping path before touching the file", async () => {
    const { service } = await setup();
    await expect(service.readFile({ path: "../escape.txt" })).rejects.toMatchObject({
      code: "compute_invalid_path",
    });
  });

  // Regression pin: readFile's output goes into the model's context and must
  // stay bounded by readMaxBytes even though applyPatch/writeFile's source
  // reads now use the much larger maxDownloadBytes.
  it("rejects a file over readMaxBytes even though maxDownloadBytes is much larger", async () => {
    const { backend, runtime, service } = await setup({
      readMaxBytes: 100,
      maxDownloadBytes: 10_000,
    });
    await seedText(backend, runtime, "big.txt", "x".repeat(200));

    await expect(service.readFile({ path: "big.txt" })).rejects.toMatchObject({
      code: "compute_file_too_large",
    });
  });
});

describe("ComputeFileService.writeFile", () => {
  it("rejects a stale hash and writes nothing", async () => {
    const { backend, runtime, service, lease } = await setup();
    await seedText(backend, runtime, "src/a.ts", "original\n");

    await expect(
      service.writeFile({ path: "src/a.ts", content: "replacement\n", expectedHash: "stale" }),
    ).rejects.toMatchObject({ code: "compute_stale_file" });

    expect(backend.writeFileCalls).toHaveLength(0);
    expect(lease.count).toBe(0);
    expect(await readBackendText(backend, runtime, "src/a.ts")).toBe("original\n");
  });

  it("overwrites an existing file on a matching hash and emits a mutation event", async () => {
    const { backend, runtime, service, events, lease } = await setup();
    const hash = await seedText(backend, runtime, "src/a.ts", "original\n");

    const result = await service.writeFile({
      path: "src/a.ts",
      content: "replacement\n",
      expectedHash: hash,
    });

    expect(await readBackendText(backend, runtime, "src/a.ts")).toBe("replacement\n");
    expect(result.hash).toBe(
      await sha256Hex(new TextEncoder().encode("replacement\n").buffer as ArrayBuffer),
    );
    expect(result.bytesWritten).toBe(12);
    expect(lease.count).toBe(1);

    expect(events).toHaveLength(1);
    const event = events[0]!;
    expect(event).toMatchObject({
      event: "file_mutation",
      provider: "fake",
      profile: "small",
      operationCount: 1,
      byteCount: 12,
      outcome: "success",
    });
    // Privacy boundary: no path/content/hash-bearing keys.
    expect(Object.keys(event).sort()).toEqual(
      [
        "byteCount",
        "durationMs",
        "event",
        "operationCount",
        "outcome",
        "profile",
        "provider",
      ].sort(),
    );
  });

  it("creates a new file when no expected hash is given", async () => {
    const { backend, runtime, service } = await setup();

    await service.writeFile({ path: "src/new.ts", content: "hello\n", createParents: true });

    expect(await readBackendText(backend, runtime, "src/new.ts")).toBe("hello\n");
  });

  it("refuses to write over an existing file without an expected hash", async () => {
    const { backend, runtime, service } = await setup();
    await seedText(backend, runtime, "src/a.ts", "original\n");

    await expect(service.writeFile({ path: "src/a.ts", content: "x\n" })).rejects.toMatchObject({
      code: "compute_stale_file",
    });
    expect(backend.writeFileCalls).toHaveLength(0);
  });

  it("rejects content exceeding maxUploadBytes before any mutation", async () => {
    const { backend, service, lease, events } = await setup({ maxUploadBytes: 100 });

    await expect(
      service.writeFile({ path: "src/new.ts", content: "x".repeat(200), createParents: true }),
    ).rejects.toMatchObject({ code: "compute_file_too_large" });

    expect(backend.writeFileCalls).toHaveLength(0);
    expect(lease.count).toBe(0);
    // The rejection short-circuits before compute is acquired, but it is still
    // worth seeing: provider and profile are known without a runtime.
    expect(events).toContainEqual(
      expect.objectContaining({ event: "file_mutation", outcome: "failure", byteCount: 200 }),
    );
    // ...and it must not leak the path or content it rejected.
    for (const event of events) {
      expect(Object.keys(event)).not.toContain("path");
      expect(JSON.stringify(event)).not.toContain("src/new.ts");
    }
  });

  it("reads a pre-write hash on an existing file larger than readMaxBytes", async () => {
    // The pre-write hash read of the file about to be overwritten needs
    // applyPatch's reach (maxDownloadBytes), not the model-context readMaxBytes.
    const { backend, runtime, service } = await setup({
      readMaxBytes: 100,
      maxDownloadBytes: 10_000,
    });
    const big = "x".repeat(200);
    const hash = await seedText(backend, runtime, "big.txt", big);

    const result = await service.writeFile({
      path: "big.txt",
      content: "replacement\n",
      expectedHash: hash,
    });

    expect(result.hash).toBe(
      await sha256Hex(new TextEncoder().encode("replacement\n").buffer as ArrayBuffer),
    );
    expect(await readBackendText(backend, runtime, "big.txt")).toBe("replacement\n");
  });
});

describe("ComputeFileService.applyPatch", () => {
  const UPDATE_A = ["*** Update File: src/a.ts", "@@", " alpha", "-beta", "+BETA", " gamma"];

  it("applies a multi-file patch: update, add, and delete", async () => {
    const { backend, runtime, service, events, lease } = await setup();
    const hashA = await seedText(backend, runtime, "src/a.ts", "alpha\nbeta\ngamma\n");
    const hashB = await seedText(backend, runtime, "src/b.ts", "one\ntwo\n");

    const patch = [
      "*** Begin Patch",
      ...UPDATE_A,
      "*** Add File: src/c.ts",
      "+new file",
      "*** Delete File: src/b.ts",
      "*** End Patch",
    ].join("\n");

    const result = await service.applyPatch({
      patch,
      expectedHashes: { "src/a.ts": hashA, "src/b.ts": hashB },
    });

    expect(result).toEqual({ operations: 3, written: 2, deleted: 1 });
    expect(await readBackendText(backend, runtime, "src/a.ts")).toBe("alpha\nBETA\ngamma\n");
    expect(await readBackendText(backend, runtime, "src/c.ts")).toBe("new file\n");
    expect(await backend.inspectPath(runtime, "/workspace/src/b.ts")).toBeNull();
    expect(lease.count).toBe(1);
    expect(events).toMatchObject([
      { event: "file_mutation", operationCount: 3, outcome: "success" },
    ]);
  });

  it("prevalidates fully: a hunk mismatch writes nothing", async () => {
    const { backend, runtime, service, events } = await setup();
    const hashA = await seedText(backend, runtime, "src/a.ts", "alpha\nDIFFERENT\ngamma\n");

    const patch = ["*** Begin Patch", ...UPDATE_A, "*** End Patch"].join("\n");

    await expect(
      service.applyPatch({ patch, expectedHashes: { "src/a.ts": hashA } }),
    ).rejects.toMatchObject({ code: "compute_patch_hunk_mismatch" });

    expect(backend.writeFileCalls).toHaveLength(0);
    expect(backend.movePathCalls).toHaveLength(0);
    expect(backend.deletePathCalls).toHaveLength(0);
    // Parsing succeeded, so the known operation count survives into the
    // failure event even though the commit never ran.
    expect(events).toMatchObject([
      { event: "file_mutation", operationCount: 1, outcome: "failure" },
    ]);
  });

  it("mutates nothing when an aliased spelling collides with a plain path", async () => {
    // "./src/a.ts" normalizes to the same file as "src/a.ts": the update writes
    // it and the delete removes it. Left undetected, the commit's write-then-
    // delete would destroy the file while reporting success. Reject at parse
    // time, before any backend mutation.
    const { backend, runtime, service } = await setup();
    const hashA = await seedText(backend, runtime, "src/a.ts", "keep\nold\n");

    const patch = [
      "*** Begin Patch",
      "*** Update File: src/a.ts",
      "@@",
      " keep",
      "-old",
      "+new",
      "*** Delete File: ./src/a.ts",
      "*** End Patch",
    ].join("\n");

    await expect(
      service.applyPatch({ patch, expectedHashes: { "src/a.ts": hashA } }),
    ).rejects.toMatchObject({ code: "compute_patch_duplicate_path" });

    expect(backend.writeFileCalls).toHaveLength(0);
    expect(backend.movePathCalls).toHaveLength(0);
    expect(backend.deletePathCalls).toHaveLength(0);
    // The file itself is untouched.
    expect(await readBackendText(backend, runtime, "src/a.ts")).toBe("keep\nold\n");
  });

  it("emits operationCount 0 on failure when the patch itself fails to parse", async () => {
    const { service, events } = await setup();

    await expect(
      service.applyPatch({ patch: "not a patch", expectedHashes: {} }),
    ).rejects.toMatchObject({ code: "compute_patch_malformed" });

    expect(events).toMatchObject([
      { event: "file_mutation", operationCount: 0, outcome: "failure" },
    ]);
  });

  it("rejects an add whose destination already exists, before any write", async () => {
    const { backend, runtime, service } = await setup();
    await seedText(backend, runtime, "src/a.ts", "exists\n");

    const patch = ["*** Begin Patch", "*** Add File: src/a.ts", "+new", "*** End Patch"].join("\n");

    await expect(service.applyPatch({ patch, expectedHashes: {} })).rejects.toMatchObject({
      code: "compute_patch_file_exists",
    });
    expect(backend.writeFileCalls).toHaveLength(0);
    expect(backend.movePathCalls).toHaveLength(0);
    expect(backend.deletePathCalls).toHaveLength(0);
  });

  it("rejects a move whose destination already exists on disk, before any write", async () => {
    const { backend, runtime, service } = await setup();
    const hashA = await seedText(backend, runtime, "src/a.ts", "alpha\nbeta\ngamma\n");
    await seedText(backend, runtime, "src/b.ts", "already here\n");

    const patch = [
      "*** Begin Patch",
      "*** Update File: src/a.ts",
      "*** Move to: src/b.ts",
      "@@",
      " alpha",
      "-beta",
      "+BETA",
      " gamma",
      "*** End Patch",
    ].join("\n");

    await expect(
      service.applyPatch({ patch, expectedHashes: { "src/a.ts": hashA } }),
    ).rejects.toMatchObject({ code: "compute_patch_file_exists" });
    expect(backend.writeFileCalls).toHaveLength(0);
    expect(backend.movePathCalls).toHaveLength(0);
  });

  it("rejects a stale source hash before any write", async () => {
    const { backend, runtime, service } = await setup();
    await seedText(backend, runtime, "src/a.ts", "alpha\nbeta\ngamma\n");

    const patch = ["*** Begin Patch", ...UPDATE_A, "*** End Patch"].join("\n");

    await expect(
      service.applyPatch({ patch, expectedHashes: { "src/a.ts": "stale" } }),
    ).rejects.toMatchObject({ code: "compute_stale_file" });
    expect(backend.writeFileCalls).toHaveLength(0);
  });

  it("raises a sorted compute_partial_write and cleans up temps on a mid-commit failure", async () => {
    const { backend, runtime, service, lease } = await setup();
    const hashA = await seedText(backend, runtime, "src/a.ts", "alpha\nbeta\ngamma\n");
    const hashB = await seedText(backend, runtime, "src/b.ts", "beta\nalpha\ngamma\n");

    const patch = [
      "*** Begin Patch",
      ...UPDATE_A,
      "*** Update File: src/b.ts",
      "@@",
      " beta",
      "-alpha",
      "+ALPHA",
      " gamma",
      "*** End Patch",
    ].join("\n");

    backend.failNextMovePath(new Error("injected move failure"));

    const error = await service
      .applyPatch({ patch, expectedHashes: { "src/a.ts": hashA, "src/b.ts": hashB } })
      .then(
        () => null,
        (caught: unknown) => caught,
      );

    expect(error).toBeInstanceOf(ComputePartialWriteError);
    expect((error as ComputePartialWriteError).code).toBe("compute_partial_write");
    expect((error as ComputePartialWriteError).affectedPaths).toEqual(["src/a.ts", "src/b.ts"]);

    // Both staged temp files were written, then best-effort removed on failure.
    const tempWrites = backend.writeFileCalls.filter((call) => call.path.includes(".nadi-tmp-"));
    expect(tempWrites).toHaveLength(2);
    const tempDeletes = backend.deletePathCalls.filter((call) => call.path.includes(".nadi-tmp-"));
    expect(tempDeletes.map((call) => call.path).sort()).toEqual(
      tempWrites.map((call) => call.path).sort(),
    );

    // The lease is not refreshed when the commit fails.
    expect(lease.count).toBe(0);
    // Original content survives the failed first move.
    expect(await readBackendText(backend, runtime, "src/a.ts")).toBe("alpha\nbeta\ngamma\n");
  });

  it("propagates the underlying error unchanged when the first temp write fails", async () => {
    const { backend, runtime, service, lease } = await setup();
    const hashA = await seedText(backend, runtime, "src/a.ts", "alpha\nbeta\ngamma\n");
    const patch = ["*** Begin Patch", ...UPDATE_A, "*** End Patch"].join("\n");

    backend.failNextWriteFile(new Error("injected write failure"));

    const error = await service.applyPatch({ patch, expectedHashes: { "src/a.ts": hashA } }).then(
      () => null,
      (caught: unknown) => caught,
    );

    // Nothing was staged yet, so this must NOT be a ComputePartialWriteError —
    // that would wrongly imply on-disk state may have changed.
    expect(error).not.toBeInstanceOf(ComputePartialWriteError);
    expect((error as Error).message).toBe("injected write failure");
    expect(lease.count).toBe(0);
    expect(await readBackendText(backend, runtime, "src/a.ts")).toBe("alpha\nbeta\ngamma\n");
  });

  it("reads a source file larger than readMaxBytes, bounded only by maxDownloadBytes", async () => {
    // applyPatch's source reads are never shown to the model, so they must
    // use maxDownloadBytes, not the model-context readMaxBytes.
    const { backend, runtime, service } = await setup({
      readMaxBytes: 100,
      maxDownloadBytes: 10_000,
    });
    const padding = "// padding\n".repeat(30); // pushes the file past readMaxBytes (100 bytes)
    const hashA = await seedText(backend, runtime, "src/a.ts", `${padding}alpha\nbeta\ngamma\n`);

    const patch = ["*** Begin Patch", ...UPDATE_A, "*** End Patch"].join("\n");

    const result = await service.applyPatch({ patch, expectedHashes: { "src/a.ts": hashA } });

    expect(result).toEqual({ operations: 1, written: 1, deleted: 0 });
    expect(await readBackendText(backend, runtime, "src/a.ts")).toBe(
      `${padding}alpha\nBETA\ngamma\n`,
    );
  });

  it("refreshes the lease on a successful patch", async () => {
    const { backend, runtime, service, lease } = await setup();
    const hashA = await seedText(backend, runtime, "src/a.ts", "alpha\nbeta\ngamma\n");
    const patch = ["*** Begin Patch", ...UPDATE_A, "*** End Patch"].join("\n");

    await service.applyPatch({ patch, expectedHashes: { "src/a.ts": hashA } });

    expect(lease.count).toBe(1);
  });
});

describe("applyPatch does not clobber when inspectPath fails open", () => {
  it("refuses an `add` onto a file inspectPath reports as absent", async () => {
    const { backend, runtime, service } = await setup();
    await seedText(backend, runtime, "src/keep.ts", "original content\n");
    // The provider failed in band; inspectPath cannot tell absent from unreadable.
    backend.seedBlindInspect(runtime, "/workspace/src/keep.ts");

    const patch = [
      "*** Begin Patch",
      "*** Add File: src/keep.ts",
      "+clobbered",
      "*** End Patch",
    ].join("\n");

    await expect(service.applyPatch({ patch, expectedHashes: {} })).rejects.toMatchObject({
      code: "compute_patch_file_exists",
    });

    // The throw is not the property. The bytes surviving is the property.
    expect(await readBackendText(backend, runtime, "src/keep.ts")).toBe("original content\n");
  });

  it("refuses an `update` + moveTo onto a destination inspectPath reports as absent", async () => {
    const { backend, runtime, service } = await setup();
    const hashA = await seedText(backend, runtime, "src/a.ts", "alpha\nbeta\ngamma\n");
    await seedText(backend, runtime, "src/b.ts", "destination original\n");
    backend.seedBlindInspect(runtime, "/workspace/src/b.ts");

    const patch = [
      "*** Begin Patch",
      "*** Update File: src/a.ts",
      "*** Move to: src/b.ts",
      "@@",
      " alpha",
      "-beta",
      "+BETA",
      " gamma",
      "*** End Patch",
    ].join("\n");

    await expect(
      service.applyPatch({ patch, expectedHashes: { "src/a.ts": hashA } }),
    ).rejects.toMatchObject({ code: "compute_patch_file_exists" });

    expect(await readBackendText(backend, runtime, "src/b.ts")).toBe("destination original\n");
  });

  // The `add` guard must refuse ANY occupied destination, not just a regular
  // file. The old `entry.leaf` guard covered directories because `inspectPath`
  // reports them; the `pathExists` guard covers them only because all three
  // backends happen to include directories in their probe. Untested, that is an
  // accident — a backend whose `pathExists` only saw files would let an `add`
  // onto a directory through to commit(), which moves with overwrite:true.
  it("refuses an `add` whose destination is an existing directory", async () => {
    const { backend, runtime, service } = await setup();
    await backend.createDirectory(runtime, "/workspace/src/occupied");

    const patch = [
      "*** Begin Patch",
      "*** Add File: src/occupied",
      "+clobbered",
      "*** End Patch",
    ].join("\n");

    await expect(service.applyPatch({ patch, expectedHashes: {} })).rejects.toMatchObject({
      code: "compute_patch_file_exists",
    });

    expect(backend.writeFileCalls).toHaveLength(0);
    expect(backend.movePathCalls).toHaveLength(0);
  });

  it("still adds a file that is genuinely absent", async () => {
    const { backend, runtime, service } = await setup();

    const patch = ["*** Begin Patch", "*** Add File: src/new.ts", "+fresh", "*** End Patch"].join(
      "\n",
    );

    const result = await service.applyPatch({ patch, expectedHashes: {} });

    expect(result).toMatchObject({ written: 1 });
    expect(await readBackendText(backend, runtime, "src/new.ts")).toBe("fresh\n");
  });

  it("propagates a pathExists provider failure on `add` and writes nothing", async () => {
    // pathExists answers-or-throws by contract: a provider failure must never
    // be read as "destination absent". This proves the service half of that —
    // the throw reaches the caller, and because pathExists runs during
    // prevalidation (before any temp write is staged), nothing was ever
    // written, moved, or deleted.
    const { backend, runtime, service } = await setup();
    await seedText(backend, runtime, "src/keep.ts", "original content\n");
    backend.failNextPathExists(new Error("injected pathExists failure"));

    const patch = [
      "*** Begin Patch",
      "*** Add File: src/keep.ts",
      "+clobbered",
      "*** End Patch",
    ].join("\n");

    const error = await service.applyPatch({ patch, expectedHashes: {} }).then(
      () => null,
      (caught: unknown) => caught,
    );

    expect((error as Error).message).toBe("injected pathExists failure");
    expect(backend.writeFileCalls).toHaveLength(0);
    expect(backend.movePathCalls).toHaveLength(0);
    expect(backend.deletePathCalls).toHaveLength(0);
    expect(await readBackendText(backend, runtime, "src/keep.ts")).toBe("original content\n");
  });
});
