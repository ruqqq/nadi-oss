import { env, runInDurableObject } from "cloudflare:test";
import { describe, expect, it } from "vitest";

// Pinning test for the `_deliverDetachedTerminal` override that steers a
// detached subagent's completion into a mid-turn parent (see
// src/agent/think-thread-agent.ts). It guards the SDK-internal coupling: if an
// agents-SDK upgrade renames/removes `_deliverDetachedTerminal` or changes its
// arity, the "SDK base still exposes it" assertion fails LOUDLY here instead of
// silently dropping every subagent completion in production.
//
// The behavioral steer (the completion actually lands in the parent transcript
// mid-turn) is covered by the live smoke, not this unit-of-plumbing pin.
describe("subagent detached-terminal injection (SDK pin)", () => {
  it("suppresses the SDK's deferred delivery and shadows the SDK funnel", async () => {
    const stub = env.THINK_THREAD_AGENT.get(env.THINK_THREAD_AGENT.idFromName("thr_detached_pin"));
    await runInDurableObject(stub, async (agent: unknown) => {
      const a = agent as {
        formatDetachedCompletion: (run: unknown, result: unknown) => string;
        _deliverDetachedTerminal?: unknown;
        _readAgentToolRun?: unknown;
      };

      // (a) formatDetachedCompletion returns "" for every real terminal —
      // delivery has moved to the override, and "" makes the SDK's own
      // `_cfDetachedNotifyFinish` early-return (no duplicate submission).
      expect(a.formatDetachedCompletion({ runId: "r" }, { status: "completed" })).toBe("");
      expect(a.formatDetachedCompletion({ runId: "r" }, { status: "error", error: "boom" })).toBe(
        "",
      );

      // (b) Our override exists on the instance (installed on
      // ThinkThreadAgent.prototype) and shadows the SDK method.
      expect(typeof a._deliverDetachedTerminal).toBe("function");
      const ownProto = Object.getPrototypeOf(a) as Record<string, unknown>;
      expect(typeof ownProto._deliverDetachedTerminal).toBe("function");

      // (c) The SDK base still exposes `_deliverDetachedTerminal` one prototype
      // level up (what our override's `super`-equivalent call reaches). Fails
      // loudly if an SDK upgrade renames/removes it. Arity >= 3 pins the
      // (runId, kind, result, ...) shape the override forwards.
      const sdkProto = Object.getPrototypeOf(ownProto) as {
        _deliverDetachedTerminal?: (...args: unknown[]) => unknown;
      };
      expect(typeof sdkProto._deliverDetachedTerminal).toBe("function");
      expect(sdkProto._deliverDetachedTerminal?.length ?? 0).toBeGreaterThanOrEqual(3);

      // (d) The SDK base still exposes `_readAgentToolRun`, the seam our
      // override reads to recover a subagent's label (its `inputPreview`) for
      // the completion card. Fails loudly if an SDK upgrade renames/removes
      // it, since the override reads it defensively (optional-chained) and
      // would otherwise silently degrade back to "(unlabeled)" forever.
      expect(typeof a._readAgentToolRun).toBe("function");
    });
  });
});
