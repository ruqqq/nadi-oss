/**
 * End-to-end coverage for the model-native file tools (`read_file`,
 * `write_file`, `apply_patch`) driven through the *real* tool definitions
 * (`buildComputeFileToolDefs`) wired the same way production does in
 * `createComputeTools` — over a live `ThreadComputeService` and the in-memory
 * `FakeComputeBackend`.
 *
 * Tasks 1-4 each passed their own review; every defect this plan produced lived
 * at a seam *between* tasks. This suite exercises the whole chain as one unit:
 * the tool input schemas do their real validation, the path guard walks a real
 * (fake) backend, the patch parser and file-service commit ordering run
 * together, and hashes round-trip through the actual tool results. We never
 * call `ComputeFileService` directly and never hand-compute a hash.
 */
import { describe, expect, it } from "vitest";
import { buildComputeFileToolDefs } from "../../src/agent/compute-file-tools";
import { DEFAULT_COMPUTE_LIMITS } from "../../src/compute/config";
import { FakeComputeBackend } from "../../src/compute/backends/fake";
import { GENERATION_PATH } from "../../src/compute/generation";
import { ThreadComputeService } from "../../src/compute/thread-service";
import { DEFAULT_MONITOR_POLL_INTERVAL_MS } from "../../src/compute/watchers";
import { createMemoryComputeStore } from "../unit/compute/helpers/memory-store";
import { threadWorkRoot } from "../../src/compute/workspace-layout";

const THREAD_ID = "thr_compute_file_tools_integration";

type ToolResult = Record<string, unknown> & { ok: boolean };

/** Wires the file tools exactly as `createComputeTools` does: over the thread's shared `service.files`. */
function buildFileTools(backend: FakeComputeBackend) {
  const service = new ThreadComputeService({
    backend,
    store: createMemoryComputeStore(),
    config: {
      provider: "fake",
      providerConfig: { kind: "cloudflare" },
      resourceProfile: "small",
      idleTimeoutMs: 5000,
      recoveryTtlMs: 60000,
      maxProcessRuntimeMs: 60000,
      monitorPollIntervalMs: DEFAULT_MONITOR_POLL_INTERVAL_MS,
      limits: DEFAULT_COMPUTE_LIMITS,
      allowedHosts: null,
      editableEnv: {},
      agentEditableEnv: {},
      secretEnvNames: [],
    },
    environmentId: "fake-env",
    threadId: THREAD_ID,
    env: {},
    setAlarm: async () => {},
    now: () => 1000,
  });
  return buildComputeFileToolDefs(async () => service.files);
}

/**
 * Runs a tool as the model would: validate the arguments through the tool's own
 * `inputSchema` (bounds, positive ints, required fields) before `execute`. A
 * schema-invalid call throws here, mirroring the SDK's pre-execute validation.
 */
async function runTool(tool: unknown, input: unknown): Promise<ToolResult> {
  const t = tool as {
    inputSchema: { parse: (i: unknown) => unknown };
    execute: (i: unknown, ctx: unknown) => Promise<ToolResult>;
  };
  return t.execute(t.inputSchema.parse(input), {} as never);
}

/** The runtime the service lazily acquired, for seeding symlinks into the backend. */
function activeRuntime(backend: FakeComputeBackend) {
  const last = backend.acquireCalls.at(-1);
  if (!last) throw new Error("no runtime acquired yet");
  return last.runtime;
}

/**
 * Mutations the *caller's* tool calls caused, which is the only thing these
 * cases assert on.
 *
 * `GENERATION_PATH` is excluded deliberately, and it is the one exclusion:
 * `ThreadComputeService` writes the sandbox generation nonce once, inside
 * `readOrAcquireRuntime`, at genuine provision. Compute is acquired lazily, so
 * the *first* tool call in a test provisions — and a test whose first call is a
 * rejected one (the path-escape case) would otherwise see that infrastructure
 * write and read it as "the guard wrote something". Nothing else is filtered:
 * any write the guard let through — including the `.nadi-tmp-` staging files
 * the file service commits through — still counts, so a guard that actually
 * wrote the caller's content cannot hide here.
 */
function mutationCounts(backend: FakeComputeBackend) {
  return {
    writes: backend.writeFileCalls.filter((call) => call.path !== GENERATION_PATH).length,
    moves: backend.movePathCalls.length,
    deletes: backend.deletePathCalls.length,
  };
}

const ORIGINAL = "alpha\nbeta\ngamma\n";
const PATH = "notes/todo.md";

describe("compute file tools end to end", () => {
  it("creates, reads, patches, rejects a stale replay, recovers, moves, and deletes a file", async () => {
    const backend = new FakeComputeBackend();
    const tools = buildFileTools(backend);

    // 1. Create the file. write_file reports the hash it just wrote.
    const created = await runTool(tools.write_file, {
      path: PATH,
      content: ORIGINAL,
      createParents: true,
    });
    expect(created.ok).toBe(true);
    const writtenHash = created.hash as string;

    // 2. Read it back; the read hash must equal the write hash (round-trip).
    const firstRead = await runTool(tools.read_file, { path: PATH });
    expect(firstRead.ok).toBe(true);
    expect(firstRead.content).toBe("1: alpha\n2: beta\n3: gamma");
    const h1 = firstRead.hash as string;
    expect(h1).toBe(writtenHash);

    // 3. Patch using exactly the hash read_file returned (round-trip into apply_patch).
    const patchBeta = [
      "*** Begin Patch",
      "*** Update File: notes/todo.md",
      "@@",
      " alpha",
      "-beta",
      "+BETA",
      " gamma",
      "*** End Patch",
    ].join("\n");
    const patched = await runTool(tools.apply_patch, {
      patch: patchBeta,
      expectedHashes: { [PATH]: h1 },
    });
    expect(patched).toMatchObject({ ok: true, operations: 1, written: 1, deleted: 0 });

    // 4. Re-read: content changed and the hash moved.
    const secondRead = await runTool(tools.read_file, { path: PATH });
    expect(secondRead.content).toBe("1: alpha\n2: BETA\n3: gamma");
    const h2 = secondRead.hash as string;
    expect(h2).not.toBe(h1);

    // 5. Stale rejection must be actionable: replay the ORIGINAL (now stale)
    // patch. It fails with the offending path AND the file's live hash, and
    // writes nothing.
    const beforeStale = mutationCounts(backend);
    const stale = await runTool(tools.apply_patch, {
      patch: patchBeta,
      expectedHashes: { [PATH]: h1 },
    });
    expect(stale.ok).toBe(false);
    expect(stale.error).toBe("compute_stale_file");
    expect(stale.path).toBe(PATH);
    expect(stale.currentHash).toBe(h2); // the live hash, not the stale h1
    expect(mutationCounts(backend)).toEqual(beforeStale);

    // Recovery: re-read for the fresh hash, re-patch, succeed.
    const reread = await runTool(tools.read_file, { path: PATH });
    expect(reread.hash).toBe(h2);
    const patchGamma = [
      "*** Begin Patch",
      "*** Update File: notes/todo.md",
      "@@",
      " alpha",
      " BETA",
      "-gamma",
      "+GAMMA",
      "*** End Patch",
    ].join("\n");
    const recovered = await runTool(tools.apply_patch, {
      patch: patchGamma,
      expectedHashes: { [PATH]: h2 },
    });
    expect(recovered).toMatchObject({ ok: true, written: 1 });

    // Round-trip through write_file too: overwrite using a read hash.
    const thirdRead = await runTool(tools.read_file, { path: PATH });
    expect(thirdRead.content).toBe("1: alpha\n2: BETA\n3: GAMMA");
    const h3 = thirdRead.hash as string;
    const overwritten = await runTool(tools.write_file, {
      path: PATH,
      content: "rewritten\n",
      expectedHash: h3,
    });
    expect(overwritten.ok).toBe(true);
    const h4 = (await runTool(tools.read_file, { path: PATH })).hash as string;
    expect(h4).toBe(overwritten.hash);

    // 6. Move the file via a pure move (Update + Move to, no hunk).
    const moved = await runTool(tools.apply_patch, {
      patch: [
        "*** Begin Patch",
        "*** Update File: notes/todo.md",
        "*** Move to: notes/done.md",
        "*** End Patch",
      ].join("\n"),
      expectedHashes: { [PATH]: h4 },
    });
    expect(moved).toMatchObject({ ok: true, written: 1, deleted: 1 });
    // Old path is gone; new path holds the content.
    expect((await runTool(tools.read_file, { path: PATH })).ok).toBe(false);
    const doneRead = await runTool(tools.read_file, { path: "notes/done.md" });
    expect(doneRead.ok).toBe(true);
    expect(doneRead.content).toBe("1: rewritten");
    const doneHash = doneRead.hash as string;

    // 7. Delete it.
    const deleted = await runTool(tools.apply_patch, {
      patch: ["*** Begin Patch", "*** Delete File: notes/done.md", "*** End Patch"].join("\n"),
      expectedHashes: { "notes/done.md": doneHash },
    });
    expect(deleted).toMatchObject({ ok: true, deleted: 1 });
    expect((await runTool(tools.read_file, { path: "notes/done.md" })).ok).toBe(false);
  });

  it("rejects escaping paths and mutates nothing", async () => {
    const backend = new FakeComputeBackend();
    const tools = buildFileTools(backend);

    // Traversal is rejected up front as an invalid path (the designed code for a
    // syntactic `../` escape; `compute_path_escape` is reserved for a symlink
    // discovered while walking the tree). Either way: nothing is written.
    const traversal = await runTool(tools.write_file, { path: "../outside", content: "x" });
    expect(traversal.ok).toBe(false);
    expect(traversal.error).toBe("compute_invalid_path");
    expect(mutationCounts(backend)).toEqual({ writes: 0, moves: 0, deletes: 0 });

    // Seed a symlinked ancestor, then target a path underneath it. The path
    // guard rejects the symlink component with compute_path_escape.
    await runTool(tools.write_file, { path: "safe.txt", content: "ok\n", createParents: true });
    // Seeded in THIS thread's working directory: the file tools resolve
    // relative paths there, not at /workspace, so a symlink planted at the old
    // root is simply never walked.
    backend.seedSymlink(activeRuntime(backend), `${threadWorkRoot(THREAD_ID)}/link`, "/outside");
    const before = mutationCounts(backend);

    const writeUnderLink = await runTool(tools.write_file, {
      path: "link/evil.txt",
      content: "x",
      createParents: true,
    });
    expect(writeUnderLink).toMatchObject({ ok: false, error: "compute_path_escape" });

    const patchUnderLink = await runTool(tools.apply_patch, {
      patch: ["*** Begin Patch", "*** Add File: link/evil2.txt", "+x", "*** End Patch"].join("\n"),
      expectedHashes: {},
    });
    expect(patchUnderLink).toMatchObject({ ok: false, error: "compute_path_escape" });

    // No new mutations from either escaping attempt.
    expect(mutationCounts(backend)).toEqual(before);
  });

  it("validates atomically: a last-operation failure leaves zero mutations", async () => {
    const backend = new FakeComputeBackend();
    const tools = buildFileTools(backend);

    await runTool(tools.write_file, {
      path: "multi/a.ts",
      content: "a1\na2\na3\n",
      createParents: true,
    });
    const hashA = (await runTool(tools.read_file, { path: "multi/a.ts" })).hash as string;
    const before = mutationCounts(backend);

    // First op is a valid change that *would* write; the last op targets a
    // missing file. Prevalidation runs before any commit, so nothing is written.
    const patch = [
      "*** Begin Patch",
      "*** Update File: multi/a.ts",
      "@@",
      " a1",
      "-a2",
      "+A2",
      " a3",
      "*** Update File: multi/missing.ts",
      "@@",
      " x",
      "-y",
      "+Y",
      "*** End Patch",
    ].join("\n");
    const result = await runTool(tools.apply_patch, {
      patch,
      expectedHashes: { "multi/a.ts": hashA, "multi/missing.ts": "does-not-matter" },
    });
    expect(result).toMatchObject({ ok: false, error: "compute_patch_missing_file" });
    expect(mutationCounts(backend)).toEqual(before);
    // The valid first file is untouched on disk.
    expect((await runTool(tools.read_file, { path: "multi/a.ts" })).content).toBe(
      "1: a1\n2: a2\n3: a3",
    );
  });

  it("rejects a move-then-delete collision in the parser without executing it", async () => {
    const backend = new FakeComputeBackend();
    const tools = buildFileTools(backend);

    await runTool(tools.write_file, { path: "coll/a.md", content: "A\n", createParents: true });
    await runTool(tools.write_file, { path: "coll/b.md", content: "B\n", createParents: true });
    const hashA = (await runTool(tools.read_file, { path: "coll/a.md" })).hash as string;
    const hashB = (await runTool(tools.read_file, { path: "coll/b.md" })).hash as string;
    const before = mutationCounts(backend);

    // Move a -> b while also deleting b: the destination collides with a deleted
    // path. Task 3 commits writes before deletes, so executing this would
    // destroy both files. The parser must reject it.
    const patch = [
      "*** Begin Patch",
      "*** Update File: coll/a.md",
      "*** Move to: coll/b.md",
      "*** Delete File: coll/b.md",
      "*** End Patch",
    ].join("\n");
    const result = await runTool(tools.apply_patch, {
      patch,
      expectedHashes: { "coll/a.md": hashA, "coll/b.md": hashB },
    });
    expect(result).toMatchObject({ ok: false, error: "compute_patch_duplicate_path" });
    expect(mutationCounts(backend)).toEqual(before);
    // Both files survive intact.
    expect((await runTool(tools.read_file, { path: "coll/a.md" })).content).toBe("1: A");
    expect((await runTool(tools.read_file, { path: "coll/b.md" })).content).toBe("1: B");
  });
});
