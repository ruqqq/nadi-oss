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
      environmentEditableEnv: {},
      environmentSecretEnvNames: [],
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
    expect(published.files.find((f) => f.relativePath === "index.html")?.mimeType).toBe("text/html");
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
});

describe("exec_publish_artifact tool", () => {
  function makePublishTool(published: {
    files: Array<{ relativePath: string; bytes: ArrayBuffer; mimeType: string }>;
    totalBytes: number;
  }) {
    const putMock = vi.fn(async () => {});
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
});
