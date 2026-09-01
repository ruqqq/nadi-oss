import { env, runInDurableObject } from "cloudflare:test";
import { beforeAll, describe, expect, it } from "vitest";
import { drizzle } from "drizzle-orm/d1";
import * as schema from "../../src/db/schema";
import { applyRegistryTestSchema } from "./helpers/registry";
import { FakeComputeBackend } from "../../src/compute/backends/fake";
import {
  clearComputeHostTestOverrides,
  setComputeHostTestOverrides,
} from "../../src/compute/host-test-overrides";

const now = 1_800_000_000_000;

const WORKSPACE_ID = "ws_sbx";
/**
 * The DO is keyed by AGENT since P3, so the agent id — not the thread id — is
 * what decides which sandbox storage a test touches. One shared agent id would
 * put every `it()` in this file into ONE box, and the per-test thread ids below
 * would stop isolating anything.
 */
const agentIdFor = (threadId: string) => `agent_${threadId}`;

/**
 * Seeds the workspace/agent/sandbox-settings rows and a thread-index row for
 * `threadId`. Called fresh from EVERY `it()` (not `beforeAll`/`beforeEach`
 * once) because `REGISTRY_DB` gets its own isolated storage snapshot per
 * test — a `beforeAll` write does not reach an `it`, per this suite's own
 * fixture note.
 *
 * Each `it()` below also passes its OWN `threadId`, not a shared one:
 * `resolve-compute-service.integration.test.ts` establishes the repo's real
 * convention here — a Durable Object addressed with `idFromName` is not
 * proven to get a fresh storage snapshot per `it()` the way `REGISTRY_DB`
 * does, and this suite hit exactly that leak with a single shared thread id
 * before switching to per-test ids.
 */
async function seedComputeEnabledThread(threadId: string) {
  const db = drizzle(env.REGISTRY_DB, { schema });
  await db.insert(schema.workspaces).values({
    id: WORKSPACE_ID,
    name: "Sandbox WS",
    flagsJson: "{}",
    createdAt: now,
  });
  await db.insert(schema.agents).values({
    id: agentIdFor(threadId),
    workspaceId: WORKSPACE_ID,
    name: "Nadi",
    systemPrompt: "",
    provider: "anthropic",
    model: "claude-opus-5",
    modelInputModalities: '["text"]',
    reasoningEffort: "medium",
    createdAt: now,
  });
  await db.insert(schema.workspaceSandboxSettings).values({
    workspaceId: WORKSPACE_ID,
    enabled: true,
    provider: "mock",
    // `getWorkspaceComputeSettings` throws `missing_provider_config_json` on
    // a null column — the brief's fixture sketch omitted this, but the real
    // schema (src/db/schema.ts) requires it. `{"kind":"mock"}` matches
    // `defaultProviderConfig("mock")` in src/compute/config.ts.
    providerConfigJson: JSON.stringify({ kind: "mock" }),
    image: "",
    createdAt: now,
    updatedAt: now,
  });
  await db.insert(schema.threadIndex).values({
    id: threadId,
    workspaceId: WORKSPACE_ID,
    agentId: agentIdFor(threadId),
    kind: "regular",
    title: "T",
    source: "manual",
    createdAt: now,
    updatedAt: now,
  });
}

/** The AGENT's box — `idFromName(agentId)`, which is what P3 re-keyed. */
function stub(threadId: string) {
  return env.AGENT_SANDBOX.get(env.AGENT_SANDBOX.idFromName(agentIdFor(threadId)));
}

/**
 * The caller's identity, which `session()` requires rather than deriving from
 * `threadId` — see `AgentSandbox.session`.
 */
const runtimeConfigFor = (threadId: string) => ({
  workspaceId: WORKSPACE_ID,
  agentId: agentIdFor(threadId),
});

async function openSession(threadId: string, supportsProcessMonitor = true) {
  const opened = await stub(threadId).session({
    threadId,
    workspaceThreadId: threadId,
    supportsProcessMonitor,
    runtimeConfig: runtimeConfigFor(threadId),
  });
  if (!opened.ok) throw new Error(`session failed: ${opened.error.code}`);
  if (!opened.value) throw new Error("expected compute to be enabled");
  return opened.value;
}

describe("AgentSandbox durable object", () => {
  beforeAll(async () => {
    await applyRegistryTestSchema(env.REGISTRY_DB);
  });

  it("runs a command using its OWN storage, not the thread DO's", async () => {
    const threadId = "thr_sbx_run";
    await seedComputeEnabledThread(threadId);

    const { session } = await openSession(threadId);
    const result = await session.execRun({ command: "echo hello" });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.exitCode).toBe(0);

    // The compute_state row must exist in THIS DO's SQLite. That is the claim.
    await runInDurableObject(stub(threadId), async (_instance, state) => {
      const rows = [...state.storage.sql.exec("SELECT id, status FROM compute_state").raw()];
      expect(rows.length).toBe(1);
    });
  });

  /**
   * The caller's `supportsProcessMonitor` must reach the resolved service. It
   * is the single flag that admits background work, and getting it wrong is
   * SILENT: with it false `execWatch` refuses, long-running exec is
   * backgrounded without a watcher, and watcher polling returns nothing — the
   * tool surface merely changes shape, so a suite that never asserts on it
   * stays green while the feature is off.
   *
   * `execWatch` is the discriminator because its gate
   * (`thread-service.ts:1660`) runs BEFORE any process lookup: with the flag
   * false an unknown process id yields `compute_process_monitor_unavailable`,
   * and with it true the SAME call gets as far as `process_missing`. So the
   * two outcomes cannot both be produced by a hardcoded value.
   *
   * Reached through `runInDurableObject` on the DO's own private
   * `resolveService` — a PRODUCTION method (`session()` and the alarm both use
   * it), not a test-only RPC — which is this repo's existing way into DO
   * internals.
   */
  describe("supportsProcessMonitor reaches the resolved service", () => {
    async function watchError(threadId: string, supportsProcessMonitor: boolean) {
      await seedComputeEnabledThread(threadId);
      return await runInDurableObject(stub(threadId), async (instance) => {
        const resolved = await (
          instance as unknown as {
            resolveService: (
              id: string,
              options: { supportsProcessMonitor: boolean },
            ) => Promise<{
              service: { execWatch: (i: { processId: string }) => Promise<unknown> };
            }>;
          }
        ).resolveService(threadId, { supportsProcessMonitor });
        try {
          await resolved.service.execWatch({ processId: "proc_does_not_exist" });
          return "no_error";
        } catch (error) {
          return String(error);
        }
      });
    }

    it("ADMITS the process monitor when the caller says true", async () => {
      const message = await watchError("thr_sbx_monitor_on", true);
      expect(message).not.toContain("compute_process_monitor_unavailable");
      expect(message).toContain("process_missing");
    });

    it("REFUSES the process monitor when the caller says false", async () => {
      const message = await watchError("thr_sbx_monitor_off", false);
      expect(message).toContain("compute_process_monitor_unavailable");
    });
  });

  /**
   * `backgroundLongRunningExec` is DERIVED in `resolveService`
   * (`supportsProcessMonitor && !attachedRuntime`), mirroring
   * `think-thread-agent.ts`'s `sandboxHostDeps()`. `resolveComputeService` now
   * REQUIRES the field (it used to default to `!deps.attachedRuntime` ALONE,
   * which would let a runtime that cannot deliver a completion reminder
   * background a long-running exec anyway), so an omission is a compile error —
   * but a WRONG stated value is still silent, which is what these two cases
   * pin.
   *
   * Like `supportsProcessMonitor` above, getting it wrong is SILENT: the exec
   * simply takes a different shape. So the assertion is the BACKEND CALL LOG,
   * which only the instrumented fake records: `backgroundLongRunningExec: false`
   * routes `exec` to the blocking `runCommand` path (`thread-service.ts:643`),
   * and `true` routes it to `startProcess` + a watcher. The two cases point in
   * OPPOSITE directions for the same command, so no single hardcoded value
   * satisfies both — and deleting the derivation flips the `false` case, since
   * its default would be `true`.
   *
   * The exec-timing knobs come through the host-override registry because they
   * are service deps no provider can supply; the same pattern
   * `think-thread-agent.integration.test.ts` uses for the thread-DO twin.
   */
  describe("backgroundLongRunningExec is DERIVED, not defaulted", () => {
    async function execLongRunning(threadId: string, supportsProcessMonitor: boolean) {
      await seedComputeEnabledThread(threadId);
      return await runInDurableObject(stub(threadId), async (instance) => {
        const provider = new FakeComputeBackend();
        let clock = now;
        setComputeHostTestOverrides(threadId, {
          buildBackend: async () => provider,
          now: () => clock,
          execForegroundTimeoutMs: 1,
          execForegroundPollIntervalMs: 1,
          sleep: async (ms: number) => {
            clock += ms;
          },
        });
        try {
          const resolved = await (
            instance as unknown as {
              resolveService: (
                id: string,
                options: { supportsProcessMonitor: boolean },
              ) => Promise<{
                service: {
                  exec: (i: { command: string; label?: string }) => Promise<{ status: string }>;
                  deps: { backgroundLongRunningExec?: boolean };
                };
              } | null>;
            }
          ).resolveService(threadId, { supportsProcessMonitor });
          if (!resolved) throw new Error("expected a compute service");
          const execResult = await resolved.service.exec({ command: "sleep 300", label: "build" });
          return {
            status: execResult.status,
            backgroundLongRunningExec: resolved.service.deps.backgroundLongRunningExec,
            runCommandCalls: provider.runCommandCalls.length,
            startProcessCalls: provider.startProcessCalls.length,
          };
        } finally {
          clearComputeHostTestOverrides(threadId);
        }
      });
    }

    it("BACKGROUNDS a long exec when the caller admits the process monitor", async () => {
      const result = await execLongRunning("thr_sbx_bglre_on", true);
      // Behaviour first: the flag's value is a corroborating detail, the shape
      // of the backend traffic is the thing that would actually be wrong.
      expect(result.startProcessCalls).toBe(1);
      expect(result.runCommandCalls).toBe(0);
      expect(result.backgroundLongRunningExec).toBe(true);
    });

    it("runs a long exec SYNCHRONOUSLY when the caller refuses the process monitor", async () => {
      // The mutation target. Drop the derivation and this case takes the
      // default (`!attachedRuntime` = true), backgrounding a command whose
      // completion nobody can report — and only the call log says so.
      const result = await execLongRunning("thr_sbx_bglre_off", false);
      expect(result.runCommandCalls).toBe(1);
      expect(result.startProcessCalls).toBe(0);
      expect(result.backgroundLongRunningExec).toBe(false);
    });
  });

  /**
   * THE IN-FLIGHT LATCH: nothing between `preparationInFlight.get` and its
   * `.set` may await.
   *
   * `ensureThreadWorkspacePrepared` dedupes concurrent preparations with a
   * plain Map. That works only because the window between the `get` that asks
   * "is anyone preparing this" and the `set` that says "I am" contains no
   * suspension point — the `run` IIFE executes synchronously up to its first
   * `await`, and the `.set` follows in the same tick. Hoist any await out of
   * `run` and into that window and two `exec`s in one turn both miss the latch,
   * both `git clone` into the same worktree, and Task 2's round-1 finding is
   * back with a green suite.
   *
   * That invariant was protected only by a comment, and the signature read this
   * task added is exactly the kind of await someone hoists for readability — it
   * was nearly shipped there. So it is pinned here.
   *
   * Reached the way this file already reaches DO internals: `runInDurableObject`
   * plus a cast to the private member. The latch lives on the DO and is keyed by
   * thread, so calling the method twice on ONE instance is the real concurrency
   * rather than a simulation of it — no second `ThreadComputeService` and no
   * session memoization is involved.
   */
  describe("concurrent preparations are deduped by the in-flight latch", () => {
    type PreparationInternals = {
      ensureThreadWorkspacePrepared: (
        threadId: string,
        prepare: () => Promise<{ summary: string; signature: string | null }>,
      ) => Promise<void>;
      preparationFailures: Map<string, { key: string; count: number; signature: string | null }>;
    };

    /**
     * Two concurrent calls against one DO instance, with a `prepare` that does
     * not settle until the test says so — so the second call cannot arrive
     * "after" the first by an accident of timing.
     *
     * `seedFailures` optionally installs a suspension record first; see the two
     * cases below for why that is a different test and not a variation.
     */
    async function concurrentPreparations(
      threadId: string,
      seedFailures?: { key: string; count: number; signature: string | null },
    ) {
      await seedComputeEnabledThread(threadId);
      return await runInDurableObject(stub(threadId), async (instance) => {
        const internals = instance as unknown as PreparationInternals;
        if (seedFailures) internals.preparationFailures.set(threadId, seedFailures);

        let release: (() => void) | undefined;
        const gate = new Promise<void>((resolve) => {
          release = resolve;
        });
        let calls = 0;
        const prepare = async () => {
          calls += 1;
          await gate;
          return { summary: "prepared", signature: "sig-after" };
        };

        // Issued in ONE synchronous tick: the second call happens before the
        // first has had any chance to settle, which is what a turn's two
        // `exec`s do.
        const first = internals.ensureThreadWorkspacePrepared(threadId, prepare);
        const second = internals.ensureThreadWorkspacePrepared(threadId, prepare);
        // Let both reach their first suspension point before releasing, so a
        // missing latch has actually had the opportunity to double-run.
        for (let tick = 0; tick < 8; tick += 1) await Promise.resolve();
        release?.();
        await Promise.all([first, second]);
        return calls;
      });
    }

    /**
     * The general case: no suspension record, so `run` reaches `await prepare()`
     * as its first suspension point. One preparation, and the second caller
     * AWAITS it rather than skipping it — "someone is preparing this" is not the
     * same claim as "someone prepared this".
     */
    it("runs ONE preparation for two concurrent callers", async () => {
      expect(await concurrentPreparations("thr_sbx_prep_concurrent")).toBe(1);
    });

    /**
     * The specific case, and the one that kills the hoisted-await mutation.
     *
     * With a suspension record whose signature no longer matches the agent's
     * configuration, the cap check has to READ D1 before it can decide — the
     * only await on this path other than `prepare` itself. Inside `run` that is
     * harmless. Hoisted above the `.set` it is the regression: both callers pass
     * the `get`, both await the read, both prepare.
     *
     * The general case above cannot see that mutation at all, because with no
     * record the hoisted branch never awaits. Two tests, not one parameterised
     * one.
     */
    it("runs ONE preparation when a stale suspension must be invalidated first", async () => {
      const calls = await concurrentPreparations("thr_sbx_prep_concurrent_stale", {
        key: "environment setup failed with exit code 7",
        // Comfortably past MAX_PREPARATION_ATTEMPTS, so the cap branch is taken
        // whatever that constant becomes.
        count: 99,
        // Not the agent's current signature, so the suspension is invalidated
        // and preparation is attempted — which is the point: the D1 read that
        // decides this is the await in question.
        signature: "stale-signature-that-cannot-match",
      });
      expect(calls).toBe(1);
    });
  });
});
