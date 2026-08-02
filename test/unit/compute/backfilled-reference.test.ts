import { describe, expect, it } from "vitest";
import { DaytonaComputeBackend } from "../../../src/compute/backends/daytona";
import {
  legacyProcessReference,
  legacyRecoveryReference,
  legacyRuntimeReference,
  type LegacySandboxProcessRow,
  type LegacySandboxStateRow,
} from "../../../src/compute/thread-store";

// Regression for C1: store-backfilled references must parse through the real
// Daytona backend's discriminated union. Before the fix the backfill emitted
// kind-less payloads that threw ZodError (not ComputeError("runtime_missing")),
// so no graceful re-provision path caught it. The two shapes never met in a
// test — this is that seam.

const SANDBOX_ID = "sbx-legacy-1";

function legacyStateRow(overrides: Partial<LegacySandboxStateRow>): LegacySandboxStateRow {
  return {
    id: "state-old",
    provider: "daytona",
    provider_sandbox_id: SANDBOX_ID,
    status: "ready",
    created_at: 1,
    last_used_at: 2,
    evict_at: null,
    error: null,
    pending_resource_package: null,
    active_resource_package: "small",
    suspended_at: null,
    suspend_expires_at: null,
    suspend_reason: null,
    ...overrides,
  };
}

const legacyProcessRow: LegacySandboxProcessRow = {
  id: "proc-old",
  provider_session_id: "sess-old",
  provider_command_id: "cmd-old",
};

/** Records the sandbox ids `getSandbox` is asked for so we can assert round-trip. */
function stubClient() {
  const getCalls: string[] = [];
  const startCalls: string[] = [];
  const sandbox = {
    id: SANDBOX_ID,
    start: async () => {
      startCalls.push(SANDBOX_ID);
    },
    stop: async () => {},
    delete: async () => {},
    process: {
      createSession: async () => {},
      deleteSession: async () => {},
      executeSessionCommand: async () => ({ cmdId: "cmd-new" }),
      getSessionCommand: async () => ({ exitCode: 0 }),
      getSessionCommandLogs: async () => ({ stdout: "hi\n", stderr: "" }),
    },
    // acquire now provisions the workspace root, so a resumable sandbox needs fs.
    fs: {
      createFolder: async () => {},
    },
  };
  const client = {
    create: async () => ({ id: SANDBOX_ID }),
    get: async (id: string) => {
      getCalls.push(id);
      return sandbox;
    },
  };
  return { client, getCalls, startCalls };
}

function makeBackend(client: ReturnType<typeof stubClient>["client"]) {
  return new DaytonaComputeBackend({ apiKey: "test", client });
}

describe("store-backfilled references round-trip through DaytonaComputeBackend", () => {
  it("parses a backfilled runtime reference and reaches the owning sandbox", async () => {
    const runtime = legacyRuntimeReference(legacyStateRow({ status: "ready" }));
    expect(runtime).not.toBeNull();

    const { client, getCalls } = stubClient();
    const backend = makeBackend(client);

    const started = await backend.startProcess(runtime!, { command: "echo hi", timeoutMs: 1_000 });
    expect(getCalls).toContain(SANDBOX_ID);
    // Reference produced by the backend must itself round-trip back in.
    expect(await backend.getProcessStatus(runtime!, started.process)).toEqual({
      status: "exited",
      exitCode: 0,
    });
  });

  it("parses a backfilled recovery reference and resumes the sandbox", async () => {
    const recovery = legacyRecoveryReference(legacyStateRow({ status: "suspended" }));
    expect(recovery).not.toBeNull();

    const { client, startCalls } = stubClient();
    const backend = makeBackend(client);

    const runtime = await backend.acquire(
      {
        environmentId: "legacy",
        profile: "small",
        workspaceRoot: "/workspace",
        env: {},
        maxProcessRuntimeMs: 0,
        allowedHosts: null,
      },
      recovery!,
    );
    expect(startCalls).toContain(SANDBOX_ID);
    // Resume yields a runtime reference the backend accepts for further work.
    await expect(
      backend.startProcess(runtime, { command: "true", timeoutMs: 1_000 }),
    ).resolves.toBeDefined();
  });

  it("parses a backfilled process reference against its owning runtime", async () => {
    const runtime = legacyRuntimeReference(legacyStateRow({ status: "ready" }));
    const process = legacyProcessReference(legacyProcessRow, SANDBOX_ID);
    expect(process).not.toBeNull();

    const { client } = stubClient();
    const backend = makeBackend(client);

    // requireProcessRuntime matches only because the backfilled process ref
    // carries the same sandboxId as the runtime ref (the fix's core claim).
    expect(await backend.getProcessStatus(runtime!, process!)).toEqual({
      status: "exited",
      exitCode: 0,
    });
  });

  it("destroys a backfilled recovery reference without throwing (cleanup path)", async () => {
    const recovery = legacyRecoveryReference(legacyStateRow({ status: "suspended" }));
    const { client, getCalls } = stubClient();
    const backend = makeBackend(client);

    await expect(backend.destroy(recovery!)).resolves.toBeUndefined();
    expect(getCalls).toContain(SANDBOX_ID);
  });
});
