import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * Route-level orchestration for /api/debug/sprites-smoke: the DEBUG_TOKEN gate
 * (404 — never a 401/405 — on a missing/wrong token, matching every other
 * debug route), the SPRITES_API_KEY precondition (400, checked AFTER the
 * token gate), and that a matched request delegates to `runSpritesSmoke`. The
 * live smoke itself needs a real sprites.dev key and cannot run here — see
 * `src/compute/backends/sprites-smoke.ts`; it IS the test for the provider.
 */

const { runSpritesSmoke, getAgentByName } = vi.hoisted(() => ({
  runSpritesSmoke: vi.fn(),
  getAgentByName: vi.fn(),
}));
vi.mock("../../../src/compute/backends/sprites-smoke", () => ({ runSpritesSmoke }));
// debug-routes.ts imports `agents` at module scope for every other debug
// route's threadStub(); it must be mocked even though sprites-smoke doesn't
// use it, or loading the module drags in "cloudflare:workers" under Node.
vi.mock("agents", () => ({ getAgentByName }));

import { routeDebug } from "../../../src/http/debug-routes";
import type { Env } from "../../../src/env";

const TOKEN = "debug-secret-token";

function env(withSpritesKey = true): Env {
  return {
    DEBUG_TOKEN: TOKEN,
    ...(withSpritesKey ? { SPRITES_API_KEY: "sprites-key" } : {}),
  } as unknown as Env;
}

function post(token?: string, withSpritesKey = true): { req: Request; env: Env } {
  return {
    req: new Request("https://example.com/api/debug/sprites-smoke", {
      method: "POST",
      headers: token ? { "x-debug-token": token } : {},
    }),
    env: env(withSpritesKey),
  };
}

describe("routeDebug — sprites-smoke", () => {
  beforeEach(() => {
    runSpritesSmoke.mockReset();
  });

  it("404s on a missing token without touching the smoke", async () => {
    const { req, env: e } = post();
    const res = await routeDebug(req, e);
    expect(res?.status).toBe(404);
    expect(runSpritesSmoke).not.toHaveBeenCalled();
  });

  it("404s (not 401) on a wrong token", async () => {
    const { req, env: e } = post("wrong");
    const res = await routeDebug(req, e);
    expect(res?.status).toBe(404);
    expect(runSpritesSmoke).not.toHaveBeenCalled();
  });

  it("400s when SPRITES_API_KEY is not set, without touching the smoke", async () => {
    const { req, env: e } = post(TOKEN, false);
    const res = await routeDebug(req, e);
    expect(res?.status).toBe(400);
    await expect(res!.json()).resolves.toEqual({ error: "SPRITES_API_KEY not set" });
    expect(runSpritesSmoke).not.toHaveBeenCalled();
  });

  it("delegates to runSpritesSmoke and returns its report verbatim", async () => {
    const report = {
      ok: true,
      steps: [{ step: "1. acquire", ok: true, detail: "sprite created", ms: 12 }],
    };
    runSpritesSmoke.mockResolvedValue(report);

    const { req, env: e } = post(TOKEN);
    const res = await routeDebug(req, e);

    expect(res?.status).toBe(200);
    expect(runSpritesSmoke).toHaveBeenCalledTimes(1);
    expect(runSpritesSmoke).toHaveBeenCalledWith(e);
    await expect(res!.json()).resolves.toEqual(report);
  });

  it("never leaks SPRITES_API_KEY or DEBUG_TOKEN into the response", async () => {
    const report = { ok: false, steps: [{ step: "1. acquire", ok: false, detail: "boom", ms: 1 }] };
    runSpritesSmoke.mockResolvedValue(report);

    const { req, env: e } = post(TOKEN);
    const res = await routeDebug(req, e);
    const text = await res!.text();

    expect(text).not.toContain("sprites-key");
    expect(text).not.toContain(TOKEN);
  });
});
