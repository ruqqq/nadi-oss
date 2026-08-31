/**
 * The PUSH half of background-work completion, end to end: a real
 * `ThinkThreadAgent` Durable Object with a real `WorkLedgerStore`, hit through
 * the real HTTP router (`SELF.fetch`) exactly as a sandbox wrapper would.
 *
 * Only the compute BACKEND is fake — everything else (the ledger, the
 * injection buffer, the completion-token HMAC, the route dispatch) is real.
 */
import { SELF, env, runInDurableObject } from "cloudflare:test";
import { drizzle } from "drizzle-orm/d1";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import * as schema from "../../src/db/schema";
import type { ThinkThreadAgent } from "../../src/agent/think-thread-agent";
import type { WorkLedgerStore } from "../../src/agent/work-ledger-store";
import { deriveCompletionSecret, signCompletionToken } from "../../src/compute/completion-token";
import { FakeComputeBackend } from "../../src/compute/backends/fake";
import {
  clearComputeHostTestOverrides,
  setComputeHostTestOverrides,
} from "../../src/compute/host-test-overrides";
import type { ThreadComputeService } from "../../src/compute/thread-service";
import { saveDaytonaApiKey } from "../../src/compute/settings";
import { applyRegistryTestSchema, seedRegistryThread } from "./helpers/registry";

type LedgerTestableAgent = ThinkThreadAgent & {
  __unsafe_ensureInitialized(): Promise<void>;
  resolveComputeServiceForTest(): Promise<{ service: ThreadComputeService } | null>;
};

function ledgerOf(instance: ThinkThreadAgent): WorkLedgerStore {
  return (instance as unknown as { workLedger: WorkLedgerStore }).workLedger;
}

function injectionsOf(instance: ThinkThreadAgent): Array<{ kind: string; text: string }> {
  return (
    instance as unknown as {
      injectionBuffer(): {
        peekAll(): Array<{
          kind: string;
          message: { parts: Array<{ type: string; text?: string }> };
        }>;
      };
    }
  )
    .injectionBuffer()
    .peekAll()
    .map((entry) => ({
      kind: entry.kind,
      text: entry.message.parts
        .filter((part) => part.type === "text")
        .map((part) => part.text ?? "")
        .join(""),
    }));
}

/** Pending dedupe keys for `watcher-completion` entries, in enqueue order. */
function pendingWatcherKeysOf(instance: ThinkThreadAgent): string[] {
  return (
    instance as unknown as {
      injectionBuffer(): { pendingKeys(kind: string): string[] };
    }
  )
    .injectionBuffer()
    .pendingKeys("watcher-completion");
}

function stubFor(threadId: string) {
  return env.THINK_THREAD_AGENT.get(env.THINK_THREAD_AGENT.idFromName(threadId));
}

async function seedSandboxEnabledWorkspace(workspaceId: string) {
  const providerConfigJson = JSON.stringify({
    kind: "daytona",
    apiKeySecretName: "sandbox:daytona",
    apiUrl: null,
    target: null,
    profiles: {
      small: { kind: "image", value: "node:22" },
      medium: { kind: "image", value: "node:22" },
    },
  });
  await env.REGISTRY_DB.prepare(
    "INSERT OR IGNORE INTO workspace_sandbox_settings (workspace_id, enabled, provider, provider_config_json, image, idle_timeout_ms, max_process_runtime_ms, limits_json) VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
  )
    .bind(workspaceId, 1, "daytona", providerConfigJson, "node:22", 900_000, 600_000, "{}")
    .run();
  await saveDaytonaApiKey({
    env,
    workspaceId,
    secretName: "sandbox:daytona",
    value: "dt_test_secret",
  });
}

async function seedThread(threadId: string, options?: { sandbox?: boolean }) {
  const workspaceId = `workspace-${threadId}`;
  await seedRegistryThread(env.REGISTRY_DB, {
    workspaceId,
    agentId: `agent-${threadId}`,
    threadId,
    runtime: "think",
    provider: "mock",
    model: "mock",
  });
  if (options?.sandbox !== false) await seedSandboxEnabledWorkspace(workspaceId);
}

/**
 * Prime the agent for compute work: fake backend, instant backgrounding.
 *
 * Approach: the thread-keyed host-override registry, NOT the D1 `mock`
 * provider. The two knobs that make `sleep 300` background after 1ms
 * (`execForegroundTimeoutMs`/`execForegroundPollIntervalMs`) are host deps of
 * the compute SERVICE, not properties of any backend — no provider choice can
 * express them, so selecting `mock` in D1 would leave this test waiting out the
 * real 30s foreground window.
 */
/**
 * Every thread this file registers an override for, so `afterAll` can clear
 * exactly those and nothing else. `integration-fast` runs `isolate: false`, so
 * the override map is ONE map shared by every file in the project run — a
 * blanket clear here would reach into other files' registrations, and leaving
 * `startWatchedProcess`'s deliberate non-cleanup in place past this file would
 * leak a `FakeComputeBackend` into them.
 */
const REGISTERED_THREADS = new Set<string>();

function primeCompute(threadId: string, backend: FakeComputeBackend): () => void {
  REGISTERED_THREADS.add(threadId);
  setComputeHostTestOverrides(threadId, {
    buildBackend: async () => backend,
    execForegroundTimeoutMs: 1,
    execForegroundPollIntervalMs: 1,
  });
  return () => {
    clearComputeHostTestOverrides(threadId);
  };
}

/**
 * Start a real backgrounded, watched process; returns its real ledger row id.
 *
 * Deliberately does NOT clear the registered host overrides afterward
 * (unlike `work-ledger.integration.test.ts`'s equivalent, which re-primes
 * before every later call that needs one). The completion HTTP route resolves
 * the compute service independently, INSIDE the same live DO instance but
 * through a call this test does not control — so the fake-backend override
 * has to still be in place when that happens, or `resolveComputeService`
 * tries to build a real Daytona backend from the seeded (fake) provider
 * config and `workFacts`'s `service` silently comes back null, which used to
 * make the teardown call below a quiet no-op instead of a real assertion
 * failure.
 */
async function startWatchedProcess(threadId: string): Promise<{ processId: string }> {
  const stub = stubFor(threadId);
  return runInDurableObject(stub, async (instance: ThinkThreadAgent) => {
    const testInstance = instance as LedgerTestableAgent;
    await testInstance.__unsafe_ensureInitialized();
    primeCompute(threadId, new FakeComputeBackend());
    // Keep the completion's proactive injection sitting in the durable
    // buffer instead of being drained straight into `submitMessages` (which
    // needs a real chat session this test never sets up) — same trick
    // `work-ledger.integration.test.ts` uses to count reminders.
    (instance as unknown as { _turnQueue?: { isActive: boolean } })._turnQueue = {
      isActive: true,
    };
    const resolved = await testInstance.resolveComputeServiceForTest();
    if (!resolved) throw new Error("expected compute service");
    const execResult = (await resolved.service.exec({
      command: "sleep 300",
      label: "build",
    })) as { status: string; processId: string };
    expect(execResult.status).toBe("backgrounded");
    return { processId: execResult.processId };
  });
}

async function ledgerRow(threadId: string, processId: string) {
  const stub = stubFor(threadId);
  return runInDurableObject(stub, async (instance: ThinkThreadAgent) =>
    ledgerOf(instance).get(processId),
  );
}

async function deliveredWatcherMessages(threadId: string) {
  const stub = stubFor(threadId);
  return runInDurableObject(stub, async (instance: ThinkThreadAgent) => ({
    messages: injectionsOf(instance).filter((entry) => entry.kind === "watcher-completion"),
    dedupeKeys: pendingWatcherKeysOf(instance),
  }));
}

/**
 * Simulate "the first injection already drained into a turn" without
 * standing up a real chat session: peek + delete, the same two steps
 * `_kickInjectionTurn` performs after `submitMessages` succeeds. This is
 * what makes a SECOND completion's dedupe key a genuinely fresh enqueue
 * attempt in the test, matching production — where the buffer does not sit
 * around holding the first entry the way `_turnQueue.isActive = true` makes
 * it do here for inspection.
 */
async function drainInjectionBuffer(threadId: string): Promise<void> {
  const stub = stubFor(threadId);
  await runInDurableObject(stub, async (instance: ThinkThreadAgent) => {
    const buffer = (
      instance as unknown as {
        injectionBuffer(): {
          peekAll(): Array<{ seq: number }>;
          deleteDrained(seqs: number[]): void;
        };
      }
    ).injectionBuffer();
    buffer.deleteDrained(buffer.peekAll().map((entry) => entry.seq));
  });
}

/** The compute layer's own view: is the process still watched, and what does
 * the store say its status/exit code are. This is what `exec_watch_list`,
 * `execOutput`, and the background-work dock all read — independent of the ledger and
 * the injection buffer, which is why it needs its own assertions. */
async function computeStateOf(
  threadId: string,
  processId: string,
): Promise<{ watched: boolean; status: string | undefined; exitCode: number | null | undefined }> {
  const stub = stubFor(threadId);
  return runInDurableObject(stub, async (instance: ThinkThreadAgent) => {
    const testInstance = instance as LedgerTestableAgent;
    // Reads only (`listActiveWatchersView`, `execList`) — the fake backend is
    // never actually called, but `resolveComputeService` still needs an
    // override to avoid constructing a real Daytona backend, mirroring
    // `startWatchedProcess`.
    const cleanup = primeCompute(threadId, new FakeComputeBackend());
    try {
      const resolved = await testInstance.resolveComputeServiceForTest();
      if (!resolved) throw new Error("expected compute service");
      const watched = resolved.service
        .listActiveWatchersView()
        .some((watcher) => watcher.processId === processId);
      const { processes } = await resolved.service.execList({ status: "all" });
      const process = processes.find((p) => p.id === processId);
      return { watched, status: process?.status, exitCode: process?.exitCode };
    } finally {
      cleanup();
    }
  });
}

function postCompletion(token: string, body: unknown) {
  return SELF.fetch("https://nadi.test/api/compute/completion", {
    method: "POST",
    headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
}

afterAll(() => {
  for (const threadId of REGISTERED_THREADS) clearComputeHostTestOverrides(threadId);
  REGISTERED_THREADS.clear();
});

beforeAll(async () => {
  drizzle(env.REGISTRY_DB, { schema });
  await applyRegistryTestSchema(env.REGISTRY_DB);
});

describe("routeCompletion (DO integration)", () => {
  it("terminalises the ledger row and delivers exactly once", async () => {
    const threadId = "thr-completion-happy";
    await seedThread(threadId);
    const { processId } = await startWatchedProcess(threadId);

    const secret = await deriveCompletionSecret(env.BETTER_AUTH_SECRET);
    const token = await signCompletionToken(secret, {
      threadId,
      processId,
      exp: Date.now() + 600_000,
    });

    const first = await postCompletion(token, { processId, exitCode: 0 });
    expect(first.status).toBe(200);
    expect(await first.json()).toEqual({ accepted: true });

    // Drain the buffer the way a real turn would: the first entry's dedupe
    // key disappears, so the SECOND post's `already_terminal` collapse has to
    // come from the LEDGER, not from the injection buffer's own dedupe-by-key
    // suppression still holding the first (undrained) entry. Without this
    // step, `_turnQueue.isActive = true` (set so the test can inspect the
    // buffer at all) would let the buffer's own key-collision check quietly
    // do the collapsing work instead of the ledger guard this test claims to
    // cover — see `drainInjectionBuffer`'s doc comment.
    await drainInjectionBuffer(threadId);

    // Replay is a no-op, not a second delivery: the row is already terminal.
    const second = await postCompletion(token, { processId, exitCode: 0 });
    expect(second.status).toBe(200);
    expect(await second.json()).toEqual({ accepted: true, reason: "already_terminal" });

    const row = await ledgerRow(threadId, processId);
    expect(row?.terminal).not.toBeNull();
    expect(row?.terminal?.outcome).toBe("exited");

    // Only the first post's message ever reached the buffer — it was drained
    // above, so a buffer with anything in it now means the ledger guard
    // failed to collapse the replay.
    const delivered = await deliveredWatcherMessages(threadId);
    expect(delivered.messages).toHaveLength(0);
    expect(delivered.dedupeKeys).toEqual([]);

    // The compute layer's own bookkeeping must agree with what the model was
    // told: no longer watched, and the store's process row shows the real
    // exit, not whatever it last observed before the push arrived.
    const computeState = await computeStateOf(threadId, processId);
    expect(computeState.watched).toBe(false);
    expect(computeState.status).toBe("exited");
    expect(computeState.exitCode).toBe(0);
  });

  it('reports a non-zero exit as "exited" with the code intact', async () => {
    const threadId = "thr-completion-nonzero";
    await seedThread(threadId);
    const { processId } = await startWatchedProcess(threadId);

    const secret = await deriveCompletionSecret(env.BETTER_AUTH_SECRET);
    const token = await signCompletionToken(secret, {
      threadId,
      processId,
      exp: Date.now() + 600_000,
    });

    const res = await postCompletion(token, { processId, exitCode: 17 });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ accepted: true });

    const row = await ledgerRow(threadId, processId);
    // "exited" regardless of the code — there is no "failed" outcome.
    expect(row?.terminal?.outcome).toBe("exited");

    const delivered = await deliveredWatcherMessages(threadId);
    expect(delivered.messages[0]?.text).toContain("exited with code 17");

    const computeState = await computeStateOf(threadId, processId);
    expect(computeState.status).toBe("exited");
    expect(computeState.exitCode).toBe(17);
  });

  it("rejects a non-integer exit code", async () => {
    const threadId = "thr-completion-badexitcode";
    await seedThread(threadId);
    const { processId } = await startWatchedProcess(threadId);

    const secret = await deriveCompletionSecret(env.BETTER_AUTH_SECRET);
    const token = await signCompletionToken(secret, {
      threadId,
      processId,
      exp: Date.now() + 600_000,
    });

    for (const exitCode of [1.5, Number.NaN, Number.POSITIVE_INFINITY]) {
      const res = await postCompletion(token, { processId, exitCode });
      expect(res.status).toBe(400);
    }

    const row = await ledgerRow(threadId, processId);
    expect(row?.terminal).toBeNull();
  });

  it("rejects a token minted for another thread or process", async () => {
    const threadId = "thr-completion-mismatch";
    await seedThread(threadId);
    const { processId } = await startWatchedProcess(threadId);

    const secret = await deriveCompletionSecret(env.BETTER_AUTH_SECRET);
    const wrongProcessToken = await signCompletionToken(secret, {
      threadId,
      processId: "someone-else",
      exp: Date.now() + 600_000,
    });

    const res = await postCompletion(wrongProcessToken, { processId, exitCode: 0 });
    expect(res.status).toBe(403);

    const row = await ledgerRow(threadId, processId);
    expect(row?.terminal).toBeNull();
  });

  it("401s an invalid or expired token without touching the ledger", async () => {
    const threadId = "thr-completion-badtoken";
    await seedThread(threadId);
    const { processId } = await startWatchedProcess(threadId);

    const res = await postCompletion("not-a-real-token", { processId, exitCode: 0 });
    expect(res.status).toBe(401);

    const row = await ledgerRow(threadId, processId);
    expect(row?.terminal).toBeNull();
  });

  it("declines when background work is disabled for the workspace", async () => {
    const threadId = "thr-completion-disabled";
    const workspaceId = `workspace-${threadId}`;
    await seedThread(threadId);
    // Flip the workspace's own flag off — this is what "turned background
    // work off mid-flight" means; the deployment-level flag stays on.
    await env.REGISTRY_DB.prepare("UPDATE workspaces SET flags_json = ? WHERE id = ?")
      .bind(JSON.stringify({ backgroundWork: false }), workspaceId)
      .run();

    const secret = await deriveCompletionSecret(env.BETTER_AUTH_SECRET);
    const token = await signCompletionToken(secret, {
      threadId,
      processId: "proc-never-registered",
      exp: Date.now() + 600_000,
    });

    const res = await postCompletion(token, { processId: "proc-never-registered", exitCode: 0 });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ accepted: false, reason: "background_work_disabled" });
  });
});
