import { env, runInDurableObject } from "cloudflare:test";
import { beforeAll, describe, expect, it } from "vitest";
import { applyRegistryTestSchema, seedRegistryThread } from "./helpers/registry";

const runInThinkDo = runInDurableObject as any;

describe("exportHistory", () => {
  beforeAll(async () => {
    await applyRegistryTestSchema(env.REGISTRY_DB);
  });

  it("returns the DO's persisted messages verbatim", async () => {
    const { threadId } = await seedRegistryThread(env.REGISTRY_DB, {
      threadId: "thr_export",
      runtime: "think",
    });
    const stub = env.THINK_THREAD_AGENT.get(env.THINK_THREAD_AGENT.idFromName(threadId));
    const messages = [
      { id: "m1", role: "user", parts: [{ type: "text", text: "hello" }] },
      { id: "m2", role: "assistant", parts: [{ type: "text", text: "hi" }] },
    ];
    await runInThinkDo(stub, async (instance: any) => {
      await instance.__unsafe_ensureInitialized();
      await instance.addMessages(messages);
    });
    const exported = await (stub as any).exportHistory();
    expect(exported).toEqual(messages);
  });
});
