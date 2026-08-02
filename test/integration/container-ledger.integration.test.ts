import { env } from "cloudflare:test";
import { beforeEach, describe, expect, it } from "vitest";
import { ContainerLedger } from "../../src/compute/container-ledger";
import { applyRegistryTestSchema } from "./helpers/registry";

const NOW = 1_000_000;
const TTL = 60_000;

function ledger() {
  return new ContainerLedger(env.REGISTRY_DB);
}

async function admit(threadId: string, limit: number, now = NOW, workspaceId = "ws1") {
  return await ledger().tryAdmit({
    threadId,
    workspaceId,
    provider: "cloudflare",
    profile: "small",
    now,
    ttlMs: TTL,
    limit,
  });
}

describe("ContainerLedger", () => {
  beforeEach(async () => {
    await applyRegistryTestSchema(env.REGISTRY_DB);
    await env.REGISTRY_DB.prepare("DELETE FROM active_containers").run();
  });

  it("admits up to the limit and refuses past it", async () => {
    expect(await admit("t1", 2)).toBe(true);
    expect(await admit("t2", 2)).toBe(true);
    expect(await admit("t3", 2)).toBe(false);
    expect(await ledger().countActive({ workspaceId: "ws1", now: NOW })).toBe(2);
  });

  it("does not count expired rows, so a leaked row cannot wedge the cap", async () => {
    expect(await admit("stale", 1)).toBe(true);
    // Long after `stale`'s expires_at (NOW + TTL) has passed:
    const later = NOW + TTL + 1;
    expect(await admit("fresh", 1, later)).toBe(true);
    expect(await ledger().countActive({ workspaceId: "ws1", now: later })).toBe(1);
  });

  it("scopes the cap per workspace", async () => {
    expect(await admit("a", 1, NOW, "ws1")).toBe(true);
    expect(await admit("b", 1, NOW, "ws2")).toBe(true);
  });

  it("re-admitting the same thread is idempotent, not a second slot", async () => {
    expect(await admit("t1", 1)).toBe(true);
    expect(await admit("t1", 1)).toBe(true);
    expect(await ledger().countActive({ workspaceId: "ws1", now: NOW })).toBe(1);
  });

  it("cannot admit over the limit under concurrent calls", async () => {
    const got = await Promise.all(["a", "b", "c", "d"].map((t) => admit(t, 2)));
    expect(got.filter(Boolean)).toHaveLength(2);
    expect(await ledger().countActive({ workspaceId: "ws1", now: NOW })).toBe(2);
  });

  it("release frees a slot", async () => {
    expect(await admit("t1", 1)).toBe(true);
    expect(await admit("t2", 1)).toBe(false);
    await ledger().release("t1");
    expect(await admit("t2", 1)).toBe(true);
  });

  it("refresh extends expiry", async () => {
    await admit("t1", 1);
    const held = await ledger().refresh({
      threadId: "t1",
      workspaceId: "ws1",
      provider: "cloudflare",
      profile: "small",
      now: NOW + 10_000,
      ttlMs: TTL,
      limit: 1,
    });
    expect(held).toBe(true);
    expect(await ledger().countActive({ workspaceId: "ws1", now: NOW + TTL + 1 })).toBe(1);
  });

  it("self-heals: refreshing a thread whose row was pruned re-establishes it", async () => {
    await admit("t1", 1);
    // Simulate the row having been pruned (e.g. by the opportunistic-expiry
    // sweep) while the container behind it is still alive.
    await env.REGISTRY_DB.prepare("DELETE FROM active_containers WHERE thread_id = ?1")
      .bind("t1")
      .run();
    expect(await ledger().countActive({ workspaceId: "ws1", now: NOW })).toBe(0);

    await ledger().refresh({
      threadId: "t1",
      workspaceId: "ws1",
      provider: "cloudflare",
      profile: "small",
      now: NOW + 10_000,
      ttlMs: TTL,
      limit: 1,
    });

    expect(await ledger().countActive({ workspaceId: "ws1", now: NOW + 10_000 })).toBe(1);
  });

  it("self-heal is fail-safe: does not resurrect a row when the workspace is genuinely at cap", async () => {
    await admit("t1", 1);
    await env.REGISTRY_DB.prepare("DELETE FROM active_containers WHERE thread_id = ?1")
      .bind("t1")
      .run();
    // Fill the single slot with a different thread so t1's re-claim attempt
    // is genuinely refused.
    expect(await admit("someone-else", 1, NOW + 1)).toBe(true);

    // Fail-safe: never throws — but it must REPORT the lost slot, not swallow it.
    await expect(
      ledger().refresh({
        threadId: "t1",
        workspaceId: "ws1",
        provider: "cloudflare",
        profile: "small",
        now: NOW + 2,
        ttlMs: TTL,
        limit: 1,
      }),
    ).resolves.toBe(false);

    expect(
      (
        await ledger().listReclaimCandidates({
          workspaceId: "ws1",
          excludeThreadId: "someone-else",
          now: NOW + 2,
        })
      ).map((r) => r.threadId),
    ).not.toContain("t1");
  });

  it("lists reclaim candidates oldest-first, excluding self", async () => {
    await ledger().tryAdmit({
      threadId: "old",
      workspaceId: "ws1",
      provider: "cloudflare",
      profile: "small",
      now: NOW,
      ttlMs: TTL,
      limit: 9,
    });
    await ledger().tryAdmit({
      threadId: "new",
      workspaceId: "ws1",
      provider: "cloudflare",
      profile: "small",
      now: NOW + 5_000,
      ttlMs: TTL,
      limit: 9,
    });
    await ledger().tryAdmit({
      threadId: "self",
      workspaceId: "ws1",
      provider: "cloudflare",
      profile: "small",
      now: NOW + 1_000,
      ttlMs: TTL,
      limit: 9,
    });

    const got = await ledger().listReclaimCandidates({
      workspaceId: "ws1",
      excludeThreadId: "self",
      now: NOW,
    });
    expect(got.map((r) => r.threadId)).toEqual(["old", "new"]);
  });

  it("excludes expired rows from reclaim candidates", async () => {
    await ledger().tryAdmit({
      threadId: "expired",
      workspaceId: "ws1",
      provider: "cloudflare",
      profile: "small",
      now: NOW,
      ttlMs: TTL,
      limit: 9,
    });
    // Query at a time after "expired"'s expires_at (NOW + TTL) has passed:
    const later = NOW + TTL + 1;

    const got = await ledger().listReclaimCandidates({
      workspaceId: "ws1",
      excludeThreadId: "self",
      now: later,
    });
    expect(got.map((r) => r.threadId)).not.toContain("expired");
  });
});
