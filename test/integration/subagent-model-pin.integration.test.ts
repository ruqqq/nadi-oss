import { env, runInDurableObject } from "cloudflare:test";
import { beforeAll, describe, expect, it } from "vitest";
import { applyRegistryTestSchema, seedRegistryThread } from "./helpers/registry";
import type { SubAgent } from "../../src/agent/subagent";

// TEST-ONLY: `SUB_AGENT` is a test-only Miniflare binding (see vitest.config.ts)
// for a facet-only class with no wrangler.jsonc binding, so it's not present in
// the generated worker-configuration.d.ts. Augment `Cloudflare.Env` here so the
// binding is typed for this test file without touching the generated types —
// same pattern as `subagent.integration.test.ts`.
declare global {
  namespace Cloudflare {
    interface Env {
      SUB_AGENT: DurableObjectNamespace<SubAgent>;
    }
  }
}

type SubAgentTestSeam = SubAgent & {
  _testSubagentContext?: {
    parentThreadId: string;
    workspaceId: string;
    agentId: string;
    attachedRuntime: { provider: string; version: 1; payload: Record<string, string> };
  };
  __unsafe_ensureInitialized(): Promise<void>;
};

// `runInDurableObject`'s generic inference blows up ("Type instantiation is
// excessively deep") against Think's deeply generic Session/TurnConfig types —
// same workaround as `subagent.integration.test.ts` and
// `think-thread-agent.integration.test.ts`.
const runInSubAgentDo = runInDurableObject as any;

function subagentContextFor(threadId: string, workspaceId: string, agentId: string) {
  return {
    parentThreadId: threadId,
    workspaceId,
    agentId,
    attachedRuntime: {
      provider: "daytona" as const,
      version: 1 as const,
      payload: { kind: "runtime", sandboxId: "fake_sbx_pin" },
    },
  };
}

/**
 * Writes directly to `thread_index.model_provider`/`model`/`model_input_modalities`
 * — the row a mid-conversation model-switch commit lands on (see
 * `model-switch-commit.integration.test.ts`). Bypassing the commit machinery
 * here is deliberate: this file is only exercising what a subagent reads AFTER
 * a switch has already landed, not the switch itself.
 *
 * `model_input_modalities` has to be set alongside provider/model:
 * `resolveThreadRuntimeConfigForAgent`'s `useThreadSnapshot` check
 * (thread-agent-config.ts) requires all three to be valid before it will read
 * the thread's own snapshot instead of falling back to the agent's default —
 * a provider/model-only update silently no-ops.
 */
async function setThreadModel(threadId: string, provider: string, model: string) {
  await env.REGISTRY_DB.prepare(
    "UPDATE thread_index SET model_provider = ?, model = ?, model_input_modalities = ? WHERE id = ?",
  )
    .bind(provider, model, JSON.stringify(["text"]), threadId)
    .run();
}

describe("SubAgent model pin (integration)", () => {
  beforeAll(async () => {
    await applyRegistryTestSchema(env.REGISTRY_DB);
  });

  it("pins the parent's model on the first turn", async () => {
    const { threadId, workspaceId, agentId } = await seedRegistryThread(env.REGISTRY_DB, {
      threadId: "sub_pin_parent_first",
      workspaceId: "ws-sub-pin-first",
      provider: "openai",
      model: "gpt-5",
    });
    const stub = env.SUB_AGENT.get(env.SUB_AGENT.idFromName("sub_pin_run_first"));

    const model = await runInSubAgentDo(stub, async (child: SubAgentTestSeam) => {
      child._testSubagentContext = subagentContextFor(threadId, workspaceId, agentId);
      await child.__unsafe_ensureInitialized();
      const config = await child.resolveRuntimeConfigForThink();
      return config.modelConfig.model;
    });

    expect(model).toBe("gpt-5");
  });

  it("keeps the pin when the parent switches mid-run", async () => {
    const { threadId, workspaceId, agentId } = await seedRegistryThread(env.REGISTRY_DB, {
      threadId: "sub_pin_parent_midrun",
      workspaceId: "ws-sub-pin-midrun",
      provider: "openai",
      model: "gpt-5",
    });
    const stub = env.SUB_AGENT.get(env.SUB_AGENT.idFromName("sub_pin_run_midrun"));

    const secondModel = await runInSubAgentDo(stub, async (child: SubAgentTestSeam) => {
      child._testSubagentContext = subagentContextFor(threadId, workspaceId, agentId);
      await child.__unsafe_ensureInitialized();
      // First turn: pins "gpt-5" on the facet's own storage.
      await child.resolveRuntimeConfigForThink();
      // The parent's row now points at a different model — as if the user
      // switched mid-conversation while this run was in flight.
      await setThreadModel(threadId, "anthropic", "claude-opus-5");
      const config = await child.resolveRuntimeConfigForThink();
      return config.modelConfig.model;
    });

    // The pin wins: the run's model does not move underneath it.
    expect(secondModel).toBe("gpt-5");
  });

  it("a subagent created after the switch gets the new model", async () => {
    const { threadId, workspaceId, agentId } = await seedRegistryThread(env.REGISTRY_DB, {
      threadId: "sub_pin_parent_after",
      workspaceId: "ws-sub-pin-after",
      provider: "anthropic",
      model: "claude-opus-5",
    });
    const stub = env.SUB_AGENT.get(env.SUB_AGENT.idFromName("sub_pin_run_after"));

    const model = await runInSubAgentDo(stub, async (child: SubAgentTestSeam) => {
      child._testSubagentContext = subagentContextFor(threadId, workspaceId, agentId);
      await child.__unsafe_ensureInitialized();
      // No prior pin on this fresh facet: the first call pins whatever the
      // parent's row says right now, i.e. the post-switch model.
      const config = await child.resolveRuntimeConfigForThink();
      return config.modelConfig.model;
    });

    expect(model).toBe("claude-opus-5");
  });
});
