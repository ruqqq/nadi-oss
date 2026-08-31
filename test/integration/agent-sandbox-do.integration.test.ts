import { env, runInDurableObject } from "cloudflare:test";
import { beforeAll, describe, expect, it } from "vitest";
import { drizzle } from "drizzle-orm/d1";
import * as schema from "../../src/db/schema";
import { applyRegistryTestSchema } from "./helpers/registry";

const now = 1_800_000_000_000;

const WORKSPACE_ID = "ws_sbx";
const AGENT_ID = "agent_sbx";

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
    id: AGENT_ID,
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
    agentId: AGENT_ID,
    kind: "regular",
    title: "T",
    source: "manual",
    createdAt: now,
    updatedAt: now,
  });
}

function stub(threadId: string) {
  return env.AGENT_SANDBOX.get(env.AGENT_SANDBOX.idFromName(threadId));
}

describe("AgentSandbox durable object", () => {
  beforeAll(async () => {
    await applyRegistryTestSchema(env.REGISTRY_DB);
  });

  it("runs a command using its OWN storage, not the thread DO's", async () => {
    const threadId = "thr_sbx_run";
    await seedComputeEnabledThread(threadId);

    const result = await stub(threadId).runCommand({
      threadId,
      command: "echo hello",
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.exitCode).toBe(0);

    // The compute_state row must exist in THIS DO's SQLite. That is the claim.
    await runInDurableObject(stub(threadId), async (_instance, state) => {
      const rows = [...state.storage.sql.exec("SELECT id, status FROM compute_state").raw()];
      expect(rows.length).toBe(1);
    });
  });

  it("reports compute state through the RPC surface", async () => {
    const threadId = "thr_sbx_state";
    await seedComputeEnabledThread(threadId);

    await stub(threadId).runCommand({ threadId, command: "echo hi" });
    const view = await stub(threadId).getComputeStateView({ threadId });
    expect(view.ok).toBe(true);
    if (!view.ok) return;
    expect(view.value?.status).toBe("active");
  });

  it("returns null state before anything has run", async () => {
    const threadId = "thr_sbx_empty";
    await seedComputeEnabledThread(threadId);

    const view = await stub(threadId).getComputeStateView({ threadId });
    expect(view.ok).toBe(true);
    if (!view.ok) return;
    expect(view.value).toBeNull();
  });

  it("ENCODES an error instead of throwing across RPC", async () => {
    const result = await stub("thr_missing").runCommand({
      threadId: "thr_missing",
      command: "echo hello",
    });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(typeof result.error.code).toBe("string");
  });
});
