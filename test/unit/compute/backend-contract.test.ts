import { describe, expect, it } from "vitest";
import "../../../src/compute/backend";
import { ComputeError } from "../../../src/compute/errors";
import type { BackendReference, ComputeBackend, ComputeSpec } from "../../../src/compute/backend";
import {
  DaytonaComputeBackend,
  isNotFoundError,
  isSymlinkMode,
} from "../../../src/compute/backends/daytona";
import { FakeComputeBackend } from "../../../src/compute/backends/fake";
import { createFakeCloudflareBackend } from "./helpers/fake-cloudflare-client";
import { createFakeSpritesBackend } from "./helpers/fake-sprites-client";

const TEST_SPEC: ComputeSpec = {
  environmentId: "contract-test",
  profile: "small",
  workspaceRoot: "/workspace",
  env: { CONTRACT_TEST: "true" },
  maxProcessRuntimeMs: 1_000,
  allowedHosts: null,
};

function bytes(value: string): ArrayBuffer {
  return new TextEncoder().encode(value).buffer;
}

function text(value: ArrayBuffer): string {
  return new TextDecoder().decode(value);
}

export interface ContractOptions {
  /**
   * Whether the backend supports recoverable release + restore. Off for the
   * Cloudflare backend until Task 3 wires R2-backed recovery; the recoverable
   * case is skipped (not deleted) so it re-activates when Task 3 lands.
   */
  recoverableRelease?: boolean;
  /**
   * Whether an op on a discarded runtime reports `runtime_missing`. True for
   * Daytona and the Fake (a destroyed sandbox is gone). FALSE for Cloudflare:
   * real `getSandbox(id)` silently recreates a fresh empty container on a
   * destroyed id, so the op reaches an empty workspace instead of throwing. The
   * divergent Cloudflare behavior is asserted directly in that suite's own test.
   */
  reportsMissingRuntimeAfterDiscard?: boolean;
}

export function computeBackendContract(
  name: string,
  make: () => ComputeBackend,
  options: ContractOptions = {},
) {
  const { recoverableRelease = true, reportsMissingRuntimeAfterDiscard = true } = options;
  const itRecoverable = recoverableRelease ? it : it.skip;
  describe(name, () => {
    it("acquires a runtime and reports command status and output", async () => {
      const backend = make();
      const runtime = await backend.acquire(TEST_SPEC);

      const started = await backend.startProcess(runtime, {
        command: "echo ready",
        timeoutMs: 1_000,
      });

      expect(started.status).toBe("exited");
      expect(await backend.getProcessStatus(runtime, started.process)).toEqual({
        status: "exited",
        exitCode: 0,
      });
      expect(await backend.readProcessOutput(runtime, started.process)).toEqual({
        stdout: "ready\n",
        stderr: "",
      });
    });

    it("round-trips workspace files", async () => {
      const backend = make();
      const runtime = await backend.acquire(TEST_SPEC);

      await backend.writeFile(runtime, "/workspace/value.txt", bytes("before"), {
        createParents: false,
        overwrite: false,
      });

      expect(await backend.inspectPath(runtime, "/workspace/value.txt")).toEqual({
        type: "file",
        size: 6,
        resolvedPath: "/workspace/value.txt",
      });
      expect(text((await backend.readFile(runtime, "/workspace/value.txt", 1_024)).bytes)).toBe(
        "before",
      );
    });

    it("throws compute_file_too_large instead of truncating an oversized read", async () => {
      const backend = make();
      const runtime = await backend.acquire(TEST_SPEC);
      await backend.writeFile(runtime, "/workspace/big.txt", bytes("0123456789"), {
        createParents: false,
        overwrite: false,
      });

      await expect(backend.readFile(runtime, "/workspace/big.txt", 4)).rejects.toMatchObject({
        code: "compute_file_too_large",
      });
    });

    itRecoverable("preserves workspace files across recoverable release", async () => {
      const backend = make();
      const runtime = await backend.acquire(TEST_SPEC);
      await backend.writeFile(runtime, "/workspace/value.txt", bytes("before"), {
        createParents: false,
        overwrite: false,
      });
      const recovery = await backend.release(runtime, {
        disposition: "recoverable",
        recoveryTtlMs: 86_400_000,
      });

      expect(recovery).not.toBeNull();
      const restored = await backend.acquire(TEST_SPEC, recovery!);
      expect(text((await backend.readFile(restored, "/workspace/value.txt", 1_024)).bytes)).toBe(
        "before",
      );
    });

    it("discards released runtimes", async () => {
      const backend = make();
      const runtime = await backend.acquire(TEST_SPEC);

      await expect(backend.release(runtime, { disposition: "discard" })).resolves.toBeNull();
      if (reportsMissingRuntimeAfterDiscard) {
        await expect(
          backend.readFile(runtime, "/workspace/value.txt", 1_024),
        ).rejects.toMatchObject({ code: "runtime_missing" });
      }
    });

    it("movePath replaces an existing destination with overwrite, rejects without it", async () => {
      const backend = make();
      const runtime = await backend.acquire(TEST_SPEC);
      await backend.writeFile(runtime, "/workspace/dest.txt", bytes("old"), {
        createParents: false,
        overwrite: false,
      });
      await backend.writeFile(runtime, "/workspace/src.txt", bytes("new"), {
        createParents: false,
        overwrite: false,
      });

      // overwrite:false onto an existing destination must reject and touch nothing.
      await expect(
        backend.movePath(runtime, "/workspace/src.txt", "/workspace/dest.txt", false),
      ).rejects.toMatchObject({ code: "provider_transient" });
      expect(text((await backend.readFile(runtime, "/workspace/dest.txt", 1_024)).bytes)).toBe(
        "old",
      );

      // overwrite:true replaces the destination and consumes the source.
      await backend.movePath(runtime, "/workspace/src.txt", "/workspace/dest.txt", true);
      expect(text((await backend.readFile(runtime, "/workspace/dest.txt", 1_024)).bytes)).toBe(
        "new",
      );
      expect(await backend.inspectPath(runtime, "/workspace/src.txt")).toBeNull();
    });

    it("listDirectory answers with a directory's entries", async () => {
      const backend = make();
      const runtime = await backend.acquire(TEST_SPEC);
      await backend.writeFile(runtime, "/workspace/a.txt", bytes("a"), {
        createParents: false,
        overwrite: false,
      });
      await backend.createDirectory(runtime, "/workspace/sub");

      const entries = await backend.listDirectory(runtime, "/workspace");
      expect(entries).toContainEqual({ name: "a.txt", type: "file" });
      expect(entries).toContainEqual({ name: "sub", type: "directory" });
    });

    // The whole point of the primitive. `readGeneration` claims `absent` on the
    // ABSENCE of a throw, so a backend that answered `[]` for a directory it
    // could not list would report a healthy container's files as wiped.
    it("listDirectory THROWS for a directory that does not exist — never [] or null", async () => {
      const backend = make();
      const runtime = await backend.acquire(TEST_SPEC);

      await expect(backend.listDirectory(runtime, "/workspace/nope")).rejects.toThrow();
    });

    // `includeHidden` is load-bearing on Cloudflare: the real container server
    // omits dot-prefixed entries without it, and the reset nonce is
    // `.nadi-generation`. Drop the flag and this fails — which is the point.
    it("listDirectory includes dot-prefixed entries", async () => {
      const backend = make();
      const runtime = await backend.acquire(TEST_SPEC);
      await backend.writeFile(runtime, "/workspace/.hidden", bytes("h"), {
        createParents: false,
        overwrite: false,
      });

      expect(await backend.listDirectory(runtime, "/workspace")).toContainEqual({
        name: ".hidden",
        type: "file",
      });
    });
  });
}

computeBackendContract("FakeComputeBackend", () => new FakeComputeBackend());

// Cloudflare cannot report `runtime_missing` after a discard — a destroyed DO id
// resolves to a fresh empty container — so that shared assertion is off here and
// asserted directly in the Cloudflare suite. Recovery is now implemented (Task 3),
// so the recoverable-release contract case runs.
computeBackendContract("CloudflareComputeBackend", () => createFakeCloudflareBackend().backend, {
  reportsMissingRuntimeAfterDiscard: false,
});

// Sprites hibernates instead of archiving; recoverable release is a no-op and
// restore reuses the same sprite, so the full contract applies.
computeBackendContract("SpritesComputeBackend", () => createFakeSpritesBackend().backend);

describe("FakeComputeBackend failure seams", () => {
  it("fails the next release without losing the runtime", async () => {
    const backend = new FakeComputeBackend();
    const runtime = await backend.acquire(TEST_SPEC);
    backend.failNextRelease(new ComputeError("provider_transient"));

    await expect(backend.release(runtime, { disposition: "recoverable" })).rejects.toMatchObject({
      code: "provider_transient",
    });
    await expect(
      backend.startProcess(runtime, { command: "echo still-active", timeoutMs: 1_000 }),
    ).resolves.toMatchObject({ status: "exited" });
  });

  it("fails the next acquisition", async () => {
    const backend = new FakeComputeBackend();
    backend.failNextAcquire(new ComputeError("recovery_failed"));

    await expect(backend.acquire(TEST_SPEC)).rejects.toMatchObject({ code: "recovery_failed" });
  });

  it("simulates a runtime being deleted out of band", async () => {
    const backend = new FakeComputeBackend();
    const runtime = await backend.acquire(TEST_SPEC);
    backend.deleteRuntimeOutOfBand(runtime);

    await expect(
      backend.startProcess(runtime, { command: "echo missing", timeoutMs: 1_000 }),
    ).rejects.toMatchObject({ code: "runtime_missing" });
  });
});

describe("DaytonaComputeBackend.inspectPath symlink detection", () => {
  const SANDBOX_ID = "sbx-inspect-1";
  const runtime: BackendReference = {
    provider: "daytona",
    version: 1,
    payload: { kind: "runtime", sandboxId: SANDBOX_ID },
  };

  function makeBackend(permissions: string) {
    const sandbox = {
      id: SANDBOX_ID,
      process: {
        createSession: async () => {},
        executeSessionCommand: async () => ({ cmdId: "cmd" }),
        getSessionCommandLogs: async () => ({ stdout: "", stderr: "" }),
      },
      fs: {
        getFileDetails: async (_path: string) => ({ isDir: false, size: 0, permissions }),
      },
    };
    const client = { create: async () => ({ id: SANDBOX_ID }), get: async () => sandbox };
    return new DaytonaComputeBackend({ apiKey: "test", client });
  }

  it("reports a symlink when getFileDetails permissions begin with 'l'", async () => {
    const backend = makeBackend("lrwxrwxrwx");
    expect(await backend.inspectPath(runtime, "/workspace/link")).toEqual({
      type: "symlink",
      size: 0,
      resolvedPath: "/workspace/link",
    });
  });

  it("reports a plain file otherwise", async () => {
    const backend = makeBackend("-rw-r--r--");
    expect(await backend.inspectPath(runtime, "/workspace/file")).toEqual({
      type: "file",
      size: 0,
      resolvedPath: "/workspace/file",
    });
  });
});

describe("isNotFoundError", () => {
  it("treats a genuine HTTP 404 as absent, from status or message", () => {
    // axios-shaped: the status rides on `response.status` (and sometimes `status`).
    expect(isNotFoundError({ response: { status: 404 } })).toBe(true);
    expect(isNotFoundError({ status: 404 })).toBe(true);
    // The Daytona client stringifies a 404 without ever saying "not found".
    expect(isNotFoundError(new Error("Request failed with status code 404"))).toBe(true);
    expect(isNotFoundError(new Error("not found"))).toBe(true);
  });

  it("propagates non-404 and network errors rather than masking them as absent", () => {
    expect(isNotFoundError({ response: { status: 403 } })).toBe(false);
    expect(isNotFoundError(new Error("Request failed with status code 403"))).toBe(false);
    expect(isNotFoundError({ response: { status: 500 } })).toBe(false);
    expect(isNotFoundError(new Error("Request failed with status code 500"))).toBe(false);
    // A bare network error carries no HTTP status and must not be swallowed.
    expect(isNotFoundError(new Error("socket hang up"))).toBe(false);
  });

  // The shape the Daytona SDK ACTUALLY throws: a flat `statusCode`. Until this
  // was read, `extractHttpStatus` returned undefined for every real error and
  // `isNotFoundError` worked here only by its message-regex fallback.
  it("reads the flat statusCode the Daytona SDK really throws", () => {
    expect(isNotFoundError({ statusCode: 404 })).toBe(true);
    expect(isNotFoundError({ statusCode: 500 })).toBe(false);
  });

  // `inspectPath` is fail-open BY DESIGN and this wave must not tighten it.
  // Making the status a POSITIVE-only signal is what preserves that: a non-404
  // status no longer suppresses the message fallback, so nothing that mapped to
  // "absent" before now throws.
  it("keeps its fail-open leniency: a non-404 status does not veto the message", () => {
    expect(isNotFoundError(Object.assign(new Error("not found"), { statusCode: 500 }))).toBe(true);
  });
});

describe("DaytonaComputeBackend.inspectPath 404 handling", () => {
  const SANDBOX_ID = "sbx-inspect-404";
  const runtime: BackendReference = {
    provider: "daytona",
    version: 1,
    payload: { kind: "runtime", sandboxId: SANDBOX_ID },
  };

  it("returns null when getFileDetails throws an axios-shaped 404", async () => {
    const notFound = Object.assign(new Error("Request failed with status code 404"), {
      response: { status: 404 },
    });
    const sandbox = {
      id: SANDBOX_ID,
      process: {
        createSession: async () => {},
        executeSessionCommand: async () => ({ cmdId: "cmd" }),
        getSessionCommandLogs: async () => ({ stdout: "", stderr: "" }),
      },
      fs: {
        getFileDetails: async (_path: string) => {
          throw notFound;
        },
      },
    };
    const client = { create: async () => ({ id: SANDBOX_ID }), get: async () => sandbox };
    const backend = new DaytonaComputeBackend({ apiKey: "test", client });

    expect(await backend.inspectPath(runtime, "/workspace/missing.txt")).toBeNull();
  });
});

describe("DaytonaComputeBackend.listDirectory", () => {
  const SANDBOX_ID = "sbx-list";
  const runtime: BackendReference = {
    provider: "daytona",
    version: 1,
    payload: { kind: "runtime", sandboxId: SANDBOX_ID },
  };

  // `listFiles` is typed `unknown`-returning on purpose: the point of the shape
  // tests below is what arrives at RUNTIME, which the SDK's typings cannot pin.
  function makeBackend(listFiles: (path: string) => Promise<unknown>) {
    const sandbox = {
      id: SANDBOX_ID,
      process: {
        createSession: async () => {},
        executeSessionCommand: async () => ({ cmdId: "cmd" }),
        getSessionCommandLogs: async () => ({ stdout: "", stderr: "" }),
      },
      fs: { listFiles } as unknown as {
        listFiles(path: string): Promise<Array<{ name: string; isDir?: boolean }>>;
      },
    };
    const client = { create: async () => ({ id: SANDBOX_ID }), get: async () => sandbox };
    return new DaytonaComputeBackend({ apiKey: "test", client });
  }

  it("answers with entries, mapping isDir to the entry type", async () => {
    const backend = makeBackend(async () => [
      { name: ".nadi-generation", isDir: false },
      { name: "sub", isDir: true },
    ]);

    expect(await backend.listDirectory(runtime, "/tmp")).toEqual([
      { name: ".nadi-generation", type: "file" },
      { name: "sub", type: "directory" },
    ]);
  });

  // No not-found mapping: unlike `inspectPath`, a 404 here is a throw. The
  // contract has no null arm, and swallowing this would be a false absence.
  it("throws — does not swallow — an axios-shaped 404", async () => {
    const notFound = Object.assign(new Error("Request failed with status code 404"), {
      response: { status: 404 },
    });
    const backend = makeBackend(async () => {
      throw notFound;
    });

    await expect(backend.listDirectory(runtime, "/tmp/missing")).rejects.toThrow();
  });

  // The shape mismatches that do NOT throw on their own are the dangerous half.
  // A wrapper object fails safe (`.map` is not a function), but an ARRAY whose
  // basename is under another key, or is an absolute path, throws nothing: the
  // nonce match silently misses and `readGeneration` reads that as a wipe,
  // faulting healthy work on every tick. Each of these must REJECT.
  // Asserting the code (not a bare `.toThrow()`) matters here: a `TypeError`
  // from an accidental property access would also satisfy `.toThrow()`, and
  // would pass this test for the wrong reason instead of pinning the intended
  // `ComputeError("provider_transient")`.
  it("rejects an array of entries carrying no `name` (basename under another key)", async () => {
    const backend = makeBackend(async () => [{ path: "/tmp/.nadi-generation" }]);
    await expect(backend.listDirectory(runtime, "/tmp")).rejects.toMatchObject({
      code: "provider_transient",
    });
  });

  it("rejects entries whose `name` is an absolute path, not a basename", async () => {
    const backend = makeBackend(async () => [{ name: "/tmp/.nadi-generation", isDir: false }]);
    await expect(backend.listDirectory(runtime, "/tmp")).rejects.toMatchObject({
      code: "provider_transient",
    });
  });

  it("rejects a wrapper object instead of an array", async () => {
    const backend = makeBackend(async () => ({ files: [{ name: ".nadi-generation" }] }));
    await expect(backend.listDirectory(runtime, "/tmp")).rejects.toMatchObject({
      code: "provider_transient",
    });
  });

  it("rejects a non-string / empty name", async () => {
    await expect(
      makeBackend(async () => [{ name: 42, isDir: false }]).listDirectory(runtime, "/tmp"),
    ).rejects.toMatchObject({ code: "provider_transient" });
    await expect(
      makeBackend(async () => [{ name: "", isDir: false }]).listDirectory(runtime, "/tmp"),
    ).rejects.toMatchObject({ code: "provider_transient" });
    await expect(
      makeBackend(async () => [null]).listDirectory(runtime, "/tmp"),
    ).rejects.toMatchObject({ code: "provider_transient" });
  });
});

describe("DaytonaComputeBackend.acquire workspace root", () => {
  function makeBackend() {
    const folders: string[] = [];
    const sandbox = {
      id: "sbx-acquire",
      start: async () => {},
      process: {
        createSession: async () => {},
        executeSessionCommand: async () => ({ cmdId: "cmd" }),
        getSessionCommandLogs: async () => ({ stdout: "", stderr: "" }),
      },
      fs: {
        createFolder: async (path: string) => void folders.push(path),
      },
    };
    const client = { create: async () => ({ id: "sbx-acquire" }), get: async () => sandbox };
    return { backend: new DaytonaComputeBackend({ apiKey: "test", client }), folders };
  }

  it("creates the workspace root on a fresh acquire", async () => {
    const { backend, folders } = makeBackend();
    await backend.acquire(TEST_SPEC);
    expect(folders).toContain("/workspace");
  });

  it("creates the workspace root on the recovery/resume path", async () => {
    const { backend, folders } = makeBackend();
    const recovery: BackendReference = {
      provider: "daytona",
      version: 1,
      payload: { kind: "recovery", sandboxId: "sbx-acquire" },
    };
    await backend.acquire(TEST_SPEC, recovery);
    expect(folders).toContain("/workspace");
  });
});

describe("DaytonaComputeBackend.readFile oversize handling", () => {
  const SANDBOX_ID = "sbx-readfile-1";
  const runtime: BackendReference = {
    provider: "daytona",
    version: 1,
    payload: { kind: "runtime", sandboxId: SANDBOX_ID },
  };

  it("throws compute_file_too_large instead of truncating an oversized download", async () => {
    const sandbox = {
      id: SANDBOX_ID,
      process: {
        createSession: async () => {},
        executeSessionCommand: async () => ({ cmdId: "cmd" }),
        getSessionCommandLogs: async () => ({ stdout: "", stderr: "" }),
      },
      fs: {
        downloadFile: async (_path: string) => new TextEncoder().encode("0123456789"),
      },
    };
    const client = { create: async () => ({ id: SANDBOX_ID }), get: async () => sandbox };
    const backend = new DaytonaComputeBackend({ apiKey: "test", client });

    await expect(backend.readFile(runtime, "/workspace/big.txt", 4)).rejects.toMatchObject({
      code: "compute_file_too_large",
    });
  });
});

describe("DaytonaComputeBackend.movePath overwrite semantics", () => {
  const SANDBOX_ID = "sbx-move-1";
  const runtime: BackendReference = {
    provider: "daytona",
    version: 1,
    payload: { kind: "runtime", sandboxId: SANDBOX_ID },
  };

  // Daytona's native moveFiles does not overwrite. `overwrite: true` must delete
  // an existing destination first, or every in-place apply_patch update fails in
  // production while the fake (which always pre-deletes) passes.
  function makeBackend(destinationExists: boolean) {
    const calls: string[] = [];
    const sandbox = {
      id: SANDBOX_ID,
      process: {
        createSession: async () => {},
        executeSessionCommand: async () => ({ cmdId: "cmd" }),
        getSessionCommandLogs: async () => ({ stdout: "", stderr: "" }),
      },
      fs: {
        getFileDetails: async (_path: string) => {
          // A GENUINE 404 from the SDK, not a bare `new Error("not found")`.
          // The destination probe now runs through `pathExists`, which only
          // accepts a numeric 404 as "proven absent" — the old fixture was a
          // shape the axios interceptor guarantees never reaches us, and under
          // it a broken request read as an empty destination.
          if (!destinationExists) {
            const { DaytonaNotFoundError } = await import("@daytona/sdk");
            throw new DaytonaNotFoundError("file does not exist", 404, undefined, "not_found");
          }
          return { isDir: false, size: 3 };
        },
        deleteFile: async (path: string) => void calls.push(`delete:${path}`),
        moveFiles: async (from: string, to: string) => void calls.push(`move:${from}->${to}`),
      },
    };
    const client = { create: async () => ({ id: SANDBOX_ID }), get: async () => sandbox };
    return { backend: new DaytonaComputeBackend({ apiKey: "test", client }), calls };
  }

  it("deletes an existing destination before moveFiles when overwriting", async () => {
    const { backend, calls } = makeBackend(true);
    await backend.movePath(runtime, "/workspace/tmp", "/workspace/dest.txt", true);
    expect(calls).toEqual([
      "delete:/workspace/dest.txt",
      "move:/workspace/tmp->/workspace/dest.txt",
    ]);
  });

  it("does not delete when overwriting a destination that does not exist", async () => {
    const { backend, calls } = makeBackend(false);
    await backend.movePath(runtime, "/workspace/tmp", "/workspace/new.txt", true);
    expect(calls).toEqual(["move:/workspace/tmp->/workspace/new.txt"]);
  });

  it("rejects overwrite:false onto an existing destination without moving", async () => {
    const { backend, calls } = makeBackend(true);
    await expect(
      backend.movePath(runtime, "/workspace/tmp", "/workspace/dest.txt", false),
    ).rejects.toMatchObject({ code: "provider_transient" });
    expect(calls).toEqual([]);
  });
});

describe("Daytona symlink detection", () => {
  /**
   * Live-verified: Daytona's toolbox is Go, and `FileMode.String()` renders a
   * symlink as a leading "L" in `mode` ("Lrwxrwxrwx"). `permissions` carries no
   * type char, so the original `permissions.startsWith("l")` check never fired
   * and a symlink to /etc read straight through the containment guard.
   */
  it("treats a Go-style mode as a symlink", () => {
    expect(isSymlinkMode({ mode: "Lrwxrwxrwx", permissions: "rwxrwxrwx" })).toBe(true);
  });

  it("treats a POSIX ls-style permissions string as a symlink", () => {
    expect(isSymlinkMode({ permissions: "lrwxrwxrwx" })).toBe(true);
  });

  it("does not treat a regular file or directory as a symlink", () => {
    expect(isSymlinkMode({ mode: "-rw-r--r--", permissions: "rw-r--r--" })).toBe(false);
    expect(isSymlinkMode({ mode: "drwxr-xr-x", permissions: "rwxr-xr-x" })).toBe(false);
    expect(isSymlinkMode({})).toBe(false);
  });
});

describe("Daytona inspectPath symlink precedence", () => {
  function backendWithDetails(details: Record<string, unknown>) {
    const sandbox = { fs: { getFileDetails: async () => details } };
    const backend = new DaytonaComputeBackend({
      apiKey: "k",
      apiUrl: null,
      target: null,
      source: { kind: "image", value: "img" },
      client: { get: async () => sandbox },
    } as never);
    return backend;
  }

  const runtime = {
    provider: "daytona",
    version: 1,
    payload: { kind: "runtime", sandboxId: "sb" },
  } as never;

  it("reports symlink even when the provider marks the resolved target a directory", async () => {
    // A link to /etc: Daytona follows it and returns isDir. If a provider ever
    // does surface a link type alongside isDir, symlink must win — otherwise the
    // guard silently degrades to "directory" and lets the path through.
    const backend = backendWithDetails({ isDir: true, size: 0, mode: "Lrwxrwxrwx" });
    expect(await backend.inspectPath(runtime, "/workspace/link")).toMatchObject({
      type: "symlink",
    });
  });

  it("still reports a plain directory as a directory", async () => {
    const backend = backendWithDetails({ isDir: true, size: 0, mode: "drwxr-xr-x" });
    expect(await backend.inspectPath(runtime, "/workspace/dir")).toMatchObject({
      type: "directory",
    });
  });
});

describe("Daytona client + sandbox memoization", () => {
  function countingClient(options: { stopError?: Error; archiveError?: Error } = {}) {
    const lifecycleCalls: string[] = [];
    const sandbox = {
      fs: {
        createFolder: async () => {},
        getFileDetails: async () => ({ isDir: false, size: 1, mode: "-rw-r--r--" }),
      },
      delete: async () => {},
      stop: async () => {
        lifecycleCalls.push("stop");
        if (options.stopError) throw options.stopError;
      },
      archive: async () => {
        lifecycleCalls.push("archive");
        if (options.archiveError) throw options.archiveError;
      },
      start: async () => void lifecycleCalls.push("start"),
    };
    let getCalls = 0;
    const client = {
      get: async () => {
        getCalls += 1;
        return sandbox;
      },
    };
    const backend = new DaytonaComputeBackend({
      apiKey: "k",
      apiUrl: null,
      target: null,
      source: { kind: "image", value: "img" },
      client,
    } as never);
    return { backend, getCalls: () => getCalls, lifecycleCalls };
  }

  const runtime = {
    provider: "daytona",
    version: 1,
    payload: { kind: "runtime", sandboxId: "sb" },
  } as never;

  it("fetches the sandbox once across many inspectPath calls", async () => {
    // assertPathContained inspects every path component; a multi-file apply_patch
    // otherwise made one HTTP round-trip per component per path.
    const { backend, getCalls } = countingClient();
    await backend.inspectPath(runtime, "/workspace/a");
    await backend.inspectPath(runtime, "/workspace/a/b");
    await backend.inspectPath(runtime, "/workspace/a/b/c");
    expect(getCalls()).toBe(1);
  });

  it("re-fetches after the sandbox is archived", async () => {
    const { backend, getCalls, lifecycleCalls } = countingClient();
    await backend.inspectPath(runtime, "/workspace/a");
    const recovery = await backend.release(runtime, { disposition: "recoverable" });
    expect(lifecycleCalls).toEqual(["stop", "archive"]);
    expect(recovery).toEqual({
      provider: "daytona",
      version: 1,
      payload: { kind: "recovery", sandboxId: "sb" },
    });
    await backend.inspectPath(runtime, "/workspace/a");
    expect(getCalls()).toBe(2); // initial (release reuses it), then a refetch after archive
  });

  it("rejects recoverable release when archive is unsupported", async () => {
    const lifecycleCalls: string[] = [];
    const backend = new DaytonaComputeBackend({
      apiKey: "test",
      client: {
        get: async () => ({
          stop: async () => void lifecycleCalls.push("stop"),
        }),
      },
    } as never);

    await expect(backend.release(runtime, { disposition: "recoverable" })).rejects.toMatchObject({
      code: "provider_transient",
      message: "daytona_archive_unsupported",
    });
    expect(lifecycleCalls).toEqual([]);
  });

  it("stops before archiving and restores the active state when native archive fails", async () => {
    const { backend, lifecycleCalls } = countingClient({
      archiveError: new Error("archive failed"),
    });

    await expect(backend.release(runtime, { disposition: "recoverable" })).rejects.toThrow(
      "archive failed",
    );
    expect(lifecycleCalls).toEqual(["stop", "archive", "start"]);
  });

  it("does not attempt archival when stopping fails", async () => {
    const { backend, lifecycleCalls } = countingClient({
      stopError: new Error("stop failed"),
    });

    await expect(backend.release(runtime, { disposition: "recoverable" })).rejects.toThrow(
      "stop failed",
    );
    expect(lifecycleCalls).toEqual(["stop"]);
  });

  it("starts archived recovery through a freshly fetched sandbox handle", async () => {
    const { backend, getCalls, lifecycleCalls } = countingClient();
    const recovery = await backend.release(runtime, { disposition: "recoverable" });
    expect(recovery).not.toBeNull();

    await backend.acquire(
      {
        environmentId: "env",
        profile: "small",
        workspaceRoot: "/workspace",
        env: {},
        maxProcessRuntimeMs: 600_000,
        allowedHosts: null,
      },
      recovery!,
    );

    expect(lifecycleCalls).toEqual(["stop", "archive", "start"]);
    expect(getCalls()).toBe(2);
  });

  it("re-fetches after the sandbox is destroyed", async () => {
    const { backend, getCalls } = countingClient();
    await backend.inspectPath(runtime, "/workspace/a");
    await backend.destroy(runtime);
    await backend.inspectPath(runtime, "/workspace/a");
    expect(getCalls()).toBe(2);
  });
});

describe("pathExists answers-or-throws", () => {
  it("FakeComputeBackend reports presence and absence", async () => {
    const backend = new FakeComputeBackend();
    const runtime = await backend.acquire({
      environmentId: "exists_test",
      profile: "small",
      workspaceRoot: "/workspace",
      env: {},
      maxProcessRuntimeMs: 0,
      allowedHosts: null,
    });
    await backend.createDirectory(runtime, "/workspace");
    backend.seedFile(runtime, "/workspace/there.txt", new TextEncoder().encode("x"), "text/plain");

    expect(await backend.pathExists(runtime, "/workspace/there.txt")).toBe(true);
    expect(await backend.pathExists(runtime, "/workspace/absent.txt")).toBe(false);
  });

  const DAYTONA_SANDBOX_ID = "sbx-path-exists";
  const daytonaRuntime: BackendReference = {
    provider: "daytona",
    version: 1,
    payload: { kind: "runtime", sandboxId: DAYTONA_SANDBOX_ID },
  };

  /**
   * The error `sandbox.fs.getFileDetails` REALLY throws for a missing path,
   * built from the SDK's own class rather than hand-shaped.
   *
   * Derivation (`@daytona/sdk@0.193.0`): `Daytona.createAxiosInstance` installs a
   * response interceptor that converts every `AxiosError` through
   * `createAxiosDaytonaError` → `createDaytonaError(message, statusCode, headers,
   * errorCode)` → `errorClassFromStatusCode(404)` = `DaytonaNotFoundError`, whose
   * base constructor sets `name = new.target.name` and a FLAT `statusCode`.
   * `Sandbox` builds its `FileSystemApi` on that same intercepted instance, so
   * nothing with an axios `response.status` can reach us. The previous fixture
   * here was `{ response: { status: 404 } }` — a shape the library never emits —
   * and it kept this test green while `pathExists` was broken on every real 404.
   */
  async function daytonaNotFoundError(): Promise<Error> {
    const { DaytonaNotFoundError } = await import("@daytona/sdk");
    return new DaytonaNotFoundError("file does not exist", 404, undefined, "not_found");
  }

  it("the real SDK 404 carries a flat statusCode and no axios shape", async () => {
    const error = (await daytonaNotFoundError()) as Error & {
      statusCode?: unknown;
      status?: unknown;
      response?: unknown;
    };
    expect(error.name).toBe("DaytonaNotFoundError");
    expect(error.statusCode).toBe(404);
    // The two properties the previous fixture invented — and the reason the old
    // `extractHttpStatus` returned undefined for every genuine production 404.
    expect(error.status).toBeUndefined();
    expect(error.response).toBeUndefined();
  });

  function daytonaBackendWithFileDetails(getFileDetails: (path: string) => Promise<never>) {
    const sandbox = {
      id: DAYTONA_SANDBOX_ID,
      process: {
        createSession: async () => {},
        executeSessionCommand: async () => ({ cmdId: "cmd" }),
        getSessionCommandLogs: async () => ({ stdout: "", stderr: "" }),
      },
      fs: { getFileDetails },
    };
    const client = { create: async () => ({ id: DAYTONA_SANDBOX_ID }), get: async () => sandbox };
    return new DaytonaComputeBackend({ apiKey: "test", client });
  }

  it("Daytona maps a real SDK 404 to false", async () => {
    const backend = daytonaBackendWithFileDetails(async () => {
      throw await daytonaNotFoundError();
    });

    expect(await backend.pathExists(daytonaRuntime, "/workspace/missing.txt")).toBe(false);
  });

  // The numeric status is the WHOLE check — the error's class name carries no
  // authority. Pins that the status alone answers.
  it("Daytona maps a 404 statusCode to false even without the SDK's error name", async () => {
    const backend = daytonaBackendWithFileDetails(async () => {
      const error = new Error("file does not exist");
      error.name = "Error";
      throw Object.assign(error, { statusCode: 404 });
    });

    expect(await backend.pathExists(daytonaRuntime, "/workspace/missing.txt")).toBe(false);
  });

  // The converse, and the reason the `error.name === "DaytonaNotFoundError"` arm
  // was dropped: the SDK constructs that class directly, with NO `statusCode`,
  // for purely client-side "local file does not exist" conditions (`Image.js:71`
  // etc., `ObjectStorage.js:59`). None reach `getFileDetails` today, but while
  // the name arm stood, any that later did would have answered "proven absent"
  // in the one function where a wrong `false` is a clobber. The name is not
  // evidence about a remote path; only a 404 is.
  it("Daytona throws on a DaytonaNotFoundError carrying no statusCode", async () => {
    const backend = daytonaBackendWithFileDetails(async () => {
      const error = new Error("Local file /tmp/x does not exist");
      error.name = "DaytonaNotFoundError";
      throw error;
    });

    await expect(
      backend.pathExists(daytonaRuntime, "/workspace/missing.txt"),
    ).rejects.toMatchObject({ code: "provider_transient" });
  });

  // A statusCode that is NOT 404 must not be read as absence just because the
  // error class shape matches — this is where `false` would become a clobber.
  it("Daytona throws on a real SDK error whose statusCode is not 404", async () => {
    const backend = daytonaBackendWithFileDetails(async () => {
      const error = new Error("internal server error");
      error.name = "DaytonaError";
      throw Object.assign(error, { statusCode: 500 });
    });

    await expect(backend.pathExists(daytonaRuntime, "/workspace/there.txt")).rejects.toMatchObject({
      code: "provider_transient",
    });
  });

  // Minor 3: the rethrow used to escape the taxonomy raw. It is now the common
  // production path for a provider hiccup on a write guard, so it must arrive as
  // a ComputeError — while still preserving the underlying message.
  it("Daytona reports an unanswerable probe as a ComputeError, not a raw SDK error", async () => {
    const backend = daytonaBackendWithFileDetails(async () => {
      throw new Error("socket hang up");
    });

    const error = await backend.pathExists(daytonaRuntime, "/workspace/there.txt").then(
      () => null,
      (caught: unknown) => caught,
    );
    expect(error).toMatchObject({ name: "ComputeError", code: "provider_transient" });
    expect((error as Error).message).toContain("daytona_exists_unanswered");
    expect((error as Error).message).toContain("socket hang up");
  });

  // The property that matters: a provider failure must NOT become `false`.
  // `false` means "proven absent" and is read downstream as permission to
  // write over the path.
  it("Daytona throws — never returns false — on a non-404 failure", async () => {
    const backend = daytonaBackendWithFileDetails(async () => {
      throw new Error("500 internal server error");
    });

    await expect(backend.pathExists(daytonaRuntime, "/workspace/there.txt")).rejects.toThrow();
  });

  // The bug class this branch exists to kill, in its narrowest form: a provider
  // failure converted into a VALUE the caller reads as fact. `isNotFoundError`
  // falls back to regex-matching the error MESSAGE when no HTTP status is
  // present, so a statusless failure whose prose echoes "not found" would answer
  // `false` = "proven absent" = permission to overwrite.
  //
  // This fixture is the SDK's OWN statusless shape, not a hand-shaped one. A
  // previous version of this test threw a bare `new Error("Sandbox not found")`,
  // which the axios interceptor guarantees can never reach us — a green test
  // over a fictional error. `DaytonaConnectionError` is how a statusless failure
  // really arrives: `createAxiosDaytonaError` returns it whenever there is no
  // `response`, and `statusCode` is then `undefined`.
  it("Daytona throws on a statusless SDK connection error whose prose says 'not found'", async () => {
    const { DaytonaConnectionError } = await import("@daytona/sdk");
    const thrown = new DaytonaConnectionError("socket hang up: file not found in cache");
    // The statuslessness is the point, and it comes from the library rather than
    // from this test's imagination — assert it on the real instance so the case
    // cannot quietly decay into a duplicate of the non-404 one above.
    expect(thrown.statusCode).toBeUndefined();
    expect(thrown.name).toBe("DaytonaConnectionError");

    const backend = daytonaBackendWithFileDetails(async () => {
      throw thrown;
    });

    const error = await backend.pathExists(daytonaRuntime, "/workspace/there.txt").then(
      () => null,
      (caught: unknown) => caught,
    );
    expect(error).toMatchObject({ name: "ComputeError", code: "provider_transient" });
    expect((error as Error).message).toContain("file not found in cache");
  });
});

/**
 * The data-loss property, pinned at the two Daytona sites that decide a WRITE
 * from an existence probe. Both used `inspectPath`, which is fail-open BY
 * DESIGN — a provider failure becomes `null` — and `null` is read here as
 * "proven absent" = permission to overwrite. They now consult `pathExists`,
 * which answers or throws.
 *
 * The assertion that matters is THE SURVIVING BYTES, not the error code: a
 * `rejects.toMatchObject({ code })` alone passes for the wrong reason against
 * several plausible broken implementations. Each test therefore asserts the
 * bytes FIRST, so the byte check cannot be skipped by an earlier assertion
 * failing.
 *
 * The failure fixture is the SDK's own statusless shape (`DaytonaConnectionError`,
 * emitted by `createAxiosDaytonaError` whenever there is no `response`) with
 * prose that trips `isNotFoundError`'s message regex (`/not found|status code
 * 404/i`). That combination is precisely what turned a broken request into a
 * `null` from `inspectPath` — a hand-shaped error would not exercise it.
 */
describe("Daytona write guards fail closed on an unanswerable probe", () => {
  const SANDBOX_ID = "sbx-write-guard";
  const runtime: BackendReference = {
    provider: "daytona",
    version: 1,
    payload: { kind: "runtime", sandboxId: SANDBOX_ID },
  };

  async function statuslessNotFoundError(): Promise<Error> {
    const { DaytonaConnectionError } = await import("@daytona/sdk");
    const error = new DaytonaConnectionError("socket hang up: file not found in cache");
    // The two properties that make this the defect's exact fixture: no status
    // (so `extractHttpStatus` yields undefined) and prose the lenient
    // `isNotFoundError` regex accepts (so `inspectPath` answered `null`).
    expect(error.statusCode).toBeUndefined();
    expect(isNotFoundError(error)).toBe(true);
    return error;
  }

  /** A Daytona sandbox whose filesystem really mutates, so a clobber is observable. */
  function backendOverFiles(files: Map<string, Uint8Array>, detailsFailure: Error) {
    const sandbox = {
      id: SANDBOX_ID,
      process: {
        createSession: async () => {},
        executeSessionCommand: async () => ({ cmdId: "cmd" }),
        getSessionCommandLogs: async () => ({ stdout: "", stderr: "" }),
      },
      fs: {
        getFileDetails: async (_path: string) => {
          throw detailsFailure;
        },
        uploadFile: async (bytes: Uint8Array | ArrayBuffer, path: string) => {
          files.set(
            path,
            new Uint8Array(bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes)),
          );
        },
        moveFiles: async (from: string, to: string) => {
          const bytes = files.get(from);
          if (bytes) {
            files.delete(from);
            files.set(to, bytes);
          }
        },
        deleteFile: async (path: string) => {
          files.delete(path);
        },
        createFolder: async () => {},
      },
    };
    const client = { create: async () => ({ id: SANDBOX_ID }), get: async () => sandbox };
    return new DaytonaComputeBackend({ apiKey: "test", client });
  }

  const text = (value: string) => new TextEncoder().encode(value);
  const read = (files: Map<string, Uint8Array>, path: string) =>
    new TextDecoder().decode(files.get(path) ?? new Uint8Array());

  it("writeFile(overwrite:false) refuses and the original bytes survive", async () => {
    const files = new Map<string, Uint8Array>([["/workspace/keep.txt", text("ORIGINAL")]]);
    const backend = backendOverFiles(files, await statuslessNotFoundError());

    const caught = await backend
      .writeFile(runtime, "/workspace/keep.txt", text("CLOBBER").buffer as ArrayBuffer, {
        overwrite: false,
        createParents: false,
      })
      .then(
        () => null,
        (error: unknown) => error,
      );

    // THE property. Asserted before the error so it is always reached.
    expect(read(files, "/workspace/keep.txt")).toBe("ORIGINAL");
    expect(caught).toMatchObject({ name: "ComputeError", code: "provider_transient" });
    expect((caught as Error).message).toContain("daytona_exists_unanswered");
  });

  it("movePath refuses and leaves both source and destination intact", async () => {
    const files = new Map<string, Uint8Array>([
      ["/workspace/new.txt", text("REPLACEMENT")],
      ["/workspace/keep.txt", text("ORIGINAL")],
    ]);
    const backend = backendOverFiles(files, await statuslessNotFoundError());

    const caught = await backend
      .movePath(runtime, "/workspace/new.txt", "/workspace/keep.txt", false)
      .then(
        () => null,
        (error: unknown) => error,
      );

    expect(read(files, "/workspace/keep.txt")).toBe("ORIGINAL");
    expect(read(files, "/workspace/new.txt")).toBe("REPLACEMENT");
    expect(caught).toMatchObject({ name: "ComputeError", code: "provider_transient" });
    expect((caught as Error).message).toContain("daytona_exists_unanswered");
  });

  // `movePath(overwrite: true)` pre-DELETES the destination, so the same
  // fail-open probe decides a destructive delete too — and an unanswerable
  // probe previously skipped it, handing `moveFiles` unverified overwrite
  // semantics (the gap that once corrupted every in-place apply_patch update).
  it("movePath(overwrite:true) refuses rather than moving on an unanswerable probe", async () => {
    const files = new Map<string, Uint8Array>([
      ["/workspace/new.txt", text("REPLACEMENT")],
      ["/workspace/keep.txt", text("ORIGINAL")],
    ]);
    const backend = backendOverFiles(files, await statuslessNotFoundError());

    const caught = await backend
      .movePath(runtime, "/workspace/new.txt", "/workspace/keep.txt", true)
      .then(
        () => null,
        (error: unknown) => error,
      );

    expect(read(files, "/workspace/keep.txt")).toBe("ORIGINAL");
    expect(read(files, "/workspace/new.txt")).toBe("REPLACEMENT");
    expect(caught).toMatchObject({ name: "ComputeError", code: "provider_transient" });
  });

  // The guards must still WORK, not merely throw on everything: a genuine 404
  // answers "absent" and the write proceeds.
  it("still writes when the probe genuinely answers absent (real SDK 404)", async () => {
    const { DaytonaNotFoundError } = await import("@daytona/sdk");
    const files = new Map<string, Uint8Array>();
    const backend = backendOverFiles(
      files,
      new DaytonaNotFoundError("file does not exist", 404, undefined, "not_found"),
    );

    await backend.writeFile(runtime, "/workspace/fresh.txt", text("NEW").buffer as ArrayBuffer, {
      overwrite: false,
      createParents: false,
    });

    expect(read(files, "/workspace/fresh.txt")).toBe("NEW");
  });
});
