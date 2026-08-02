import { env, runInDurableObject } from "cloudflare:test";
import { beforeAll, describe, expect, it } from "vitest";
import type { ThreadAgentV2 } from "../../src/agent/thread-agent";
import { applyRegistryTestSchema, seedRegistryThread } from "./helpers/registry";

describe("ThreadAgentV2 draft persistence", () => {
  beforeAll(async () => {
    await applyRegistryTestSchema(env.REGISTRY_DB);
  });

  it("defaults to empty, round-trips, and clears on whitespace-only text", async () => {
    await seedRegistryThread(env.REGISTRY_DB, { threadId: "thr_draft" });
    const stub = env.THREAD_AGENT.get(env.THREAD_AGENT.idFromName("thr_draft"));

    await runInDurableObject(stub, async (agent: ThreadAgentV2) => {
      expect(await agent.getDraft()).toBe("");

      await agent.setDraft("half-written message");
      expect(await agent.getDraft()).toBe("half-written message");

      await agent.setDraft("   ");
      expect(await agent.getDraft()).toBe("");
    });
  });
});
