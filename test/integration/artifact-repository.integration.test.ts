import { env } from "cloudflare:test";
import { beforeAll, describe, expect, it } from "vitest";
import { ArtifactRepository } from "../../src/db/artifact-repository";
import { applyRegistryTestSchema, seedRegistryThread } from "./helpers/registry";

beforeAll(async () => {
  await applyRegistryTestSchema(env.REGISTRY_DB);
  await seedRegistryThread(env.REGISTRY_DB, { threadId: "th-art" });
});

function repo() {
  return new ArtifactRepository(env.REGISTRY_DB);
}

const base = {
  workspaceId: "ws-test",
  threadId: "th-art",
  title: "Dashboard",
  entryPath: "index.html",
  fileCount: 3,
  byteSize: 4096,
  r2Prefix: "ws-test/th-art/art-1/",
  status: "active" as const,
  expiresAt: 9_999_999_999,
  createdAt: 1,
};

describe("ArtifactRepository", () => {
  it("inserts and reads back by id and within the thread", async () => {
    await repo().insert({ ...base, id: "art-1" });
    const byId = await repo().getById("art-1");
    expect(byId?.r2Prefix).toBe("ws-test/th-art/art-1/");
    expect(byId?.status).toBe("active");

    const inThread = await repo().getByIdInThread("art-1", "th-art");
    expect(inThread?.title).toBe("Dashboard");
  });

  it("scopes getByIdInThread to the thread", async () => {
    await repo().insert({ ...base, id: "art-2" });
    expect(await repo().getByIdInThread("art-2", "other-thread")).toBeNull();
  });

  it("markExpired sets status to expired", async () => {
    await repo().insert({ ...base, id: "art-3" });
    await repo().markExpired("art-3");
    expect((await repo().getById("art-3"))?.status).toBe("expired");
  });

  it("lists a thread's artifacts newest first and ignores other threads", async () => {
    await repo().insert({ ...base, id: "art-old", createdAt: 10 });
    await repo().insert({ ...base, id: "art-new", createdAt: 30, title: "Newer" });
    await repo().insert({
      ...base,
      id: "art-other",
      threadId: "th-art-other",
      r2Prefix: "ws-test/th-art-other/art-other/",
      createdAt: 40,
    });

    const rows = await repo().listByThread("th-art");
    expect(rows.map((r) => r.id)).toEqual(["art-new", "art-old"]);
  });
});
