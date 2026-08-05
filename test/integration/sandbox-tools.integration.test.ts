/**
 * Exercises the model-facing `exec_upload_file`/`exec_download_file` tool
 * definitions (src/agent/compute-tools.ts) end to end against real D1 + R2
 * bindings. This is integration-level (not unit) because the tools reach
 * `AttachmentRepository` (drizzle-over-D1) and `env.ATTACHMENTS_BUCKET`
 * directly — faking those out would mean re-implementing D1/R2 semantics,
 * which is exactly what `cloudflare:test` already provides for us.
 *
 * The compute backend itself is the in-memory `FakeComputeBackend`, so
 * these tests only cover the Nadi-side plumbing (attachment lookup, R2
 * read/write, attachment row creation, size-cap enforcement) rather than any
 * real compute runtime.
 */
import { env } from "cloudflare:test";
import { beforeAll, describe, expect, it } from "vitest";
import { buildComputeToolDefs } from "../../src/agent/compute-tools";
import { AttachmentRepository } from "../../src/db/attachment-repository";
import { ArtifactRepository } from "../../src/db/artifact-repository";
import { DEFAULT_COMPUTE_LIMITS } from "../../src/compute/config";
import { FakeComputeBackend } from "../../src/compute/backends/fake";
import { ThreadComputeService } from "../../src/compute/thread-service";
import { DEFAULT_MONITOR_POLL_INTERVAL_MS } from "../../src/compute/watchers";
import { createMemoryComputeStore } from "../unit/compute/helpers/memory-store";
import { applyRegistryTestSchema, seedRegistryThread } from "./helpers/registry";

const WORKSPACE_ID = "ws-sbx-files";
const THREAD_ID = "thr-sbx-files";

beforeAll(async () => {
  await applyRegistryTestSchema(env.REGISTRY_DB);
  await seedRegistryThread(env.REGISTRY_DB, { threadId: THREAD_ID, workspaceId: WORKSPACE_ID });
});

function buildTools(backend: FakeComputeBackend) {
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
      environmentEditableEnv: {},
      environmentSecretEnvNames: [],
    },
    environmentId: "fake-env",
    env: {},
    setAlarm: async () => {},
    now: () => 1000,
  });
  return buildComputeToolDefs(
    async () => service,
    async () => ({ env, threadId: THREAD_ID, workspaceId: WORKSPACE_ID }),
  );
}

describe("sandbox file transfer tools", () => {
  it("exec_upload_file rejects an unknown source attachment id", async () => {
    const tools = buildTools(new FakeComputeBackend());
    const result = await tools.exec_upload_file!.execute!(
      { sourceAttachmentId: "att-does-not-exist", destinationPath: "/tmp/out.txt" },
      {} as never,
    );
    expect(result).toEqual({ ok: false, error: "sandbox_upload_source_not_found" });
  });

  it("exec_upload_file rejects an attachment that belongs to a different thread", async () => {
    const repo = new AttachmentRepository(env.REGISTRY_DB);
    await env.ATTACHMENTS_BUCKET.put(
      "ws-sbx-files/other-thread/foreign.txt",
      new TextEncoder().encode("nope"),
    );
    await repo.insert({
      id: "att-foreign",
      workspaceId: WORKSPACE_ID,
      threadId: "other-thread",
      mimeType: "text/plain",
      filename: "foreign.txt",
      byteSize: 4,
      r2Key: "ws-sbx-files/other-thread/foreign.txt",
      status: "committed",
      createdAt: Date.now(),
    });

    const tools = buildTools(new FakeComputeBackend());
    const result = await tools.exec_upload_file!.execute!(
      { sourceAttachmentId: "att-foreign", destinationPath: "/tmp/out.txt" },
      {} as never,
    );
    expect(result).toEqual({ ok: false, error: "sandbox_upload_source_not_found" });
  });

  it("exec_upload_file fetches the R2 body and passes bytes through to the provider", async () => {
    const repo = new AttachmentRepository(env.REGISTRY_DB);
    const bytes = new TextEncoder().encode("upload me please");
    await env.ATTACHMENTS_BUCKET.put(`${WORKSPACE_ID}/${THREAD_ID}/att-src.txt`, bytes);
    await repo.insert({
      id: "att-src",
      workspaceId: WORKSPACE_ID,
      threadId: THREAD_ID,
      mimeType: "text/plain",
      filename: "src.txt",
      byteSize: bytes.byteLength,
      r2Key: `${WORKSPACE_ID}/${THREAD_ID}/att-src.txt`,
      status: "committed",
      createdAt: Date.now(),
    });

    const provider = new FakeComputeBackend();
    const tools = buildTools(provider);
    const uploadResult = await tools.exec_upload_file!.execute!(
      { sourceAttachmentId: "att-src", destinationPath: "/tmp/received.txt" },
      {} as never,
    );
    expect(uploadResult).toEqual({ ok: true, destinationPath: "/tmp/received.txt" });

    // Confirm the exact bytes reached the (fake) sandbox provider by reading
    // them back through the provider's own download path.
    const downloadResult = await tools.exec_download_file!.execute!(
      { path: "/tmp/received.txt" },
      {} as never,
    );
    expect(downloadResult).toMatchObject({ filename: "received.txt" });
    const attachmentId = (downloadResult as { attachmentId: string }).attachmentId;
    const stored = await new AttachmentRepository(env.REGISTRY_DB).getByIdInThread(
      attachmentId,
      THREAD_ID,
    );
    const storedObject = await env.ATTACHMENTS_BUCKET.get(stored!.r2Key);
    expect(new TextDecoder().decode(await storedObject!.arrayBuffer())).toBe("upload me please");
  });

  it("exec_download_file stores downloaded bytes as a thread-scoped committed attachment", async () => {
    const provider = new FakeComputeBackend();
    const tools = buildTools(provider);

    await tools.exec_upload_file!.execute!(
      {
        sourceAttachmentId: await seedSourceAttachment("att-for-download", "hello sandbox file"),
        destinationPath: "/tmp/download-me.txt",
      },
      {} as never,
    );

    const result = (await tools.exec_download_file!.execute!(
      { path: "/tmp/download-me.txt", artifactName: "custom-name.txt" },
      {} as never,
    )) as { attachmentId: string; filename: string; byteSize: number };

    expect(result.filename).toBe("custom-name.txt");
    expect(result.byteSize).toBe(new TextEncoder().encode("hello sandbox file").byteLength);

    const row = await new AttachmentRepository(env.REGISTRY_DB).getByIdInThread(
      result.attachmentId,
      THREAD_ID,
    );
    expect(row).not.toBeNull();
    expect(row?.status).toBe("committed");
    expect(row?.workspaceId).toBe(WORKSPACE_ID);
    expect(row?.threadId).toBe(THREAD_ID);

    const object = await env.ATTACHMENTS_BUCKET.get(row!.r2Key);
    expect(new TextDecoder().decode(await object!.arrayBuffer())).toBe("hello sandbox file");
  });

  it("enforces the size cap before storing large downloaded data as an attachment", async () => {
    const provider = new FakeComputeBackend();
    const tools = buildTools(provider);
    const sourceAttachmentId = await seedSourceAttachment(
      "att-for-oversized-download",
      "this payload is definitely larger than four bytes",
    );
    await tools.exec_upload_file!.execute!(
      { sourceAttachmentId, destinationPath: "/tmp/too-big.txt" },
      {} as never,
    );

    const before = (await new AttachmentRepository(env.REGISTRY_DB).listByThread(THREAD_ID)).length;

    const result = await tools.exec_download_file!.execute!(
      { path: "/tmp/too-big.txt", maxBytes: 4 },
      {} as never,
    );

    // The compute backend rejects an oversized read as a ComputeError; the tool
    // surfaces its code + message.
    expect(result).toEqual({
      ok: false,
      error: "compute_file_too_large",
      detail: "sandbox_file_too_large",
    });
    const after = await new AttachmentRepository(env.REGISTRY_DB).listByThread(THREAD_ID);
    expect(after.length).toBe(before);
  });

  it("exec_publish_artifact walks a sandbox directory into R2 and records an artifact row", async () => {
    const provider = new FakeComputeBackend();
    const tools = buildTools(provider);

    await tools.exec_upload_file!.execute!(
      {
        sourceAttachmentId: await seedSourceAttachment("att-index", "<html></html>"),
        destinationPath: "/tmp/site/index.html",
      },
      {} as never,
    );
    await tools.exec_upload_file!.execute!(
      {
        sourceAttachmentId: await seedSourceAttachment("att-css", "body {}"),
        destinationPath: "/tmp/site/style.css",
      },
      {} as never,
    );

    const result = (await tools.exec_publish_artifact!.execute!(
      { path: "/tmp/site", title: "Preview Site" },
      {} as never,
    )) as {
      artifactId: string;
      title: string;
      entryPath: string;
      fileCount: number;
      byteSize: number;
      url: string;
    };

    expect(result.title).toBe("Preview Site");
    expect(result.entryPath).toBe("index.html");
    expect(result.fileCount).toBe(2);
    expect(result.url).toBe(`/api/artifacts/${result.artifactId}`);

    const row = await new ArtifactRepository(env.REGISTRY_DB).getByIdInThread(
      result.artifactId,
      THREAD_ID,
    );
    expect(row).not.toBeNull();
    expect(row?.status).toBe("active");
    expect(row?.r2Prefix).toBe(`artifacts/${result.artifactId}/`);

    const htmlObject = await env.ATTACHMENTS_BUCKET.get(`${row!.r2Prefix}index.html`);
    expect(new TextDecoder().decode(await htmlObject!.arrayBuffer())).toBe("<html></html>");
    const cssObject = await env.ATTACHMENTS_BUCKET.get(`${row!.r2Prefix}style.css`);
    expect(new TextDecoder().decode(await cssObject!.arrayBuffer())).toBe("body {}");
  });
});

/** Seeds a committed thread attachment in D1+R2 and returns its id. */
async function seedSourceAttachment(id: string, content: string): Promise<string> {
  const bytes = new TextEncoder().encode(content);
  const r2Key = `${WORKSPACE_ID}/${THREAD_ID}/${id}.txt`;
  await env.ATTACHMENTS_BUCKET.put(r2Key, bytes);
  await new AttachmentRepository(env.REGISTRY_DB).insert({
    id,
    workspaceId: WORKSPACE_ID,
    threadId: THREAD_ID,
    mimeType: "text/plain",
    filename: `${id}.txt`,
    byteSize: bytes.byteLength,
    r2Key,
    status: "committed",
    createdAt: Date.now(),
  });
  return id;
}
