import { env, runInDurableObject } from "cloudflare:test";
import { drizzle } from "drizzle-orm/d1";
import { beforeAll, describe, expect, it } from "vitest";
import type { ThinkThreadAgent } from "../../src/agent/think-thread-agent";
import { AgentSkillRepository } from "../../src/db/repositories/agent-skills";
import * as schema from "../../src/db/schema";
import { applyRegistryTestSchema, seedRegistryThread } from "./helpers/registry";

const scope = { workspaceId: "workspace-script-gate", agentId: "agent-script-gate" };

beforeAll(async () => {
  await applyRegistryTestSchema(env.REGISTRY_DB);
  await seedRegistryThread(env.REGISTRY_DB, {
    ...scope,
    threadId: "script-gate",
    runtime: "think",
    provider: "mock",
    model: "mock",
  });
  const repo = new AgentSkillRepository(drizzle(env.REGISTRY_DB, { schema }));
  await repo.create({ ...scope, name: "fetcher", description: "d", body: "b" });
  await repo.setScript({
    ...scope,
    name: "fetcher",
    path: "scripts/run.py",
    source: "print('hi')",
  });
});

describe("getSkillScriptRunner gating", () => {
  it("is null when the sandbox is disabled, even with a script skill", async () => {
    const stub = env.THINK_THREAD_AGENT.get(env.THINK_THREAD_AGENT.idFromName("script-gate"));
    const runnerIsNull = await runInDurableObject(stub, async (instance: ThinkThreadAgent) => {
      await instance.getSkills(); // resolves + caches the gate
      return instance.getSkillScriptRunner() === null;
    });
    expect(runnerIsNull).toBe(true);
  });
});
