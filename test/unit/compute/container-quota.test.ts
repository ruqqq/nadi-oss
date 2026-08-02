import { describe, expect, it, vi } from "vitest";
import { ComputeError } from "../../../src/compute/errors";
import {
  createComputeQuotaGate,
  parseMaxActiveContainers,
  DEFAULT_MAX_ACTIVE_CONTAINERS,
  MAX_RECLAIM_ATTEMPTS,
} from "../../../src/compute/container-quota";
import type { ContainerLedger } from "../../../src/compute/container-ledger";

function fakeLedger(over: Partial<ContainerLedger> = {}) {
  return {
    tryAdmit: vi.fn().mockResolvedValue(true),
    refresh: vi.fn().mockResolvedValue(true),
    release: vi.fn().mockResolvedValue(undefined),
    countActive: vi.fn().mockResolvedValue(0),
    listReclaimCandidates: vi.fn().mockResolvedValue([]),
    ...over,
  } as unknown as ContainerLedger;
}

function gate(ledger: ContainerLedger, reclaim = vi.fn().mockResolvedValue(false)) {
  return {
    gate: createComputeQuotaGate({
      ledger,
      workspaceId: "ws1",
      threadId: "t1",
      provider: "cloudflare",
      profile: "small",
      idleTimeoutMs: 900_000,
      limit: 2,
      now: () => 1_000,
      reclaim,
    }),
    reclaim,
  };
}

describe("parseMaxActiveContainers", () => {
  it.each([
    [undefined, DEFAULT_MAX_ACTIVE_CONTAINERS],
    ["", DEFAULT_MAX_ACTIVE_CONTAINERS],
    ["nonsense", DEFAULT_MAX_ACTIVE_CONTAINERS],
    ["0", DEFAULT_MAX_ACTIVE_CONTAINERS],
    ["-3", DEFAULT_MAX_ACTIVE_CONTAINERS],
    ["3", 3],
    [" 7 ", 7],
  ])("parses %p as %p", (input, expected) => {
    expect(parseMaxActiveContainers(input)).toBe(expected);
  });
});

describe("createComputeQuotaGate", () => {
  it("admits when under the cap and does not try to reclaim", async () => {
    const { gate: g, reclaim } = gate(fakeLedger());
    await expect(g.admit()).resolves.toBeUndefined();
    expect(reclaim).not.toHaveBeenCalled();
  });

  it("reclaims the LRU idle container, then admits", async () => {
    const ledger = fakeLedger({
      tryAdmit: vi.fn().mockResolvedValueOnce(false).mockResolvedValueOnce(true),
      listReclaimCandidates: vi.fn().mockResolvedValue([
        {
          threadId: "old",
          workspaceId: "ws1",
          provider: "cloudflare",
          profile: "small",
          lastUsedAt: 1,
          expiresAt: 9e9,
        },
      ]),
    });
    const reclaim = vi.fn().mockResolvedValue(true);
    const { gate: g } = gate(ledger, reclaim);

    await expect(g.admit()).resolves.toBeUndefined();
    expect(reclaim).toHaveBeenCalledWith("old");
    expect(ledger.tryAdmit).toHaveBeenCalledTimes(2);
  });

  it("skips a busy candidate and tries the next", async () => {
    const ledger = fakeLedger({
      tryAdmit: vi.fn().mockResolvedValueOnce(false).mockResolvedValueOnce(true),
      listReclaimCandidates: vi.fn().mockResolvedValue([
        {
          threadId: "busy",
          workspaceId: "ws1",
          provider: "cloudflare",
          profile: "small",
          lastUsedAt: 1,
          expiresAt: 9e9,
        },
        {
          threadId: "idle",
          workspaceId: "ws1",
          provider: "cloudflare",
          profile: "small",
          lastUsedAt: 2,
          expiresAt: 9e9,
        },
      ]),
    });
    const reclaim = vi.fn().mockResolvedValueOnce(false).mockResolvedValueOnce(true);
    const { gate: g } = gate(ledger, reclaim);

    await expect(g.admit()).resolves.toBeUndefined();
    expect(reclaim.mock.calls.map((c) => c[0])).toEqual(["busy", "idle"]);
  });

  it("throws quota_exhausted with an actionable message when nothing is reclaimable", async () => {
    const ledger = fakeLedger({
      tryAdmit: vi.fn().mockResolvedValue(false),
      countActive: vi.fn().mockResolvedValue(2),
      listReclaimCandidates: vi.fn().mockResolvedValue([
        {
          threadId: "busy",
          workspaceId: "ws1",
          provider: "cloudflare",
          profile: "small",
          lastUsedAt: 1,
          expiresAt: 9e9,
        },
      ]),
    });
    const { gate: g } = gate(ledger, vi.fn().mockResolvedValue(false));

    const err = await g.admit().catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ComputeError);
    expect((err as ComputeError).code).toBe("quota_exhausted");
    // Must be human-readable: the user cannot reach the sandbox themselves.
    expect((err as ComputeError).message).toMatch(/sandbox/i);
    expect((err as ComputeError).message).not.toMatch(/^quota_exhausted$/);
  });

  it("bounds total reclaim time by capping attempts at MAX_RECLAIM_ATTEMPTS, not the full candidate list", async () => {
    const candidateCount = MAX_RECLAIM_ATTEMPTS + 5;
    const candidates = Array.from({ length: candidateCount }, (_, i) => ({
      threadId: `t${i}`,
      workspaceId: "ws1",
      provider: "cloudflare",
      profile: "small",
      lastUsedAt: i,
      expiresAt: 9e9,
    }));
    const ledger = fakeLedger({
      tryAdmit: vi.fn().mockResolvedValue(false),
      countActive: vi.fn().mockResolvedValue(candidateCount),
      listReclaimCandidates: vi.fn().mockResolvedValue(candidates),
    });
    const reclaim = vi.fn().mockResolvedValue(false);
    const { gate: g } = gate(ledger, reclaim);

    const err = await g.admit().catch((e: unknown) => e);
    expect((err as ComputeError).code).toBe("quota_exhausted");
    expect(reclaim).toHaveBeenCalledTimes(MAX_RECLAIM_ATTEMPTS);
    expect(reclaim.mock.calls.map((c) => c[0])).toEqual(
      candidates.slice(0, MAX_RECLAIM_ATTEMPTS).map((c) => c.threadId),
    );
  });

  it("REGRESSION (C2): propagates a failed re-admit from refresh instead of discarding it", async () => {
    const held = fakeLedger();
    await expect(gate(held).gate.refresh()).resolves.toBe(true);

    // The live container could not re-claim a slot: the caller must be able to
    // see that (it is an orphaned container, invisible to the cap) — and it must
    // never throw, or a refresh would break the running turn.
    const lost = fakeLedger({ refresh: vi.fn().mockResolvedValue(false) });
    await expect(gate(lost).gate.refresh()).resolves.toBe(false);
  });

  it("treats a throwing reclaim RPC as a refusal, not a failure", async () => {
    const ledger = fakeLedger({
      tryAdmit: vi.fn().mockResolvedValue(false),
      listReclaimCandidates: vi.fn().mockResolvedValue([
        {
          threadId: "boom",
          workspaceId: "ws1",
          provider: "cloudflare",
          profile: "small",
          lastUsedAt: 1,
          expiresAt: 9e9,
        },
      ]),
    });
    const reclaim = vi.fn().mockRejectedValue(new Error("DO unreachable"));
    const { gate: g } = gate(ledger, reclaim);

    const err = await g.admit().catch((e: unknown) => e);
    expect((err as ComputeError).code).toBe("quota_exhausted");
  });
});
