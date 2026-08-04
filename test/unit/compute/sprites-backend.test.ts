import { describe, expect, it } from "vitest";
import type { BackendReference, ComputeSpec } from "../../../src/compute/backend";
import { SPRITES_PROFILE_MEMORY_MB } from "../../../src/compute/backends/sprites";
import { DEFAULT_COMPUTE_LIMITS } from "../../../src/compute/config";
import { ComputeError } from "../../../src/compute/errors";
import { createFakeSpritesBackend } from "./helpers/fake-sprites-client";

const SPEC: ComputeSpec = {
  environmentId: "sprites-test",
  profile: "small",
  workspaceRoot: "/workspace",
  env: { SPRITES_TEST: "true" },
  maxProcessRuntimeMs: 1_000,
  allowedHosts: null,
};

function spriteNameOf(reference: BackendReference): string {
  return (reference.payload as { spriteName: string }).spriteName;
}

function processReference(spriteName: string, processId: string): BackendReference {
  return { provider: "sprites", version: 1, payload: { kind: "process", spriteName, processId } };
}

describe("SpritesComputeBackend.acquire", () => {
  it("posts the memory policy, then the network policy, then creates the workspace root", async () => {
    const { backend, client } = createFakeSpritesBackend();

    const runtime = await backend.acquire({
      ...SPEC,
      profile: "medium",
      allowedHosts: ["github.com", "*.npmjs.org"],
    });
    const spriteName = spriteNameOf(runtime);

    // The ORDER is the assertion: the network policy must be in place before
    // anything runs, and the mkdir is the first thing that runs.
    expect(client.calls).toEqual([
      `createSprite:${spriteName}`,
      `setMemoryPolicy:${spriteName}`,
      `setNetworkPolicy:${spriteName}`,
      "execCollect:bash -c mkdir -p -- /workspace",
    ]);
    expect(client.memoryPolicies).toEqual([
      { name: spriteName, limitMb: SPRITES_PROFILE_MEMORY_MB.medium },
    ]);
    // Allow rules first, then the catch-all deny that makes them a whitelist.
    expect(client.networkPolicies).toEqual([
      {
        name: spriteName,
        rules: [
          { domain: "github.com", action: "allow" },
          { domain: "*.npmjs.org", action: "allow" },
          { domain: "*", action: "deny" },
        ],
      },
    ]);
  });

  it("posts NO network policy when allowedHosts is null", async () => {
    const { backend, client } = createFakeSpritesBackend();

    await backend.acquire({ ...SPEC, allowedHosts: null });

    expect(client.networkPolicies).toEqual([]);
    expect(client.calls.some((call) => call.startsWith("setNetworkPolicy"))).toBe(false);
  });

  it("posts NO network policy for an empty allowedHosts list", async () => {
    // An empty list is not "deny everything": a bare `{domain:"*",action:"deny"}`
    // would cut the sandbox off entirely, which is not what null-vs-empty means
    // anywhere else in the compute layer.
    const { backend, client } = createFakeSpritesBackend();

    await backend.acquire({ ...SPEC, allowedHosts: [] });

    expect(client.networkPolicies).toEqual([]);
  });

  it("deletes the sprite when setup fails after create — sprites never auto-destroy", async () => {
    const { backend, client } = createFakeSpritesBackend();
    // The workspace-root exec is the last setup step; failing it models any
    // post-create failure.
    client.failNextExec = new ComputeError("provider_transient", "sprites_exec_socket_error");

    await expect(backend.acquire(SPEC)).rejects.toMatchObject({ code: "provider_transient" });

    // THE property: no sprite is left behind billing.
    expect(client.liveSprites()).toEqual([]);
    expect(client.calls.filter((call) => call.startsWith("deleteSprite"))).toHaveLength(1);
  });

  it("fails the acquire when mkdir /workspace exits non-zero, and still deletes", async () => {
    // An IN-BAND failure: the exec completes and reports a non-zero exit. A
    // backend that only handles the throwing shape would return a runtime whose
    // workspace root does not exist — and leak the sprite.
    const { backend, client } = createFakeSpritesBackend();
    client.nextExecResult = { exitCode: 1, stdout: "", stderr: "mkdir: permission denied" };

    await expect(backend.acquire(SPEC)).rejects.toMatchObject({
      code: "provider_transient",
      message: expect.stringContaining("sprites_workspace_root_failed") as unknown as string,
    });
    expect(client.liveSprites()).toEqual([]);
  });

  it("propagates a create failure without attempting a delete", async () => {
    // Nothing exists to clean up, and a speculative DELETE against a name the
    // provider may have rejected is not a cleanup — it is a second failure.
    const { backend, client } = createFakeSpritesBackend();
    client.failNextCreate = new ComputeError("quota_exhausted", "sprites_create_failed: 429");

    await expect(backend.acquire(SPEC)).rejects.toMatchObject({ code: "quota_exhausted" });

    expect(client.calls.some((call) => call.startsWith("deleteSprite"))).toBe(false);
  });

  it("recovers into the same sprite without creating one, and re-applies setup", async () => {
    const { backend, client } = createFakeSpritesBackend();
    const runtime = await backend.acquire(SPEC);
    const spriteName = spriteNameOf(runtime);
    const recovery = await backend.release(runtime, { disposition: "recoverable" });
    const before = client.calls.length;

    const restored = await backend.acquire(SPEC, recovery!);

    expect(spriteNameOf(restored)).toBe(spriteName);
    // A hibernated sprite already exists — creating one would strand the old.
    expect(client.calls.slice(before)).toEqual([
      `setMemoryPolicy:${spriteName}`,
      "execCollect:bash -c mkdir -p -- /workspace",
    ]);
  });

  it("rejects a recovery reference that is not a recovery payload", async () => {
    const { backend } = createFakeSpritesBackend();
    const runtime = await backend.acquire(SPEC);

    await expect(backend.acquire(SPEC, runtime)).rejects.toMatchObject({
      code: "recovery_failed",
      message: "sprites_recovery_reference_invalid",
    });
    await expect(
      backend.acquire(SPEC, { provider: "daytona", version: 1, payload: { kind: "recovery" } }),
    ).rejects.toMatchObject({ code: "recovery_failed" });
  });
});

describe("SpritesComputeBackend.release / destroy", () => {
  it("makes NO provider call for a recoverable release", async () => {
    const { backend, client } = createFakeSpritesBackend();
    const runtime = await backend.acquire(SPEC);
    const before = [...client.calls];

    const recovery = await backend.release(runtime, {
      disposition: "recoverable",
      recoveryTtlMs: 86_400_000,
    });

    expect(recovery).toEqual({
      provider: "sprites",
      version: 1,
      payload: { kind: "recovery", spriteName: spriteNameOf(runtime) },
    });
    // Hibernation is automatic; there is nothing to ask the provider for.
    expect(client.calls).toEqual(before);
    expect(client.liveSprites()).toEqual([spriteNameOf(runtime)]);
  });

  it("destroys a recovery reference — the only thing that stops storage billing", async () => {
    const { backend, client } = createFakeSpritesBackend();
    const runtime = await backend.acquire(SPEC);
    const recovery = await backend.release(runtime, { disposition: "recoverable" });

    await backend.destroy(recovery!);

    expect(client.liveSprites()).toEqual([]);
  });

  it("rejects a process reference passed to destroy", async () => {
    const { backend, client } = createFakeSpritesBackend();
    const runtime = await backend.acquire(SPEC);

    await expect(
      backend.destroy(processReference(spriteNameOf(runtime), "pid-1")),
    ).rejects.toMatchObject({ code: "runtime_missing" });
    // And nothing was deleted on the way to that rejection.
    expect(client.liveSprites()).toEqual([spriteNameOf(runtime)]);
  });
});

describe("SpritesComputeBackend process lifecycle", () => {
  it("reports failed when the session is gone and no rc file exists", async () => {
    const { backend } = createFakeSpritesBackend();
    const runtime = await backend.acquire(SPEC);

    // Never started: no session, no rc. The process vanished without recording
    // an exit — the one case where inventing an exit code would be a lie.
    expect(
      await backend.getProcessStatus(runtime, processReference(spriteNameOf(runtime), "pid-gone")),
    ).toEqual({ status: "failed" });
  });

  it("reports running while a session's command carries the process id", async () => {
    const { backend, client } = createFakeSpritesBackend();
    const runtime = await backend.acquire(SPEC);
    const spriteName = spriteNameOf(runtime);
    client.seedSession(spriteName, "sess-live", "timeout 60 bash -c 'sleep 30' > /tmp/x-pid-live");

    expect(
      await backend.getProcessStatus(runtime, processReference(spriteName, "pid-live")),
    ).toEqual({ status: "running" });
  });

  it("prefers the rc file over the session list — an exit may only move forward", async () => {
    const { backend, client } = createFakeSpritesBackend();
    const runtime = await backend.acquire(SPEC);
    const spriteName = spriteNameOf(runtime);
    client.seedSession(spriteName, "sess-stale", "bash -c ... pid-both ...");
    client.seedFile(spriteName, "/tmp/.nadi-rc-pid-both", "3");

    expect(
      await backend.getProcessStatus(runtime, processReference(spriteName, "pid-both")),
    ).toEqual({ status: "exited", exitCode: 3 });
  });

  it("ignores an unparsable rc file rather than inventing an exit", async () => {
    const { backend, client } = createFakeSpritesBackend();
    const runtime = await backend.acquire(SPEC);
    const spriteName = spriteNameOf(runtime);
    client.seedSession(spriteName, "sess-partial", "bash -c ... pid-partial ...");
    // A partial write of the sentinel: not a number, so not an answer.
    client.seedFile(spriteName, "/tmp/.nadi-rc-pid-partial", "");

    expect(
      await backend.getProcessStatus(runtime, processReference(spriteName, "pid-partial")),
    ).toEqual({ status: "running" });
  });

  it("rejects a process reference minted for a different sprite", async () => {
    const { backend } = createFakeSpritesBackend();
    const runtime = await backend.acquire(SPEC);

    await expect(
      backend.getProcessStatus(runtime, processReference("nadi-someone-else", "pid-1")),
    ).rejects.toMatchObject({ code: "process_missing" });
  });

  it("maps the three stop modes to the three signals", async () => {
    const { backend, client } = createFakeSpritesBackend();
    const runtime = await backend.acquire(SPEC);
    const spriteName = spriteNameOf(runtime);
    for (const [index, mode] of (["interrupt", "terminate", "kill"] as const).entries()) {
      client.seedSession(spriteName, `sess-${index}`, `bash -c ... pid-${index} ...`);
      expect(
        await backend.stopProcess(runtime, processReference(spriteName, `pid-${index}`), mode),
      ).toEqual({ status: "stopped" });
    }

    expect(client.killCalls.map((call) => call.signal)).toEqual(["SIGINT", "SIGTERM", "SIGKILL"]);
    expect(client.killCalls.map((call) => call.sessionId)).toEqual(["sess-0", "sess-1", "sess-2"]);
  });

  it("is a no-op when the process already exited (no matching session)", async () => {
    const { backend, client } = createFakeSpritesBackend();
    const runtime = await backend.acquire(SPEC);

    expect(
      await backend.stopProcess(
        runtime,
        processReference(spriteNameOf(runtime), "pid-gone"),
        "terminate",
      ),
    ).toEqual({ status: "stopped" });
    expect(client.killCalls).toEqual([]);
  });

  // The kill/exit race. `listSessions` answered for this sprite a moment ago, so
  // a 404 from `killSession` can only mean the SESSION went away — it exited on
  // its own. The client cannot make that call (every sprite-scoped 404 looks the
  // same to it, and a genuinely missing sprite must keep reporting
  // `runtime_missing`), so the disambiguation lives in the backend.
  it("treats a kill that races the exit as already stopped", async () => {
    const { backend, client } = createFakeSpritesBackend();
    const runtime = await backend.acquire(SPEC);
    const spriteName = spriteNameOf(runtime);
    client.seedSession(spriteName, "sess-racy", "bash -c ... pid-racy ...");
    // The session disappears between the list and the kill, so `killSession`
    // 404s on a sprite that is demonstrably alive.
    client.dropSessionsOnNextList = true;

    expect(
      await backend.stopProcess(runtime, processReference(spriteName, "pid-racy"), "kill"),
    ).toEqual({ status: "stopped" });
    expect(client.killCalls).toHaveLength(1);
  });

  it("still surfaces runtime_missing when the sprite itself is gone", async () => {
    const { backend } = createFakeSpritesBackend();
    const runtime = await backend.acquire(SPEC);
    await backend.release(runtime, { disposition: "discard" });

    await expect(
      backend.stopProcess(runtime, processReference(spriteNameOf(runtime), "pid-1"), "kill"),
    ).rejects.toMatchObject({ code: "runtime_missing" });
  });

  it("runs a background command end to end: running, then stopped and terminal", async () => {
    const { backend } = createFakeSpritesBackend();
    const runtime = await backend.acquire(SPEC);

    const started = await backend.startProcess(runtime, {
      command: "sleep 30",
      timeoutMs: 30_000,
    });

    expect(started.status).toBe("running");
    expect(await backend.getProcessStatus(runtime, started.process)).toEqual({ status: "running" });

    await backend.stopProcess(runtime, started.process, "kill");

    // Deliberately loose about WHICH terminal status. A SIGKILL to the wrapper's
    // process group means the killed `bash` never reaches its trailing
    // `printf %s "$?"`, so the realistic aftermath is no rc file and no session
    // -> `failed`. But a signal that reaches only the inner command can leave
    // bash alive to record an rc, giving `exited`. The backend handles both; the
    // property that matters — and the only one this fake can honestly witness —
    // is that the process is no longer reported as running.
    const status = await backend.getProcessStatus(runtime, started.process);
    expect(status.status).not.toBe("running");
    expect(["failed", "exited"]).toContain(status.status);
    // What THIS fake models is the kill-leaves-no-evidence path.
    expect(status).toEqual({ status: "failed" });
  });

  it("feeds stdin through a sentinel file", async () => {
    const { backend, client } = createFakeSpritesBackend();
    const runtime = await backend.acquire(SPEC);

    const started = await backend.startProcess(runtime, {
      command: "cat",
      stdin: "piped-in",
      timeoutMs: 1_000,
    });

    expect(started).toMatchObject({ status: "exited", exitCode: 0, stdout: "piped-in" });
    expect(client.calls.some((call) => call.startsWith("fsWrite:/tmp/.nadi-in-"))).toBe(true);
  });

  it("reports a non-zero exit from a completed process", async () => {
    const { backend } = createFakeSpritesBackend();
    const runtime = await backend.acquire(SPEC);

    const started = await backend.startProcess(runtime, {
      command: "sh -c 'exit 7'",
      timeoutMs: 1_000,
    });

    expect(started).toMatchObject({ status: "exited", exitCode: 7 });
  });
});

describe("SpritesComputeBackend.runCommand", () => {
  it("reports the command's own exit code as an exit, not a compute failure", async () => {
    const { backend } = createFakeSpritesBackend();
    const runtime = await backend.acquire(SPEC);

    expect(await backend.runCommand(runtime, { command: "echo hi", timeoutMs: 1_000 })).toEqual({
      status: "exited",
      exitCode: 0,
      stdout: "hi\n",
      stderr: "",
    });
  });

  it("runs in the requested cwd, defaulting to the workspace root", async () => {
    // `dir` is what the command actually runs in; dropping it would silently run
    // every command from the sprite's home directory instead.
    const { backend, client } = createFakeSpritesBackend();
    const runtime = await backend.acquire(SPEC);

    await backend.runCommand(runtime, {
      command: "true",
      cwd: "/workspace/repo",
      timeoutMs: 1_000,
    });
    await backend.runCommand(runtime, { command: "true", timeoutMs: 1_000 });

    expect(client.calls.filter((call) => call.includes("bash -c true"))).toEqual([
      "execCollect:bash -c true @/workspace/repo",
      "execCollect:bash -c true @/workspace",
    ]);
  });

  it("lets a provider fault throw rather than fabricating an exit code", async () => {
    const { backend, client } = createFakeSpritesBackend();
    const runtime = await backend.acquire(SPEC);
    client.failNextExec = new ComputeError("provider_transient", "sprites_exec_timeout");

    await expect(
      backend.runCommand(runtime, { command: "echo hi", timeoutMs: 1_000 }),
    ).rejects.toMatchObject({ code: "provider_transient" });
  });
});

describe("SpritesComputeBackend file operations", () => {
  it("reads a file whose size is exactly maxBytes", async () => {
    // The boundary the contract's oversize case cannot pin: `>` vs `>=` both
    // reject an oversized read, but only `>` lets an exact-fit read through.
    const { backend, client } = createFakeSpritesBackend();
    const runtime = await backend.acquire(SPEC);
    client.seedFile(spriteNameOf(runtime), "/workspace/exact.txt", "0123456789");

    const result = await backend.readFile(runtime, "/workspace/exact.txt", 10);

    expect(new TextDecoder().decode(result.bytes)).toBe("0123456789");
    await expect(backend.readFile(runtime, "/workspace/exact.txt", 9)).rejects.toMatchObject({
      code: "compute_file_too_large",
    });
  });

  it("throws rather than returning null for a missing readFile target", async () => {
    const { backend } = createFakeSpritesBackend();
    const runtime = await backend.acquire(SPEC);

    await expect(backend.readFile(runtime, "/workspace/absent.txt", 1_024)).rejects.toMatchObject({
      code: "provider_transient",
      message: "sprites_read_missing: /workspace/absent.txt",
    });
  });

  it("refuses an overwrite:false write onto an existing path, leaving the bytes intact", async () => {
    const { backend, client } = createFakeSpritesBackend();
    const runtime = await backend.acquire(SPEC);
    const spriteName = spriteNameOf(runtime);
    client.seedFile(spriteName, "/workspace/keep.txt", "ORIGINAL");

    await expect(
      backend.writeFile(
        runtime,
        "/workspace/keep.txt",
        new TextEncoder().encode("CLOBBER").buffer as ArrayBuffer,
        { createParents: false, overwrite: false },
      ),
    ).rejects.toMatchObject({ code: "provider_transient" });
    expect(client.readText(spriteName, "/workspace/keep.txt")).toBe("ORIGINAL");
  });

  it("reports a stat that neither answered nor said 'no such file' as unanswerable", async () => {
    // `pathExists` decides writes; a provider hiccup must NOT read as "absent".
    const { backend, client } = createFakeSpritesBackend();
    const runtime = await backend.acquire(SPEC);
    client.failNextExec = new ComputeError("provider_transient", "sprites_exec_socket_error");

    await expect(backend.pathExists(runtime, "/workspace/keep.txt")).rejects.toMatchObject({
      code: "provider_transient",
    });
  });

  it("inspects a directory and reports symlinks as symlinks", async () => {
    const { backend, client } = createFakeSpritesBackend();
    const runtime = await backend.acquire(SPEC);
    await backend.createDirectory(runtime, "/workspace/sub");

    expect(await backend.inspectPath(runtime, "/workspace/sub")).toEqual({
      type: "directory",
      size: 4096,
      resolvedPath: "/workspace/sub",
    });
    // `stat` without `-L` reports the LINK itself, so unlike Daytona this arm is
    // reachable in production.
    client.seedSymlink(spriteNameOf(runtime), "/workspace/link", 11);
    expect(await backend.inspectPath(runtime, "/workspace/link")).toEqual({
      type: "symlink",
      size: 11,
      resolvedPath: "/workspace/link",
    });
  });

  it("propagates a failed listing rather than reporting an empty directory", async () => {
    // `readGeneration` reads an answered listing as positive evidence that a
    // workspace was wiped, so `[]` from a failed list would fault healthy work.
    const { backend, client } = createFakeSpritesBackend();
    const runtime = await backend.acquire(SPEC);
    client.failNextFsList = new ComputeError("provider_transient", "sprites_fs_list_failed: 500");

    await expect(backend.listDirectory(runtime, "/workspace")).rejects.toMatchObject({
      code: "provider_transient",
    });
  });

  // `statPath` is the whole of `pathExists`, so each arm that could WRONGLY
  // answer "absent" has to be pinned separately. `No such file` in stderr is the
  // ONLY evidence of absence; every other non-zero outcome is unanswerable.
  it("throws — never answers absent — when a non-zero stat carries no stderr", async () => {
    const { backend, client } = createFakeSpritesBackend();
    const runtime = await backend.acquire(SPEC);
    client.nextExecResult = { exitCode: 1, stdout: "", stderr: "" };

    await expect(backend.pathExists(runtime, "/workspace/keep.txt")).rejects.toMatchObject({
      code: "provider_transient",
      message: expect.stringContaining("sprites_stat_unanswered") as unknown as string,
    });
  });

  it("throws when stat exits 0 with output it cannot parse", async () => {
    // A zero exit is not an answer on its own — a proxy or a busybox `stat` with
    // different flags could return 0 and prose. Reading that as a file would
    // report a directory (or a nonexistent path) as a writable file.
    const { backend, client } = createFakeSpritesBackend();
    const runtime = await backend.acquire(SPEC);
    client.nextExecResult = { exitCode: 0, stdout: "usage: stat [-L] file", stderr: "" };

    await expect(backend.inspectPath(runtime, "/workspace/keep.txt")).rejects.toMatchObject({
      code: "provider_transient",
      message: expect.stringContaining("sprites_stat_unanswered") as unknown as string,
    });
  });

  it("caps process output at the per-stream budget instead of returning it whole", async () => {
    const { backend, client } = createFakeSpritesBackend();
    const runtime = await backend.acquire(SPEC);
    const spriteName = spriteNameOf(runtime);
    const limit = DEFAULT_COMPUTE_LIMITS.maxProcessOutputBytes;
    client.seedFile(spriteName, "/tmp/.nadi-out-pid-big", "a".repeat(limit + 1_000));

    const output = await backend.readProcessOutput(
      runtime,
      processReference(spriteName, "pid-big"),
    );

    expect(output.stdout).toHaveLength(limit);
    expect(output.stderr).toBe("");
  });

  it("deletes recursively and answers absent afterwards", async () => {
    const { backend, client } = createFakeSpritesBackend();
    const runtime = await backend.acquire(SPEC);
    const spriteName = spriteNameOf(runtime);
    client.seedFile(spriteName, "/workspace/tree/nested/leaf.txt", "x");

    await backend.deletePath(runtime, "/workspace/tree");

    expect(await backend.pathExists(runtime, "/workspace/tree")).toBe(false);
    expect(await backend.pathExists(runtime, "/workspace/tree/nested/leaf.txt")).toBe(false);
  });
});
