import { env } from "cloudflare:test";
import { beforeAll, beforeEach, describe, expect, it } from "vitest";
import { drizzle } from "drizzle-orm/d1";
import * as schema from "../../src/db/schema";
import { applyRegistryTestSchema } from "./helpers/registry";
import { ArchivedMessageRepository } from "../../src/db/repositories/archived-messages";

function repo() {
  return new ArchivedMessageRepository(drizzle(env.REGISTRY_DB, { schema }));
}

describe("ArchivedMessageRepository", () => {
  beforeAll(async () => {
    await applyRegistryTestSchema(env.REGISTRY_DB);
  });
  beforeEach(async () => {
    await drizzle(env.REGISTRY_DB, { schema }).delete(schema.archivedMessage);
  });

  it("stores messages as ordered rows and reads them back in order", async () => {
    const messages = [
      { id: "m1", role: "user", parts: [{ type: "text", text: "one" }] },
      { id: "m2", role: "assistant", parts: [{ type: "text", text: "two" }] },
    ];
    await repo().replaceForThread("thr_a", messages);
    expect(await repo().listForThread("thr_a")).toEqual(messages);
  });

  it("replaceForThread overwrites any existing rows idempotently", async () => {
    await repo().replaceForThread("thr_a", [{ id: "old", role: "user", parts: [] }]);
    await repo().replaceForThread("thr_a", [{ id: "new", role: "user", parts: [] }]);
    const rows = await repo().listForThread("thr_a");
    expect(rows).toHaveLength(1);
    expect((rows[0] as { id: string }).id).toBe("new");
  });

  it("deleteForThread removes only that thread's rows", async () => {
    await repo().replaceForThread("thr_a", [{ id: "a", role: "user", parts: [] }]);
    await repo().replaceForThread("thr_b", [{ id: "b", role: "user", parts: [] }]);
    await repo().deleteForThread("thr_a");
    expect(await repo().listForThread("thr_a")).toEqual([]);
    expect(await repo().listForThread("thr_b")).toHaveLength(1);
  });
});
