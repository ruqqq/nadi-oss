import { describe, expect, it } from "vitest";
import { ComputeError } from "../../../src/compute/errors";
import { FakeComputeBackend } from "../../../src/compute/backends/fake";
import {
  GENERATION_DIR,
  GENERATION_NAME,
  GENERATION_PATH,
  readGeneration,
  writeGeneration,
} from "../../../src/compute/generation";
import { createFakeCloudflareBackend } from "./helpers/fake-cloudflare-client";

const SPEC = {
  environmentId: "thread_test",
  profile: "small" as const,
  workspaceRoot: "/workspace" as const,
  env: {},
  maxProcessRuntimeMs: 10_000,
  allowedHosts: null,
};

describe("sandbox generation nonce", () => {
  it("round-trips a nonce through the sandbox filesystem", async () => {
    const backend = new FakeComputeBackend();
    const runtime = await backend.acquire(SPEC);
    await writeGeneration(backend, runtime, "gen-a");
    expect(await readGeneration(backend, runtime)).toEqual({ kind: "found", nonce: "gen-a" });
  });

  // The production case (2026-07-16): the container is ALIVE and answering, its
  // filesystem was wiped. Nothing throws, so this absence is the only evidence
  // a reset ever leaves — reporting it as `unreadable` made `sandbox_reset`
  // unreachable in production.
  it("reports ABSENT — not unknown — when the listing answers and the nonce is gone", async () => {
    const backend = new FakeComputeBackend();
    const runtime = await backend.acquire(SPEC);
    expect(await readGeneration(backend, runtime)).toEqual({ kind: "absent" });
  });

  it("reports ABSENT after a live container's nonce is deleted under it", async () => {
    const backend = new FakeComputeBackend();
    const runtime = await backend.acquire(SPEC);
    await writeGeneration(backend, runtime, "gen-a");
    await backend.deletePath(runtime, GENERATION_PATH);
    expect(await readGeneration(backend, runtime)).toEqual({ kind: "absent" });
  });

  // Any throw, any reason. `absent` rests on the listing ANSWERING, so a listing
  // that did not answer can never reach it — this is the property by which the
  // false-absent window is closed rather than narrowed.
  it("reports UNREADABLE instead of throwing when the listing throws", async () => {
    const backend = new FakeComputeBackend();
    const runtime = await backend.acquire(SPEC);
    await writeGeneration(backend, runtime, "gen-a");
    backend.listDirectory = async () => {
      throw new ComputeError("runtime_missing", "container is gone");
    };
    expect(await readGeneration(backend, runtime)).toEqual({ kind: "unreadable" });
  });

  // The distinction that keeps `absent` honest. A `readFile` throw is NOT
  // evidence of an absence: the fake raises provider_transient/"fake_file_not_found"
  // and the real Cloudflare backend funnels every SDK throw through the same
  // provider_transient arm. Only the answered listing may be read as absent.
  it("reports UNREADABLE when the nonce is listed but cannot be read", async () => {
    const backend = new FakeComputeBackend();
    const runtime = await backend.acquire(SPEC);
    await writeGeneration(backend, runtime, "gen-a");
    backend.readFile = async () => {
      throw new ComputeError("provider_transient", "blip");
    };
    expect(await readGeneration(backend, runtime)).toEqual({ kind: "unreadable" });
  });

  // A directory/symlink where the nonce should be is not something to reason
  // about — it is neither a generation nor evidence of a reset.
  it("reports UNREADABLE when the nonce's name is listed as a non-file", async () => {
    const backend = new FakeComputeBackend();
    const runtime = await backend.acquire(SPEC);
    await backend.createDirectory(runtime, GENERATION_PATH);
    expect(await readGeneration(backend, runtime)).toEqual({ kind: "unreadable" });
  });

  it("reports UNREADABLE for a present but empty nonce (a torn write is not a reset)", async () => {
    const backend = new FakeComputeBackend();
    const runtime = await backend.acquire(SPEC);
    await writeGeneration(backend, runtime, "   ");
    expect(await readGeneration(backend, runtime)).toEqual({ kind: "unreadable" });
  });

  it("never writes anything: a probe must not overwrite a live container's nonce", async () => {
    const backend = new FakeComputeBackend();
    const runtime = await backend.acquire(SPEC);
    await writeGeneration(backend, runtime, "gen-a");
    const writesAfterProvision = backend.writeFileCalls.length;
    await readGeneration(backend, runtime); // found
    await backend.deletePath(runtime, GENERATION_PATH);
    await readGeneration(backend, runtime); // absent
    backend.listDirectory = async () => {
      throw new ComputeError("provider_transient", "blip");
    };
    await readGeneration(backend, runtime); // unreadable
    expect(backend.writeFileCalls.length).toBe(writesAfterProvision);
  });

  it("writes to a path under /tmp so it dies with the container", () => {
    expect(GENERATION_PATH.startsWith("/tmp/")).toBe(true);
  });

  // The nonce's directory and name are the two halves of the probe: one is
  // listed, the other is matched against that listing. Deriving the path pins
  // them together — and pins the exact string `compute-file-tools` filters out
  // of its mutation counts.
  it("derives GENERATION_PATH from its directory and name", () => {
    expect(GENERATION_PATH).toBe(`${GENERATION_DIR}/${GENERATION_NAME}`);
    expect(GENERATION_PATH).toBe("/tmp/.nadi-generation");
  });
});

/**
 * The property pinned against the REAL Cloudflare backend rather than the fake,
 * because it is a consequence of what that backend does with a failed listing.
 *
 * These exist because this file once pinned the opposite: a HEALTHY container
 * whose `/tmp` listing 404'd was reported `absent`, since `inspectPath` derived
 * the nonce's existence from a listing of the PARENT and mapped a "not found"-ish
 * SDK message to null. `listDirectory` has no null arm and never consults
 * `isPathNotFound`, so that route is gone by construction.
 */
describe("the /tmp listing is both the witness and the answer", () => {
  const CF_SPEC = {
    environmentId: "ws_1_thr_1",
    profile: "small" as const,
    workspaceRoot: "/workspace" as const,
    env: {},
    maxProcessRuntimeMs: 10_000,
    allowedHosts: null,
  };

  /** A healthy container: `/tmp` exists and lists fine. */
  async function healthyContainer() {
    const { backend, factory } = createFakeCloudflareBackend();
    const runtime = await backend.acquire(CF_SPEC);
    const sandboxId = (runtime.payload as { sandboxId: string }).sandboxId;
    const sandbox = factory.peek(sandboxId);
    if (!sandbox) throw new Error(`fake sandbox missing: ${sandboxId}`);
    await sandbox.mkdir("/tmp", true);
    return { backend, runtime, sandbox };
  }

  it("finds the nonce on a healthy container (the dot-prefixed name is listed)", async () => {
    const { backend, runtime } = await healthyContainer();
    await writeGeneration(backend, runtime, "gen-a");
    expect(await readGeneration(backend, runtime)).toEqual({ kind: "found", nonce: "gen-a" });
  });

  // THE REGRESSION THIS TASK FIXES. The container is HEALTHY — the nonce is
  // really on disk — and only the listing of its directory is broken, with a
  // "not found"-ish message (a proxy/route 404 is the realistic source). This
  // used to return `absent`: every row in flight was faulted `sandbox_reset` and
  // told its work was gone when it was not. A false fault is worse than a missed
  // one, so a throw is `unreadable`, always.
  it("does NOT claim absent on a healthy container whose /tmp listing 404s", async () => {
    const { backend, runtime, sandbox } = await healthyContainer();
    await writeGeneration(backend, runtime, "gen-a");
    expect(await readGeneration(backend, runtime)).toEqual({ kind: "found", nonce: "gen-a" });

    const realList = sandbox.listFiles.bind(sandbox);
    sandbox.listFiles = async (path: string, options?: { includeHidden?: boolean }) => {
      if (path === "/tmp") throw new Error("404: not found");
      return await realList(path, options);
    };

    expect(await readGeneration(backend, runtime)).toEqual({ kind: "unreadable" });
  });

  // A container serving no /tmp at all cannot reach `absent` either: same arm,
  // same reason. (Post-reset, a real container DOES serve /tmp — verified live
  // 2026-07-16 — which is why the `absent` case below is the reachable one.)
  it("does NOT claim absent when /tmp itself cannot be listed", async () => {
    const { backend, runtime, sandbox } = await healthyContainer();
    await sandbox.destroy(); // factory hands back a fresh, empty container
    expect(await readGeneration(backend, runtime)).toEqual({ kind: "unreadable" });
  });

  // The genuine wipe: the container answers a listing of the very directory the
  // nonce lives in, and the nonce is not in it. Positive evidence, not an
  // inference from an error shape.
  it("claims absent when the /tmp listing answers without the nonce", async () => {
    const { backend, runtime } = await healthyContainer();
    expect(await readGeneration(backend, runtime)).toEqual({ kind: "absent" });
  });

  // In-band failure: the SDK reports `{ success: false, files: [] }` and does
  // NOT throw. The codebase already caught this SDK doing exactly that on
  // `restoreBackup`. An empty listing that says it failed is not evidence of a
  // wipe — believing it would fault a healthy container's work on every tick.
  it("does NOT claim absent when the /tmp listing reports success: false", async () => {
    const { backend, runtime, sandbox } = await healthyContainer();
    await writeGeneration(backend, runtime, "gen-a");
    expect(await readGeneration(backend, runtime)).toEqual({ kind: "found", nonce: "gen-a" });

    sandbox.seedListFailure("/tmp");

    expect(await readGeneration(backend, runtime)).toEqual({ kind: "unreadable" });
  });

  // Pins the reason `DirEntry.type` was widened with "other": a socket/device/
  // fifo where the nonce should be is not something to reason about. Without
  // this, a later "simplification" that drops "other" from the CF map would
  // silently restore the false-absent route.
  it("does NOT claim absent when the nonce's name is a socket/device (type: other)", async () => {
    const { backend, runtime, sandbox } = await healthyContainer();
    sandbox.seedEntry("/tmp/.nadi-generation", "other");
    expect(await readGeneration(backend, runtime)).toEqual({ kind: "unreadable" });
  });

  // Pins the OTHER half of the "other" widening: that `listDirectory` itself
  // actually emits `type: "other"` for such an entry, rather than coercing it
  // to `"file"` (which the test above would not catch — a coerced `"file"`
  // still lands on a `readFile` throw -> `unreadable`, so that test stays
  // green for the wrong reason without this assertion).
  it('listDirectory emits type: "other" for a socket/device entry, uncoerced', async () => {
    const { backend, runtime, sandbox } = await healthyContainer();
    sandbox.seedEntry("/tmp/.nadi-generation", "other");
    const entries = await backend.listDirectory(runtime, "/tmp");
    expect(entries).toContainEqual({ name: ".nadi-generation", type: "other" });
  });
});
