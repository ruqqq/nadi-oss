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

  // resolveComputeService's quota gate MUST only ever be built for the
  // Cloudflare provider — a cap silently applied to Daytona (which has its own
  // provider-side capacity) would be a regression. resolveComputeService
  // itself needs a full DB-backed workspace/agent/secrets fixture to drive
  // end to end, so this exercises the narrower, directly testable property
  // that the gate-construction ternary is built on: buildComputeQuotaGate
  // returns undefined for every non-cloudflare provider and a real,
  // ledger-backed gate for cloudflare.
  it("builds a real quota gate for cloudflare", async () => {
    const gate = buildComputeQuotaGate({
      env: env as unknown as Env,
      effectiveConfig: effectiveConfig("cloudflare"),
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

  it("does not build a quota gate for a non-cloudflare provider, so Daytona is never capped by the ledger", () => {
    const gate = buildComputeQuotaGate({
      env: env as unknown as Env,
      effectiveConfig: effectiveConfig("daytona"),
      workspaceId: "ws1",
      threadId: "t-daytona",
      now: () => NOW,
    });
    expect(gate).toBeUndefined();
  });
});
