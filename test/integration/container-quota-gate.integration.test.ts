import { env } from "cloudflare:test";
import { beforeEach, describe, expect, it } from "vitest";
import { ContainerLedger } from "../../src/compute/container-ledger";
import { createComputeQuotaGate } from "../../src/compute/container-quota";
import { ComputeError } from "../../src/compute/errors";
import { buildComputeQuotaGate } from "../../src/agent/compute-tools";
import { DEFAULT_COMPUTE_LIMITS } from "../../src/compute/config";
import type { EffectiveComputeConfig } from "../../src/compute/types";
import type { Env } from "../../src/env";
import { applyRegistryTestSchema } from "./helpers/registry";

const NOW = 1_000_000;

function gateFor(threadId: string, limit: number, reclaim = async (_id: string) => false) {
  return createComputeQuotaGate({
    ledger: new ContainerLedger(env.REGISTRY_DB),
    workspaceId: "ws1",
    threadId,
    provider: "cloudflare",
    profile: "small",
    idleTimeoutMs: 900_000,
    limit,
    now: () => NOW,
    reclaim,
  });
}

function effectiveConfig(provider: "cloudflare" | "daytona"): EffectiveComputeConfig {
  return {
    provider,
    providerConfig: provider === "cloudflare" ? { kind: "cloudflare" } : { kind: "daytona" },
    resourceProfile: "small",
    idleTimeoutMs: 900_000,
    recoveryTtlMs: 86_400_000,
    maxProcessRuntimeMs: 600_000,
    monitorPollIntervalMs: 2_000,
    limits: DEFAULT_COMPUTE_LIMITS,
    allowedHosts: null,
    editableEnv: {},
    secretEnvNames: [],
  } as unknown as EffectiveComputeConfig;
}

describe("compute quota gate (real D1)", () => {
  beforeEach(async () => {
    await applyRegistryTestSchema(env.REGISTRY_DB);
    await env.REGISTRY_DB.prepare("DELETE FROM active_containers").run();
  });

  it("admits exactly one of two CONCURRENT acquires at limit=1", async () => {
    const results = await Promise.allSettled([gateFor("t1", 1).admit(), gateFor("t2", 1).admit()]);
    const admitted = results.filter((r) => r.status === "fulfilled");
    const refused = results.filter((r) => r.status === "rejected");

    expect(admitted).toHaveLength(1);
    expect(refused).toHaveLength(1);
    expect(
      await new ContainerLedger(env.REGISTRY_DB).countActive({ workspaceId: "ws1", now: NOW }),
    ).toBe(1);
  });

  it("throws quota_exhausted when nothing can be reclaimed", async () => {
    await gateFor("t1", 1).admit();
    const err = await gateFor("t2", 1)
      .admit()
      .catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ComputeError);
    expect((err as ComputeError).code).toBe("quota_exhausted");
  });

  it("reclaims an idle container and then admits", async () => {
    await gateFor("t1", 1).admit();
    const reclaimed: string[] = [];
    await expect(
      gateFor("t2", 1, async (id) => {
        reclaimed.push(id);
        return true;
      }).admit(),
    ).resolves.toBeUndefined();
    expect(reclaimed).toEqual(["t1"]);
  });

  it("an expired row does not consume a slot", async () => {
    await env.REGISTRY_DB.prepare(
      `INSERT INTO active_containers (thread_id, workspace_id, provider, profile, last_used_at, expires_at)
       VALUES ('stale', 'ws1', 'cloudflare', 'small', 1, 2)`,
    ).run();
    await expect(gateFor("fresh", 1).admit()).resolves.toBeUndefined();
  });

  // The gate is built for providers whose capacity comes out of the operator's
  // budget: Cloudflare always, Daytona only when system-managed. BYOK Daytona
  // bills the workspace's own key, so capping it would ration someone else's
  // account. resolveComputeService needs a full DB-backed workspace/agent/
  // secrets fixture to drive end to end, so these exercise the narrower,
  // directly testable property the gate construction is built on.
  it("builds a real quota gate for cloudflare", async () => {
    const gate = buildComputeQuotaGate({
      env: env as unknown as Env,
      effectiveConfig: effectiveConfig("cloudflare"),
      daytonaMode: null,
      spritesMode: null,
      workspaceId: "ws1",
      threadId: "t-cf",
      now: () => NOW,
    });
    expect(gate).toBeDefined();
    await expect(gate!.admit()).resolves.toBeUndefined();
    expect(
      await new ContainerLedger(env.REGISTRY_DB).countActive({ workspaceId: "ws1", now: NOW }),
    ).toBe(1);
    await gate!.release();
    expect(
      await new ContainerLedger(env.REGISTRY_DB).countActive({ workspaceId: "ws1", now: NOW }),
    ).toBe(0);
  });

  // System-managed Daytona bills the operator's DAYTONA_API_KEY, and it is what
  // new workspaces are provisioned with — leaving it exempt would leave every
  // new account unbounded.
  it("builds a real quota gate for system-managed daytona, and it consumes a ledger slot", async () => {
    const gate = buildComputeQuotaGate({
      env: env as unknown as Env,
      effectiveConfig: effectiveConfig("daytona"),
      daytonaMode: "system",
      spritesMode: null,
      workspaceId: "ws1",
      threadId: "t-daytona-system",
      now: () => NOW,
    });
    expect(gate).toBeDefined();
    await expect(gate!.admit()).resolves.toBeUndefined();
    expect(
      await new ContainerLedger(env.REGISTRY_DB).countActive({ workspaceId: "ws1", now: NOW }),
    ).toBe(1);
    await gate!.release();
    expect(
      await new ContainerLedger(env.REGISTRY_DB).countActive({ workspaceId: "ws1", now: NOW }),
    ).toBe(0);
  });

  it("does not build a quota gate for BYOK daytona, which pays its own provider", () => {
    const gate = buildComputeQuotaGate({
      env: env as unknown as Env,
      effectiveConfig: effectiveConfig("daytona"),
      daytonaMode: "byok",
      spritesMode: null,
      workspaceId: "ws1",
      threadId: "t-daytona-byok",
      now: () => NOW,
    });
    expect(gate).toBeUndefined();
  });

  // A Daytona workspace whose mode could not be resolved must not be capped:
  // fail open rather than refuse work on a mode we are unsure of.
  it("does not build a quota gate for daytona with an unknown mode", () => {
    const gate = buildComputeQuotaGate({
      env: env as unknown as Env,
      effectiveConfig: effectiveConfig("daytona"),
      daytonaMode: null,
      spritesMode: null,
      workspaceId: "ws1",
      threadId: "t-daytona-unknown",
      now: () => NOW,
    });
    expect(gate).toBeUndefined();
  });

  it("never caps the mock provider, whatever the daytona mode says", () => {
    const mock = { ...effectiveConfig("daytona"), provider: "mock" } as EffectiveComputeConfig;
    expect(
      buildComputeQuotaGate({
        env: env as unknown as Env,
        effectiveConfig: mock,
        daytonaMode: "system",
        spritesMode: null,
        workspaceId: "ws1",
        threadId: "t-mock",
        now: () => NOW,
      }),
    ).toBeUndefined();
  });
});
