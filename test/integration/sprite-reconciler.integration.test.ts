import { env } from "cloudflare:test";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { ACQUIRE_GRACE_MS, reconcileOrphanSprites } from "../../src/compute/sprite-reconciler";
import { log } from "../../src/log";
import { RECONCILABLE_SPRITE_PREFIX } from "../../src/compute/backends/sprites";
import type { SpritesClient } from "../../src/compute/backends/sprites-client";
import type { Env } from "../../src/env";
import { applyRegistryTestSchema } from "./helpers/registry";

const NOW = 10_000_000;

function fakeClient(names: string[]) {
  const deleted: string[] = [];
  const client = {
    listSprites: async () => ({ names }),
    deleteSprite: async (name: string) => {
      deleted.push(name);
    },
  } as unknown as SpritesClient;
  return { client, deleted };
}

async function seedAgent(agentId: string) {
  await env.REGISTRY_DB.prepare(
    "INSERT OR IGNORE INTO workspaces (id, name, created_at) VALUES ('ws1', 'ws1', 1)",
  ).run();
  await env.REGISTRY_DB.prepare(
    `INSERT OR IGNORE INTO agents (id, workspace_id, name, system_prompt, provider, model, created_at)
     VALUES (?1, 'ws1', ?1, '', 'sprites', 'm', 1)`,
  )
    .bind(agentId)
    .run();
}

async function seedRow(input: {
  agentId: string;
  status: "acquiring" | "active" | "idle";
  spriteName?: string | null;
  lastUsedAt?: number;
}) {
  await seedAgent(input.agentId);
  await env.REGISTRY_DB.prepare(
    `INSERT OR REPLACE INTO agent_sandboxes
       (agent_id, provider, sprite_name, status, created_at, last_used_at)
     VALUES (?1, 'sprites', ?2, ?3, 1, ?4)`,
  )
    .bind(input.agentId, input.spriteName ?? null, input.status, input.lastUsedAt ?? NOW)
    .run();
}

function envWithKey(): Env {
  return { ...(env as unknown as Env), SPRITES_API_KEY: "sk-test" };
}

describe("reconcileOrphanSprites", () => {
  beforeEach(async () => {
    await applyRegistryTestSchema(env.REGISTRY_DB);
    await env.REGISTRY_DB.prepare("DELETE FROM agent_sandboxes").run();
  });

  it("reaps a prefixed sprite with no ledger row", async () => {
    const { client, deleted } = fakeClient([`${RECONCILABLE_SPRITE_PREFIX}stranded`]);
    const result = await reconcileOrphanSprites(envWithKey(), { client, now: () => NOW });
    expect(deleted).toEqual([`${RECONCILABLE_SPRITE_PREFIX}stranded`]);
    expect(result).toMatchObject({ scanned: 1, orphans: 1, deleted: 1 });
  });

  // GUARD 1. Pre-P3 sprites have no row and nothing will ever backfill one — a
  // hibernated box is not woken. Reaping them would delete every existing
  // user's filesystem on this deploy's first cron.
  it("NEVER reaps a legacy nadi- sprite, however unknown it is", async () => {
    const { client, deleted } = fakeClient(["nadi-11111111-2222-3333-4444-555555555555"]);
    const result = await reconcileOrphanSprites(envWithKey(), { client, now: () => NOW });
    expect(deleted).toEqual([]);
    expect(result).toMatchObject({ scanned: 1, orphans: 0, deleted: 0 });
  });

  // GUARD 2, and the spec's own words: a disabled agent's sprite is live and
  // intentional, not an orphan. `status` distinguishes them, and `idle` is what
  // a hibernated box carries.
  it("NEVER reaps a sprite whose agent is merely idle (a disabled agent's box)", async () => {
    const name = `${RECONCILABLE_SPRITE_PREFIX}paused`;
    await seedRow({ agentId: "ag_disabled", status: "idle", spriteName: name });
    const { client, deleted } = fakeClient([name]);
    const result = await reconcileOrphanSprites(envWithKey(), { client, now: () => NOW });
    expect(deleted).toEqual([]);
    expect(result).toMatchObject({ orphans: 0 });
  });

  /**
   * THE DESTRUCTIVE DIRECTION OF GUARD 2, tested at the level where the
   * deletion actually happens.
   *
   * Round 2 narrowed guard 2 from "a row means keep, in EVERY status" to "a
   * LIVE agent's row means keep" — a protective guard made weaker, on the
   * reasoning that deleting an agent promises to delete its machine and only
   * the delete route sets `archived_at`. That reasoning is only worth anything
   * if the reap it enables actually happens: this is the case where a delete's
   * own `remove()` failed and only logged, leaving a row that would otherwise
   * spare the sprite forever with no route left that could reach it.
   *
   * Paired with the disabled-agent case above, which is the same query
   * answering the opposite way. If a future change reverts the narrowing, this
   * test fails; if it widens it, that one does.
   */
  it("REAPS the sprite of an ARCHIVED agent whose row outlived its delete", async () => {
    const name = `${RECONCILABLE_SPRITE_PREFIX}deleted-agent`;
    await seedRow({ agentId: "ag_deleted", status: "idle", spriteName: name });
    await env.REGISTRY_DB.prepare(
      "UPDATE agents SET archived_at = 1 WHERE id = 'ag_deleted'",
    ).run();

    const { client, deleted } = fakeClient([name]);
    const result = await reconcileOrphanSprites(envWithKey(), { client, now: () => NOW });

    expect(deleted).toEqual([name]);
    expect(result).toMatchObject({ orphans: 1, deleted: 1 });
  });

  // The same row, one column different: DISABLE leaves `archived_at` null, so
  // the box survives. This is the pair that makes the narrowing legible.
  it("does NOT reap it when the agent is merely disabled, not deleted", async () => {
    const name = `${RECONCILABLE_SPRITE_PREFIX}same-row-paused`;
    await seedRow({ agentId: "ag_deleted", status: "idle", spriteName: name });
    await env.REGISTRY_DB.prepare("UPDATE agents SET enabled = 0 WHERE id = 'ag_deleted'").run();

    const { client, deleted } = fakeClient([name]);
    await reconcileOrphanSprites(envWithKey(), { client, now: () => NOW });

    expect(deleted).toEqual([]);
  });

  it("NEVER reaps an active agent's sprite", async () => {
    const name = `${RECONCILABLE_SPRITE_PREFIX}busy`;
    await seedRow({ agentId: "ag_busy", status: "active", spriteName: name });
    const { client, deleted } = fakeClient([name]);
    await reconcileOrphanSprites(envWithKey(), { client, now: () => NOW });
    expect(deleted).toEqual([]);
  });

  // GUARD 3. An `acquiring` row may already own a sprite whose name was never
  // recorded, and nothing can say which one — so the whole pass stands down.
  it("reaps NOTHING while any acquire is in flight", async () => {
    await seedRow({
      agentId: "ag_starting",
      status: "acquiring",
      spriteName: null,
      lastUsedAt: NOW,
    });
    const { client, deleted } = fakeClient([`${RECONCILABLE_SPRITE_PREFIX}maybe-theirs`]);
    const result = await reconcileOrphanSprites(envWithKey(), { client, now: () => NOW });
    expect(deleted).toEqual([]);
    expect(result.skipped).toBe("acquire_in_flight");
  });

  // ...but a wedged acquire must not block reconciliation forever, or every
  // sprite stranded after it bills for good.
  it("clears a STALE acquiring row and then reaps", async () => {
    await seedRow({
      agentId: "ag_wedged",
      status: "acquiring",
      spriteName: null,
      lastUsedAt: NOW - ACQUIRE_GRACE_MS - 1,
    });
    const { client, deleted } = fakeClient([`${RECONCILABLE_SPRITE_PREFIX}stranded`]);
    const result = await reconcileOrphanSprites(envWithKey(), { client, now: () => NOW });
    expect(result.staleAcquiring).toBe(1);
    expect(deleted).toEqual([`${RECONCILABLE_SPRITE_PREFIX}stranded`]);
  });

  it("does nothing at all without a system key — BYOK keys are not ours to sweep", async () => {
    const noKey = { ...(env as unknown as Env), SPRITES_API_KEY: "  " };
    const result = await reconcileOrphanSprites(noKey, { now: () => NOW });
    expect(result.skipped).toBe("no_system_key");
  });

  // ROUND 2. The listing takes NO explicit bound: `listSprites(1)` is the only
  // value this provider has ever been observed to accept, and an out-of-range
  // one is a plausible 400 that the daily cron swallows as a WARN — stopping
  // the only collector while still reporting success. `returned` is logged on
  // every pass instead, so an operator can see it plateau at whatever the
  // provider's real cap turns out to be.
  it("asks the provider for its own page size and reports what came back", async () => {
    const asked: Array<number | undefined> = [];
    const logged = vi.spyOn(log, "info").mockImplementation(() => {});
    const client = {
      listSprites: async (maxResults?: number) => {
        asked.push(maxResults);
        return { names: [`${RECONCILABLE_SPRITE_PREFIX}a`, `${RECONCILABLE_SPRITE_PREFIX}b`] };
      },
      deleteSprite: async () => {},
    } as unknown as SpritesClient;

    try {
      await reconcileOrphanSprites(envWithKey(), { client, now: () => NOW });
      expect(asked).toEqual([undefined]);
      expect(logged).toHaveBeenCalledWith("compute.sprite_reconcile_listed", { returned: 2 });
    } finally {
      logged.mockRestore();
    }
  });

  it("a failing delete does not stop the rest of the pass", async () => {
    const names = [`${RECONCILABLE_SPRITE_PREFIX}a`, `${RECONCILABLE_SPRITE_PREFIX}b`];
    const deleted: string[] = [];
    const client = {
      listSprites: async () => ({ names }),
      deleteSprite: async (name: string) => {
        if (name.endsWith("a")) throw new Error("provider down");
        deleted.push(name);
      },
    } as unknown as SpritesClient;

    const result = await reconcileOrphanSprites(envWithKey(), { client, now: () => NOW });
    expect(deleted).toEqual([`${RECONCILABLE_SPRITE_PREFIX}b`]);
    expect(result).toMatchObject({ orphans: 2, deleted: 1 });
  });
});
