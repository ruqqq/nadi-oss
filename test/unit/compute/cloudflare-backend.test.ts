import { describe, expect, it } from "vitest";
import type { BackendReference, ComputeSpec } from "../../../src/compute/backend";
import { deriveSandboxId } from "../../../src/compute/backends/cloudflare";
import {
  createFakeCloudflareBackend,
  type FakeCloudflareEnvironment,
} from "./helpers/fake-cloudflare-client";

const BASE_SPEC: ComputeSpec = {
  environmentId: "workspace-1_thread-1",
  profile: "medium",
  workspaceRoot: "/workspace",
  env: { NADI_ENV: "1" },
  maxProcessRuntimeMs: 1_000,
  allowedHosts: null,
};

function spec(overrides: Partial<ComputeSpec> = {}): ComputeSpec {
  return { ...BASE_SPEC, ...overrides };
}

function bytes(value: string): ArrayBuffer {
  return new TextEncoder().encode(value).buffer;
}

function text(value: ArrayBuffer): string {
  return new TextDecoder().decode(value);
}

function sandboxIdOf(reference: BackendReference): string {
  const payload = reference.payload as { sandboxId: string };
  return payload.sandboxId;
}

describe("CloudflareComputeBackend.acquire", () => {
  it("selects the profile binding, derives a stable id, and keeps the container alive", async () => {
    const { backend, factory, env } = createFakeCloudflareBackend();

    await backend.acquire(spec({ profile: "medium", environmentId: "workspace-1_thread-1" }));

    expect(factory.calls[0]).toMatchObject({
      binding: env.NADI_SANDBOX_MEDIUM,
      id: deriveSandboxId("workspace-1", "thread-1"),
      options: { enableDefaultSession: false, keepAlive: true },
    });
  });

  it("selects the small binding for the small profile", async () => {
    const { backend, factory, env } = createFakeCloudflareBackend();

    await backend.acquire(spec({ profile: "small" }));

    expect(factory.calls[0]?.binding).toBe(env.NADI_SANDBOX_SMALL);
  });

  it("applies the environment to the sandbox", async () => {
    const { backend, factory } = createFakeCloudflareBackend();

    await backend.acquire(spec({ env: { A: "1", B: "2" } }));

    const sandbox = factory.peek(deriveSandboxId("workspace-1", "thread-1"));
    expect(sandbox?.lastEnv).toEqual({ A: "1", B: "2" });
  });

  it("rejects a non-empty host allowlist WITHOUT creating any container", async () => {
    const { backend, factory } = createFakeCloudflareBackend();

    await expect(
      backend.acquire(spec({ allowedHosts: ["github.com", "registry.npmjs.org"] })),
    ).rejects.toMatchObject({ code: "policy_rejected" });

    // Fail-closed must leak nothing: no sandbox was ever resolved.
    expect(factory.calls).toHaveLength(0);
  });

  it("treats an empty allowlist as unrestricted (does not reject)", async () => {
    const { backend } = createFakeCloudflareBackend();
    await expect(backend.acquire(spec({ allowedHosts: [] }))).resolves.toBeDefined();
  });

  it("throws compute_unavailable when the profile binding is absent", async () => {
    const { factory } = createFakeCloudflareBackend();
    const { CloudflareComputeBackend } = await import("../../../src/compute/backends/cloudflare");
    const backend = new CloudflareComputeBackend({
      factory,
      bindings: {},
      workspaceId: "workspace-1",
      threadId: "thread-1",
    });

    await expect(backend.acquire(spec())).rejects.toMatchObject({ code: "compute_unavailable" });
  });
});

describe("CloudflareComputeBackend sandbox identity", () => {
  it("derives the id from (workspace, thread), not from spec.environmentId", async () => {
    // The sandbox id names a Durable Object instance, so it must be unique per
    // thread. Both backends pass the SAME environmentId; if identity came from
    // environmentId they would collapse onto one shared container.
    const a = createFakeCloudflareBackend({ workspaceId: "ws-1", threadId: "thread-a" });
    const b = createFakeCloudflareBackend({ workspaceId: "ws-1", threadId: "thread-b" });

    const refA = await a.backend.acquire(spec({ environmentId: "cloudflare:small" }));
    const refB = await b.backend.acquire(spec({ environmentId: "cloudflare:small" }));

    expect(sandboxIdOf(refA)).toBe(deriveSandboxId("ws-1", "thread-a"));
    expect(sandboxIdOf(refB)).toBe(deriveSandboxId("ws-1", "thread-b"));
    expect(sandboxIdOf(refA)).not.toBe(sandboxIdOf(refB));

    // Stable across repeated acquires for the same pair (environmentId varies).
    const refAAgain = await a.backend.acquire(spec({ environmentId: "something-else" }));
    expect(sandboxIdOf(refAAgain)).toBe(sandboxIdOf(refA));
  });

  it("throws compute_unavailable when the thread identity is missing", async () => {
    const { factory, bindings } = createFakeCloudflareBackend();
    const { CloudflareComputeBackend } = await import("../../../src/compute/backends/cloudflare");
    const backend = new CloudflareComputeBackend({
      factory,
      bindings,
      workspaceId: "ws-1",
      threadId: "",
    });

    await expect(backend.acquire(spec())).rejects.toMatchObject({ code: "compute_unavailable" });
    // Fail closed before any container is resolved.
    expect(factory.calls).toHaveLength(0);
  });
});

describe("CloudflareComputeBackend observability labels", () => {
  it("labels the container with workspace and thread for cost attribution", async () => {
    const { backend, factory } = createFakeCloudflareBackend({
      workspaceId: "ws1",
      threadId: "thr1",
    });
    await backend.acquire(spec());
    expect(factory.lastOptions?.labels).toEqual({ workspaceId: "ws1", threadId: "thr1" });
  });
});

describe("CloudflareComputeBackend discard divergence", () => {
  it("reaches a FRESH empty sandbox after discard instead of reporting runtime_missing", async () => {
    // REAL PROVIDER DIVERGENCE (to be confirmed by the Task 7 live smoke run):
    // getSandbox(id) on a destroyed Durable Object id does not report it gone —
    // it recreates an empty container behind the same id. So an op on the stale
    // runtime reference reaches an empty workspace rather than throwing.
    const { backend } = createFakeCloudflareBackend();
    const runtime = await backend.acquire(spec());
    await backend.writeFile(runtime, "/workspace/keep.txt", bytes("data"), {
      createParents: false,
      overwrite: false,
    });

    await backend.release(runtime, { disposition: "discard" });

    // The previously written file is gone, and inspecting it returns null rather
    // than throwing runtime_missing — the divergence the shared contract skips.
    expect(await backend.inspectPath(runtime, "/workspace/keep.txt")).toBeNull();
  });
});

describe("CloudflareComputeBackend reference payloads", () => {
  it("persists runtime and process references as plain JSON", async () => {
    const { backend } = createFakeCloudflareBackend();
    const runtime = await backend.acquire(spec());
    const started = await backend.startProcess(runtime, { command: "echo hi", timeoutMs: 1_000 });

    // A JSON round-trip catches an SDK object or a Process instance sneaking into
    // a persisted payload — the deep-equal only holds for plain data.
    expect(JSON.parse(JSON.stringify(runtime))).toEqual(runtime);
    expect(JSON.parse(JSON.stringify(started.process))).toEqual(started.process);
  });
});

describe("CloudflareComputeBackend.readFile mime passthrough", () => {
  it("surfaces a provider mime type and leaves it undefined when absent", async () => {
    const { backend, factory } = createFakeCloudflareBackend();
    const runtime = await backend.acquire(spec());
    const sandbox = factory.peek(deriveSandboxId("workspace-1", "thread-1"))!;
    sandbox.seedFile("/workspace/withmime.bin", new Uint8Array([1, 2, 3]), "application/pdf");
    sandbox.seedFile("/workspace/plain.bin", new Uint8Array([4, 5, 6]));

    expect((await backend.readFile(runtime, "/workspace/withmime.bin", 1_024)).mimeType).toBe(
      "application/pdf",
    );
    expect(
      (await backend.readFile(runtime, "/workspace/plain.bin", 1_024)).mimeType,
    ).toBeUndefined();
  });
});

describe("CloudflareComputeBackend processes", () => {
  async function acquired(): Promise<{
    env: FakeCloudflareEnvironment;
    runtime: BackendReference;
  }> {
    const environment = createFakeCloudflareBackend();
    const runtime = await environment.backend.acquire(spec());
    return { env: environment, runtime };
  }

  it("cross-checks the process reference against the runtime", async () => {
    const { env, runtime } = await acquired();
    const otherRuntime = await createFakeCloudflareBackend({
      threadId: "thread-9",
    }).backend.acquire(spec());
    const started = await env.backend.startProcess(runtime, {
      command: "echo hi",
      timeoutMs: 1_000,
    });

    await expect(env.backend.getProcessStatus(otherRuntime, started.process)).rejects.toMatchObject(
      { code: "process_missing" },
    );
  });

  // Live 2026-07-10: a command that finished inside the ~10s foreground window
  // hung the agent's turn. The SDK auto-deletes a process record on exit
  // (ProcessOptions.autoCleanup defaults true), so the next poll got null and
  // getProcessStatus threw process_missing instead of reporting the exit. The
  // backend must start processes with autoCleanup:false so status and output
  // survive until we read them.
  it("keeps a completed process readable (autoCleanup disabled)", async () => {
    const { env, runtime } = await acquired();
    const started = await env.backend.startProcess(runtime, {
      command: "echo done",
      timeoutMs: 1_000,
    });

    const status = await env.backend.getProcessStatus(runtime, started.process);
    expect(status.status).toBe("exited");
    const output = await env.backend.readProcessOutput(runtime, started.process);
    expect(output.stdout).toBe("done\n");
  });

  it("stops a process with a kill signal", async () => {
    const { env, runtime } = await acquired();
    const started = await env.backend.startProcess(runtime, {
      command: "sleep 100",
      timeoutMs: 10_000,
    });
    expect(started.status).toBe("running");

    const stopped = await env.backend.stopProcess(runtime, started.process, "kill");
    expect(stopped.status).toBe("stopped");
  });

  it("streams accumulated output to the sink", async () => {
    const { env, runtime } = await acquired();
    const started = await env.backend.startProcess(runtime, {
      command: "echo streamed",
      timeoutMs: 1_000,
    });

    const chunks: string[] = [];
    await env.backend.streamProcessOutput(runtime, started.process, {
      stdout: (chunk) => void chunks.push(chunk),
      stderr: () => {},
    });
    expect(chunks.join("")).toBe("streamed\n");
  });
});

describe("CloudflareComputeBackend completion callback wrapping", () => {
  async function acquired(): Promise<{
    env: FakeCloudflareEnvironment;
    runtime: BackendReference;
  }> {
    const environment = createFakeCloudflareBackend();
    const runtime = await environment.backend.acquire(spec());
    return { env: environment, runtime };
  }

  it("declares that it consumes the completion callback", () => {
    const { backend } = createFakeCloudflareBackend();
    expect(backend.consumesCompletionCallback).toBe(true);
  });

  it("declares that the callback DELAYS its only completion signal", () => {
    // `waitForProcessExit` settles on the log stream closing — the wrapper
    // exiting — and the callback runs inside that wrapper. Dropping this
    // declaration silently restores the generous 25s curl bound, which lands
    // inside `exec()`'s 10s foreground window.
    const { backend } = createFakeCloudflareBackend();
    expect(backend.completionCallbackDelaysCompletion).toBe(true);
  });

  it("wraps the command so the callback runs after it, preserving the command's exit code", async () => {
    const { env, runtime } = await acquired();
    const sandbox = env.factory.peek(deriveSandboxId("workspace-1", "thread-1"))!;

    await env.backend.startProcess(runtime, {
      command: "make build",
      timeoutMs: 600_000,
      completionCallback: "curl -sf -m 25 -X POST https://app/api/compute/completion",
    });

    const sent = sandbox.calls.at(-1)!;
    expect(sent).toContain("make build");
    // The callback must not pollute captured output, and the command's status must win.
    expect(sent).toMatch(/__nadi_rc=/);
    expect(sent).toMatch(/curl .*>\/dev\/null 2>&1/);
    expect(sent.indexOf("make build")).toBeLessThan(sent.indexOf("curl"));
    expect(sent.trimEnd()).toMatch(/exit "?\$__nadi_rc"?$/);
  });

  it("passes the command through untouched when there is no callback", async () => {
    const { env, runtime } = await acquired();
    const sandbox = env.factory.peek(deriveSandboxId("workspace-1", "thread-1"))!;

    await env.backend.startProcess(runtime, { command: "make build", timeoutMs: 600_000 });

    expect(sandbox.calls.at(-1)).toBe("start:make build");
  });

  it("gives the SDK's own timeout extra room beyond the wrapped command's budget", async () => {
    const { env, runtime } = await acquired();
    const sandbox = env.factory.peek(deriveSandboxId("workspace-1", "thread-1"))!;

    await env.backend.startProcess(runtime, {
      command: "make build",
      timeoutMs: 600_000,
      completionCallback: "curl -sf -m 25 -X POST https://app/api/compute/completion",
    });

    expect(sandbox.lastStartOptions?.timeoutMs).toBeGreaterThan(600_000);
  });

  it("does not add timeout margin when there is no callback", async () => {
    const { env, runtime } = await acquired();
    const sandbox = env.factory.peek(deriveSandboxId("workspace-1", "thread-1"))!;

    await env.backend.startProcess(runtime, { command: "make build", timeoutMs: 600_000 });

    expect(sandbox.lastStartOptions?.timeoutMs).toBe(600_000);
  });

  // Pins the composition order: `withStdin` must run BEFORE the callback
  // wrap, so the stdin pipe ends up INSIDE the quoted `bash -c` argument
  // (feeding the command) rather than outside it (feeding the wrapper as a
  // whole, which would starve the command and hand stdin to the callback
  // instead). Both this and the inner `timeout` (asserted elsewhere via the
  // timeout-margin tests) currently pass even if inverted without this
  // assertion.
  it("keeps the stdin pipe inside the quoted bash -c argument, not outside the wrapper", async () => {
    const { env, runtime } = await acquired();
    const sandbox = env.factory.peek(deriveSandboxId("workspace-1", "thread-1"))!;

    await env.backend.startProcess(runtime, {
      command: "make build",
      stdin: "hello stdin",
      timeoutMs: 600_000,
      completionCallback: "curl -sf -m 25 -X POST https://app/api/compute/completion",
    });

    const sent = sandbox.calls.at(-1)!;
    const bashCIndex = sent.indexOf("bash -c");
    const base64Index = sent.indexOf("base64 -d");
    const rcCaptureIndex = sent.indexOf("__nadi_rc=");
    expect(bashCIndex).toBeGreaterThan(-1);
    expect(base64Index).toBeGreaterThan(bashCIndex);
    expect(rcCaptureIndex).toBeGreaterThan(base64Index);
  });

  // Pins the wrapper's own-output redirect to a GROUP around the whole
  // fragment, not a bare suffix — a suffix would only silence the fragment's
  // last segment if it were ever a pipeline or an `a && b` chain.
  it("redirects the callback fragment as a group so a multi-part fragment is fully silenced", async () => {
    const { env, runtime } = await acquired();
    const sandbox = env.factory.peek(deriveSandboxId("workspace-1", "thread-1"))!;

    await env.backend.startProcess(runtime, {
      command: "make build",
      timeoutMs: 600_000,
      completionCallback: "echo one && echo two",
    });

    const sent = sandbox.calls.at(-1)!;
    expect(sent).toContain("{ echo one && echo two ; } >/dev/null 2>&1");
  });
});

describe("CloudflareComputeBackend.inspectPath", () => {
  it("returns null for a missing path without throwing", async () => {
    const { backend } = createFakeCloudflareBackend();
    const runtime = await backend.acquire(spec());
    expect(await backend.inspectPath(runtime, "/workspace/nope.txt")).toBeNull();
  });

  // Found live on 2026-07-10: the container server's `listFiles` omits dot-prefixed
  // entries unless `includeHidden` is passed. `inspectPath` derives metadata from
  // the parent listing, so every hidden path reported as missing -- and
  // `assertPathContained` walks EVERY path component through `inspectPath`, so any
  // path under `.git/` was unreachable. The old fake listed hidden entries
  // unconditionally, so no unit test could see it.
  it("sees dot-prefixed files and directories (listFiles must pass includeHidden)", async () => {
    const { backend, factory } = createFakeCloudflareBackend();
    const runtime = await backend.acquire(spec());
    const sandbox = factory.peek(deriveSandboxId("workspace-1", "thread-1"));
    sandbox?.seedEntry("/workspace/.git", "directory");
    sandbox?.seedFile("/workspace/.gitignore", new TextEncoder().encode("node_modules\n"));

    expect(await backend.inspectPath(runtime, "/workspace/.git")).toMatchObject({
      type: "directory",
    });
    expect(await backend.inspectPath(runtime, "/workspace/.gitignore")).toMatchObject({
      type: "file",
    });
  });

  it("maps a special ('other') entry to a rejection, never to a file", async () => {
    const { backend, factory } = createFakeCloudflareBackend();
    const runtime = await backend.acquire(spec());
    factory.peek(deriveSandboxId("workspace-1", "thread-1"))?.seedEntry("/workspace/sock", "other");

    await expect(backend.inspectPath(runtime, "/workspace/sock")).rejects.toMatchObject({
      code: "compute_invalid_path",
    });
  });

  // The SDK can fail IN BAND: `{ success: false, files: [] }` with no throw.
  // `listDirectory` MUST NOT report a directory it could not list as an empty
  // listing — `readGeneration` reads an empty /tmp as a wipe.
  it("throws when listFiles reports success: false instead of answering []", async () => {
    const { backend, factory } = createFakeCloudflareBackend();
    const runtime = await backend.acquire(spec());
    factory.peek(deriveSandboxId("workspace-1", "thread-1"))?.seedListFailure("/workspace");

    await expect(backend.listDirectory(runtime, "/workspace")).rejects.toMatchObject({
      code: "provider_transient",
    });
  });

  // Scope guard: `inspectPath` deliberately does NOT consult `success`. It
  // already answers `null` for an unlistable parent, and its many call sites
  // depend on that. Pinning it so the `listDirectory` fix cannot drift into it.
  it("leaves inspectPath's success:false behavior unchanged (null, not a throw)", async () => {
    const { backend, factory } = createFakeCloudflareBackend();
    const runtime = await backend.acquire(spec());
    factory.peek(deriveSandboxId("workspace-1", "thread-1"))?.seedListFailure("/workspace");

    expect(await backend.inspectPath(runtime, "/workspace/anything.txt")).toBeNull();
  });

  // The SDK can also succeed while answering for the WRONG directory (a
  // route/proxy mixup). `success: true` alone is not evidence the listing is
  // OF `/workspace` — only the SDK's own `path` echo proves that. Without this
  // check, a listing of `/` would be silently accepted as `/workspace`'s
  // listing, and a missing nonce would read as a wipe.
  it("throws when listFiles answers for a different path than requested", async () => {
    const { backend, factory } = createFakeCloudflareBackend();
    const runtime = await backend.acquire(spec());
    factory
      .peek(deriveSandboxId("workspace-1", "thread-1"))
      ?.seedListPathMismatch("/workspace", "/");

    await expect(backend.listDirectory(runtime, "/workspace")).rejects.toMatchObject({
      code: "provider_transient",
    });
  });

  // A trailing slash is the one benign spelling difference: both sides are
  // always absolute paths from internal callers, so this is not a loophole —
  // it just keeps a correct listing from misfiring on cosmetic SDK spelling.
  it("does not misfire the path check on a trailing-slash echo", async () => {
    const { backend, factory } = createFakeCloudflareBackend();
    const runtime = await backend.acquire(spec());
    factory
      .peek(deriveSandboxId("workspace-1", "thread-1"))
      ?.seedListPathMismatch("/workspace", "/workspace/");

    await expect(backend.listDirectory(runtime, "/workspace")).resolves.toEqual([]);
  });

  // Scope guard: `inspectPath` never inspects `path` at all (it doesn't route
  // through `listDirectory`), so a path-mismatched listing must not affect it.
  it("leaves inspectPath unaffected by a listFiles path mismatch", async () => {
    const { backend, factory } = createFakeCloudflareBackend();
    const runtime = await backend.acquire(spec());
    factory
      .peek(deriveSandboxId("workspace-1", "thread-1"))
      ?.seedListPathMismatch("/workspace", "/");

    expect(await backend.inspectPath(runtime, "/workspace/anything.txt")).toBeNull();
  });

  it("reports a symlink entry as a symlink", async () => {
    const { backend, factory } = createFakeCloudflareBackend();
    const runtime = await backend.acquire(spec());
    factory
      .peek(deriveSandboxId("workspace-1", "thread-1"))
      ?.seedEntry("/workspace/link", "symlink");

    expect(await backend.inspectPath(runtime, "/workspace/link")).toMatchObject({
      type: "symlink",
    });
  });
});

describe("CloudflareComputeBackend.movePath", () => {
  // The container server's overwrite behavior for /api/move is UNVERIFIED on
  // this machine (no Docker). These tests pin the delete-then-move CALL SEQUENCE
  // the backend performs; they do NOT prove the server actually overwrites.
  it("deletes the destination before moving when overwriting", async () => {
    const { backend, factory } = createFakeCloudflareBackend();
    const runtime = await backend.acquire(spec());
    await backend.writeFile(runtime, "/workspace/dest.txt", bytes("old"), {
      createParents: false,
      overwrite: false,
    });
    await backend.writeFile(runtime, "/workspace/tmp.txt", bytes("new"), {
      createParents: false,
      overwrite: false,
    });
    const sandbox = factory.peek(deriveSandboxId("workspace-1", "thread-1"))!;
    sandbox.calls.length = 0;

    await backend.movePath(runtime, "/workspace/tmp.txt", "/workspace/dest.txt", true);

    expect(sandbox.calls).toEqual([
      "delete:/workspace/dest.txt",
      "move:/workspace/tmp.txt->/workspace/dest.txt",
    ]);
  });

  it("raises when the overwrite delete reports success:false, and does NOT move", async () => {
    // A non-throwing { success: false } delete leaves the destination in place;
    // moving anyway is the unverified-overwrite hole the pre-delete exists to close.
    const { backend, factory } = createFakeCloudflareBackend();
    const runtime = await backend.acquire(spec());
    await backend.writeFile(runtime, "/workspace/dest.txt", bytes("old"), {
      createParents: false,
      overwrite: false,
    });
    await backend.writeFile(runtime, "/workspace/tmp.txt", bytes("new"), {
      createParents: false,
      overwrite: false,
    });
    const sandbox = factory.peek(deriveSandboxId("workspace-1", "thread-1"))!;
    sandbox.nextDeleteUnsuccessful = true;
    sandbox.calls.length = 0;

    await expect(
      backend.movePath(runtime, "/workspace/tmp.txt", "/workspace/dest.txt", true),
    ).rejects.toMatchObject({ code: "provider_transient" });
    // The move must never run after a failed delete.
    expect(sandbox.calls.some((call) => call.startsWith("move:"))).toBe(false);
  });

  it("rejects overwrite:false onto an existing destination without moving", async () => {
    const { backend, factory } = createFakeCloudflareBackend();
    const runtime = await backend.acquire(spec());
    await backend.writeFile(runtime, "/workspace/dest.txt", bytes("old"), {
      createParents: false,
      overwrite: false,
    });
    const sandbox = factory.peek(deriveSandboxId("workspace-1", "thread-1"))!;
    sandbox.calls.length = 0;

    await expect(
      backend.movePath(runtime, "/workspace/tmp.txt", "/workspace/dest.txt", false),
    ).rejects.toMatchObject({ code: "provider_transient" });
    expect(sandbox.calls.some((call) => call.startsWith("move:"))).toBe(false);
  });

  // The SDK can report failure IN BAND: `{ success: false, exists: false }` with
  // no throw. Answering `false` there tells movePath the destination is free —
  // for overwrite:false that skips the "already exists" guard entirely and lets
  // the move run straight over a real file, exactly the clobber this backend
  // exists to prevent.
  it("refuses an overwrite:false move whose destination exists probe failed in band", async () => {
    const { backend, factory } = createFakeCloudflareBackend();
    const runtime = await backend.acquire(spec());
    await backend.writeFile(runtime, "/workspace/dest.txt", bytes("old"), {
      createParents: false,
      overwrite: false,
    });
    await backend.writeFile(runtime, "/workspace/tmp.txt", bytes("new"), {
      createParents: false,
      overwrite: false,
    });
    const sandbox = factory.peek(deriveSandboxId("workspace-1", "thread-1"))!;
    sandbox.seedExistsFailure("/workspace/dest.txt");
    sandbox.calls.length = 0;

    await expect(
      backend.movePath(runtime, "/workspace/tmp.txt", "/workspace/dest.txt", false),
    ).rejects.toMatchObject({ code: "provider_transient" });
    expect(sandbox.calls.some((call) => call.startsWith("move:"))).toBe(false);

    // The property that matters is not the throw — it is the bytes surviving:
    // the destination keeps its original content and the source was never moved.
    const { bytes: destAfter } = await backend.readFile(runtime, "/workspace/dest.txt", 1_000);
    expect(text(destAfter)).toBe("old");
    const { bytes: srcAfter } = await backend.readFile(runtime, "/workspace/tmp.txt", 1_000);
    expect(text(srcAfter)).toBe("new");
  });

  // The third `existsProbe` caller. A mismatched echo means the probe answered
  // about a different path, so `exists:false` here would skip the "destination
  // exists" guard and move straight over a real file.
  it("refuses an overwrite:false move whose destination exists probe echoed a different path", async () => {
    const { backend, factory } = createFakeCloudflareBackend();
    const runtime = await backend.acquire(spec());
    await backend.writeFile(runtime, "/workspace/dest.txt", bytes("old"), {
      createParents: false,
      overwrite: false,
    });
    await backend.writeFile(runtime, "/workspace/tmp.txt", bytes("new"), {
      createParents: false,
      overwrite: false,
    });
    const sandbox = factory.peek(deriveSandboxId("workspace-1", "thread-1"))!;
    sandbox.seedExistsPathMismatch("/workspace/dest.txt", "/something/else");
    sandbox.calls.length = 0;

    const error = await backend
      .movePath(runtime, "/workspace/tmp.txt", "/workspace/dest.txt", false)
      .then(
        () => null,
        (caught: unknown) => caught,
      );
    expect(error).toMatchObject({ code: "provider_transient" });
    expect((error as Error).message).toBe("cloudflare_exists_path_mismatch");
    expect(sandbox.calls.some((call) => call.startsWith("move:"))).toBe(false);

    const { bytes: destAfter } = await backend.readFile(runtime, "/workspace/dest.txt", 1_000);
    expect(text(destAfter)).toBe("old");
  });

  // The third caller of the `exists`-field guard. A response that omits `exists`
  // clears `success` AND the echo check, then yields `undefined` — falsy — so an
  // unvalidated probe reports the destination free and the move runs over it.
  it("refuses an overwrite:false move whose exists probe omitted `exists`", async () => {
    const { backend, factory } = createFakeCloudflareBackend();
    const runtime = await backend.acquire(spec());
    await backend.writeFile(runtime, "/workspace/dest.txt", bytes("old"), {
      createParents: false,
      overwrite: false,
    });
    await backend.writeFile(runtime, "/workspace/tmp.txt", bytes("new"), {
      createParents: false,
      overwrite: false,
    });
    const sandbox = factory.peek(deriveSandboxId("workspace-1", "thread-1"))!;
    sandbox.seedExistsOmitsExists("/workspace/dest.txt");
    sandbox.calls.length = 0;

    const error = await backend
      .movePath(runtime, "/workspace/tmp.txt", "/workspace/dest.txt", false)
      .then(
        () => null,
        (caught: unknown) => caught,
      );
    expect(error).toMatchObject({ name: "ComputeError", code: "provider_transient" });
    expect((error as Error).message).toBe("cloudflare_exists_missing");
    expect(sandbox.calls.some((call) => call.startsWith("move:"))).toBe(false);

    // The property that matters is the bytes surviving, not the throw.
    const { bytes: destAfter } = await backend.readFile(runtime, "/workspace/dest.txt", 1_000);
    expect(text(destAfter)).toBe("old");
    const { bytes: srcAfter } = await backend.readFile(runtime, "/workspace/tmp.txt", 1_000);
    expect(text(srcAfter)).toBe("new");
  });
});

describe("CloudflareComputeBackend.release", () => {
  it("discards by destroying the container", async () => {
    const { backend, factory } = createFakeCloudflareBackend();
    const runtime = await backend.acquire(spec());

    await expect(backend.release(runtime, { disposition: "discard" })).resolves.toBeNull();
    expect(factory.peek(deriveSandboxId("workspace-1", "thread-1"))?.destroyed).toBe(true);
  });

  it("backs up BEFORE destroying on a recoverable release", async () => {
    const { backend, factory } = createFakeCloudflareBackend();
    const runtime = await backend.acquire(spec());
    const sandbox = factory.peek(deriveSandboxId("workspace-1", "thread-1"))!;

    const recovery = await backend.release(runtime, {
      disposition: "recoverable",
      recoveryTtlMs: 86_400_000,
    });

    // Ordering IS the safety property: the container is destroyed only AFTER the
    // backup resolves. (A fake proves the call ORDER, not real durability.)
    expect(sandbox.events).toEqual(["createBackup:/workspace", "destroy"]);
    expect(recovery?.payload).toMatchObject({ kind: "backup" });
  });

  it("does NOT destroy the container when the backup fails, and throws provider_transient", async () => {
    const { backend, factory } = createFakeCloudflareBackend();
    const runtime = await backend.acquire(spec());
    const sandbox = factory.peek(deriveSandboxId("workspace-1", "thread-1"))!;
    sandbox.failNextBackup = new Error("R2 unavailable");

    await expect(
      backend.release(runtime, { disposition: "recoverable", recoveryTtlMs: 86_400_000 }),
    ).rejects.toMatchObject({ code: "provider_transient" });

    // The single most important assertion: a failed backup must never destroy the
    // container, or the workspace is unrecoverable.
    expect(sandbox.destroyed).toBe(false);
    expect(sandbox.events).toEqual(["createBackup:/workspace"]);
  });

  it("passes the useLocalBucket flag through to createBackup", async () => {
    const local = createFakeCloudflareBackend({ useLocalBucket: true });
    const runtime = await local.backend.acquire(spec());
    const recovery = await local.backend.release(runtime, {
      disposition: "recoverable",
      recoveryTtlMs: 86_400_000,
    });
    const backupId = (recovery!.payload as { backup: { id: string } }).backup.id;
    expect(local.factory.backups.get(backupId)).toBeDefined();
  });

  it("converts the ms TTL to seconds for the provider and computes expiresAt from the injected clock", async () => {
    const NOW = 1_700_000_000_000;
    const { backend, factory } = createFakeCloudflareBackend({ now: () => NOW });
    const runtime = await backend.acquire(spec());

    const recovery = await backend.release(runtime, {
      disposition: "recoverable",
      recoveryTtlMs: 2 * 60 * 60 * 1_000, // 2 hours, inside the 1–168h bound
    });

    // The PROVIDER-FACING ttl is in SECONDS: 2h → 7200. Asserting this (not only
    // expiresAt) is what catches feeding milliseconds straight to createBackup —
    // that would expire backups ~1000× too soon while expiresAt still looked right.
    const sandbox = factory.peek(deriveSandboxId("workspace-1", "thread-1"))!;
    expect(sandbox.lastBackupTtl).toBe(7_200);
    // expiresAt = now + ttl (2h) — our own bookkeeping, not a provider field.
    expect((recovery!.payload as { expiresAt: number }).expiresAt).toBe(NOW + 2 * 60 * 60 * 1_000);
  });

  it("clamps an above-policy TTL down to the 168h bound", async () => {
    const NOW = 1_700_000_000_000;
    const { backend, factory } = createFakeCloudflareBackend({ now: () => NOW });
    const runtime = await backend.acquire(spec());

    // A 1000-hour request must clamp to 168h, not expire ~1000× early or run forever.
    const recovery = await backend.release(runtime, {
      disposition: "recoverable",
      recoveryTtlMs: 1_000 * 60 * 60 * 1_000,
    });
    expect(factory.peek(deriveSandboxId("workspace-1", "thread-1"))!.lastBackupTtl).toBe(
      168 * 60 * 60,
    );
    expect((recovery!.payload as { expiresAt: number }).expiresAt).toBe(
      NOW + 168 * 60 * 60 * 1_000,
    );
  });

  it("clamps a below-policy TTL up to the 1h bound", async () => {
    const NOW = 1_700_000_000_000;
    const { backend, factory } = createFakeCloudflareBackend({ now: () => NOW });
    const runtime = await backend.acquire(spec());

    // A 30-minute request is below Nadi's 1h floor and must clamp UP to 1h (3600s),
    // not pass through as a sub-policy lifetime.
    const recovery = await backend.release(runtime, {
      disposition: "recoverable",
      recoveryTtlMs: 30 * 60 * 1_000,
    });
    expect(factory.peek(deriveSandboxId("workspace-1", "thread-1"))!.lastBackupTtl).toBe(3_600);
    expect((recovery!.payload as { expiresAt: number }).expiresAt).toBe(NOW + 60 * 60 * 1_000);
  });

  it("persists the recovery reference as plain JSON", async () => {
    const { backend } = createFakeCloudflareBackend();
    const runtime = await backend.acquire(spec());
    const recovery = await backend.release(runtime, {
      disposition: "recoverable",
      recoveryTtlMs: 86_400_000,
    });
    // A persisted reference must survive a JSON round-trip with no SDK object.
    expect(JSON.parse(JSON.stringify(recovery))).toEqual(recovery);
  });
});

describe("CloudflareComputeBackend recovery acquire", () => {
  async function released(now = () => 1_700_000_000_000) {
    const environment = createFakeCloudflareBackend({ now });
    const runtime = await environment.backend.acquire(spec({ env: { OLD: "1" } }));
    await environment.backend.writeFile(runtime, "/workspace/keep.txt", bytes("preserved"), {
      createParents: false,
      overwrite: false,
    });
    const recovery = await environment.backend.release(runtime, {
      disposition: "recoverable",
      recoveryTtlMs: 86_400_000,
    });
    return { environment, recovery: recovery! };
  }

  it("restores the backup, reapplies the CURRENT env, and re-enables keep-alive", async () => {
    const { environment, recovery } = await released();

    // Reacquire with a DIFFERENT env than the one captured at release time.
    const restored = await environment.backend.acquire(spec({ env: { FRESH: "2" } }), recovery);

    expect(
      text((await environment.backend.readFile(restored, "/workspace/keep.txt", 1_024)).bytes),
    ).toBe("preserved");
    const sandbox = environment.factory.peek(deriveSandboxId("workspace-1", "thread-1"))!;
    // Env comes from the CURRENT spec, never from the recovery reference.
    expect(sandbox.lastEnv).toEqual({ FRESH: "2" });
    expect(sandbox.keepAlive).toBe(true);
  });

  it("derives the target sandbox id from (workspace, thread), not the reference", async () => {
    const { environment, recovery } = await released();
    const restored = await environment.backend.acquire(spec(), recovery);
    expect(sandboxIdOf(restored)).toBe(deriveSandboxId("workspace-1", "thread-1"));
  });

  it("fail-closes a recovering acquire with a host allowlist BEFORE any container", async () => {
    const { environment, recovery } = await released();
    const callsBefore = environment.factory.calls.length;

    await expect(
      environment.backend.acquire(spec({ allowedHosts: ["github.com"] }), recovery),
    ).rejects.toMatchObject({ code: "policy_rejected" });
    // No new container resolved on the rejected recovery path.
    expect(environment.factory.calls.length).toBe(callsBefore);
  });

  it("keeps the recovery reference reusable when restore fails, then a retry succeeds", async () => {
    const { environment, recovery } = await released();
    const snapshot = JSON.parse(JSON.stringify(recovery));
    environment.factory.failNextRestore(new Error("R2 restore boom"));

    await expect(environment.backend.acquire(spec(), recovery)).rejects.toMatchObject({
      code: "recovery_failed",
    });
    // The reference must NOT be mutated or invalidated by a failed restore.
    expect(recovery).toEqual(snapshot);

    // A retry with the same reference succeeds — the backup was never destroyed.
    const restored = await environment.backend.acquire(spec(), recovery);
    expect(
      text((await environment.backend.readFile(restored, "/workspace/keep.txt", 1_024)).bytes),
    ).toBe("preserved");
  });

  it("rejects a non-throwing unsuccessful restore BEFORE reapplying env or keep-alive, and stays reusable", async () => {
    // The silent-data-loss hazard: the container resolves restoreBackup with
    // { success: false } WITHOUT throwing. If the backend proceeded, markActive
    // would discard this recovery reference over an empty workspace and the backup
    // would be GC'd at TTL — permanent, silent loss.
    const { environment, recovery } = await released();
    const snapshot = JSON.parse(JSON.stringify(recovery));
    environment.factory.failNextRestoreSuccess();

    await expect(
      environment.backend.acquire(spec({ env: { FRESH: "2" } }), recovery),
    ).rejects.toMatchObject({ code: "recovery_failed" });

    const sandbox = environment.factory.peek(deriveSandboxId("workspace-1", "thread-1"))!;
    // Neither env nor keep-alive may be touched on a failed restore.
    expect(sandbox.lastEnv).toBeUndefined();
    expect(sandbox.setKeepAliveCalls).toBe(0);
    // The reference must NOT be mutated or invalidated.
    expect(recovery).toEqual(snapshot);

    // A retry with the SAME reference succeeds — the backup was never consumed.
    const restored = await environment.backend.acquire(spec({ env: { FRESH: "2" } }), recovery);
    expect(
      text((await environment.backend.readFile(restored, "/workspace/keep.txt", 1_024)).bytes),
    ).toBe("preserved");
  });

  it("round-trips localBucket:true through the reference into the restore call", async () => {
    // localBucket selects the SDK's restore path; dropping it restores a local-dev
    // backup over the production presigned/FUSE path and fails permanently.
    const environment = createFakeCloudflareBackend({ useLocalBucket: true });
    const runtime = await environment.backend.acquire(spec({ env: { OLD: "1" } }));
    await environment.backend.writeFile(runtime, "/workspace/keep.txt", bytes("preserved"), {
      createParents: false,
      overwrite: false,
    });
    const recovery = await environment.backend.release(runtime, {
      disposition: "recoverable",
      recoveryTtlMs: 86_400_000,
    });

    // The flag is persisted on the reference...
    expect((recovery!.payload as { backup: { localBucket?: boolean } }).backup.localBucket).toBe(
      true,
    );

    await environment.backend.acquire(spec({ env: { FRESH: "2" } }), recovery!);
    // ...and replayed into the restore call.
    const sandbox = environment.factory.peek(deriveSandboxId("workspace-1", "thread-1"))!;
    expect(sandbox.lastRestoreBackup?.localBucket).toBe(true);
  });

  it("rejects a malformed recovery reference with recovery_failed", async () => {
    const { backend } = createFakeCloudflareBackend();
    const malformed: BackendReference = {
      provider: "cloudflare",
      version: 1,
      payload: {
        kind: "backup",
        backup: { id: "", dir: "/workspace" },
        profile: "small",
        expiresAt: 1,
      },
    };
    await expect(backend.acquire(spec(), malformed)).rejects.toMatchObject({
      code: "recovery_failed",
    });
  });
});

describe("CloudflareComputeBackend reference validation", () => {
  it("rejects a foreign-provider runtime reference", async () => {
    const { backend } = createFakeCloudflareBackend();
    const foreign: BackendReference = {
      provider: "daytona",
      version: 1,
      payload: { kind: "runtime", sandboxId: "x", profile: "small" },
    };
    await expect(backend.readFile(foreign, "/workspace/x", 10)).rejects.toMatchObject({
      code: "runtime_missing",
    });
  });
});

describe("CloudflareComputeBackend.pathExists", () => {
  it("answers true for a present file and false for an absent one", async () => {
    const { backend, factory } = createFakeCloudflareBackend();
    const runtime = await backend.acquire(spec());
    const sandbox = factory.peek(sandboxIdOf(runtime))!;
    sandbox.seedFile("/workspace/there.txt", new TextEncoder().encode("x"));

    expect(await backend.pathExists(runtime, "/workspace/there.txt")).toBe(true);
    expect(await backend.pathExists(runtime, "/workspace/absent.txt")).toBe(false);
  });

  // The SDK can report failure IN BAND: `{ success: false, exists: false }`
  // with no throw. Answering `false` there tells apply_patch the destination
  // is free, and it overwrites whatever is really on disk.
  it("throws — never answers false — when the SDK reports failure in band", async () => {
    const { backend, factory } = createFakeCloudflareBackend();
    const runtime = await backend.acquire(spec());
    const sandbox = factory.peek(sandboxIdOf(runtime))!;
    sandbox.seedFile("/workspace/there.txt", new TextEncoder().encode("x"));
    sandbox.seedExistsFailure("/workspace/there.txt");

    await expect(backend.pathExists(runtime, "/workspace/there.txt")).rejects.toMatchObject({
      code: "provider_transient",
    });
  });

  // `success: true` does not prove the answer is about the path we asked for.
  // A route/proxy mixup that answers for a DIFFERENT path lands here as
  // `exists: false` — "proven absent" — and apply_patch's `add` guard reads
  // that as permission to write; commit() then moves with overwrite:true.
  it("throws — never answers false — when the SDK echoes a different path", async () => {
    const { backend, factory } = createFakeCloudflareBackend();
    const runtime = await backend.acquire(spec());
    const sandbox = factory.peek(sandboxIdOf(runtime))!;
    sandbox.seedFile("/workspace/there.txt", new TextEncoder().encode("x"));
    // The mixup answers for a path that genuinely does not exist, so a backend
    // that ignored the echo would report `exists: false` for a real file.
    sandbox.seedExistsPathMismatch("/workspace/absent.txt", "/something/else");

    const error = await backend.pathExists(runtime, "/workspace/absent.txt").then(
      () => null,
      (caught: unknown) => caught,
    );
    expect(error).toMatchObject({ code: "provider_transient" });
    expect((error as Error).message).toBe("cloudflare_exists_path_mismatch");
  });

  // The echo check's own failure mode: `result.path` is typed `string`, but the
  // typings are compile-time and the container's JSON is what arrives. An
  // omitted echo used to reach `stripTrailingSlash(undefined)` and surface as a
  // raw `TypeError` — outside the ComputeError taxonomy, so callers that map
  // provider failures by `code` would not recognise it.
  it("reports an exists response that omits `path` as a ComputeError, not a TypeError", async () => {
    const { backend, factory } = createFakeCloudflareBackend();
    const runtime = await backend.acquire(spec());
    const sandbox = factory.peek(sandboxIdOf(runtime))!;
    sandbox.seedFile("/workspace/there.txt", new TextEncoder().encode("x"));
    sandbox.seedExistsOmitsPath("/workspace/there.txt");

    const error = await backend.pathExists(runtime, "/workspace/there.txt").then(
      () => null,
      (caught: unknown) => caught,
    );
    expect(error).toMatchObject({ name: "ComputeError", code: "provider_transient" });
    expect((error as Error).message).toBe("cloudflare_exists_path_missing");
  });

  // The field that DECIDES the write, under the same runtime-shape reasoning as
  // the echo guard beside it. `exists` is typed `boolean`, but a response shaped
  // `{ success: true, path: "<matching>" }` that omits it yields `undefined` —
  // falsy — so an unvalidated `return result.exists` reports a REAL file as
  // proven absent, which every caller reads as permission to overwrite.
  it("throws — never answers false — when the SDK omits `exists` from a healthy response", async () => {
    const { backend, factory } = createFakeCloudflareBackend();
    const runtime = await backend.acquire(spec());
    const sandbox = factory.peek(sandboxIdOf(runtime))!;
    sandbox.seedFile("/workspace/real.txt", new TextEncoder().encode("PRECIOUS"));
    sandbox.seedExistsOmitsExists("/workspace/real.txt");

    const error = await backend.pathExists(runtime, "/workspace/real.txt").then(
      (value) => value,
      (caught: unknown) => caught,
    );
    expect(error).toMatchObject({ name: "ComputeError", code: "provider_transient" });
    expect((error as Error).message).toBe("cloudflare_exists_missing");
  });

  // The reviewer's clobber reproduction, end to end: seed PRECIOUS, omit
  // `exists`, and assert the bytes survive. A throw assertion alone would pass
  // against implementations that throw AFTER writing.
  it("refuses a writeFile(overwrite:false) whose exists probe omitted `exists`, and the bytes survive", async () => {
    const { backend, factory } = createFakeCloudflareBackend();
    const runtime = await backend.acquire(spec());
    const sandbox = factory.peek(sandboxIdOf(runtime))!;
    sandbox.seedFile("/workspace/real.txt", new TextEncoder().encode("PRECIOUS"));
    sandbox.seedExistsOmitsExists("/workspace/real.txt");

    const error = await backend
      .writeFile(runtime, "/workspace/real.txt", bytes("CLOBBERED"), {
        createParents: false,
        overwrite: false,
      })
      .then(
        () => null,
        (caught: unknown) => caught,
      );
    expect(error).toMatchObject({ name: "ComputeError", code: "provider_transient" });
    expect((error as Error).message).toBe("cloudflare_exists_missing");

    const { bytes: after } = await backend.readFile(runtime, "/workspace/real.txt", 1_000);
    expect(text(after)).toBe("PRECIOUS");
  });

  // A narrower guard (`result.exists === undefined`) would still reject
  // omission but let a PRESENT, wrong-typed, falsy `exists` through unchecked —
  // `null` is falsy, same as `undefined`, so it would report a REAL file as
  // proven absent and permit the overwrite. This is the guard rail against that
  // narrowing: `typeof result.exists !== "boolean"` rejects it regardless.
  it("refuses a writeFile(overwrite:false) whose exists probe returned a wrong-typed (null) exists, and the bytes survive", async () => {
    const { backend, factory } = createFakeCloudflareBackend();
    const runtime = await backend.acquire(spec());
    const sandbox = factory.peek(sandboxIdOf(runtime))!;
    sandbox.seedFile("/workspace/real.txt", new TextEncoder().encode("PRECIOUS"));
    sandbox.seedExistsWrongType("/workspace/real.txt", null);

    const error = await backend
      .writeFile(runtime, "/workspace/real.txt", bytes("CLOBBERED"), {
        createParents: false,
        overwrite: false,
      })
      .then(
        () => null,
        (caught: unknown) => caught,
      );
    expect(error).toMatchObject({ name: "ComputeError", code: "provider_transient" });
    expect((error as Error).message).toBe("cloudflare_exists_missing");

    const { bytes: after } = await backend.readFile(runtime, "/workspace/real.txt", 1_000);
    expect(text(after)).toBe("PRECIOUS");
  });

  // Contract alignment with its two immediate neighbours: `inspectPath` and
  // `listDirectory` both map a dead container to runtime_missing.
  it("maps a dead container to runtime_missing, like inspectPath and listDirectory", async () => {
    const { backend, factory } = createFakeCloudflareBackend();
    const runtime = await backend.acquire(spec());
    const sandbox = factory.peek(sandboxIdOf(runtime))!;
    // Drive the SDK-level signal directly: the fake FACTORY re-creates a fresh
    // container for a destroyed id (modelling real `getSandbox`), so flipping
    // `destroyed` alone would never surface SandboxNotFound to the backend.
    sandbox.exists = () =>
      Promise.reject(Object.assign(new Error("gone"), { name: "SandboxNotFound" }));

    const error = await backend.pathExists(runtime, "/workspace/there.txt").then(
      () => null,
      (caught: unknown) => caught,
    );
    expect(error).toMatchObject({ code: "runtime_missing" });
    expect((error as Error).message).toBe("cloudflare_runtime_not_found");
  });

  it("refuses a writeFile(overwrite:false) whose exists probe failed in band", async () => {
    const { backend, factory } = createFakeCloudflareBackend();
    const runtime = await backend.acquire(spec());
    const sandbox = factory.peek(sandboxIdOf(runtime))!;
    sandbox.seedFile("/workspace/there.txt", new TextEncoder().encode("original"));
    sandbox.seedExistsFailure("/workspace/there.txt");

    await expect(
      backend.writeFile(runtime, "/workspace/there.txt", bytes("replacement"), {
        createParents: false,
        overwrite: false,
      }),
    ).rejects.toMatchObject({ code: "provider_transient" });

    // The property that matters is not the throw — it is the bytes surviving.
    const { bytes: after } = await backend.readFile(runtime, "/workspace/there.txt", 1_000);
    expect(text(after)).toBe("original");
  });

  // The echo check lives in `existsProbe`, which has THREE callers. Only
  // `pathExists` pinned it, so deleting the throw killed exactly one test while
  // leaving the two paths that actually write unguarded. A mixed-up echo means
  // the `exists:false` is about some OTHER path, so trusting it here overwrites
  // a real file.
  it("refuses a writeFile(overwrite:false) whose exists probe echoed a different path", async () => {
    const { backend, factory } = createFakeCloudflareBackend();
    const runtime = await backend.acquire(spec());
    const sandbox = factory.peek(sandboxIdOf(runtime))!;
    sandbox.seedFile("/workspace/there.txt", new TextEncoder().encode("original"));
    sandbox.seedExistsPathMismatch("/workspace/there.txt", "/something/else");

    const error = await backend
      .writeFile(runtime, "/workspace/there.txt", bytes("replacement"), {
        createParents: false,
        overwrite: false,
      })
      .then(
        () => null,
        (caught: unknown) => caught,
      );
    expect(error).toMatchObject({ code: "provider_transient" });
    expect((error as Error).message).toBe("cloudflare_exists_path_mismatch");

    const { bytes: after } = await backend.readFile(runtime, "/workspace/there.txt", 1_000);
    expect(text(after)).toBe("original");
  });
});

/**
 * The SDK rejects any sandbox id longer than 63 characters (a DNS-label limit,
 * `sanitizeSandboxId` in @cloudflare/sandbox). Every other test in this file
 * uses short synthetic ids like `ws-1`/`thread-a`, so none of them can see an
 * overflow — which is exactly how a 20-character overrun reached production:
 * real ids are `ws_<uuid>` (39) and `thr_<uuid>` (40), and the old derivation
 * added its own `ws_` prefix on top for a total of 83.
 *
 * These fixtures are therefore deliberately REALISTIC, not convenient.
 */
describe("deriveSandboxId length (the SDK's 63-char limit)", () => {
  const SDK_MAX = 63;
  const realWorkspaceId = `ws_${crypto.randomUUID()}`;
  const realThreadId = `thr_${crypto.randomUUID()}`;

  it("fits within the SDK limit for real uuid-shaped ids", () => {
    const id = deriveSandboxId(realWorkspaceId, realThreadId);
    expect(id.length).toBeLessThanOrEqual(SDK_MAX);
  });

  it("fits for the longest plausible ids, not just one sample", () => {
    // A workspace name is user-supplied in some deployments; length must not
    // depend on the caller's input at all.
    const id = deriveSandboxId("w".repeat(200), "t".repeat(200));
    expect(id.length).toBeLessThanOrEqual(SDK_MAX);
  });

  it("stays within the SDK's other id rules", () => {
    const id = deriveSandboxId(realWorkspaceId, realThreadId);
    expect(id).toMatch(/^[A-Za-z0-9_-]+$/);
    expect(id.startsWith("-")).toBe(false);
    expect(id.endsWith("-")).toBe(false);
    const reserved = ["www", "api", "admin", "root", "system", "cloudflare", "workers"];
    expect(reserved).not.toContain(id.toLowerCase());
  });

  it("is deterministic for the same pair and distinct across threads", () => {
    const again = deriveSandboxId(realWorkspaceId, realThreadId);
    expect(deriveSandboxId(realWorkspaceId, realThreadId)).toBe(again);

    const other = deriveSandboxId(realWorkspaceId, `thr_${crypto.randomUUID()}`);
    expect(other).not.toBe(again);
  });

  // Uniqueness must come from the FULL pair, never from the readable fragments.
  // Two threads sharing an id would share one filesystem and processes.
  it("distinguishes ids that share their readable prefixes", () => {
    const ws = "ws_aaaaaaaa-1111-2222-3333-444444444444";
    const t1 = "thr_bbbbbbbb-1111-2222-3333-444444444444";
    const t2 = "thr_bbbbbbbb-9999-8888-7777-666666666666"; // same first 8 chars
    expect(deriveSandboxId(ws, t1)).not.toBe(deriveSandboxId(ws, t2));

    const ws2 = "ws_aaaaaaaa-9999-8888-7777-666666666666"; // same first 8 chars
    expect(deriveSandboxId(ws, t1)).not.toBe(deriveSandboxId(ws2, t1));
  });

  // The others assert PROPERTIES, so this one pins the shape itself — otherwise
  // the format could drift silently and orphan every existing container.
  it("has the documented shape and a fixed length", () => {
    const id = deriveSandboxId(
      "ws_abc12345-dead-beef-cafe-000000000000",
      "thr_xyz98765-dead-beef-cafe-111111111111",
    );
    expect(id).toBe("ws_ws_abc12_thr_xyz9_069d4a6c8b7cbcaafc42bb0f");
    expect(id).toMatch(/^ws_[A-Za-z0-9_-]{1,8}_[A-Za-z0-9_-]{1,8}_[0-9a-f]{24}$/);
    // BOUNDED, not fixed: short inputs yield short fragments. The bound is the
    // property that matters — an id whose length tracks its inputs is what
    // broke production.
    expect(id.length).toBe(45);
    expect(deriveSandboxId("a".repeat(999), "b".repeat(999)).length).toBe(45);
    expect(deriveSandboxId("a", "b").length).toBeLessThanOrEqual(45);
  });

  it("separates the workspace and thread components", () => {
    // `(a, bc)` and `(ab, c)` must not collapse to the same id.
    expect(deriveSandboxId("ab", "c")).not.toBe(deriveSandboxId("a", "bc"));
  });
});
