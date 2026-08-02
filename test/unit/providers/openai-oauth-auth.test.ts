import { describe, expect, it, vi } from "vitest";
import {
  OpenAIOAuthAuthManager,
  parseOpenAIOAuthTokens,
  stringifyOpenAIOAuthTokens,
} from "../../../src/providers/openai-oauth/auth";

describe("OpenAI OAuth auth manager", () => {
  it("parses tokens and extracts account id from either field name", () => {
    expect(parseOpenAIOAuthTokens('{"access_token":"a","account_id":"acct"}')).toMatchObject({
      accessToken: "a",
      accountId: "acct",
    });
    expect(parseOpenAIOAuthTokens('{"access_token":"a","accountId":"acct2"}')).toMatchObject({
      accountId: "acct2",
    });
  });

  it("prefers top-level tokens over a stale nested `tokens` block", () => {
    // A persisted secret that contains both a stale nested copy and a rotated
    // top-level copy (the shape stringify produces from a Codex auth.json paste).
    const parsed = parseOpenAIOAuthTokens(
      JSON.stringify({
        tokens: { access_token: "A0", refresh_token: "R0", account_id: "acct" },
        access_token: "A1",
        refresh_token: "R1",
      }),
    );
    expect(parsed.refreshToken).toBe("R1");
    expect(parsed.accessToken).toBe("A1");
    expect(parsed.accountId).toBe("acct");
  });

  it("round-trips a rotated refresh token from a nested Codex auth.json shape", () => {
    // Simulate a pasted Codex `auth.json` (nested `tokens`), then a rotation.
    const parsed = parseOpenAIOAuthTokens(
      JSON.stringify({
        OPENAI_API_KEY: null,
        tokens: { id_token: "id0", access_token: "A0", refresh_token: "R0", account_id: "acct" },
        last_refresh: "2026-06-28T00:00:00.000Z",
      }),
    );
    expect(parsed.refreshToken).toBe("R0");

    const rotated = stringifyOpenAIOAuthTokens({
      ...parsed,
      accessToken: "A1",
      refreshToken: "R1",
      raw: { ...parsed.raw, access_token: "A1", refresh_token: "R1" },
    });

    // The next load must see the rotated token, not the stale nested one.
    const reloaded = parseOpenAIOAuthTokens(rotated);
    expect(reloaded.refreshToken).toBe("R1");
    expect(reloaded.accessToken).toBe("A1");
    // The nested block must not retain the stale rotated-away secrets.
    const persisted = JSON.parse(rotated) as { tokens?: Record<string, unknown> };
    expect(persisted.tokens?.refresh_token).toBe("R1");
    expect(persisted.tokens?.access_token).toBe("A1");
  });

  it("refreshes stale tokens and persists the updated token JSON", async () => {
    const saved: string[] = [];
    const fetch = vi.fn(async (_input: RequestInfo | URL, _init?: RequestInit) => {
      return new Response(
        JSON.stringify({
          access_token: "fresh-access",
          refresh_token: "fresh-refresh",
          expires_in: 3600,
        }),
        { status: 200, headers: { "content-type": "application/json" } },
      );
    });
    const manager = new OpenAIOAuthAuthManager({
      load: async () =>
        JSON.stringify({
          access_token: "old-access",
          refresh_token: "refresh",
          account_id: "account",
          expires_at: Date.now() - 1000,
        }),
      save: async (value) => {
        saved.push(value);
      },
      fetch,
    });

    await expect(manager.getAuthHeaders()).resolves.toEqual({
      Authorization: "Bearer fresh-access",
      "chatgpt-account-id": "account",
      "OpenAI-Beta": "responses=experimental",
    });
    expect(fetch).toHaveBeenCalledWith(
      "https://auth.openai.com/oauth/token",
      expect.objectContaining({
        method: "POST",
        headers: expect.objectContaining({ "content-type": "application/json" }),
      }),
    );
    const refreshInit = fetch.mock.calls[0]?.[1];
    expect(JSON.parse(String(refreshInit?.body))).toMatchObject({
      grant_type: "refresh_token",
      refresh_token: "refresh",
      client_id: "app_EMoamEEZ73f0CkXaXp7hrann",
      scope: "openid profile email offline_access",
    });
    expect(saved).toHaveLength(1);
    expect(JSON.parse(saved[0] ?? "{}")).toMatchObject({
      access_token: "fresh-access",
      refresh_token: "fresh-refresh",
      account_id: "account",
    });
  });

  it("collapses concurrent refreshes into a single token request (single-flight)", async () => {
    const saved: string[] = [];
    let inFlight = 0;
    let maxInFlight = 0;
    const fetch = vi.fn(async (_input: RequestInfo | URL, _init?: RequestInit) => {
      inFlight += 1;
      maxInFlight = Math.max(maxInFlight, inFlight);
      await new Promise((resolve) => setTimeout(resolve, 10));
      inFlight -= 1;
      return new Response(
        JSON.stringify({ access_token: "fresh", refresh_token: "rotated", expires_in: 3600 }),
        { status: 200, headers: { "content-type": "application/json" } },
      );
    });
    const manager = new OpenAIOAuthAuthManager({
      load: async () =>
        JSON.stringify({
          access_token: "old",
          refresh_token: "r1",
          account_id: "account",
          expires_at: Date.now() - 1000,
        }),
      save: async (value) => {
        saved.push(value);
      },
      fetch,
    });

    const [a, b, c] = await Promise.all([
      manager.getAuthHeaders(),
      manager.getAuthHeaders(),
      manager.getAuthHeaders(),
    ]);

    // The (rotating) refresh token must be replayed exactly once.
    expect(fetch).toHaveBeenCalledTimes(1);
    expect(maxInFlight).toBe(1);
    expect(saved).toHaveLength(1);
    expect(a).toEqual(b);
    expect(b).toEqual(c);
    expect(a.Authorization).toBe("Bearer fresh");
  });
});
