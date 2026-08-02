import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * Route-level orchestration for the live work-ledger debug endpoints
 * (`/sandbox-reset`, `/work-healthy`): the DEBUG_TOKEN gate (404 — never a 401 —
 * on a missing/wrong token), path dispatch, the `threadId` requirement, argument
 * passthrough, and the no-throw contract (a thrown RPC surfaces as JSON 500, not
 * a bare Worker 1101).
 *
 * `getAgentByName` is mocked: nothing here talks to a real Durable Object or a
 * real container. What these endpoints actually PROVE — that a reset is detected
 * and a healthy run is not faulted — is unverifiable in a unit test by
 * construction, since `FakeComputeBackend` cannot OOM. That is the whole reason
 * the endpoints exist; these tests only cover the wiring around them.
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

function get(path: string, token?: string): Request {
  return new Request(`https://example.com${path}`, {
    headers: token ? { "x-debug-token": token } : {},
  });
}

function stubWith(overrides: Record<string, unknown>) {
  const stub = {
    debugSandboxReset: vi.fn(),
    debugWorkHealthy: vi.fn(),
    debugWorkLedger: vi.fn(),
    ...overrides,
  };
  getAgentByName.mockResolvedValue(stub);
  return stub;
}

describe("routeDebug — work-ledger live verification endpoints", () => {
  beforeEach(() => {
    getAgentByName.mockReset();
  });

  for (const path of ["/api/debug/sandbox-reset", "/api/debug/work-healthy"]) {
    describe(path, () => {
      it("404s on a missing token without touching the stub", async () => {
        const res = await routeDebug(post(path, { threadId: "t1" }), env());
        expect(res?.status).toBe(404);
        expect(getAgentByName).not.toHaveBeenCalled();
      });

      it("404s (not 401) on a wrong token — no existence signal", async () => {
        const res = await routeDebug(post(path, { threadId: "t1" }, "wrong"), env());
        expect(res?.status).toBe(404);
        expect(getAgentByName).not.toHaveBeenCalled();
      });

      it("404s when DEBUG_TOKEN is unset", async () => {
        const res = await routeDebug(post(path, { threadId: "t1" }, TOKEN), {} as unknown as Env);
        expect(res?.status).toBe(404);
        expect(getAgentByName).not.toHaveBeenCalled();
      });

      it("400s when threadId is missing", async () => {
        const res = await routeDebug(post(path, {}, TOKEN), env());
        expect(res?.status).toBe(400);
        expect(getAgentByName).not.toHaveBeenCalled();
      });

      it("surfaces a thrown RPC as JSON 500, never a bare throw", async () => {
        stubWith({
          debugSandboxReset: vi.fn().mockRejectedValue(new Error("sandbox_disabled")),
          debugWorkHealthy: vi.fn().mockRejectedValue(new Error("sandbox_disabled")),
        });
        const res = await routeDebug(post(path, { threadId: "thr_1" }, TOKEN), env());
        expect(res?.status).toBe(500);
        await expect(res!.json()).resolves.toMatchObject({
          error: expect.stringContaining("sandbox_disabled"),
        });
      });
    });
  }

  it("routes sandbox-reset to debugSandboxReset and passes the result through verbatim", async () => {
    // A degraded run: the DO never re-provisioned, so it fell to no_liveness.
    // The route must report that honestly rather than reshaping it.
    const result = {
      provider: "cloudflare",
      processId: "proc_1",
      generationBefore: "gen-a",
      generationAfter: "gen-a",
      generationDiverged: false,
      resetPathExercised: false,
      outcome: "fault",
      reason: "no_liveness",
      reminderDelivered: true,
      reminderText: "<system-reminder>… showed no liveness signal …</system-reminder>",
      terminalViaExplicitSweep: false,
      elapsedMs: 34_000,
      steps: [{ step: "5. force a re-provision (nonce must diverge)", ok: false, detail: "…" }],
    };
    const stub = stubWith({ debugSandboxReset: vi.fn().mockResolvedValue(result) });

    const res = await routeDebug(
      post("/api/debug/sandbox-reset", { threadId: "thr_42" }, TOKEN),
      env(),
    );

    expect(res?.status).toBe(200);
    expect(getAgentByName).toHaveBeenCalledWith(expect.anything(), "thr_42");
    expect(stub.debugSandboxReset).toHaveBeenCalledTimes(1);
    expect(stub.debugWorkHealthy).not.toHaveBeenCalled();
    await expect(res!.json()).resolves.toEqual(result);
  });

  it("routes work-healthy to debugWorkHealthy and passes the result through verbatim", async () => {
    const result = {
      provider: "cloudflare",
      processId: "proc_2",
      generation: "gen-a",
      aliveAfterStaleWindow: true,
      stampAdvancedMs: 21_000,
      outcome: "exited",
      reason: "process_exit",
      faultDelivered: false,
      faultText: null,
      elapsedMs: 41_000,
      steps: [{ step: "6. NO fault was delivered to the model", ok: true, detail: "…" }],
    };
    const stub = stubWith({ debugWorkHealthy: vi.fn().mockResolvedValue(result) });

    const res = await routeDebug(
      post("/api/debug/work-healthy", { threadId: "thr_42" }, TOKEN),
      env(),
    );

    expect(res?.status).toBe(200);
    expect(stub.debugWorkHealthy).toHaveBeenCalledTimes(1);
    expect(stub.debugSandboxReset).not.toHaveBeenCalled();
    await expect(res!.json()).resolves.toEqual(result);
  });

  it("passes sleepSeconds through to debugWorkHealthy, and undefined when omitted", async () => {
    const stub = stubWith({ debugWorkHealthy: vi.fn().mockResolvedValue({}) });

    await routeDebug(
      post("/api/debug/work-healthy", { threadId: "t", sleepSeconds: 45 }, TOKEN),
      env(),
    );
    expect(stub.debugWorkHealthy).toHaveBeenLastCalledWith(45);

    await routeDebug(post("/api/debug/work-healthy", { threadId: "t" }, TOKEN), env());
    expect(stub.debugWorkHealthy).toHaveBeenLastCalledWith(undefined);
  });

  it("does not match GET on either endpoint", async () => {
    stubWith({});
    for (const path of ["/api/debug/sandbox-reset", "/api/debug/work-healthy"]) {
      const res = await routeDebug(
        new Request(`https://example.com${path}?threadId=t`, {
          headers: { "x-debug-token": TOKEN },
        }),
        env(),
      );
      expect(res?.status).toBe(404);
    }
    expect(getAgentByName).not.toHaveBeenCalled();
  });
});

describe("routeDebug — GET /api/debug/work-ledger", () => {
  beforeEach(() => {
    getAgentByName.mockReset();
  });

  it("404s on a missing token without touching the stub", async () => {
    const res = await routeDebug(get("/api/debug/work-ledger?threadId=t1"), env());
    expect(res?.status).toBe(404);
    expect(getAgentByName).not.toHaveBeenCalled();
  });

  it("404s (not 401) on a wrong token — no existence signal", async () => {
    const res = await routeDebug(get("/api/debug/work-ledger?threadId=t1", "wrong"), env());
    expect(res?.status).toBe(404);
    expect(getAgentByName).not.toHaveBeenCalled();
  });

  it("400s when threadId is missing", async () => {
    const res = await routeDebug(get("/api/debug/work-ledger", TOKEN), env());
    expect(res?.status).toBe(400);
    expect(getAgentByName).not.toHaveBeenCalled();
  });

  it("surfaces a thrown RPC as JSON 500, never a bare throw", async () => {
    stubWith({ debugWorkLedger: vi.fn().mockRejectedValue(new Error("boom")) });
    const res = await routeDebug(get("/api/debug/work-ledger?threadId=thr_1", TOKEN), env());
    expect(res?.status).toBe(500);
    await expect(res!.json()).resolves.toMatchObject({ error: expect.stringContaining("boom") });
  });

  it("returns the thread's ledger rows verbatim on 200", async () => {
    const rows = [
      {
        id: "proc_1",
        kind: "process",
        startedAt: 1000,
        lastAliveAt: 1500,
        staleAfterMs: 21_000,
        deadlineAt: 60_000,
        terminal: { outcome: "exited", reason: "process_exit" },
      },
    ];
    const stub = stubWith({ debugWorkLedger: vi.fn().mockResolvedValue({ rows }) });

    const res = await routeDebug(get("/api/debug/work-ledger?threadId=thr_42", TOKEN), env());

    expect(res?.status).toBe(200);
    expect(getAgentByName).toHaveBeenCalledWith(expect.anything(), "thr_42");
    expect(stub.debugWorkLedger).toHaveBeenCalledTimes(1);
    await expect(res!.json()).resolves.toEqual({ rows });
  });
});
