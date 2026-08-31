/**
 * END-TO-END coverage for `resolveComputeService` itself (src/agent/compute-tools.ts),
 * not a reimplementation of its two-call resolve pattern. The old unit test
 * (`test/unit/compute/env-resolve.test.ts`) defined a local
 * `resolveWithLazyProfile` helper that reimplemented the "resolve once with no
 * profile, bail early, resolve again with the workbench profile" wiring and
 * then tested the helper — a change to the REAL wiring in
 * `resolveComputeService` could never fail those tests, because they never
 * imported it. These two cases drive the exported function directly, over a
 * real thread Durable Object's storage and a real D1-backed registry, so a
 * regression in the actual resolution order fails here.
 */
import { env, runInDurableObject } from "cloudflare:test";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import type { ThinkThreadAgent } from "../../src/agent/think-thread-agent";
import {
  adoptCommittedWorkbenchResourceProfile,
  resolveComputeService,
  type ComputeServiceHostDeps,
} from "../../src/agent/compute-tools";
import { FakeComputeBackend } from "../../src/compute/backends/fake";
import type {
  BackendProcessReference,
  BackendReference,
  ComputeBackend,
  ComputeSpec,
  DirEntry,
  PathInfo,
  ProcessStatus,
  ReadFileResult,
  ReleaseOptions,
  StartProcessInput,
  StartProcessResult,
  StopMode,
  WriteFileOptions,
} from "../../src/compute/backend";
import { ThreadRepositorySnapshotRepository } from "../../src/db/repositories/thread-repository-snapshots";
import { ThreadComputeStore } from "../../src/compute/thread-store";
import { ComputeError } from "../../src/compute/errors";
import { DEFAULT_COMPUTE_ALLOWED_HOSTS } from "../../src/compute/config";
import type { Env } from "../../src/env";
import { createWorkspaceSecretsServices } from "../../src/secrets";
import { applyRegistryTestSchema, seedRegistryThread } from "./helpers/registry";

const NOW = 1_800_000_000_000;

function storageOf(agent: ThinkThreadAgent): DurableObjectStorage {
  return (agent as unknown as { ctx: { storage: DurableObjectStorage } }).ctx.storage;
}

function baseDeps(
  threadId: string,
  workspaceId: string,
  agentId: string,
  storage: DurableObjectStorage,
): ComputeServiceHostDeps {
  return {
    env: env as unknown as Env,
    threadId,
    storage,
    resolveRuntimeConfig: async () => ({ workspaceId, agentId }),
    scheduleEviction: async () => {},
    cancelEviction: async () => {},
    deliverSystemReminder: async () => {},
    supportsProcessMonitor: false,
    // Required, no default — see `ComputeServiceHostDeps.backgroundLongRunningExec`.
    // Matches the production derivation (`supportsProcessMonitor && !attachedRuntime`)
    // for the `supportsProcessMonitor: false` above.
    backgroundLongRunningExec: false,
    buildBackend: async () => new FakeComputeBackend(),
    now: () => NOW,
  };
}

async function seedComputeEnabledWorkspace(workspaceId: string) {
  await env.REGISTRY_DB.prepare(
    `INSERT INTO workspace_sandbox_settings
      (workspace_id, enabled, provider, provider_config_json,
       image, idle_timeout_ms, recovery_ttl_ms, max_process_runtime_ms, limits_json,
       network_restriction_enabled, network_domain_allowlist)
     VALUES (?, 1, 'cloudflare', ?, '', 900000, 86400000, 600000, '{}', 0, '')`,
  )
    .bind(workspaceId, JSON.stringify({ kind: "cloudflare" }))
    .run();
}

class ProviderCheckingBackend implements ComputeBackend {
  readonly destroyCalls: BackendReference[] = [];

  constructor(readonly id: "daytona" | "cloudflare") {}

  async acquire(spec: ComputeSpec, recovery?: BackendReference): Promise<BackendReference> {
    void spec;
    if (recovery && recovery.provider !== this.id) {
      throw new ComputeError("recovery_failed", `${this.id}_recovery_reference_invalid`);
    }
    return {
      provider: this.id,
      version: 1,
      payload: { kind: "runtime", sandboxId: `${this.id}-runtime`, profile: "small" },
    };
  }

  async release(
    runtime: BackendReference,
    options: ReleaseOptions,
  ): Promise<BackendReference | null> {
    void options;
    if (runtime.provider !== this.id) {
      throw new ComputeError("runtime_missing", `${this.id}_runtime_reference_invalid`);
    }
    return null;
  }

  async destroy(reference: BackendReference): Promise<void> {
    if (reference.provider !== this.id) {
      throw new ComputeError("runtime_missing", `${this.id}_runtime_reference_invalid`);
    }
    this.destroyCalls.push(reference);
  }

  async startProcess(
    runtime: BackendReference,
    input: StartProcessInput,
  ): Promise<StartProcessResult> {
    void input;
    if (runtime.provider !== this.id) {
      throw new ComputeError("runtime_missing", `${this.id}_runtime_reference_invalid`);
    }
    return {
      status: "exited",
      exitCode: 0,
      process: { provider: this.id, version: 1, payload: { kind: "process", sandboxId: "p" } },
    };
  }

  async getProcessStatus(
    runtime: BackendReference,
    process: BackendProcessReference,
  ): Promise<ProcessStatus> {
    void process;
    if (runtime.provider !== this.id) {
      throw new ComputeError("runtime_missing", `${this.id}_runtime_reference_invalid`);
    }
    return { status: "exited", exitCode: 0 };
  }

  async readProcessOutput(): Promise<{ stdout?: string; stderr?: string }> {
    return {};
  }

  async stopProcess(
    runtime: BackendReference,
    process: BackendProcessReference,
    mode: StopMode,
  ): Promise<ProcessStatus> {
    void process;
    void mode;
    if (runtime.provider !== this.id) {
      throw new ComputeError("runtime_missing", `${this.id}_runtime_reference_invalid`);
    }
    return { status: "stopped" };
  }

  async inspectPath(runtime: BackendReference, path: string): Promise<PathInfo | null> {
    void runtime;
    void path;
    return null;
  }

  async pathExists(runtime: BackendReference, path: string): Promise<boolean> {
    void runtime;
    void path;
    return false;
  }

  async listDirectory(runtime: BackendReference, path: string): Promise<DirEntry[]> {
    void runtime;
    void path;
    return [];
  }

  async readFile(
    runtime: BackendReference,
    path: string,
    maxBytes: number,
  ): Promise<ReadFileResult> {
    void runtime;
    void path;
    void maxBytes;
    return { bytes: new ArrayBuffer(0) };
  }

  async writeFile(
    runtime: BackendReference,
    path: string,
    bytes: ArrayBuffer,
    options: WriteFileOptions,
  ): Promise<void> {
    void runtime;
    void path;
    void bytes;
    void options;
  }

  async createDirectory(runtime: BackendReference, path: string): Promise<void> {
    void runtime;
    void path;
  }

  async deletePath(runtime: BackendReference, path: string): Promise<void> {
    void runtime;
    void path;
  }

  async movePath(
    runtime: BackendReference,
    from: string,
    to: string,
    overwrite: boolean,
  ): Promise<void> {
    void runtime;
    void from;
    void to;
    void overwrite;
  }
}

describe("resolveComputeService (real D1 + real DO storage)", () => {
  beforeAll(async () => {
    await applyRegistryTestSchema(env.REGISTRY_DB);
  });

  it("takes config.resourceProfile from the thread's workbench snapshot, not the default", async () => {
    const threadId = "thr_resolve_snapshot_profile";
    const { workspaceId, agentId } = await seedRegistryThread(env.REGISTRY_DB, {
      threadId,
      runtime: "think",
    });
    await seedComputeEnabledWorkspace(workspaceId);

    const workbenchId = "wb_resolve_snapshot_profile";
    await env.REGISTRY_DB.prepare(
      `INSERT INTO workbenches (id, workspace_id, name, resource_profile, sandbox_env_vars_json, created_at, updated_at)
       VALUES (?, ?, 'Medium bench', 'medium', '{}', ?, ?)`,
    )
      .bind(workbenchId, workspaceId, NOW, NOW)
      .run();
    await env.REGISTRY_DB.prepare(
      `INSERT INTO thread_workbench_snapshots (thread_id, workspace_id, workbench_id, name, setup_script, resource_profile, created_at)
       VALUES (?, ?, ?, 'Medium bench', '', 'medium', ?)`,
    )
      .bind(threadId, workspaceId, workbenchId, NOW)
      .run();

    const stub = env.THINK_THREAD_AGENT.get(env.THINK_THREAD_AGENT.idFromName(threadId));
    await runInDurableObject(stub, async (agent: ThinkThreadAgent) => {
      const storage = storageOf(agent);
      // No prior compute state exists on this fresh DO, so
      // `store.getComputeState()?.resourceProfile` cannot mask what this task
      // changed: the profile threaded from the snapshot into `config.value`.
      const resolved = await resolveComputeService(
        baseDeps(threadId, workspaceId, agentId, storage),
      );
      expect(resolved).not.toBeNull();
      expect(resolved?.config.resourceProfile).toBe("medium");
    });
  });

  it("unions the workbench allowlist into allowedHosts, and drops the agent override", async () => {
    const threadId = "thr_resolve_workbench_allowlist";
    const { workspaceId, agentId } = await seedRegistryThread(env.REGISTRY_DB, {
      threadId,
      runtime: "think",
    });
    // Workspace restriction ON with its own allowlist — the master switch.
    await env.REGISTRY_DB.prepare(
      `INSERT INTO workspace_sandbox_settings
        (workspace_id, enabled, provider, provider_config_json,
         image, idle_timeout_ms, recovery_ttl_ms, max_process_runtime_ms, limits_json,
         network_restriction_enabled, network_domain_allowlist)
       VALUES (?, 1, 'cloudflare', ?, '', 900000, 86400000, 600000, '{}', 1, 'ws.example.com')`,
    )
      .bind(workspaceId, JSON.stringify({ kind: "cloudflare" }))
      .run();
    // A retired agent-level override that must NOT reach the allowlist anymore.
    await env.REGISTRY_DB.prepare(
      `UPDATE agents SET sandbox_network_domain_allowlist = 'agent.example.com' WHERE id = ?`,
    )
      .bind(agentId)
      .run();

    const workbenchId = "wb_resolve_allowlist";
    await env.REGISTRY_DB.prepare(
      `INSERT INTO workbenches (id, workspace_id, name, resource_profile, sandbox_env_vars_json, sandbox_network_domain_allowlist, created_at, updated_at)
       VALUES (?, ?, 'Bench', 'small', '{}', 'wb.example.com', ?, ?)`,
    )
      .bind(workbenchId, workspaceId, NOW, NOW)
      .run();
    await env.REGISTRY_DB.prepare(
      `INSERT INTO thread_workbench_snapshots (thread_id, workspace_id, workbench_id, name, setup_script, resource_profile, created_at)
       VALUES (?, ?, ?, 'Bench', '', 'small', ?)`,
    )
      .bind(threadId, workspaceId, workbenchId, NOW)
      .run();

    const stub = env.THINK_THREAD_AGENT.get(env.THINK_THREAD_AGENT.idFromName(threadId));
    await runInDurableObject(stub, async (agent: ThinkThreadAgent) => {
      const storage = storageOf(agent);
      const resolved = await resolveComputeService(
        baseDeps(threadId, workspaceId, agentId, storage),
      );
      expect(resolved).not.toBeNull();
      const hosts = resolved?.config.allowedHosts ?? [];
      expect(hosts).toContain("ws.example.com");
      expect(hosts).toContain("wb.example.com");
      expect(hosts).not.toContain("agent.example.com");
    });
  });

  it("activates Daytona restrictions from a workbench allowlist and preserves default, skill, and enabled MCP hosts", async () => {
    const threadId = "thr_resolve_daytona_workbench_allowlist";
    const { workspaceId, agentId } = await seedRegistryThread(env.REGISTRY_DB, {
      threadId,
      runtime: "think",
    });
    await env.REGISTRY_DB.prepare(
      `INSERT INTO workspace_sandbox_settings
        (workspace_id, enabled, provider, provider_config_json,
         image, idle_timeout_ms, recovery_ttl_ms, max_process_runtime_ms, limits_json,
         network_restriction_enabled, network_domain_allowlist)
       VALUES (?, 1, 'daytona', ?, '', 900000, 86400000, 600000, '{}', 0, '')`,
    )
      .bind(
        workspaceId,
        JSON.stringify({
          kind: "daytona",
          apiKeySecretName: "sandbox:daytona",
          apiUrl: null,
          target: null,
          profiles: {
            small: { kind: "image", value: "node:22" },
            medium: { kind: "image", value: "node:22" },
          },
        }),
      )
      .run();
    const { writer } = createWorkspaceSecretsServices(env as unknown as Env);
    await writer.ensureWorkspaceDek(workspaceId);
    await writer.set(workspaceId, "sandbox:daytona", "test-key");

    const workbenchId = "wb_daytona_allowlist";
    await env.REGISTRY_DB.prepare(
      `INSERT INTO workbenches (id, workspace_id, name, resource_profile, sandbox_env_vars_json, sandbox_network_domain_allowlist, created_at, updated_at)
       VALUES (?, ?, 'Daytona bench', 'small', '{}', 'api.workbench.test', ?, ?)`,
    )
      .bind(workbenchId, workspaceId, NOW, NOW)
      .run();
    await env.REGISTRY_DB.prepare(
      `INSERT INTO thread_workbench_snapshots (thread_id, workspace_id, workbench_id, name, setup_script, resource_profile, created_at)
       VALUES (?, ?, ?, 'Daytona bench', '', 'small', ?)`,
    )
      .bind(threadId, workspaceId, workbenchId, NOW)
      .run();
    await env.REGISTRY_DB.prepare(
      `INSERT INTO skills (id, workspace_id, agent_id, name, description, body, enabled, network_domains, created_at, updated_at)
       VALUES ('skill_daytona_allowlist', ?, ?, 'Network skill', '', '', 1, '["api.skill.test"]', ?, ?)`,
    )
      .bind(workspaceId, agentId, NOW, NOW)
      .run();
    await env.REGISTRY_DB.prepare(
      `INSERT INTO mcp_servers (id, workspace_id, name, url, enabled, created_at)
       VALUES
         ('mcp_daytona_enabled', ?, 'Enabled MCP', 'https://mcp.example.test/sse', 1, ?),
         ('mcp_daytona_disabled', ?, 'Disabled MCP', 'https://disabled.example.test/sse', 0, ?)`,
    )
      .bind(workspaceId, NOW, workspaceId, NOW)
      .run();

    const stub = env.THINK_THREAD_AGENT.get(env.THINK_THREAD_AGENT.idFromName(threadId));
    await runInDurableObject(stub, async (agent: ThinkThreadAgent) => {
      const resolved = await resolveComputeService(
        baseDeps(threadId, workspaceId, agentId, storageOf(agent)),
      );
      expect(resolved).not.toBeNull();
      expect(resolved!.config.allowedHosts).toEqual(
        expect.arrayContaining([
          ...DEFAULT_COMPUTE_ALLOWED_HOSTS,
          "api.workbench.test",
          "api.skill.test",
          "mcp.example.test",
        ]),
      );
      expect(resolved!.config.allowedHosts).not.toContain("disabled.example.test");
    });
  });

  it("never queries the workbench snapshot when compute is disabled for the workspace", async () => {
    const threadId = "thr_resolve_disabled_no_snapshot";
    // Deliberately no `workspace_sandbox_settings` row: compute is disabled by
    // absence, the same as a workspace that never turned it on.
    const { workspaceId, agentId } = await seedRegistryThread(env.REGISTRY_DB, {
      threadId,
      runtime: "think",
    });

    const snapshotSpy = vi.spyOn(
      ThreadRepositorySnapshotRepository.prototype,
      "listWorkbenchSnapshot",
    );

    const stub = env.THINK_THREAD_AGENT.get(env.THINK_THREAD_AGENT.idFromName(threadId));
    await runInDurableObject(stub, async (agent: ThinkThreadAgent) => {
      const storage = storageOf(agent);
      const resolved = await resolveComputeService(
        baseDeps(threadId, workspaceId, agentId, storage),
      );
      expect(resolved).toBeNull();
    });

    // Scoped to THIS thread on purpose. The spy is installed on the prototype,
    // so a bare `not.toHaveBeenCalled()` also fails on calls made by anything
    // else alive in the isolate — background work from another suite, an alarm
    // still draining — none of which says anything about the behaviour under
    // test. That is exactly how this flaked in CI: the recorded call was for an
    // app-generated `thr_c6ff892e-…`, while every thread in this file is a
    // deterministic `thr_resolve_*`. The claim is "resolving a
    // compute-disabled thread does not query ITS snapshot", and this asserts
    // that claim rather than a global that the test cannot control.
    expect(snapshotSpy).not.toHaveBeenCalledWith(threadId);
  });

  /**
   * Regression for the defect that defeated the whole feature: `markAcquiring`
   * persists the resolved profile into the DO's `compute_state`, `markAbsent`
   * preserves it, and BOTH readers (`resolveComputeService` here and
   * `readOrAcquireRuntime` inside the service) prefer that stored value over
   * the workbench-derived config. So once a thread had ever acquired a sandbox,
   * the profile frozen at that first acquire won forever — a small->medium
   * switch re-snapshotted to medium and showed medium in the UI while every
   * later sandbox still provisioned small, from small's base image.
   *
   * This drives the real sequence over real D1 + real DO storage: acquire on a
   * small workbench, move the snapshot to a medium workbench, run the commit's
   * profile-adoption step, release, then acquire again — and asserts on the
   * spec the BACKEND actually received, not on any intermediate value.
   */
  it("acquires with the new workbench's profile and image after a committed switch", async () => {
    const threadId = "thr_switch_reacquires_medium";
    const { workspaceId, agentId } = await seedRegistryThread(env.REGISTRY_DB, {
      threadId,
      runtime: "think",
    });
    // Cloudflare, whose environment source is derived as `provider:profile`.
    // That still makes the base-image half of the defect observable — the
    // profile selects the environment, so a stale profile provisions the wrong
    // one — without needing a Daytona API-key secret in KV.
    await seedComputeEnabledWorkspace(workspaceId);

    for (const [id, name, profile] of [
      ["wb_switch_small", "Small bench", "small"],
      ["wb_switch_medium", "Medium bench", "medium"],
    ] as const) {
      await env.REGISTRY_DB.prepare(
        `INSERT INTO workbenches (id, workspace_id, name, resource_profile, sandbox_env_vars_json, created_at, updated_at)
         VALUES (?, ?, ?, ?, '{}', ?, ?)`,
      )
        .bind(id, workspaceId, name, profile, NOW, NOW)
        .run();
    }

    const snapshotTo = async (workbenchId: string, name: string, profile: string) => {
      await env.REGISTRY_DB.prepare(`DELETE FROM thread_workbench_snapshots WHERE thread_id = ?`)
        .bind(threadId)
        .run();
      await env.REGISTRY_DB.prepare(
        `INSERT INTO thread_workbench_snapshots (thread_id, workspace_id, workbench_id, name, setup_script, resource_profile, created_at)
         VALUES (?, ?, ?, ?, '', ?, ?)`,
      )
        .bind(threadId, workspaceId, workbenchId, name, profile, NOW)
        .run();
    };

    await snapshotTo("wb_switch_small", "Small bench", "small");

    const backend = new FakeComputeBackend();
    const stub = env.THINK_THREAD_AGENT.get(env.THINK_THREAD_AGENT.idFromName(threadId));
    await runInDurableObject(stub, async (agent: ThinkThreadAgent) => {
      const storage = storageOf(agent);
      const deps: ComputeServiceHostDeps = {
        ...baseDeps(threadId, workspaceId, agentId, storage),
        buildBackend: async () => backend,
      };

      // 1. First acquire on the small workbench. This is what writes the
      //    profile into `compute_state` and arms the defect.
      const first = await resolveComputeService(deps);
      expect(first).not.toBeNull();
      await first!.service.ensureRuntimeReference();
      expect(backend.acquireCalls).toHaveLength(1);
      expect(backend.acquireCalls[0]!.spec.profile).toBe("small");
      expect(backend.acquireCalls[0]!.spec.environmentId).toBe("cloudflare:small");

      // 2. The user switches to the medium workbench; the commit re-snapshots.
      await snapshotTo("wb_switch_medium", "Medium bench", "medium");
      // 3. ...and then adopts the committed profile. Without this step the
      //    stored "small" survives and wins on every future read.
      await adoptCommittedWorkbenchResourceProfile(deps);
      // 4. Teardown, exactly as `commitWorkbenchSwitchIfPending` does next.
      await first!.service.execShutdown({ confirm: true });

      // 5. The NEXT acquire — a fresh resolve, as a later turn would do — must
      //    provision medium, from medium's snapshot.
      const second = await resolveComputeService(deps);
      expect(second).not.toBeNull();
      expect(second!.config.resourceProfile).toBe("medium");
      await second!.service.ensureRuntimeReference();

      const latest = backend.acquireCalls.at(-1)!;
      expect(backend.acquireCalls.length).toBeGreaterThan(1);
      expect(latest.spec.profile).toBe("medium");
      expect(latest.spec.environmentId).toBe("cloudflare:medium");
    });
  });

  it("uses the stored provider backend when shutting down a runtime after the workspace provider changes", async () => {
    const threadId = "thr_provider_switch_shutdown";
    const { workspaceId, agentId } = await seedRegistryThread(env.REGISTRY_DB, {
      threadId,
      runtime: "think",
    });
    await seedComputeEnabledWorkspace(workspaceId);

    const daytona = new ProviderCheckingBackend("daytona");
    const cloudflare = new ProviderCheckingBackend("cloudflare");
    const stub = env.THINK_THREAD_AGENT.get(env.THINK_THREAD_AGENT.idFromName(threadId));

    await runInDurableObject(stub, async (agent: ThinkThreadAgent) => {
      const storage = storageOf(agent);
      const store = new ThreadComputeStore(storage);
      store.migrate();
      const storedProviderConfig = {
        kind: "daytona" as const,
        apiKeySecretName: "sandbox:old-daytona",
        apiUrl: "https://old-daytona.example.test",
        target: "us",
        profiles: {
          small: { kind: "image" as const, value: "node:22" },
          medium: null,
        },
      };
      store.markAcquiring({
        provider: "daytona",
        providerConfig: storedProviderConfig,
        resourceProfile: "small",
        now: NOW - 1,
      });
      store.markActive(
        {
          provider: "daytona",
          version: 1,
          payload: { kind: "runtime", sandboxId: "daytona-live" },
        },
        NOW,
      );
      const providerConfigs: unknown[] = [];

      const resolved = await resolveComputeService({
        ...baseDeps(threadId, workspaceId, agentId, storage),
        buildBackend: async (config) => {
          providerConfigs.push(config.providerConfig);
          return config.provider === "daytona" ? daytona : cloudflare;
        },
      });
      expect(resolved).not.toBeNull();

      await resolved!.service.execShutdown({ confirm: true });

      expect(daytona.destroyCalls).toEqual([
        {
          provider: "daytona",
          version: 1,
          payload: { kind: "runtime", sandboxId: "daytona-live" },
        },
      ]);
      expect(cloudflare.destroyCalls).toEqual([]);
      expect(providerConfigs).toEqual([storedProviderConfig]);
      expect(store.getComputeState()?.status).toBe("absent");
    });
  });

  it("uses the stored provider backend when cleaning up expired recovery after the workspace provider changes", async () => {
    const threadId = "thr_provider_switch_recovery_cleanup";
    const { workspaceId, agentId } = await seedRegistryThread(env.REGISTRY_DB, {
      threadId,
      runtime: "think",
    });
    await seedComputeEnabledWorkspace(workspaceId);

    const daytona = new ProviderCheckingBackend("daytona");
    const cloudflare = new ProviderCheckingBackend("cloudflare");
    const stub = env.THINK_THREAD_AGENT.get(env.THINK_THREAD_AGENT.idFromName(threadId));

    await runInDurableObject(stub, async (agent: ThinkThreadAgent) => {
      const storage = storageOf(agent);
      const store = new ThreadComputeStore(storage);
      store.migrate();
      const storedProviderConfig = {
        kind: "daytona" as const,
        apiKeySecretName: "sandbox:old-daytona",
        apiUrl: null,
        target: null,
        profiles: {
          small: { kind: "image" as const, value: "node:22" },
          medium: null,
        },
      };
      store.markAcquiring({
        provider: "daytona",
        providerConfig: storedProviderConfig,
        resourceProfile: "small",
        now: NOW - 2,
      });
      store.markRecoverable(
        {
          provider: "daytona",
          version: 1,
          payload: { kind: "recovery", sandboxId: "daytona-recovery" },
        },
        NOW - 1,
        NOW - 1,
      );

      const resolved = await resolveComputeService({
        ...baseDeps(threadId, workspaceId, agentId, storage),
        buildBackend: async (config) => (config.provider === "daytona" ? daytona : cloudflare),
      });
      expect(resolved).not.toBeNull();

      await resolved!.service.execShutdown({ confirm: true });

      expect(daytona.destroyCalls).toEqual([
        {
          provider: "daytona",
          version: 1,
          payload: { kind: "recovery", sandboxId: "daytona-recovery" },
        },
      ]);
      expect(cloudflare.destroyCalls).toEqual([]);
      expect(store.getComputeState()?.status).toBe("absent");
    });
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });
});
