import { env } from "cloudflare:test";
import { beforeAll, describe, expect, it } from "vitest";
import { AttachmentRepository } from "../../src/db/attachment-repository";
import { applyRegistryTestSchema, seedRegistryThread } from "./helpers/registry";

beforeAll(async () => {
  await applyRegistryTestSchema(env.REGISTRY_DB);
  await seedRegistryThread(env.REGISTRY_DB, { threadId: "th-att" });
});

function repo() {
  return new AttachmentRepository(env.REGISTRY_DB);
}

const base = {
  workspaceId: "ws-test",
  threadId: "th-att",
  mimeType: "image/png",
  byteSize: 1234,
  width: 800,
  height: 600,
  r2Key: "ws-test/th-att/a.png",
  status: "pending" as const,
  createdAt: 1,
};

describe("AttachmentRepository", () => {
  it("inserts and reads back within the thread", async () => {
    await repo().insert({ ...base, id: "att-1" });
    const row = await repo().getByIdInThread("att-1", "th-att");
    expect(row?.r2Key).toBe("ws-test/th-att/a.png");
    expect(row?.status).toBe("pending");
  });

  it("scopes getByIdInThread to the thread", async () => {
    await repo().insert({ ...base, id: "att-2" });
    expect(await repo().getByIdInThread("att-2", "other-thread")).toBeNull();
  });

  it("lists only the thread's attachments and marks committed", async () => {
    await repo().insert({ ...base, id: "att-3", threadId: "th-att" });
    await repo().insert({ ...base, id: "att-4", threadId: "th-other", r2Key: "x" });
    const rows = await repo().listByThread("th-att");
    expect(rows.map((r) => r.id)).toContain("att-3");
    expect(rows.map((r) => r.id)).not.toContain("att-4");
    // Fix 2: markCommitted now requires threadId as second argument.
    await repo().markCommitted(["att-3"], "th-att");
    expect((await repo().getByIdInThread("att-3", "th-att"))?.status).toBe("committed");
  });

  // Fix 2: thread-scoped commit — wrong threadId must not flip another thread's attachment.
  it("markCommitted with wrong threadId does not commit a foreign attachment", async () => {
    await repo().insert({
      ...base,
      id: "att-5-foreign",
      threadId: "th-att",
      r2Key: "ws-test/th-att/e.png",
    });
    // Pass the wrong thread — the row belongs to "th-att" but we claim "th-wrong".
    await repo().markCommitted(["att-5-foreign"], "th-wrong");
    // Row must still be pending.
    const row = await repo().getByIdInThread("att-5-foreign", "th-att");
    expect(row?.status).toBe("pending");
    // Correct-scope call should succeed.
    await repo().markCommitted(["att-5-foreign"], "th-att");
    expect((await repo().getByIdInThread("att-5-foreign", "th-att"))?.status).toBe("committed");
  });
});
