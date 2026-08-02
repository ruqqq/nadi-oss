import { env } from "cloudflare:test";
import { beforeEach, describe, expect, it } from "vitest";
import { AttachmentRepository } from "../../src/db/attachment-repository";
import { createAttachmentTools } from "../../src/agent/attachment-tools";
import { applyRegistryTestSchema, seedRegistryThread } from "./helpers/registry";

beforeEach(async () => {
  await applyRegistryTestSchema(env.REGISTRY_DB);
  await seedRegistryThread(env.REGISTRY_DB, { threadId: "th-tools" });
  const repo = new AttachmentRepository(env.REGISTRY_DB);
  await repo.insert({
    id: "tool-att-1",
    workspaceId: "ws",
    threadId: "th-tools",
    mimeType: "image/png",
    filename: "photo.png",
    byteSize: 10,
    width: 100,
    height: 80,
    r2Key: "ws/th-tools/tool-att-1.png",
    status: "committed",
    extractedText: "A screenshot showing an approval dialog for a daily briefing automaton.",
    extractedSource: "workers-ai-moondream",
    extractedAt: 2,
    createdAt: 1,
  });
  await repo.insert({
    id: "tool-att-other",
    workspaceId: "ws",
    threadId: "th-elsewhere",
    mimeType: "image/png",
    byteSize: 10,
    width: 1,
    height: 1,
    r2Key: "ws/th-elsewhere/x.png",
    status: "committed",
    createdAt: 1,
  });
});

describe("attachment tools", () => {
  it("listAttachments returns only this thread's attachments", async () => {
    const tools = createAttachmentTools({ env, threadId: "th-tools" });
    const out = (await tools.listAttachments.execute!({}, {} as never)) as string;
    expect(out).toContain("tool-att-1");
    expect(out).not.toContain("tool-att-other");
  });

  it("getAttachmentUrl signs a url for an in-thread attachment", async () => {
    const tools = createAttachmentTools({ env, threadId: "th-tools" });
    const out = (await tools.getAttachmentUrl.execute!(
      { attachmentId: "tool-att-1" },
      {} as never,
    )) as string;
    expect(out).toContain("r2.cloudflarestorage.com");
    expect(out).toContain("X-Amz-Signature=");
  });

  it("getAttachmentUrl refuses a cross-thread id", async () => {
    const tools = createAttachmentTools({ env, threadId: "th-tools" });
    const out = (await tools.getAttachmentUrl.execute!(
      { attachmentId: "tool-att-other" },
      {} as never,
    )) as string;
    expect(out).toContain("error");
  });

  it("listAttachments includes filename", async () => {
    const tools = createAttachmentTools({ env, threadId: "th-tools" });
    const out = (await tools.listAttachments.execute!({}, {} as never)) as string;
    expect(out).toContain("photo.png");
    expect(out).toContain("filename");
  });

  it("listAttachments includes generated extraction context when available", async () => {
    const tools = createAttachmentTools({ env, threadId: "th-tools" });
    const out = (await tools.listAttachments.execute!({}, {} as never)) as string;
    const parsed = JSON.parse(out);
    expect(parsed[0]).toMatchObject({
      id: "tool-att-1",
      extraction: {
        status: "available",
        source: "workers-ai-moondream",
        text: "A screenshot showing an approval dialog for a daily briefing automaton.",
        truncated: false,
      },
    });
  });

  it("getAttachmentUrl description does not encourage OCR when extracted context exists", () => {
    const tools = createAttachmentTools({ env, threadId: "th-tools" });
    expect(tools.getAttachmentUrl.description).toContain("raw file");
    expect(tools.getAttachmentUrl.description).not.toContain("OCR");
  });
});
