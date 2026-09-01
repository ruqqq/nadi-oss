import { env } from "cloudflare:test";
import { beforeEach, describe, expect, it } from "vitest";
import { AgentSandboxLedger } from "../../src/compute/agent-sandbox-ledger";
import { createAgentSandboxGate } from "../../src/compute/agent-sandbox-quota";
import { ComputeError } from "../../src/compute/errors";
import { buildAgentSandboxGate } from "../../src/agent/compute-tools";
import { DEFAULT_COMPUTE_LIMITS } from "../../src/compute/config";
import type { BackendReference, ComputeBackend } from "../../src/compute/backend";
import type { EffectiveComputeConfig } from "../../src/compute/types";
import type { Env } from "../../src/env";
import { applyRegistryTestSchema } from "./helpers/registry";

const NOW = 1_000_000;

function ledger() {
  return new AgentSandboxLedger(env.REGISTRY_DB);
}

async function seedWorkspaceAgents(rows: { agentId: string; workspaceId: string }[]) {
  const workspaces = new Set(rows.map((r) => r.workspaceId));
  for (const workspaceId of workspaces) {
    await env.REGISTRY_DB.prepare(
      "INSERT OR IGNORE INTO workspaces (id, name, created_at) VALUES (?1, ?1, 1)",
    )
      .bind(workspaceId)
      .run();
  }
  for (const row of rows) {
    await env.REGISTRY_DB.prepare(
      `INSERT OR IGNORE INTO agents (id, workspace_id, name, system_prompt, provider, model, created_at)
       VALUES (?1, ?2, ?1, '', 'mock', 'mock', 1)`,
    )
      .bind(row.agentId, row.workspaceId)
      .run();
  }
}

const RUNTIME: BackendReference = {
  provider: "mock",
  version: 1,
  payload: { kind: "runtime", sandboxId: "nadi-b1-machine" },
};

function gateFor(
  agentId: string,
  limit: number,
  options: {
    workspaceId?: string;
    reclaim?: (id: string) => Promise<boolean>;
    externalRuntimeId?: (runtime: BackendReference) => string | null;
  } = {},
) {
  return createAgentSandboxGate({
    ledger: ledger(),
    workspaceId: options.workspaceId ?? "ws1",
    agentId,
    provider: "mock",
    limit,
    externalRuntimeId:
      options.externalRuntimeId ??
      ((runtime) => (runtime.payload as { sandboxId: string }).sandboxId),
    now: () => NOW,
    reclaim: options.reclaim ?? (async () => false),
  });
}

function effectiveConfig(provider: "cloudflare" | "daytona" | "sprites"): EffectiveComputeConfig {
  return {
    provider,
    providerConfig: { kind: provider },
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

const FAKE_BACKEND = {
  externalRuntimeId: (reference: BackendReference) =>
    (reference.payload as { sandboxId?: string }).sandboxId ?? null,
} as unknown as ComputeBackend;

describe("AgentSandboxLedger (real D1)", () => {
  beforeEach(async () => {
    await applyRegistryTestSchema(env.REGISTRY_DB);
    await env.REGISTRY_DB.prepare("DELETE FROM agent_sandboxes").run();
    await seedWorkspaceAgents([
      { agentId: "ag_a", workspaceId: "ws1" },
      { agentId: "ag_b", workspaceId: "ws1" },
      { agentId: "ag_c", workspaceId: "ws1" },
      { agentId: "ag_d", workspaceId: "ws1" },
      { agentId: "ag_other", workspaceId: "ws2" },
    ]);
  });

  it("admits up to the limit and refuses past it", async () => {
    expect(
      await ledger().tryAdmit({
        agentId: "ag_a",
        workspaceId: "ws1",
        provider: "mock",
        now: NOW,
        limit: 2,
      }),
    ).toBe(true);
    expect(
      await ledger().tryAdmit({
        agentId: "ag_b",
        workspaceId: "ws1",
        provider: "mock",
        now: NOW,
        limit: 2,
      }),
    ).toBe(true);
    expect(
      await ledger().tryAdmit({
        agentId: "ag_c",
        workspaceId: "ws1",
        provider: "mock",
        now: NOW,
        limit: 2,
      }),
    ).toBe(false);
    expect(await ledger().countActive("ws1")).toBe(2);
  });

  // The cap counts CONCURRENCY, and it counts it through the join — there is no
  // `workspace_id` on `agent_sandboxes` to count flat.
  it("scopes the cap per workspace, through the join on agents", async () => {
    expect(
      await ledger().tryAdmit({
        agentId: "ag_a",
        workspaceId: "ws1",
        provider: "mock",
        now: NOW,
        limit: 1,
      }),
    ).toBe(true);
    expect(
      await ledger().tryAdmit({
        agentId: "ag_other",
        workspaceId: "ws2",
        provider: "mock",
        now: NOW,
        limit: 1,
      }),
    ).toBe(true);
    expect(await ledger().countActive("ws1")).toBe(1);
    expect(await ledger().countActive("ws2")).toBe(1);
  });

  // THE PERSISTENCE INVARIANT. With no TTL, a hibernated box's row lives
  // forever; counting it would turn a concurrency cap into "how many agents may
  // EVER have had a box", and the workspace would wedge permanently.
  it("an idle box keeps its row but frees its slot", async () => {
    await ledger().tryAdmit({
      agentId: "ag_a",
      workspaceId: "ws1",
      provider: "mock",
      now: NOW,
      limit: 1,
    });
    await ledger().recordSprite({
      agentId: "ag_a",
      provider: "mock",
      externalId: "nadi-b1-a",
      now: NOW,
    });
    expect(await ledger().countActive("ws1")).toBe(1);

    await ledger().markIdle({ agentId: "ag_a", now: NOW + 1 });
    expect(await ledger().countActive("ws1")).toBe(0);
    // The row — and therefore the sprite's accountability — survives.
    expect(await ledger().listKnownSpriteNames()).toEqual(new Set(["nadi-b1-a"]));
    expect(
      await ledger().tryAdmit({
        agentId: "ag_b",
        workspaceId: "ws1",
        provider: "mock",
        now: NOW,
        limit: 1,
      }),
    ).toBe(true);
  });

  it("re-admitting the same agent is idempotent, not a second slot, and keeps its sprite name", async () => {
    await ledger().tryAdmit({
      agentId: "ag_a",
      workspaceId: "ws1",
      provider: "mock",
      now: NOW,
      limit: 1,
    });
    await ledger().recordSprite({
      agentId: "ag_a",
      provider: "mock",
      externalId: "nadi-b1-a",
      now: NOW,
    });
    await ledger().markIdle({ agentId: "ag_a", now: NOW });
    expect(
      await ledger().tryAdmit({
        agentId: "ag_a",
        workspaceId: "ws1",
        provider: "mock",
        now: NOW + 5,
        limit: 1,
      }),
    ).toBe(true);
    expect(await ledger().countActive("ws1")).toBe(1);
    // A wake must not blank the name the reconciler reads.
    expect(await ledger().listKnownSpriteNames()).toEqual(new Set(["nadi-b1-a"]));
  });

  it("cannot admit over the limit under concurrent calls", async () => {
    const got = await Promise.all(
      ["ag_a", "ag_b", "ag_c", "ag_d"].map((agentId) =>
        ledger().tryAdmit({ agentId, workspaceId: "ws1", provider: "mock", now: NOW, limit: 2 }),
      ),
    );
    expect(got.filter(Boolean)).toHaveLength(2);
    expect(await ledger().countActive("ws1")).toBe(2);
  });

  it("touch keeps an active row warm and never resurrects an idle one", async () => {
    await ledger().tryAdmit({
      agentId: "ag_a",
      workspaceId: "ws1",
      provider: "mock",
      now: NOW,
      limit: 2,
    });
    await ledger().recordSprite({ agentId: "ag_a", provider: "mock", externalId: "s", now: NOW });
    await ledger().markIdle({ agentId: "ag_a", now: NOW });
    await ledger().touch({ agentId: "ag_a", now: NOW + 100 });
    expect(await ledger().countActive("ws1")).toBe(0);
  });

  it("reclaim candidates are active rows of OTHER agents, least-recently-used first", async () => {
    for (const [agentId, at] of [
      ["ag_a", 30],
      ["ag_b", 10],
      ["ag_c", 20],
    ] as const) {
      await ledger().tryAdmit({ agentId, workspaceId: "ws1", provider: "mock", now: at, limit: 9 });
      await ledger().recordSprite({ agentId, provider: "mock", externalId: agentId, now: at });
    }
    const candidates = await ledger().listReclaimCandidates({
      workspaceId: "ws1",
      excludeAgentId: "ag_a",
    });
    expect(candidates.map((c) => c.agentId)).toEqual(["ag_b", "ag_c"]);
    expect(candidates[0]?.workspaceId).toBe("ws1");
  });

  it("clears stale acquiring rows but leaves fresh ones", async () => {
    await ledger().tryAdmit({
      agentId: "ag_a",
      workspaceId: "ws1",
      provider: "mock",
      now: 100,
      limit: 9,
    });
    await ledger().tryAdmit({
      agentId: "ag_b",
      workspaceId: "ws1",
      provider: "mock",
      now: 900,
      limit: 9,
    });
    expect(await ledger().clearStaleAcquiring(500)).toBe(1);
    expect(await ledger().countAcquiringSince(500)).toBe(1);
  });

  /**
   * THE WORST BUG IN THE PHASE, and it lived inside guard 3's own cure.
   *
   * `tryAdmit`'s `ON CONFLICT DO UPDATE` moves an existing row to `acquiring`
   * on every wake and PRESERVES `sprite_name` — so a hibernated box being
   * restored sits in `acquiring` while still naming a live machine holding the
   * agent's whole disk. The rollback that would put it back runs in the Worker,
   * so a Worker or DO death mid-restore skips it. `clearStaleAcquiring` then
   * DELETED that row, and the next reconciler pass saw a `nadi-b1-*` sprite
   * with no row and deleted a live agent's filesystem.
   */
  it("REGRESSION: a stale acquire that NAMES a machine is demoted to idle, never deleted", async () => {
    // The exact shape a crashed wake leaves: an idle box, re-admitted (which is
    // what a restore does), then abandoned before the rollback could run.
    await ledger().tryAdmit({
      agentId: "ag_a",
      workspaceId: "ws1",
      provider: "mock",
      now: 10,
      limit: 9,
    });
    await ledger().recordSprite({
      agentId: "ag_a",
      provider: "mock",
      externalId: "nadi-b1-live",
      now: 10,
    });
    await ledger().markIdle({ agentId: "ag_a", now: 20 });
    await ledger().tryAdmit({
      agentId: "ag_a",
      workspaceId: "ws1",
      provider: "mock",
      now: 100,
      limit: 9,
    });

    const row = await env.REGISTRY_DB.prepare(
      "SELECT status, sprite_name FROM agent_sandboxes WHERE agent_id = 'ag_a'",
    ).first<{ status: string; sprite_name: string | null }>();
    // ANTI-VACUITY: the wake really did leave a NAMED row sitting in `acquiring`.
    expect(row).toEqual({ status: "acquiring", sprite_name: "nadi-b1-live" });

    expect(await ledger().clearStaleAcquiring(500)).toBe(1);

    // The machine is still accounted for, so the reconciler will not touch it.
    expect(await ledger().listKnownSpriteNames()).toEqual(new Set(["nadi-b1-live"]));
    const after = await env.REGISTRY_DB.prepare(
      "SELECT status FROM agent_sandboxes WHERE agent_id = 'ag_a'",
    ).first<{ status: string }>();
    expect(after?.status).toBe("idle");
    // And it no longer blocks the reap pass, nor holds a concurrency slot.
    expect(await ledger().countAcquiringSince(0)).toBe(0);
    expect(await ledger().countActive("ws1")).toBe(0);
  });

  it("a stale acquire with NO machine name is deleted — the only case with evidence", async () => {
    await ledger().tryAdmit({
      agentId: "ag_b",
      workspaceId: "ws1",
      provider: "mock",
      now: 100,
      limit: 9,
    });
    expect(await ledger().clearStaleAcquiring(500)).toBe(1);
    const after = await env.REGISTRY_DB.prepare(
      "SELECT agent_id FROM agent_sandboxes WHERE agent_id = 'ag_b'",
    ).first();
    expect(after).toBeNull();
  });

  /**
   * ROUND-2 FINDING 1 — the same race `markIdle` refuses to create, which round
   * 1 introduced into `recordSprite` by making it an unguarded upsert.
   *
   * `archiveAgent` tears the box down and `remove()`s the row BEFORE stamping
   * `archived_at`. An acquire still in flight then returns and calls
   * `recordSprite`. Unguarded, that INSERTs a fresh `active` row naming a
   * brand-new sprite for an agent nothing can reach: the reconciler spares it
   * (a row exists), `countActive` counts it forever, and the reclaim RPC can
   * never succeed on an archived agent so the slot is never freed. Before round
   * 1 the bare UPDATE matched zero rows and the reconciler collected the
   * sprite, which was the correct outcome.
   */
  it("REGRESSION: recordSprite for an ARCHIVED agent writes nothing, so the reaper collects the sprite", async () => {
    await ledger().tryAdmit({
      agentId: "ag_a",
      workspaceId: "ws1",
      provider: "mock",
      now: 10,
      limit: 9,
    });
    // The delete: teardown drops the row, then the archive stamp lands.
    await ledger().remove("ag_a");
    await env.REGISTRY_DB.prepare("UPDATE agents SET archived_at = 99 WHERE id = 'ag_a'").run();

    // The in-flight acquire returns AFTER both.
    await ledger().recordSprite({
      agentId: "ag_a",
      provider: "mock",
      externalId: "nadi-b1-raced",
      now: 100,
    });

    const row = await env.REGISTRY_DB.prepare(
      "SELECT agent_id FROM agent_sandboxes WHERE agent_id = 'ag_a'",
    ).first();
    expect(row).toBeNull();
    // Nameless to the reconciler, which is what makes it destroy the sprite —
    // the intended outcome for an agent the user deleted.
    expect(await ledger().listKnownSpriteNames()).toEqual(new Set());
    // And no phantom slot is lost.
    expect(await ledger().countActive("ws1")).toBe(0);
  });

  /**
   * The tail of the same finding: a row that OUTLIVED its delete (a `remove()`
   * that failed and only logged) must not hold a slot, be offered to a reclaim
   * that can never succeed, or spare a sprite nothing can reach.
   *
   * ALL FOUR READERS ARE DRIVEN HERE, deliberately. Round 2 filtered three and
   * missed `tryAdmit` — the statement where the insert IS the lease — and NO
   * TEST NOTICED, because the other three agreed with each other. Three of four
   * is worse than none: `tryAdmit` counting a row `countActive` does not gives
   * a permanent `quota_exhausted` reading "All N-1 slots are busy (limit N)"
   * with nothing to free.
   */
  it("REGRESSION: an archived agent's surviving row holds no slot and protects no sprite", async () => {
    await ledger().tryAdmit({
      agentId: "ag_a",
      workspaceId: "ws1",
      provider: "mock",
      now: 10,
      limit: 9,
    });
    await ledger().recordSprite({
      agentId: "ag_a",
      provider: "mock",
      externalId: "nadi-b1-stranded",
      now: 10,
    });
    // ANTI-VACUITY: while the agent is LIVE, all four answers protect it — the
    // cap included, which is what `tryAdmit` at limit 1 measures.
    expect(await ledger().countActive("ws1")).toBe(1);
    expect(await ledger().listKnownSpriteNames()).toEqual(new Set(["nadi-b1-stranded"]));
    expect(
      (await ledger().listReclaimCandidates({ workspaceId: "ws1", excludeAgentId: "ag_b" })).map(
        (c) => c.agentId,
      ),
    ).toEqual(["ag_a"]);
    expect(
      await ledger().tryAdmit({
        agentId: "ag_b",
        workspaceId: "ws1",
        provider: "mock",
        now: 20,
        limit: 1,
      }),
    ).toBe(false);
    await ledger().remove("ag_b");

    await env.REGISTRY_DB.prepare("UPDATE agents SET archived_at = 99 WHERE id = 'ag_a'").run();

    expect(await ledger().countActive("ws1")).toBe(0);
    expect(await ledger().listKnownSpriteNames()).toEqual(new Set());
    expect(
      await ledger().listReclaimCandidates({ workspaceId: "ws1", excludeAgentId: "ag_b" }),
    ).toEqual([]);
    // THE FOURTH READER. Without its own `archived_at` filter this stays
    // `false` forever: a permanent `quota_exhausted` naming a slot count the
    // other three answers say is free, with no candidate to reclaim.
    expect(
      await ledger().tryAdmit({
        agentId: "ag_b",
        workspaceId: "ws1",
        provider: "mock",
        now: 30,
        limit: 1,
      }),
    ).toBe(true);
  });

  // DISABLE is not DELETE: it leaves `archived_at` null, so a paused agent's
  // box stays protected by every one of the four answers above.
  it("a DISABLED agent's box is still counted, offered and protected", async () => {
    await ledger().tryAdmit({
      agentId: "ag_a",
      workspaceId: "ws1",
      provider: "mock",
      now: 10,
      limit: 9,
    });
    await ledger().recordSprite({
      agentId: "ag_a",
      provider: "mock",
      externalId: "nadi-b1-paused",
      now: 10,
    });
    await env.REGISTRY_DB.prepare("UPDATE agents SET enabled = 0 WHERE id = 'ag_a'").run();

    expect(await ledger().listKnownSpriteNames()).toEqual(new Set(["nadi-b1-paused"]));
    expect(await ledger().countActive("ws1")).toBe(1);
    expect(
      (await ledger().listReclaimCandidates({ workspaceId: "ws1", excludeAgentId: "ag_b" })).map(
        (c) => c.agentId,
      ),
    ).toEqual(["ag_a"]);
    // Still holds its slot: a paused box is real capacity, not a free one.
    expect(
      await ledger().tryAdmit({
        agentId: "ag_b",
        workspaceId: "ws1",
        provider: "mock",
        now: 20,
        limit: 1,
      }),
    ).toBe(false);
  });

  // F2. A bare `UPDATE` matches zero rows and says nothing, leaving a live
  // sprite with no row for the reaper to spare.
  it("recordSprite re-creates a row that was cleared under it", async () => {
    await ledger().tryAdmit({
      agentId: "ag_c",
      workspaceId: "ws1",
      provider: "mock",
      now: 10,
      limit: 9,
    });
    await ledger().remove("ag_c");
    await ledger().recordSprite({
      agentId: "ag_c",
      provider: "mock",
      externalId: "nadi-b1-rescued",
      now: 20,
    });
    expect(await ledger().listKnownSpriteNames()).toEqual(new Set(["nadi-b1-rescued"]));
    expect(await ledger().countActive("ws1")).toBe(1);
  });
});

describe("createAgentSandboxGate (real D1)", () => {
  beforeEach(async () => {
    await applyRegistryTestSchema(env.REGISTRY_DB);
    await env.REGISTRY_DB.prepare("DELETE FROM agent_sandboxes").run();
    await seedWorkspaceAgents([
      { agentId: "ag_a", workspaceId: "ws1" },
      { agentId: "ag_b", workspaceId: "ws1" },
    ]);
  });

  it("admits exactly one of two CONCURRENT acquires at limit=1", async () => {
    const results = await Promise.allSettled([
      gateFor("ag_a", 1).admit(),
      gateFor("ag_b", 1).admit(),
    ]);
    expect(results.filter((r) => r.status === "fulfilled")).toHaveLength(1);
    expect(results.filter((r) => r.status === "rejected")).toHaveLength(1);
    expect(await ledger().countActive("ws1")).toBe(1);
  });

  it("throws quota_exhausted when nothing can be reclaimed", async () => {
    await gateFor("ag_a", 1).admit();
    const err = await gateFor("ag_b", 1)
      .admit()
      .catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ComputeError);
    expect((err as ComputeError).code).toBe("quota_exhausted");
  });

  it("reclaims the LRU agent's box and then admits — without deleting its row", async () => {
    await gateFor("ag_a", 1).admit();
    await gateFor("ag_a", 1).recordRuntime(RUNTIME);
    const reclaimed: string[] = [];
    await expect(
      gateFor("ag_b", 1, {
        reclaim: async (id) => {
          reclaimed.push(id);
          return true;
        },
      }).admit(),
    ).resolves.toBeUndefined();
    expect(reclaimed).toEqual(["ag_a"]);
    // The reclaimed agent's MACHINE is still accounted for. If this row were
    // deleted the orphan reconciler would delete its hibernated sprite.
    expect(await ledger().listKnownSpriteNames()).toEqual(new Set(["nadi-b1-machine"]));
  });

  it("recordRuntime writes the machine name the reconciler reads", async () => {
    await gateFor("ag_a", 1).admit();
    expect(await ledger().listKnownSpriteNames()).toEqual(new Set());
    await gateFor("ag_a", 1).recordRuntime(RUNTIME);
    expect(await ledger().listKnownSpriteNames()).toEqual(new Set(["nadi-b1-machine"]));
  });

  it("idle keeps the row; forget removes it", async () => {
    const gate = gateFor("ag_a", 1);
    await gate.admit();
    await gate.recordRuntime(RUNTIME);
    await gate.idle();
    expect(await ledger().listKnownSpriteNames()).toEqual(new Set(["nadi-b1-machine"]));
    await gate.forget();
    expect(await ledger().listKnownSpriteNames()).toEqual(new Set());
  });
});

describe("buildAgentSandboxGate", () => {
  beforeEach(async () => {
    await applyRegistryTestSchema(env.REGISTRY_DB);
    await env.REGISTRY_DB.prepare("DELETE FROM agent_sandboxes").run();
    await seedWorkspaceAgents([
      { agentId: "ag_a", workspaceId: "ws1" },
      { agentId: "ag_b", workspaceId: "ws1" },
    ]);
  });

  function build(
    provider: "cloudflare" | "daytona" | "sprites",
    modes: { daytonaMode?: "system" | "byok" | null; spritesMode?: "system" | "byok" | null },
    agentId = "ag_a",
  ) {
    return buildAgentSandboxGate({
      env: { ...(env as unknown as Env), MAX_ACTIVE_AGENT_SANDBOXES_PER_WORKSPACE: "1" },
      effectiveConfig: effectiveConfig(provider),
      daytonaMode: modes.daytonaMode ?? null,
      spritesMode: modes.spritesMode ?? null,
      workspaceId: "ws1",
      agentId,
      backend: FAKE_BACKEND,
      now: () => NOW,
    });
  }

  // A gate is ALWAYS built now: it is the writer of the row that keeps the
  // orphan reconciler off the box, not merely a refusal.
  it("rations cloudflare", async () => {
    await build("cloudflare", {}).admit();
    await expect(build("cloudflare", {}, "ag_b").admit()).rejects.toBeInstanceOf(ComputeError);
  });

  it("rations system-managed sprites", async () => {
    await build("sprites", { spritesMode: "system" }).admit();
    await expect(
      build("sprites", { spritesMode: "system" }, "ag_b").admit(),
    ).rejects.toBeInstanceOf(ComputeError);
  });

  it("does NOT ration BYOK sprites — but still writes the row", async () => {
    await build("sprites", { spritesMode: "byok" }).admit();
    await expect(
      build("sprites", { spritesMode: "byok" }, "ag_b").admit(),
    ).resolves.toBeUndefined();
    expect(await ledger().countActive("ws1")).toBe(2);
  });

  it("does NOT ration BYOK daytona, nor daytona with an unknown mode", async () => {
    await build("daytona", { daytonaMode: "byok" }).admit();
    await expect(build("daytona", { daytonaMode: null }, "ag_b").admit()).resolves.toBeUndefined();
  });

  it("rations system-managed daytona", async () => {
    await build("daytona", { daytonaMode: "system" }).admit();
    await expect(
      build("daytona", { daytonaMode: "system" }, "ag_b").admit(),
    ).rejects.toBeInstanceOf(ComputeError);
  });
});
