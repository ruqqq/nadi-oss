import { describe, expect, it, vi } from "vitest";
import { FakeComputeBackend } from "../../../src/compute/backends/fake";
import { DEFAULT_COMPUTE_LIMITS } from "../../../src/compute/config";
import { ThreadComputeService } from "../../../src/compute/thread-service";
import { DEFAULT_MONITOR_POLL_INTERVAL_MS } from "../../../src/compute/watchers";
import { createMemoryComputeStore } from "../compute/helpers/memory-store";
import { buildComputeToolDefs } from "../../../src/agent/compute-tools";

const { insertMock } = vi.hoisted(() => ({ insertMock: vi.fn() }));

vi.mock("../../../src/db/artifact-repository", () => ({
  ArtifactRepository: class {
    insert = insertMock;
  },
}));

function createService(backend = new FakeComputeBackend()) {
  const store = createMemoryComputeStore();
  const service = new ThreadComputeService({
    backend,
    store,
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
    env: {},
    setAlarm: async () => {},
    now: () => 1000,
  });
  return { service, backend, store };
}

async function seedDir(
  service: ThreadComputeService,
  backend: FakeComputeBackend,
  store: ReturnType<typeof createMemoryComputeStore>,
  basePath: string,
  files: Record<string, string>,
) {
  await service.exec({ command: "pwd" });
  const runtime = store.getComputeState()?.runtimeRef;
  if (!runtime) throw new Error("runtime missing");
  for (const [rel, content] of Object.entries(files)) {
    await backend.writeFile(
      runtime,
      `${basePath}/${rel}`,
      new TextEncoder().encode(content).buffer,
      { createParents: true, overwrite: true },
    );
  }
}

describe("ThreadComputeService.execPublishArtifact", () => {
  it("walks a directory and returns files with the entry present", async () => {
    const { service, backend, store } = createService();
    await seedDir(service, backend, store, "/workspace/dist", {
      "index.html": "<html></html>",
      "style.css": "body {}",
    });

    const published = await service.execPublishArtifact({ path: "/workspace/dist" });

    expect(published.files).toHaveLength(2);
    expect(published.files.map((f) => f.relativePath).sort()).toEqual(["index.html", "style.css"]);
    expect(published.files.find((f) => f.relativePath === "index.html")?.mimeType).toBe(
      "text/html",
    );
    expect(published.files.find((f) => f.relativePath === "style.css")?.mimeType).toBe("text/css");
    expect(published.totalBytes).toBeGreaterThan(0);
  });

  it("rejects when the entry file is missing", async () => {
    const { service, backend, store } = createService();
    await seedDir(service, backend, store, "/workspace/dist", { "style.css": "body {}" });

    await expect(service.execPublishArtifact({ path: "/workspace/dist" })).rejects.toThrow(
      "artifact_entry_missing",
    );
  });

  // The tool description invites `path` + `entryPath` for a single .html file,
  // so a model passing the FILE as `path` is the expected fumble. It has to fail
  // by saying so.
  //
  // On sprites the listing does not stop it: listing a file answers 200 with a
  // one-entry listing OF THAT FILE (live 2026-08-05), so `walk` built
  // `/workspace/report.html/report.html` and died on the read with
  // `sprites_read_missing` — a message about a missing file, for a file that is
  // there. That is why the check runs BEFORE the walk instead of leaning on the
  // listing to fail. This fake throws on the listing, so it cannot reproduce the
  // sprites path; it pins the guard, not the provider.
  it("rejects a file path with a message that names the fix", async () => {
    const { service, backend, store } = createService();
    await seedDir(service, backend, store, "/workspace", { "report.html": "<html></html>" });

    await expect(service.execPublishArtifact({ path: "/workspace/report.html" })).rejects.toThrow(
      "artifact_path_not_directory: /workspace/report.html is a file — pass its parent directory as path and its filename as entryPath",
    );
  });

  it("still publishes when the path is a directory", async () => {
    // The guard must not cost the normal case a listing it already does.
    const { service, backend, store } = createService();
    await seedDir(service, backend, store, "/workspace/dist", { "index.html": "<html></html>" });

    await expect(service.execPublishArtifact({ path: "/workspace/dist" })).resolves.toMatchObject({
      files: [{ relativePath: "index.html" }],
    });
  });

  it("does not reject a path inspectPath cannot see", async () => {
    // `inspectPath` returns null for BOTH "nothing there" and "the provider
    // answered something that reads like not-found" (Cloudflare's fail-open).
    // Turning that into a not-a-directory verdict would refuse to publish a
    // directory that is really there, so only a positive `file` verdict blocks.
    const { service, backend, store } = createService();
    await seedDir(service, backend, store, "/workspace/dist", { "index.html": "<html></html>" });
    const runtime = store.getComputeState()?.runtimeRef;
    if (!runtime) throw new Error("runtime missing");
    backend.seedBlindInspect(runtime, "/workspace/dist");

    await expect(service.execPublishArtifact({ path: "/workspace/dist" })).resolves.toMatchObject({
      files: [{ relativePath: "index.html" }],
    });
  });

  it("rejects path traversal in the sandbox path", async () => {
    const { service } = createService();

    await expect(service.execPublishArtifact({ path: "/workspace/../etc" })).rejects.toThrow(
      "compute_invalid_path",
    );
  });

  it("rejects path traversal in entryPath", async () => {
    const { service } = createService();

    await expect(
      service.execPublishArtifact({ path: "/workspace/dist", entryPath: "../index.html" }),
    ).rejects.toThrow("compute_invalid_path");
  });

  it("rejects more than 100 files", async () => {
    const { service, backend, store } = createService();
    const files: Record<string, string> = { "index.html": "<html></html>" };
    for (let i = 0; i < 100; i++) files[`asset-${i}.txt`] = "x";
    await seedDir(service, backend, store, "/workspace/dist", files);

    await expect(service.execPublishArtifact({ path: "/workspace/dist" })).rejects.toThrow(
      "artifact_too_many_files",
    );
  });

  it("rejects payloads larger than 20MB", async () => {
    const { service, backend, store } = createService();
    await seedDir(service, backend, store, "/workspace/dist", {
      "a.txt": "x".repeat(50),
      "b.txt": "x".repeat(50),
      "index.html": "<html></html>",
    });

    await expect(
      service.execPublishArtifact({ path: "/workspace/dist", maxBytes: 100 }),
    ).rejects.toThrow("artifact_too_large");
  });

  it("prefers the extension MIME map over a provider text/plain for HTML", async () => {
    const { service, backend, store } = createService();
    await seedDir(service, backend, store, "/workspace/dist", {
      "index.html": "<html></html>",
      "style.css": "body {}",
    });
    const runtime = store.getComputeState()?.runtimeRef;
    if (!runtime) throw new Error("runtime missing");
    // Re-seed with a wrong provider mime — mirrors Cloudflare sandbox reporting text/plain.
    backend.seedFile(
      runtime,
      "/workspace/dist/index.html",
      new TextEncoder().encode("<html></html>"),
      "text/plain",
    );
    backend.seedFile(
      runtime,
      "/workspace/dist/style.css",
      new TextEncoder().encode("body {}"),
      "text/plain",
    );

    const published = await service.execPublishArtifact({ path: "/workspace/dist" });

    expect(published.files.find((f) => f.relativePath === "index.html")?.mimeType).toBe(
      "text/html",
    );
    expect(published.files.find((f) => f.relativePath === "style.css")?.mimeType).toBe("text/css");
  });
});

describe("exec_publish_artifact tool", () => {
  function makePublishTool(published: {
    files: Array<{ relativePath: string; bytes: ArrayBuffer; mimeType: string }>;
    totalBytes: number;
  }) {
    const putMock = vi.fn(
      async (
        _key: string,
        _body: ArrayBuffer,
        _opts?: { httpMetadata?: { contentType: string } },
      ) => {},
    );
    const env = {
      ATTACHMENTS_BUCKET: { put: putMock },
      REGISTRY_DB: {},
    };
    const tools = buildComputeToolDefs(
      async () => ({ execPublishArtifact: async () => published }) as never,
      async () => ({ env, threadId: "thr_1", workspaceId: "ws_1" }) as never,
    );
    return {
      execute: (tools.exec_publish_artifact as { execute: (input: unknown) => Promise<unknown> })
        .execute,
      putMock,
    };
  }

  it("uploads files to R2 and inserts an artifact row", async () => {
    insertMock.mockClear();
    const html = new TextEncoder().encode("<html></html>").buffer;
    const css = new TextEncoder().encode("body {}").buffer;
    const { execute, putMock } = makePublishTool({
      files: [
        { relativePath: "index.html", bytes: html, mimeType: "text/html" },
        { relativePath: "style.css", bytes: css, mimeType: "text/css" },
      ],
      totalBytes: html.byteLength + css.byteLength,
    });

    const result = (await execute({ path: "/workspace/dist", title: "My Site" })) as {
      artifactId: string;
      title: string;
      entryPath: string;
      fileCount: number;
      byteSize: number;
      expiresAt: number;
      url: string;
    };

    expect(putMock).toHaveBeenCalledTimes(2);
    expect(putMock.mock.calls[0]?.[0]).toMatch(/^artifacts\/art_/);
    expect(putMock.mock.calls[0]?.[2]).toMatchObject({
      httpMetadata: { contentType: "text/html" },
    });
    expect(insertMock).toHaveBeenCalledTimes(1);
    expect(insertMock.mock.calls[0]?.[0]).toMatchObject({
      workspaceId: "ws_1",
      threadId: "thr_1",
      title: "My Site",
      entryPath: "index.html",
      fileCount: 2,
      status: "active",
    });
    expect(result.fileCount).toBe(2);
    expect(result.url).toBe(`/api/artifacts/${result.artifactId}`);
    expect(result.expiresAt).toBeGreaterThan(Date.now());
  });

  it("deletes the R2 prefix when a mid-publish put fails", async () => {
    insertMock.mockClear();
    const html = new TextEncoder().encode("<html></html>").buffer;
    const css = new TextEncoder().encode("body {}").buffer;
    const listMock = vi.fn(async () => ({
      objects: [{ key: "artifacts/art_x/index.html" }],
      truncated: false,
    }));
    const deleteMock = vi.fn(async () => {});
    let putCount = 0;
    const putMock = vi.fn(async () => {
      putCount += 1;
      if (putCount === 2) throw new Error("r2_put_failed");
    });
    const env = {
      ATTACHMENTS_BUCKET: { put: putMock, list: listMock, delete: deleteMock },
      REGISTRY_DB: {},
    };
    const tools = buildComputeToolDefs(
      async () =>
        ({
          execPublishArtifact: async () => ({
            files: [
              { relativePath: "index.html", bytes: html, mimeType: "text/html" },
              { relativePath: "style.css", bytes: css, mimeType: "text/css" },
            ],
            totalBytes: html.byteLength + css.byteLength,
          }),
        }) as never,
      async () => ({ env, threadId: "thr_1", workspaceId: "ws_1" }) as never,
    );
    const execute = (
      tools.exec_publish_artifact as { execute: (input: unknown) => Promise<unknown> }
    ).execute;

    const result = (await execute({ path: "/workspace/dist" })) as { ok?: boolean };

    expect(result).toMatchObject({ ok: false });
    expect(insertMock).not.toHaveBeenCalled();
    expect(listMock).toHaveBeenCalled();
    expect(deleteMock).toHaveBeenCalledWith("artifacts/art_x/index.html");
  });
});
