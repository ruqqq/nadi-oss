import { env, runInDurableObject } from "cloudflare:test";
import { beforeAll, describe, expect, it } from "vitest";
import { ThinkThreadAgent } from "../../src/agent/think-thread-agent";
import { applyRegistryTestSchema, seedRegistryThread } from "./helpers/registry";

type PrivateCommit = {
  commitPendingModelSwitch(): Promise<{
    from: { provider: string; model: string };
    to: { provider: string; model: string };
  } | null>;
};

async function readThreadIndexRow(threadId: string) {
  return env.REGISTRY_DB.prepare(
    "SELECT model_provider, model, model_input_modalities, show_reasoning, reasoning_effort, model_supports_reasoning, updated_at FROM thread_index WHERE id = ?",
  )
    .bind(threadId)
    .first<{
      model_provider: string | null;
      model: string | null;
      model_input_modalities: string | null;
      show_reasoning: number | null;
      reasoning_effort: string | null;
      model_supports_reasoning: number | null;
      updated_at: number;
    }>();
}

/**
 * `commitPendingModelSwitch` end to end: real DO storage for the pending
 * slot, real registry D1 for the write. `model-switch-commit.test.ts` (unit,
 * duck-typed `this`) proves the two branches that return before touching the
 * registry — nothing pending, and the incomplete-tool-call guard. This proves
 * everything that requires a real `thread_index` row: the six-column write,
 * that `updatedAt` is never part of it, and — via `beforeTurnProbeForTest`,
 * the same seam `think-thread-agent.integration.test.ts` uses to read a
 * turn's resolved model — that the switch lands on the SAME turn that
 * committed it rather than the next one.
 */
describe("commitPendingModelSwitch (integration)", () => {
  beforeAll(async () => {
    await applyRegistryTestSchema(env.REGISTRY_DB);
  });

  it("writes the six snapshot columns and clears the pending switch", async () => {
    const { threadId } = await seedRegistryThread(env.REGISTRY_DB, {
      threadId: "thr_commit_write",
    });
    const stub = env.THINK_THREAD_AGENT.get(env.THINK_THREAD_AGENT.idFromName(threadId));

    const result = await runInDurableObject(stub, async (agent: ThinkThreadAgent) => {
      await agent.setPendingModelSwitch({ provider: "mock-tool-call", model: "mock-model-2" });
      return (agent as unknown as PrivateCommit).commitPendingModelSwitch();
    });

    expect(result).toMatchObject({
      from: { provider: "mock", model: "mock" },
      to: { provider: "mock-tool-call", model: "mock-model-2" },
    });

    const row = await readThreadIndexRow(threadId);
    expect(row?.model_provider).toBe("mock-tool-call");
    expect(row?.model).toBe("mock-model-2");
    expect(row?.model_input_modalities).toBeTruthy();

    const pendingAfter = await runInDurableObject(stub, (agent: ThinkThreadAgent) =>
      agent.getPendingModelSwitch(),
    );
    expect(pendingAfter).toBeNull();
  });

  it("does NOT bump updatedAt as part of the snapshot write", async () => {
    const seededUpdatedAt = 1_800_000_555_000;
    const { threadId } = await seedRegistryThread(env.REGISTRY_DB, {
      threadId: "thr_commit_no_bump",
      updatedAt: seededUpdatedAt,
    });
    const stub = env.THINK_THREAD_AGENT.get(env.THINK_THREAD_AGENT.idFromName(threadId));

    const before = await readThreadIndexRow(threadId);
    expect(before?.updated_at).toBe(seededUpdatedAt);

    await runInDurableObject(stub, async (agent: ThinkThreadAgent) => {
      await agent.setPendingModelSwitch({ provider: "mock-tool-call", model: "mock-model-2" });
      await (agent as unknown as PrivateCommit).commitPendingModelSwitch();
    });

    const after = await readThreadIndexRow(threadId);
    // The user message that triggers this turn owns `updatedAt`; the commit
    // itself must leave it exactly as seeded, not merely "close" to it.
    expect(after?.updated_at).toBe(seededUpdatedAt);
    expect(after?.model_provider).toBe("mock-tool-call");
  });

  it("is a no-op when nothing is pending", async () => {
    const { threadId } = await seedRegistryThread(env.REGISTRY_DB, {
      threadId: "thr_commit_noop",
    });
    const stub = env.THINK_THREAD_AGENT.get(env.THINK_THREAD_AGENT.idFromName(threadId));

    const before = await readThreadIndexRow(threadId);

    const result = await runInDurableObject(stub, (agent: ThinkThreadAgent) =>
      (agent as unknown as PrivateCommit).commitPendingModelSwitch(),
    );

    expect(result).toBeNull();
    const after = await readThreadIndexRow(threadId);
    expect(after).toEqual(before);
  });

  it("commits onto the SAME turn it runs in, not the next one", async () => {
    // The behavioural proof that the commit point sits before the
    // `resolveRuntimeConfigForThink` read that feeds the turn: if the commit
    // call ever moved after that read (or the per-wake config cache weren't
    // invalidated post-commit), this turn would still report the OLD model
    // and only the NEXT turn would pick up the switch.
    const { threadId } = await seedRegistryThread(env.REGISTRY_DB, {
      threadId: "thr_commit_same_turn",
    });
    const stub = env.THINK_THREAD_AGENT.get(env.THINK_THREAD_AGENT.idFromName(threadId));

    const probe = await runInDurableObject(stub, async (agent: ThinkThreadAgent) => {
      await agent.setPendingModelSwitch({ provider: "mock-tool-call", model: "mock-model-2" });
      return (
        agent as unknown as {
          beforeTurnProbeForTest(
            messages?: unknown[],
          ): Promise<{ provider?: string; modelId?: string }>;
        }
      ).beforeTurnProbeForTest([{ role: "user", content: "hello" }]);
    });

    // `mock-tool-call` hardcodes its `modelId` regardless of the `model`
    // string passed to it (see `model-factory.ts`), so the provider swap —
    // the field that only changes if `beforeTurn` actually re-resolved the
    // config after the commit — is the meaningful assertion here. The
    // `model` column itself is checked below, directly off `thread_index`.
    expect(probe.provider).toBe("mock-tool-call");

    const row = await readThreadIndexRow(threadId);
    expect(row?.model_provider).toBe("mock-tool-call");
    expect(row?.model).toBe("mock-model-2");

    const pendingAfter = await runInDurableObject(stub, (agent: ThinkThreadAgent) =>
      agent.getPendingModelSwitch(),
    );
    expect(pendingAfter).toBeNull();
  });
});
