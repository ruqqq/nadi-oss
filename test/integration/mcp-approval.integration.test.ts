import { env, runInDurableObject } from "cloudflare:test";
import { beforeAll, describe, expect, it } from "vitest";
import type { ThreadAgent } from "../../src/agent/thread-agent";
import { applyRegistryTestSchema, seedRegistryThread } from "./helpers/registry";

beforeAll(async () => {
  await applyRegistryTestSchema(env.REGISTRY_DB);
  await seedRegistryThread(env.REGISTRY_DB, { threadId: "legacy-mcp-stub" });
});

describe("ThreadAgent MCP approval legacy stub", () => {
  it("does not expose the legacy MCP/model run loop", async () => {
    const stub = env.THREAD_AGENT.get(env.THREAD_AGENT.idFromName("legacy-mcp-stub"));

    const result = await runInDurableObject(stub, async (instance: ThreadAgent) => {
      const response = await instance.onChatMessage(async () => {});
      return {
        status: response?.status,
        body: response ? ((await response.json()) as { error?: string }) : null,
      };
    });

    expect(result.status).toBe(410);
    expect(result.body?.error).toBe("legacy_thread_runtime_unavailable");
  });
});
