import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * Route-level orchestration for the Cloudflare compute debug endpoints: the
 * DEBUG_TOKEN gate (404 — never a 401 — on a missing/wrong token), path
 * dispatch, the `threadId` requirement, and that the matched route delegates to
 * the thread stub's RPC. `getAgentByName` is mocked; nothing here talks to a real
 * Durable Object or a real container.
 */

const { getAgentByName } = vi.hoisted(() => ({ getAgentByName: vi.fn() }));
vi.mock("agents", () => ({ getAgentByName }));

import { routeDebug } from "../../../src/http/debug-routes";
import type { Env } from "../../../src/env";

const TOKEN = "debug-secret-token";

function env(): Env {
  return { DEBUG_TOKEN: TOKEN, THINK_THREAD_AGENT: {} } as unknown as Env;
}

function post(path: string, body: unknown, token?: string): Request {
  return new Request(`https://example.com${path}`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      ...(token ? { "x-debug-token": token } : {}),
    },
    body: JSON.stringify(body),
  });
}

describe("routeDebug — cloudflare compute endpoints", () => {
  beforeEach(() => {
    getAgentByName.mockReset();
  });

  it("404s on a missing token without touching the stub", async () => {
    const res = await routeDebug(post("/api/debug/cloudflare-compute", { threadId: "t1" }), env());
    expect(res?.status).toBe(404);
    expect(getAgentByName).not.toHaveBeenCalled();
  });

  it("404s (not 401) on a wrong token", async () => {
    const res = await routeDebug(
      post("/api/debug/cloudflare-compute", { threadId: "t1" }, "wrong"),
      env(),
    );
    expect(res?.status).toBe(404);
    expect(getAgentByName).not.toHaveBeenCalled();
  });

  it("400s when threadId is missing", async () => {
    const res = await routeDebug(post("/api/debug/cloudflare-compute", {}, TOKEN), env());
    expect(res?.status).toBe(400);
    expect(getAgentByName).not.toHaveBeenCalled();
  });

  it("delegates to debugCloudflareCompute via getAgentByName", async () => {
    const result = {
      steps: [{ step: "1. readiness reports ready", ok: true, detail: "ready=true" }],
    };
    const stub = {
      debugCloudflareCompute: vi.fn().mockResolvedValue(result),
      debugCloudflareShutdown: vi.fn(),
    };
    getAgentByName.mockResolvedValue(stub);

    const res = await routeDebug(
      post("/api/debug/cloudflare-compute", { threadId: "thr_42" }, TOKEN),
      env(),
    );

    expect(res?.status).toBe(200);
    expect(getAgentByName).toHaveBeenCalledWith(expect.anything(), "thr_42");
    expect(stub.debugCloudflareCompute).toHaveBeenCalledTimes(1);
    expect(stub.debugCloudflareShutdown).not.toHaveBeenCalled();
    await expect(res!.json()).resolves.toEqual(result);
  });

  it("routes cloudflare-shutdown to debugCloudflareShutdown", async () => {
    const result = { sandboxId: "ws_w_t", destroyed: ["small"], errors: [] };
    const stub = {
      debugCloudflareCompute: vi.fn(),
      debugCloudflareShutdown: vi.fn().mockResolvedValue(result),
    };
    getAgentByName.mockResolvedValue(stub);

    const res = await routeDebug(
      post("/api/debug/cloudflare-shutdown", { threadId: "thr_42" }, TOKEN),
      env(),
    );

    expect(res?.status).toBe(200);
    expect(stub.debugCloudflareShutdown).toHaveBeenCalledTimes(1);
    expect(stub.debugCloudflareCompute).not.toHaveBeenCalled();
    await expect(res!.json()).resolves.toEqual(result);
  });
});
