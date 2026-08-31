/**
 * End-to-end artifact flow: sandbox publish → R2 → signed view token → ARTIFACTS_HOST serve.
 */
import { SELF, env } from "cloudflare:test";
import { afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import { drizzle } from "drizzle-orm/d1";
import { buildComputeToolDefs } from "../../src/agent/compute-tools";
import { deriveArtifactViewSecret, signArtifactViewToken } from "../../src/artifacts/view-token";
import { DEFAULT_COMPUTE_LIMITS } from "../../src/compute/config";
import { FakeComputeBackend } from "../../src/compute/backends/fake";
import { ThreadComputeService } from "../../src/compute/thread-service";
import { DEFAULT_MONITOR_POLL_INTERVAL_MS } from "../../src/compute/watchers";
import { AttachmentRepository } from "../../src/db/attachment-repository";
import { ArtifactRepository } from "../../src/db/artifact-repository";
import * as schema from "../../src/db/schema";
import { createMemoryComputeStore } from "../unit/compute/helpers/memory-store";
import { applyRegistryTestSchema, seedRegistryThread } from "./helpers/registry";

const WORKSPACE_ID = "ws-artifacts-e2e";
const THREAD_ID = "thr-artifacts-e2e";
const ARTIFACTS_HOST = "artifacts.localhost";
const SITE_PATH = "/tmp/site";

const HTML = `<!DOCTYPE html>
<html><head><link rel="stylesheet" href="./app.css"></head><body>Hello artifact</body></html>`;
const CSS = "body { color: red; }";

type EnvWithArtifactsHost = typeof env & { ARTIFACTS_HOST?: string };

let previousArtifactsHost: string | undefined;

beforeAll(async () => {
  await applyRegistryTestSchema(env.REGISTRY_DB);
  await seedRegistryThread(env.REGISTRY_DB, { threadId: THREAD_ID, workspaceId: WORKSPACE_ID });
});

beforeEach(() => {
  previousArtifactsHost = (env as EnvWithArtifactsHost).ARTIFACTS_HOST;
  (env as EnvWithArtifactsHost).ARTIFACTS_HOST = ARTIFACTS_HOST;
});

afterEach(() => {
  if (previousArtifactsHost === undefined) {
    delete (env as EnvWithArtifactsHost).ARTIFACTS_HOST;
  } else {
    (env as EnvWithArtifactsHost).ARTIFACTS_HOST = previousArtifactsHost;
  }
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
    },
    environmentId: "fake-env",
    env: {},
    setAlarm: async () => {},
    now: () => Date.now(),
  });
  return buildComputeToolDefs(
    async () => service,
    async () => ({ env, threadId: THREAD_ID, workspaceId: WORKSPACE_ID }),
  );
}

async function seedSandboxSite(tools: ReturnType<typeof buildTools>) {
  await tools.exec_upload_file!.execute!(
    {
      sourceAttachmentId: await seedSourceAttachment("att-html", HTML),
      destinationPath: `${SITE_PATH}/index.html`,
    },
    {} as never,
  );
  await tools.exec_upload_file!.execute!(
    {
      sourceAttachmentId: await seedSourceAttachment("att-css", CSS),
      destinationPath: `${SITE_PATH}/app.css`,
    },
    {} as never,
  );
}

async function publishSite(tools: ReturnType<typeof buildTools>) {
  return (await tools.exec_publish_artifact!.execute!(
    { path: SITE_PATH, title: "Preview Site" },
    {} as never,
  )) as {
    artifactId: string;
    title: string;
    entryPath: string;
    fileCount: number;
    byteSize: number;
    url: string;
  };
}

async function mintViewToken(artifactId: string, exp = Date.now() + 15 * 60 * 1000) {
  const secret = await deriveArtifactViewSecret(env.BETTER_AUTH_SECRET);
  return signArtifactViewToken(secret, { artifactId, exp });
}

describe("artifacts publish and signed serve", () => {
  it("publishes sandbox site files to R2 and serves HTML and CSS on the artifact host", async () => {
    const tools = buildTools(new FakeComputeBackend());
    await seedSandboxSite(tools);

    const published = await publishSite(tools);
    expect(published.entryPath).toBe("index.html");
    expect(published.fileCount).toBe(2);

    const row = await new ArtifactRepository(env.REGISTRY_DB).getByIdInThread(
      published.artifactId,
      THREAD_ID,
    );
    expect(row).not.toBeNull();
    expect(row?.r2Prefix).toBe(`artifacts/${published.artifactId}/`);

    const htmlKey = `${row!.r2Prefix}index.html`;
    const cssKey = `${row!.r2Prefix}app.css`;
    expect(await env.ATTACHMENTS_BUCKET.get(htmlKey)).not.toBeNull();
    expect(await env.ATTACHMENTS_BUCKET.get(cssKey)).not.toBeNull();

    const token = await mintViewToken(published.artifactId);
    const entryUrl = `https://${ARTIFACTS_HOST}/v/${token}/${published.artifactId}/`;
    const entryRes = await SELF.fetch(entryUrl);
    expect(entryRes.status).toBe(200);
    expect(entryRes.headers.get("content-type")).toBe("text/html");
    expect(await entryRes.text()).toBe(HTML);

    const cssUrl = `https://${ARTIFACTS_HOST}/v/${token}/${published.artifactId}/app.css`;
    const cssRes = await SELF.fetch(cssUrl);
    expect(cssRes.status).toBe(200);
    expect(cssRes.headers.get("content-type")).toBe("text/css");
    expect(await cssRes.text()).toBe(CSS);
  });

  it("returns 401 for an invalid view token", async () => {
    const res = await SELF.fetch(`https://${ARTIFACTS_HOST}/v/not-a-valid-token/art_fake123/`);

    expect(res.status).toBe(401);
    expect(await res.text()).toBe("Unauthorized");
  });

  it("returns 410 when artifact expiresAt is in the past", async () => {
    const tools = buildTools(new FakeComputeBackend());
    await seedSandboxSite(tools);
    const published = await publishSite(tools);

    const db = drizzle(env.REGISTRY_DB, { schema });
    await db
      .update(schema.artifacts)
      .set({ expiresAt: Date.now() - 60_000 })
      .where(eq(schema.artifacts.id, published.artifactId));

    const token = await mintViewToken(published.artifactId);
    const res = await SELF.fetch(`https://${ARTIFACTS_HOST}/v/${token}/${published.artifactId}/`);

    expect(res.status).toBe(410);
    expect(await res.text()).toBe("Artifact expired");

    const row = await new ArtifactRepository(env.REGISTRY_DB).getById(published.artifactId);
    expect(row?.status).toBe("expired");
  });
});

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
