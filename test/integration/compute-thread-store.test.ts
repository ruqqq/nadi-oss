import { env, runInDurableObject } from "cloudflare:test";
import { beforeAll, describe, expect, it } from "vitest";
import type { ThinkThreadAgent } from "../../src/agent/think-thread-agent";
import { ThreadComputeStore } from "../../src/compute/thread-store";
import { applyRegistryTestSchema, seedRegistryThread } from "./helpers/registry";

function storageOf(agent: ThinkThreadAgent): DurableObjectStorage {
  return (agent as unknown as { ctx: { storage: DurableObjectStorage } }).ctx.storage;
}

function createLegacyTables(storage: DurableObjectStorage): void {
  storage.sql.exec(`
    CREATE TABLE sandbox_state (
      id text primary key,
      provider text not null,
      provider_sandbox_id text,
      image text not null,
      status text not null,
      created_at integer not null,
      last_used_at integer not null,
      evict_at integer,
      error text,
      pending_resource_package text,
      active_resource_package text,
      suspended_at integer,
      suspend_expires_at integer,
      suspend_reason text
    )
  `);
  storage.sql.exec(`
    CREATE TABLE sandbox_processes (
      id text primary key,
      provider_session_id text,
      provider_command_id text,
      command text not null,
      cwd text,
      status text not null,
      exit_code integer,
      started_at integer not null,
      finished_at integer,
      stdout_bytes integer not null default 0,
      stderr_bytes integer not null default 0,
      stdout_lines integer not null default 0,
      stderr_lines integer not null default 0,
      output_truncated integer not null default 0,
      label text
    )
  `);
}

function seedLegacyProcess(storage: DurableObjectStorage, id: string): void {
  storage.sql.exec(
    `INSERT INTO sandbox_processes
      (id, provider_session_id, provider_command_id, command, cwd, status, exit_code, started_at,
       finished_at, stdout_bytes, stderr_bytes, stdout_lines, stderr_lines, output_truncated, label)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    id,
    "sess-old",
    "cmd-old",
    "pwd",
    "/workspace",
    "exited",
    0,
    10,
    20,
    3,
    0,
    1,
    0,
    0,
    "legacy",
  );
}

describe("ThreadComputeStore (DO SQLite)", () => {
  beforeAll(async () => {
    await applyRegistryTestSchema(env.REGISTRY_DB);
    await seedRegistryThread(env.REGISTRY_DB, { threadId: "thr_compute_store_ready" });
    await seedRegistryThread(env.REGISTRY_DB, { threadId: "thr_compute_store_suspended" });
    await seedRegistryThread(env.REGISTRY_DB, { threadId: "thr_compute_store_transitions" });
    await seedRegistryThread(env.REGISTRY_DB, { threadId: "thr_compute_store_watcher" });
    await seedRegistryThread(env.REGISTRY_DB, { threadId: "thr_compute_store_eager" });
    await seedRegistryThread(env.REGISTRY_DB, { threadId: "thr_compute_store_generation" });
    await seedRegistryThread(env.REGISTRY_DB, { threadId: "thr_compute_store_provider_config" });
  });

  /**
   * `generation` and `generation_absent_at` are two columns holding one fact,
   * and a false `sandbox_reset` tells a model its work is lost when it is not.
   * These pin the exact rules that keep them from drifting.
   */
  describe("generation columns move together", () => {
    const runtime = {
      provider: "daytona" as const,
      version: 1 as const,
      payload: { sandboxId: "sbx-gen" },
    };

    async function withStore(fn: (store: ThreadComputeStore) => void): Promise<void> {
      const stub = env.THINK_THREAD_AGENT.get(
        env.THINK_THREAD_AGENT.idFromName("thr_compute_store_generation"),
      );
      await runInDurableObject(stub, async (agent: ThinkThreadAgent) => {
        const store = new ThreadComputeStore(storageOf(agent));
        store.migrate();
        fn(store);
      });
    }

    it("preserves an absence observation across an UNKNOWN probe, and clears it on teardown", async () => {
      await withStore((store) => {
        store.markActive(runtime, 10);
        store.setGeneration({ kind: "known", nonce: "gen-a" }, 10);
        expect(store.getComputeState()).toMatchObject({
          generation: "gen-a",
          generationAbsentAt: null,
        });

        // The container answered with its nonce gone: a real reset observation.
        store.setGeneration({ kind: "absent", observedAt: 20 }, 20);
        expect(store.getComputeState()).toMatchObject({
          generation: null,
          generationAbsentAt: 20,
        });

        // A transient blip must NOT erase it — absence of evidence is not
        // evidence the wipe un-happened. Erasing here made detection a race.
        store.setGeneration({ kind: "unknown" }, 25);
        expect(store.getComputeState()?.generationAbsentAt).toBe(20);

        // A genuine provision supersedes it.
        store.setGeneration({ kind: "known", nonce: "gen-b" }, 30);
        expect(store.getComputeState()).toMatchObject({
          generation: "gen-b",
          generationAbsentAt: null,
        });
      });
    });

    it("clears BOTH columns on markDiscarding", async () => {
      await withStore((store) => {
        store.markActive(runtime, 10);
        store.setGeneration({ kind: "absent", observedAt: 20 }, 20);
        store.markDiscarding(30);
        expect(store.getComputeState()).toMatchObject({
          status: "discarding",
          generation: null,
          generationAbsentAt: null,
        });
      });
    });

    it("clears BOTH columns on markAbsent", async () => {
      await withStore((store) => {
        store.markActive(runtime, 10);
        store.setGeneration({ kind: "absent", observedAt: 20 }, 20);
        store.markAbsent(30);
        expect(store.getComputeState()).toMatchObject({
          status: "absent",
          generation: null,
          generationAbsentAt: null,
        });
      });
    });

    it("clears BOTH columns on markAcquiring", async () => {
      await withStore((store) => {
        store.markActive(runtime, 10);
        store.setGeneration({ kind: "absent", observedAt: 20 }, 20);
        store.markAcquiring({ provider: "daytona", resourceProfile: "small", now: 30 });
        expect(store.getComputeState()).toMatchObject({
          status: "acquiring",
          generation: null,
          generationAbsentAt: null,
        });
      });
    });
  });

  it("snapshots provider config while compute exists and clears it when absent", async () => {
    const stub = env.THINK_THREAD_AGENT.get(
      env.THINK_THREAD_AGENT.idFromName("thr_compute_store_provider_config"),
    );

    await runInDurableObject(stub, async (agent: ThinkThreadAgent) => {
      const store = new ThreadComputeStore(storageOf(agent));
      store.migrate();
      const providerConfig = {
        kind: "daytona" as const,
        apiKeySecretName: "sandbox:custom-daytona",
        apiUrl: "https://daytona.example.test",
        target: "eu",
        profiles: {
          small: { kind: "image" as const, value: "node:22" },
          medium: { kind: "snapshot" as const, value: "team-medium" },
        },
      };

      store.markAcquiring({
        provider: "daytona",
        providerConfig,
        resourceProfile: "small",
        now: 10,
      });
      expect(store.getComputeState()?.providerConfig).toEqual(providerConfig);

      const runtime = {
        provider: "daytona" as const,
        version: 1 as const,
        payload: { kind: "runtime", sandboxId: "sbx-provider-config" },
      };
      store.markActive(runtime, 20);
      expect(store.getComputeState()?.providerConfig).toEqual(providerConfig);

      const recovery = {
        provider: "daytona" as const,
        version: 1 as const,
        payload: { kind: "recovery", sandboxId: "sbx-provider-config" },
      };
      store.markRecoverable(recovery, 30);
      expect(store.getComputeState()?.providerConfig).toEqual(providerConfig);

      store.markAbsent(50);
      expect(store.getComputeState()).toMatchObject({
        status: "absent",
        provider: null,
        providerConfig: null,
      });
    });
  });

  it("persists the acquired host policy through recovery and clears it when absent", async () => {
    const stub = env.THINK_THREAD_AGENT.get(
      env.THINK_THREAD_AGENT.idFromName("thr_compute_store_allowed_hosts"),
    );

    await runInDurableObject(stub, async (agent: ThinkThreadAgent) => {
      const store = new ThreadComputeStore(storageOf(agent));
      store.migrate();
      store.markAcquiring({
        provider: "daytona",
        allowedHosts: ["api.example.com"],
        resourceProfile: "small",
        now: 10,
      });
      expect(store.getComputeState()?.acquiredAllowedHosts).toEqual(["api.example.com"]);

      store.markActive(
        {
          provider: "daytona",
          version: 1,
          payload: { kind: "runtime", sandboxId: "sbx-policy" },
        },
        20,
      );
      store.markRecoverable(
        {
          provider: "daytona",
          version: 1,
          payload: { kind: "recovery", sandboxId: "sbx-policy" },
        },
        30,
      );
      expect(store.getComputeState()?.acquiredAllowedHosts).toEqual(["api.example.com"]);

      store.markAbsent(50);
      expect(store.getComputeState()?.acquiredAllowedHosts).toBeUndefined();
    });
  });

  it("backfills a ready legacy row into active compute state and reads only provider-neutral columns", async () => {
    const stub = env.THINK_THREAD_AGENT.get(
      env.THINK_THREAD_AGENT.idFromName("thr_compute_store_ready"),
    );

    await runInDurableObject(stub, async (agent: ThinkThreadAgent) => {
      const storage = storageOf(agent);
      createLegacyTables(storage);
      storage.sql.exec(
        `INSERT INTO sandbox_state
          (id, provider, provider_sandbox_id, image, status, created_at, last_used_at, evict_at, error,
           pending_resource_package, active_resource_package, suspended_at, suspend_expires_at, suspend_reason)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        "ready-old",
        "daytona",
        "sbx-ready",
        "node:22",
        "ready",
        1,
        2,
        3,
        null,
        "small",
        "medium",
        null,
        null,
        null,
      );
      seedLegacyProcess(storage, "proc-ready");

      const store = new ThreadComputeStore(storage);
      store.migrate();

      expect(store.getComputeState()).toMatchObject({
        status: "active",
        provider: "daytona",
        runtimeRef: {
          provider: "daytona",
          version: 1,
          payload: { kind: "runtime", sandboxId: "sbx-ready" },
        },
        recoveryRef: null,
        resourceProfile: "medium",
      });
      expect(store.getProcess("proc-ready")?.backendProcessRef).toEqual({
        provider: "daytona",
        version: 1,
        payload: {
          kind: "process",
          sandboxId: "sbx-ready",
          sessionId: "sess-old",
          commandId: "cmd-old",
        },
      });

      storage.sql.exec("UPDATE sandbox_state SET status = 'deleted', provider_sandbox_id = NULL");
      storage.sql.exec(
        "UPDATE sandbox_processes SET provider_session_id = 'changed', provider_command_id = 'changed'",
      );
      expect(store.getComputeState()?.status).toBe("active");
      expect(store.getProcess("proc-ready")?.backendProcessRef).toEqual({
        provider: "daytona",
        version: 1,
        payload: {
          kind: "process",
          sandboxId: "sbx-ready",
          sessionId: "sess-old",
          commandId: "cmd-old",
        },
      });

      const beforeSecondMigration = {
        state: store.getComputeState(),
        process: store.getProcess("proc-ready"),
      };
      store.migrate();
      expect({
        state: store.getComputeState(),
        process: store.getProcess("proc-ready"),
      }).toEqual(beforeSecondMigration);
    });
  });

  it("backfills a suspended legacy row into recoverable compute state", async () => {
    const stub = env.THINK_THREAD_AGENT.get(
      env.THINK_THREAD_AGENT.idFromName("thr_compute_store_suspended"),
    );

    await runInDurableObject(stub, async (agent: ThinkThreadAgent) => {
      const storage = storageOf(agent);
      createLegacyTables(storage);
      storage.sql.exec(
        `INSERT INTO sandbox_state
          (id, provider, provider_sandbox_id, image, status, created_at, last_used_at, evict_at, error,
           pending_resource_package, active_resource_package, suspended_at, suspend_expires_at, suspend_reason)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        "suspended-old",
        "daytona",
        "sbx-old",
        "node:22",
        "suspended",
        1,
        2,
        null,
        null,
        "small",
        "small",
        30,
        40,
        "repository_work_idle",
      );
      seedLegacyProcess(storage, "proc-old");

      const store = new ThreadComputeStore(storage);
      store.migrate();

      expect(store.getComputeState()).toMatchObject({
        status: "recoverable",
        provider: "daytona",
        runtimeRef: null,
        recoveryRef: {
          provider: "daytona",
          version: 1,
          payload: { kind: "recovery", sandboxId: "sbx-old" },
        },
      });
      expect(store.getProcess("proc-old")?.backendProcessRef).toEqual({
        provider: "daytona",
        version: 1,
        payload: {
          kind: "process",
          sandboxId: "sbx-old",
          sessionId: "sess-old",
          commandId: "cmd-old",
        },
      });
    });
  });

  it("eagerly backfills provider-neutral state from the legacy store migration", async () => {
    const stub = env.THINK_THREAD_AGENT.get(
      env.THINK_THREAD_AGENT.idFromName("thr_compute_store_eager"),
    );

    await runInDurableObject(stub, async (agent: ThinkThreadAgent) => {
      const storage = storageOf(agent);
      createLegacyTables(storage);
      storage.sql.exec(
        `INSERT INTO sandbox_state
          (id, provider, provider_sandbox_id, image, status, created_at, last_used_at, evict_at, error,
           pending_resource_package, active_resource_package, suspended_at, suspend_expires_at, suspend_reason)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        "eager-old",
        "daytona",
        "sbx-eager",
        "node:22",
        "ready",
        1,
        2,
        3,
        null,
        "small",
        "small",
        null,
        null,
        null,
      );

      new ThreadComputeStore(storage).migrate();

      expect(new ThreadComputeStore(storage).getComputeState()).toMatchObject({
        status: "active",
        runtimeRef: {
          provider: "daytona",
          version: 1,
          payload: { sandboxId: "sbx-eager" },
        },
      });
    });
  });

  it("persists each compute lifecycle transition", async () => {
    const stub = env.THINK_THREAD_AGENT.get(
      env.THINK_THREAD_AGENT.idFromName("thr_compute_store_transitions"),
    );

    await runInDurableObject(stub, async (agent: ThinkThreadAgent) => {
      const storage = storageOf(agent);
      const store = new ThreadComputeStore(storage);
      store.migrate();
      expect(
        storage.sql
          .exec<{ version: number }>(
            "SELECT version FROM compute_store_schema WHERE name = 'thread_compute_store'",
          )
          .toArray()[0],
      ).toEqual({ version: 2 });

      store.markAcquiring({ provider: "daytona", resourceProfile: "small", now: 10 });
      expect(store.getComputeState()).toMatchObject({ status: "acquiring", lastUsedAt: 10 });

      const runtime = { provider: "daytona", version: 1 as const, payload: { sandboxId: "sbx-1" } };
      store.markActive(runtime, 20);
      store.touchLastUsed(30);
      expect(store.getComputeState()).toMatchObject({
        status: "active",
        runtimeRef: runtime,
        lastUsedAt: 30,
      });

      store.markReleasing(40);
      expect(store.getComputeState()?.status).toBe("releasing");

      const recovery = {
        provider: "daytona",
        version: 1 as const,
        payload: { sandboxId: "sbx-1", mode: "stopped" },
      };
      store.markRecoverable(recovery, 50);
      expect(store.getComputeState()).toMatchObject({
        status: "recoverable",
        runtimeRef: null,
        recoveryRef: recovery,
        // Always NULL since P3: a stored expiry is the only thing a reader
        // could turn back into a timed destroy of the agent's filesystem.
        recoveryExpiresAt: null,
      });

      store.markActive(runtime, 65);
      expect(store.getComputeState()).toMatchObject({
        status: "active",
        runtimeRef: runtime,
        recoveryRef: null,
        recoveryExpiresAt: null,
      });

      store.markDiscarding(70);
      expect(store.getComputeState()?.status).toBe("discarding");
      store.markAbsent(80);
      expect(store.getComputeState()).toMatchObject({
        status: "absent",
        runtimeRef: null,
        recoveryRef: null,
      });

      store.markError({ code: "provider_transient", detail: "retry later" }, 90);
      expect(store.getComputeState()).toMatchObject({
        status: "error",
        errorCode: "provider_transient",
        errorDetail: "retry later",
      });
    });
  });
});

/**
 * FIX ROUND 1 — the real store and the unit-test fake must agree about the
 * ONE field that decides where a completion is delivered.
 *
 * `ThreadComputeStore.updateProcess` deliberately skips `threadId` (a process
 * that changed owners would report to a thread that never started it). The
 * in-memory fake spread the whole patch, so a future caller that patched it
 * would pass in unit tests and be silently dropped in production. Asserted
 * against BOTH implementations from one table, so they cannot drift apart
 * again.
 */
describe("updateProcess never reassigns a process's owner", () => {
  beforeAll(async () => {
    await applyRegistryTestSchema(env.REGISTRY_DB);
  });

  function seedRecord(threadId: string) {
    return {
      id: "proc_owner",
      threadId,
      backendProcessRef: null,
      command: "sleep 1",
      cwd: null,
      status: "running" as const,
      exitCode: null,
      startedAt: 1_000,
      finishedAt: null,
      stdoutBytes: 0,
      stderrBytes: 0,
      stdoutLines: 0,
      stderrLines: 0,
      outputTruncated: false,
      label: null,
    };
  }

  it("is dropped by the real Durable Object store", async () => {
    const { threadId } = await seedRegistryThread(env.REGISTRY_DB, {
      threadId: "thr_store_owner",
      runtime: "think",
    });
    const stub = env.THINK_THREAD_AGENT.get(env.THINK_THREAD_AGENT.idFromName(threadId));
    await (runInDurableObject as any)(stub, async (instance: ThinkThreadAgent) => {
      const store = new ThreadComputeStore(storageOf(instance));
      store.migrate();
      store.createProcess(seedRecord("thr_real_owner"));
      store.updateProcess("proc_owner", {
        status: "exited",
        threadId: "thr_thief",
      });
      const row = store.getProcess("proc_owner");
      expect(row?.status).toBe("exited");
      expect(row?.threadId, "the owner may not be reassigned by a patch").toBe("thr_real_owner");
    });
  });

  it("is dropped by the in-memory fake the unit tests run against", async () => {
    const { createMemoryComputeStore } = await import("../unit/compute/helpers/memory-store");
    const store = createMemoryComputeStore();
    store.createProcess(seedRecord("thr_fake_owner"));
    store.updateProcess("proc_owner", { status: "exited", threadId: "thr_thief" });
    const row = store.getProcess("proc_owner");
    expect(row?.status).toBe("exited");
    expect(
      row?.threadId,
      "the fake must refuse what the real store refuses, or unit tests bless a no-op",
    ).toBe("thr_fake_owner");
  });
});
