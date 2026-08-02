import { env, runInDurableObject } from "cloudflare:test";
import type { UIMessage } from "ai";
import { beforeAll, describe, expect, it } from "vitest";
import type { ThreadAgent } from "../../src/agent/thread-agent";
import { AttachmentRepository } from "../../src/db/attachment-repository";
import { applyRegistryTestSchema, seedRegistryThread } from "./helpers/registry";

beforeAll(async () => {
  await applyRegistryTestSchema(env.REGISTRY_DB);
  await seedRegistryThread(env.REGISTRY_DB, {
    workspaceId: "ws-legacy-imgchat",
    agentId: "agent-legacy-imgchat",
    threadId: "th-legacy-imgchat",
  });
  await env.ATTACHMENTS_BUCKET.put(
    "ws-legacy-imgchat/th-legacy-imgchat/pic.png",
    new Uint8Array([1, 2, 3]),
  );
  await new AttachmentRepository(env.REGISTRY_DB).insert({
    id: "legacy-pic",
    workspaceId: "ws-legacy-imgchat",
    threadId: "th-legacy-imgchat",
    mimeType: "image/png",
    byteSize: 3,
    width: 10,
    height: 10,
    r2Key: "ws-legacy-imgchat/th-legacy-imgchat/pic.png",
    status: "pending",
    createdAt: 1,
  });
});

describe("attachment chat legacy stub", () => {
  it("does not commit attachments by starting a legacy model turn", async () => {
    const stub = env.THREAD_AGENT.get(env.THREAD_AGENT.idFromName("th-legacy-imgchat"));
    const userMessage: UIMessage = {
      id: "u-legacy",
      role: "user",
      parts: [
        { type: "text", text: "what is this" },
        { type: "file", url: "/api/attachments/legacy-pic", mediaType: "image/png" },
      ],
    };

    const result = await runInDurableObject(stub, async (instance: ThreadAgent) => {
      const response = await instance.onChatMessage(async () => {});
      await instance.saveMessages([userMessage]);
      return { status: response?.status };
    });

    expect(result.status).toBe(410);
    const row = await new AttachmentRepository(env.REGISTRY_DB).getByIdInThread(
      "legacy-pic",
      "th-legacy-imgchat",
    );
    expect(row?.status).toBe("pending");
  });
});
