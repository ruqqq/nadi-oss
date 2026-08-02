import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * Route-level wiring for `/api/debug/thread-search-repair`: the DEBUG_TOKEN gate,
 * the optional `limit` passthrough, limit validation, and the no-throw contract.
 *
 * The endpoint exists because Cloudflare cron triggers cannot be invoked
 * manually, so this is the only way to drain the search backfill or exercise the
 * repair path without waiting for the daily run. Whether repair actually indexes
 * anything is covered by the integration suite against real D1; this file mocks
 * the repair function and only proves the route hands off correctly.
 */

const { repairStaleThreadSearchProjections } = vi.hoisted(() => ({
  repairStaleThreadSearchProjections: vi.fn(),
}));
vi.mock("../../../src/thread-knowledge/repair", () => ({ repairStaleThreadSearchProjections }));
vi.mock("agents", () => ({ getAgentByName: vi.fn() }));

import { routeDebug } from "../../../src/http/debug-routes";
import type { Env } from "../../../src/env";

const TOKEN = "debug-secret-token";
const PATH = "/api/debug/thread-search-repair";

function env(): Env {
  return { DEBUG_TOKEN: TOKEN, THINK_THREAD_AGENT: {} } as unknown as Env;
}

function post(body: unknown, token?: string): Request {
  return new Request(`https://example.com${PATH}`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      ...(token ? { "x-debug-token": token } : {}),
    },
    body: JSON.stringify(body),
  });
}

describe("routeDebug — /api/debug/thread-search-repair", () => {
  beforeEach(() => {
    repairStaleThreadSearchProjections.mockReset();
    repairStaleThreadSearchProjections.mockResolvedValue({
      selected: 10,
      succeeded: 9,
      failed: 1,
      remaining: 42,
    });
  });

  it("404s on a missing token without running repair", async () => {
    const res = await routeDebug(post({}), env());
    expect(res?.status).toBe(404);
    expect(repairStaleThreadSearchProjections).not.toHaveBeenCalled();
  });

  it("404s (not 401) on a wrong token — no existence signal", async () => {
    const res = await routeDebug(post({}, "nope"), env());
    expect(res?.status).toBe(404);
    expect(repairStaleThreadSearchProjections).not.toHaveBeenCalled();
  });

  it("runs the default batch when no limit is given", async () => {
    const res = await routeDebug(post({}, TOKEN), env());
    expect(res?.status).toBe(200);
    await expect(res?.json()).resolves.toEqual({
      selected: 10,
      succeeded: 9,
      failed: 1,
      remaining: 42,
    });
    expect(repairStaleThreadSearchProjections).toHaveBeenCalledTimes(1);
    expect(repairStaleThreadSearchProjections.mock.calls[0]).toHaveLength(1);
  });

  it("passes an explicit limit through", async () => {
    const res = await routeDebug(post({ limit: 50 }, TOKEN), env());
    expect(res?.status).toBe(200);
    expect(repairStaleThreadSearchProjections.mock.calls[0]?.[1]).toBe(50);
  });

  it("400s on a non-positive or non-finite limit without running repair", async () => {
    for (const limit of [0, -5, "many"]) {
      const res = await routeDebug(post({ limit }, TOKEN), env());
      expect(res?.status).toBe(400);
    }
    expect(repairStaleThreadSearchProjections).not.toHaveBeenCalled();
  });

  it("surfaces a thrown repair as JSON 500, not a bare Worker error", async () => {
    repairStaleThreadSearchProjections.mockRejectedValue(new Error("d1 exploded"));
    const res = await routeDebug(post({}, TOKEN), env());
    expect(res?.status).toBe(500);
    await expect(res?.json()).resolves.toMatchObject({ error: expect.stringContaining("d1") });
  });
});
