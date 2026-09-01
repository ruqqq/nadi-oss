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
});
