import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * Route-level orchestration for POST /api/debug/compact: the DEBUG_TOKEN gate
 * (404 — never a 401 — on a missing/wrong token), the `threadId` requirement,
 * and that the matched route delegates to the thread stub's
 * `debugSeedAndCompact` RPC. `getAgentByName` is mocked; nothing here talks to
 * a real Durable Object, model, or summarizer — that end-to-end proof is a live
 * smoke run against a deployed build (see
 * `.codex/skills/subagent-debug-endpoints/SKILL.md`), matching how the
 * neighbouring cloudflare-compute debug route is tested (its own algorithm
 * lives and is unit-tested elsewhere; this file only guards the route).
 */

const {
  getAgentByName,
  registryDb,
  WorkspaceRepository,
  isSupportedAgentProvider,
  isUsableProviderForWorkspace,
} = vi.hoisted(() => ({
  getAgentByName: vi.fn(),
  registryDb: vi.fn(),
  WorkspaceRepository: vi.fn(),
  isSupportedAgentProvider: vi.fn(),
  isUsableProviderForWorkspace: vi.fn(),
}));
vi.mock("agents", () => ({ getAgentByName }));
vi.mock("../../../src/db/client", () => ({ registryDb }));
vi.mock("../../../src/db/repositories/workspaces", () => ({ WorkspaceRepository }));
vi.mock("../../../src/settings/model-selection", () => ({
  isSupportedAgentProvider,
  isUsableProviderForWorkspace,
}));

import { routeDebug } from "../../../src/http/debug-routes";
import type { Env } from "../../../src/env";

const TOKEN = "debug-secret-token";

function env(): Env {
  return {
    DEBUG_TOKEN: TOKEN,
    THINK_THREAD_AGENT: {},
    DEFAULT_WORKSPACE_ID: "ws_default",
  } as unknown as Env;
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

describe("routeDebug — /api/debug/compact", () => {
  beforeEach(() => {
    getAgentByName.mockReset();
  });

  it("404s on a missing token without touching the stub", async () => {
    const res = await routeDebug(post("/api/debug/compact", { threadId: "t1" }), env());
    expect(res?.status).toBe(404);
    expect(getAgentByName).not.toHaveBeenCalled();
  });

  it("404s (not 401) on a wrong token", async () => {
    const res = await routeDebug(post("/api/debug/compact", { threadId: "t1" }, "wrong"), env());
    expect(res?.status).toBe(404);
    expect(getAgentByName).not.toHaveBeenCalled();
  });

  it("400s when threadId is missing", async () => {
    const res = await routeDebug(post("/api/debug/compact", {}, TOKEN), env());
    expect(res?.status).toBe(400);
    expect(getAgentByName).not.toHaveBeenCalled();
  });

  it("delegates to debugSeedAndCompact via getAgentByName and returns its result", async () => {
    const result = {
      provider: "openai-oauth",
      model: "gpt-5.3-codex-spark",
      budget: { contextWindow: 200_000, compactAfterTokens: 118_000 },
      seeded: { messages: 60, estimatedTokens: 153_400 },
      compacted: true,
      outcome: { status: "shortened", summarizedMessages: 55, summaryTokens: 400 },
    };
    const stub = { debugSeedAndCompact: vi.fn().mockResolvedValue(result) };
    getAgentByName.mockResolvedValue(stub);

    const res = await routeDebug(post("/api/debug/compact", { threadId: "thr_42" }, TOKEN), env());

    expect(res?.status).toBe(200);
    expect(getAgentByName).toHaveBeenCalledWith(expect.anything(), "thr_42");
    expect(stub.debugSeedAndCompact).toHaveBeenCalledTimes(1);
    await expect(res!.json()).resolves.toEqual(result);
  });

  it("surfaces a thrown error as JSON 500, not a bare 1101", async () => {
    const stub = {
      debugSeedAndCompact: vi.fn().mockRejectedValue(new Error("thread_compaction_not_stable")),
    };
    getAgentByName.mockResolvedValue(stub);

    const res = await routeDebug(post("/api/debug/compact", { threadId: "thr_42" }, TOKEN), env());

    expect(res?.status).toBe(500);
    const body = (await res!.json()) as { error: string };
    expect(body.error).toContain("thread_compaction_not_stable");
  });
});

/**
 * Route-level orchestration for POST /api/debug/thread: the optional
 * `{provider, model}` override on the thread's own `thread_index` row. Both
 * `isSupportedAgentProvider` and `isUsableProviderForWorkspace` are mocked —
 * their own gating logic is exercised by the callers that already own it
 * (`thread-routes.ts`'s snapshot resolver); this file only guards that the
 * route wires them in and writes what they approve.
 */
describe("routeDebug — POST /api/debug/thread", () => {
  const agentRow = {
    id: "agent_1",
    provider: "anthropic",
    model: "claude-default",
    modelInputModalities: '["text"]',
  };

  function fakeDb(agent: unknown) {
    const values = vi.fn().mockResolvedValue(undefined);
    return {
      select: vi.fn(() => ({
        from: vi.fn(() => ({
          where: vi.fn(() => ({
            get: vi.fn(async () => agent),
          })),
        })),
      })),
      insert: vi.fn(() => ({ values })),
      _values: values,
    };
  }

  beforeEach(() => {
    getAgentByName.mockReset();
    registryDb.mockReset();
    WorkspaceRepository.mockReset();
    isSupportedAgentProvider.mockReset();
    isUsableProviderForWorkspace.mockReset();
    WorkspaceRepository.mockImplementation(function () {
      return { getOwnerEmail: vi.fn().mockResolvedValue("owner@example.com") };
    });
  });

  it("404s when the workspace has no agent", async () => {
    registryDb.mockReturnValue(fakeDb(null));

    const res = await routeDebug(post("/api/debug/thread", {}, TOKEN), env());

    expect(res?.status).toBe(404);
  });

  it("registers a thread on the agent's default model when no override is given", async () => {
    const db = fakeDb(agentRow);
    registryDb.mockReturnValue(db);

    const res = await routeDebug(post("/api/debug/thread", {}, TOKEN), env());

    expect(res?.status).toBe(200);
    expect(isSupportedAgentProvider).not.toHaveBeenCalled();
    expect(isUsableProviderForWorkspace).not.toHaveBeenCalled();
    const body = (await res!.json()) as { provider: string; model: string };
    expect(body.provider).toBe("anthropic");
    expect(body.model).toBe("claude-default");
    expect(db._values).toHaveBeenCalledWith(
      expect.objectContaining({ modelProvider: "anthropic", model: "claude-default" }),
    );
  });

  it("registers a thread on an override provider/model once validated + usable", async () => {
    const db = fakeDb(agentRow);
    registryDb.mockReturnValue(db);
    isSupportedAgentProvider.mockReturnValue(true);
    isUsableProviderForWorkspace.mockResolvedValue(true);

    const res = await routeDebug(
      post("/api/debug/thread", { provider: "openai-oauth", model: "gpt-5.3-codex-spark" }, TOKEN),
      env(),
    );

    expect(res?.status).toBe(200);
    expect(isSupportedAgentProvider).toHaveBeenCalledWith("openai-oauth");
    expect(isUsableProviderForWorkspace).toHaveBeenCalledWith(
      expect.anything(),
      "ws_default",
      "openai-oauth",
      "owner@example.com",
    );
    const body = (await res!.json()) as { provider: string; model: string };
    expect(body.provider).toBe("openai-oauth");
    expect(body.model).toBe("gpt-5.3-codex-spark");
    expect(db._values).toHaveBeenCalledWith(
      expect.objectContaining({ modelProvider: "openai-oauth", model: "gpt-5.3-codex-spark" }),
    );
  });

  it("400s on an unsupported provider without touching usability or inserting", async () => {
    const db = fakeDb(agentRow);
    registryDb.mockReturnValue(db);
    isSupportedAgentProvider.mockReturnValue(false);

    const res = await routeDebug(
      post("/api/debug/thread", { provider: "not-a-real-provider", model: "x" }, TOKEN),
      env(),
    );

    expect(res?.status).toBe(400);
    expect(isUsableProviderForWorkspace).not.toHaveBeenCalled();
    expect(db._values).not.toHaveBeenCalled();
  });

  it("400s when the model is missing alongside a provider", async () => {
    const db = fakeDb(agentRow);
    registryDb.mockReturnValue(db);
    isSupportedAgentProvider.mockReturnValue(true);

    const res = await routeDebug(
      post("/api/debug/thread", { provider: "openai-oauth" }, TOKEN),
      env(),
    );

    expect(res?.status).toBe(400);
    expect(db._values).not.toHaveBeenCalled();
  });

  it("400s when the provider is supported but not usable for this workspace", async () => {
    const db = fakeDb(agentRow);
    registryDb.mockReturnValue(db);
    isSupportedAgentProvider.mockReturnValue(true);
    isUsableProviderForWorkspace.mockResolvedValue(false);

    const res = await routeDebug(
      post("/api/debug/thread", { provider: "openai-oauth", model: "gpt-5.3-codex-spark" }, TOKEN),
      env(),
    );

    expect(res?.status).toBe(400);
    expect(db._values).not.toHaveBeenCalled();
  });
});
