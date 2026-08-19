import { env, runInDurableObject } from "cloudflare:test";
import { beforeAll, describe, expect, it, vi } from "vitest";
import { ThinkThreadAgent } from "../../src/agent/think-thread-agent";
import { ThreadRepository } from "../../src/db/repositories/threads";
import { modelSwitchPart, readModelSwitchPart } from "../../src/agent/model-switch";
import { applyRegistryTestSchema, seedRegistryThread } from "./helpers/registry";

type Initializable = { __unsafe_ensureInitialized(): Promise<void> };

type PrivateCommit = {
  commitPendingModelSwitch(): Promise<{
    from: { provider: string; model: string };
    to: { provider: string; model: string };
  } | null>;
};

/** A user message carrying a switch request on its own `metadata` — exactly
 *  what `App.tsx`'s `handleSend` builds for a direct send. There is no
 *  `setPendingModelSwitch` RPC any more: picking a model is pure client
 *  state, and the request only ever reaches the server on the message that
 *  commits it. */
function switchRequestMessage(
  id: string,
  text: string,
  request: { provider: string; model: string },
) {
  return {
    id,
    role: "user" as const,
    parts: [{ type: "text" as const, text }],
    metadata: request,
  };
}

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
 * `commitPendingModelSwitch` end to end: real registry D1 for the write, real
 * DO for the transcript. `model-switch-commit.test.ts` (unit, duck-typed
 * `this`) proves the two branches that return before touching the registry —
 * nothing to commit, and the incomplete-tool-call guard. This proves
 * everything that requires a real `thread_index` row: the six-column write,
 * that `updatedAt` is never part of it, that `resolveThreadModelSnapshotValue`
 * actually gates the write, and — via `beforeTurnProbeForTest`, the same
 * seam `think-thread-agent.integration.test.ts` uses to read a turn's
 * resolved model — that the switch lands on the SAME turn that committed it
 * rather than the next one. `model-switch-send-path.integration.test.ts`
 * covers the same ground driven through the REAL send paths
 * (`submitMessages`/`submitQueuedUserMessage`) rather than this method
 * directly.
 */
describe("commitPendingModelSwitch (integration)", () => {
  beforeAll(async () => {
    await applyRegistryTestSchema(env.REGISTRY_DB);
  });

  it("writes the six snapshot columns", async () => {
    const { threadId } = await seedRegistryThread(env.REGISTRY_DB, {
      threadId: "thr_commit_write",
    });
    const stub = env.THINK_THREAD_AGENT.get(env.THINK_THREAD_AGENT.idFromName(threadId));

    const result = await runInDurableObject(stub, async (agent: ThinkThreadAgent) => {
      await (agent as unknown as Initializable).__unsafe_ensureInitialized();
      await agent.addMessages([
        switchRequestMessage("u1", "switch please", {
          provider: "mock-tool-call",
          model: "mock-model-2",
        }),
      ]);
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
      await (agent as unknown as Initializable).__unsafe_ensureInitialized();
      await agent.addMessages([
        switchRequestMessage("u1", "switch please", {
          provider: "mock-tool-call",
          model: "mock-model-2",
        }),
      ]);
      await (agent as unknown as PrivateCommit).commitPendingModelSwitch();
    });

    const after = await readThreadIndexRow(threadId);
    // The user message that triggers this turn owns `updatedAt`; the commit
    // itself must leave it exactly as seeded, not merely "close" to it.
    expect(after?.updated_at).toBe(seededUpdatedAt);
    expect(after?.model_provider).toBe("mock-tool-call");
  });

  it("is a no-op when the transcript carries no switch request", async () => {
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

  it("is a no-op WITHOUT writing when the request is refused by the workspace", async () => {
    const { threadId } = await seedRegistryThread(env.REGISTRY_DB, {
      threadId: "thr_commit_rejected",
    });
    const stub = env.THINK_THREAD_AGENT.get(env.THINK_THREAD_AGENT.idFromName(threadId));

    const updateSpy = vi.spyOn(ThreadRepository.prototype, "updateModelSnapshot");
    try {
      const result = await runInDurableObject(stub, async (agent: ThinkThreadAgent) => {
        await (agent as unknown as Initializable).__unsafe_ensureInitialized();
        // A real provider this test workspace has no configured settings
        // for — `resolveThreadModelSnapshotValue`/`isUsableProviderForWorkspace`
        // must refuse it. The turn must proceed unaffected; nothing here
        // aborts anything, it just never writes.
        await agent.addMessages([
          switchRequestMessage("u1", "switch please", {
            provider: "anthropic",
            model: "claude-opus-5",
          }),
        ]);
        return (agent as unknown as PrivateCommit).commitPendingModelSwitch();
      });

      expect(result).toBeNull();
      expect(updateSpy).not.toHaveBeenCalled();
      const row = await readThreadIndexRow(threadId);
      expect(row?.model_provider).toBeNull();
    } finally {
      updateSpy.mockRestore();
    }
  });

  it("no-ops WITHOUT writing when the request matches the current model", async () => {
    // The thread's default (from `seedRegistryThread`) is provider "mock",
    // model "mock" — "switching" to the same tuple must be a pure no-op. A
    // regression that hoists the `updateModelSnapshot` call above the
    // `sameModelTuple` check would start writing here even though nothing
    // changed. Asserted positively — "the row looks unchanged" alone would
    // not catch a same-value write.
    const { threadId } = await seedRegistryThread(env.REGISTRY_DB, {
      threadId: "thr_commit_same_model",
    });
    const stub = env.THINK_THREAD_AGENT.get(env.THINK_THREAD_AGENT.idFromName(threadId));

    const updateSpy = vi.spyOn(ThreadRepository.prototype, "updateModelSnapshot");
    try {
      const result = await runInDurableObject(stub, async (agent: ThinkThreadAgent) => {
        await (agent as unknown as Initializable).__unsafe_ensureInitialized();
        await agent.addMessages([
          switchRequestMessage("u1", "switch please", { provider: "mock", model: "mock" }),
        ]);
        return (agent as unknown as PrivateCommit).commitPendingModelSwitch();
      });

      expect(result).toBeNull();
      expect(updateSpy).not.toHaveBeenCalled();
    } finally {
      updateSpy.mockRestore();
    }
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
      await (agent as unknown as Initializable).__unsafe_ensureInitialized();
      await agent.addMessages([
        switchRequestMessage("u1", "hello", {
          provider: "mock-tool-call",
          model: "mock-model-2",
        }),
      ]);
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
  });
});

/**
 * The SERVER writes the transcript marker, from the commit it actually
 * performed. It used to be written only by `web/src/App.tsx` on send, which
 * made it conditional on that one code path running: an automaton run
 * (`buildAutomatonRunMessage` carries no metadata) and the feedback branch
 * both committed a switch with NO marker anywhere — and a marker-less
 * transcript reads to the sanitizer as one same-origin segment, which
 * replays the old model's signed reasoning at the new one. None of those
 * paths differ from this method's point of view: they all reach
 * `commitPendingModelSwitch` with a transcript the client never decorated,
 * which is exactly what these drive.
 */
describe("commitPendingModelSwitch marks the transcript", () => {
  beforeAll(async () => {
    await applyRegistryTestSchema(env.REGISTRY_DB);
  });

  it("writes the marker and the durable origin record with no client help", async () => {
    const { threadId } = await seedRegistryThread(env.REGISTRY_DB, {
      threadId: "thr_commit_marker",
    });
    const stub = env.THINK_THREAD_AGENT.get(env.THINK_THREAD_AGENT.idFromName(threadId));

    const parts = await runInDurableObject(stub, async (agent: ThinkThreadAgent) => {
      // Session-backed writes need the Think init that a raw DO stub skips.
      await (agent as unknown as Initializable).__unsafe_ensureInitialized();
      // The request rides on the message itself; the client attaches no
      // `data-model-switch` part — exactly what an automaton run or the
      // feedback branch produces too.
      await agent.addMessages([
        switchRequestMessage("u1", "keep going", {
          provider: "mock-tool-call",
          model: "mock-model-2",
        }),
      ]);
      await (agent as unknown as PrivateCommit).commitPendingModelSwitch();
      return agent.messages.find((m) => m.id === "u1")?.parts;
    });

    expect(readModelSwitchPart(parts?.[0])).toEqual({
      from: { provider: "mock", model: "mock" },
      to: { provider: "mock-tool-call", model: "mock-model-2" },
    });
    // The marker goes AHEAD of the message's own content, so the divider
    // renders above the message whose turn committed the switch.
    expect(parts?.[1]).toEqual({ type: "text", text: "keep going" });

    const origin = await runInDurableObject(stub, (agent: ThinkThreadAgent) =>
      (
        agent as unknown as { currentModelSwitchOrigin(): Promise<unknown> }
      ).currentModelSwitchOrigin(),
    );
    expect(origin).toEqual({
      from: { provider: "mock", model: "mock" },
      to: { provider: "mock-tool-call", model: "mock-model-2" },
      anchorMessageId: "u1",
    });
  });

  it("never doubles a divider when a client already attached its own part", async () => {
    const { threadId } = await seedRegistryThread(env.REGISTRY_DB, {
      threadId: "thr_commit_marker_dedupe",
    });
    const stub = env.THINK_THREAD_AGENT.get(env.THINK_THREAD_AGENT.idFromName(threadId));

    const parts = await runInDurableObject(stub, async (agent: ThinkThreadAgent) => {
      await (agent as unknown as Initializable).__unsafe_ensureInitialized();
      await agent.addMessages([
        {
          id: "u1",
          role: "user",
          parts: [
            // An older deployed client that still decorates its send.
            modelSwitchPart({
              from: { provider: "mock", model: "mock" },
              to: { provider: "mock-tool-call", model: "mock-model-2" },
            }) as never,
            { type: "text", text: "keep going" },
          ],
          metadata: { provider: "mock-tool-call", model: "mock-model-2" },
        },
      ]);
      await (agent as unknown as PrivateCommit).commitPendingModelSwitch();
      return agent.messages.find((m) => m.id === "u1")?.parts;
    });

    expect(parts?.filter((part) => readModelSwitchPart(part) !== null)).toHaveLength(1);
  });
});
