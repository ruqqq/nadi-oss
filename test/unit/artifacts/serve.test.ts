import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ArtifactRow } from "../../../src/db/schema";
import { deriveArtifactViewSecret, signArtifactViewToken } from "../../../src/artifacts/view-token";
import { handleArtifactHostRequest } from "../../../src/artifacts/serve";
import type { Env } from "../../../src/env";

const BETTER_AUTH_SECRET = "test-better-auth-secret-with-enough-entropy";
const ARTIFACT_ID = "art_test123";
const NOW = 1_000_000;

const { getById, markExpired } = vi.hoisted(() => ({
  getById: vi.fn(),
  markExpired: vi.fn(async () => {}),
}));

vi.mock("../../../src/db/artifact-repository", () => ({
  ArtifactRepository: vi.fn(function ArtifactRepository() {
    return { getById, markExpired };
  }),
}));

function activeRow(overrides: Partial<ArtifactRow> = {}): ArtifactRow {
  return {
    id: ARTIFACT_ID,
    workspaceId: "ws-test",
    threadId: "th-art",
    title: "Dashboard",
    entryPath: "index.html",
    fileCount: 1,
    byteSize: 128,
    r2Prefix: `artifacts/${ARTIFACT_ID}/`,
    status: "active",
    expiresAt: NOW + 86_400_000,
    createdAt: 1,
    ...overrides,
  };
}

async function signedToken(exp = NOW + 900_000): Promise<string> {
  const secret = await deriveArtifactViewSecret(BETTER_AUTH_SECRET);
  return signArtifactViewToken(secret, { artifactId: ARTIFACT_ID, exp });
}

function makeEnv(bucket: Env["ATTACHMENTS_BUCKET"]): Env {
  return {
    BETTER_AUTH_SECRET,
    REGISTRY_DB: {} as D1Database,
    ATTACHMENTS_BUCKET: bucket,
  } as unknown as Env;
}

function htmlBucket(body = "<html></html>") {
  return {
    get: vi.fn(async (key: string) => ({
      body,
      httpMetadata: { contentType: "text/html; charset=utf-8" },
      key,
    })),
    list: vi.fn(async () => ({ objects: [], truncated: false })),
    delete: vi.fn(async () => {}),
  } as unknown as R2Bucket;
}

describe("handleArtifactHostRequest", () => {
  beforeEach(() => {
    getById.mockReset();
    markExpired.mockReset();
    vi.useFakeTimers();
    vi.setSystemTime(NOW);
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("serves the entry file with security headers when token and object are valid", async () => {
    getById.mockResolvedValue(activeRow());
    const bucket = htmlBucket();
    const token = await signedToken();
    const req = new Request(`https://artifacts.example/v/${token}/${ARTIFACT_ID}/`);

    const res = await handleArtifactHostRequest(req, makeEnv(bucket));

    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toBe("text/html");
    expect(res.headers.get("x-content-type-options")).toBe("nosniff");
    expect(res.headers.get("cache-control")).toBe("private, max-age=300");
    expect(bucket.get).toHaveBeenCalledWith(`artifacts/${ARTIFACT_ID}/index.html`);
    expect(await res.text()).toBe("<html></html>");
  });

  it("joins r2Prefix with a normalized relative asset path", async () => {
    getById.mockResolvedValue(activeRow());
    const bucket = htmlBucket("body{font-family:sans-serif}");
    const token = await signedToken();
    const req = new Request(
      `https://artifacts.example/v/${token}/${ARTIFACT_ID}/assets/./style.css`,
    );

    const res = await handleArtifactHostRequest(req, makeEnv(bucket));

    expect(res.status).toBe(200);
    expect(bucket.get).toHaveBeenCalledWith(`artifacts/${ARTIFACT_ID}/assets/style.css`);
  });

  it("returns 401 for an invalid token", async () => {
    getById.mockResolvedValue(activeRow());
    const req = new Request(`https://artifacts.example/v/not-a-token/${ARTIFACT_ID}/`);

    const res = await handleArtifactHostRequest(req, makeEnv(htmlBucket()));

    expect(res.status).toBe(401);
    expect(getById).not.toHaveBeenCalled();
  });

  it("returns 410 and keeps R2 objects so the artifact can be republished", async () => {
    getById.mockResolvedValue(activeRow({ expiresAt: NOW - 1 }));
    const bucket = {
      get: vi.fn(),
      list: vi.fn(async () => ({
        objects: [{ key: `artifacts/${ARTIFACT_ID}/index.html` }],
        truncated: false,
      })),
      delete: vi.fn(async () => {}),
    } as unknown as R2Bucket;
    const token = await signedToken();
    const req = new Request(`https://artifacts.example/v/${token}/${ARTIFACT_ID}/`);

    const res = await handleArtifactHostRequest(req, makeEnv(bucket));

    expect(res.status).toBe(410);
    expect(markExpired).toHaveBeenCalledWith(ARTIFACT_ID);
    expect(bucket.list).not.toHaveBeenCalled();
    expect(bucket.delete).not.toHaveBeenCalled();
  });

  it("returns 410 and keeps files when status is already expired", async () => {
    getById.mockResolvedValue(activeRow({ status: "expired" }));
    const bucket = {
      get: vi.fn(),
      list: vi.fn(async () => ({ objects: [], truncated: false })),
      delete: vi.fn(async () => {}),
    } as unknown as R2Bucket;
    const token = await signedToken();
    const req = new Request(`https://artifacts.example/v/${token}/${ARTIFACT_ID}/`);

    const res = await handleArtifactHostRequest(req, makeEnv(bucket));

    expect(res.status).toBe(410);
    expect(markExpired).toHaveBeenCalledWith(ARTIFACT_ID);
    expect(bucket.delete).not.toHaveBeenCalled();
  });

  it("returns 404 for parent traversal in the relative path", async () => {
    getById.mockResolvedValue(activeRow());
    const token = await signedToken();
    const req = new Request(`https://artifacts.example/v/${token}/${ARTIFACT_ID}/../secret.txt`);

    const res = await handleArtifactHostRequest(req, makeEnv(htmlBucket()));

    expect(res.status).toBe(404);
  });

  it("sets Content-Disposition attachment for octet-stream without metadata", async () => {
    getById.mockResolvedValue(activeRow({ entryPath: "data.bin" }));
    const bucket = {
      get: vi.fn(async () => ({ body: "raw", httpMetadata: undefined })),
      list: vi.fn(),
      delete: vi.fn(),
    } as unknown as R2Bucket;
    const token = await signedToken();
    const req = new Request(`https://artifacts.example/v/${token}/${ARTIFACT_ID}/`);

    const res = await handleArtifactHostRequest(req, makeEnv(bucket));

    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toBe("application/octet-stream");
    expect(res.headers.get("content-disposition")).toBe('attachment; filename="data.bin"');
  });

  it("returns 404 for non-artifact paths on the artifact host", async () => {
    const res = await handleArtifactHostRequest(
      new Request("https://artifacts.example/"),
      makeEnv(htmlBucket()),
    );

    expect(res.status).toBe(404);
  });
});
