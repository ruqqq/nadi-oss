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
import { beforeAll, describe, expect, it } from "vitest";
import * as schema from "../../src/db/schema";
import type { ThinkThreadAgent } from "../../src/agent/think-thread-agent";
import type { WorkLedgerStore } from "../../src/agent/work-ledger-store";
import { deriveCompletionSecret, signCompletionToken } from "../../src/compute/completion-token";
import { FakeComputeBackend } from "../../src/compute/backends/fake";
import type { ThreadComputeService } from "../../src/compute/thread-service";
import { saveDaytonaApiKey } from "../../src/compute/settings";
import { applyRegistryTestSchema, seedRegistryThread } from "./helpers/registry";

type LedgerTestableAgent = ThinkThreadAgent & {
  __unsafe_ensureInitialized(): Promise<void>;
  _testSandboxServiceOverrides?: {
    buildBackend?: () => Promise<FakeComputeBackend>;
    execForegroundTimeoutMs?: number;
    execForegroundPollIntervalMs?: number;
  };
  resolveComputeServiceForTest(): Promise<{ service: ThreadComputeService } | null>;
};

function ledgerOf(instance: ThinkThreadAgent): WorkLedgerStore {
  return (instance as unknown as { workLedger: WorkLedgerStore }).workLedger;
}

function injectionsOf(
  instance: ThinkThreadAgent,
): Array<{ kind: string; text: string }> {
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

/** Prime the agent for compute work: fake backend, instant backgrounding. */
function primeCompute(instance: ThinkThreadAgent, backend: FakeComputeBackend): () => void {
  const testInstance = instance as LedgerTestableAgent;
  testInstance._testSandboxServiceOverrides = {
    buildBackend: async () => backend,
    execForegroundTimeoutMs: 1,
    execForegroundPollIntervalMs: 1,
  };
  return () => {
    delete testInstance._testSandboxServiceOverrides;
  };
}

/** Start a real backgrounded, watched process; returns its real ledger row id. */
async function startWatchedProcess(threadId: string): Promise<{ processId: string }> {
  const stub = stubFor(threadId);
  return runInDurableObject(stub, async (instance: ThinkThreadAgent) => {
    const testInstance = instance as LedgerTestableAgent;
    await testInstance.__unsafe_ensureInitialized();
    const cleanup = primeCompute(instance, new FakeComputeBackend());
    // Keep the completion's proactive injection sitting in the durable
    // buffer instead of being drained straight into `submitMessages` (which
    // needs a real chat session this test never sets up) — same trick
    // `work-ledger.integration.test.ts` uses to count reminders.
    (instance as unknown as { _turnQueue?: { isActive: boolean } })._turnQueue = {
      isActive: true,
    };
    try {
      const resolved = await testInstance.resolveComputeServiceForTest();
      if (!resolved) throw new Error("expected compute service");
      const execResult = (await resolved.service.exec({
        command: "sleep 300",
        label: "build",
      })) as { status: string; processId: string };
      expect(execResult.status).toBe("backgrounded");
      return { processId: execResult.processId };
    } finally {
      cleanup();
    }
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

function postCompletion(token: string, body: unknown) {
  return SELF.fetch("https://nadi.test/api/compute/completion", {
    method: "POST",
    headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
}

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

    // Replay is a no-op, not a second delivery: the row is already terminal.
    const second = await postCompletion(token, { processId, exitCode: 0 });
    expect(second.status).toBe(200);
    expect(await second.json()).toEqual({ accepted: true, reason: "already_terminal" });

    const row = await ledgerRow(threadId, processId);
    expect(row?.terminal).not.toBeNull();
    expect(row?.terminal?.outcome).toBe("exited");

    const delivered = await deliveredWatcherMessages(threadId);
    expect(delivered.messages).toHaveLength(1);
    expect(delivered.dedupeKeys).toEqual([`watcher:${processId}:exited`]);
    expect(delivered.messages[0]?.text).toContain("exited with code 0");
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
