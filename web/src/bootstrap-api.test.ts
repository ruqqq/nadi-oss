import { describe, expect, it } from "vitest";
import { getBootstrap, parseBootstrap } from "./bootstrap-api";

function mockFetch(status: number, body: unknown): typeof fetch {
  return (async () =>
    new Response(JSON.stringify(body), {
      status,
      headers: { "content-type": "application/json" },
    })) as typeof fetch;
}

describe("getBootstrap", () => {
  it("preserves explicit background-work feature values", () => {
    expect(parseBootstrap({ features: { backgroundWork: true } }).backgroundWorkEnabled).toBe(true);
    expect(parseBootstrap({ features: { backgroundWork: false } }).backgroundWorkEnabled).toBe(false);
  });

  // The agent picker reads this at first paint. A dropped field here would show
  // an empty picker until the follow-up `GET /api/agents` landed — visible, but
  // not an error anywhere.
  it("carries the agent list, defaulting to empty when absent", () => {
    const agents = [{ id: "env_1", name: "Nadi", description: "", enabled: true }];
    expect(parseBootstrap({ agents }).agents).toEqual(agents);
    expect(parseBootstrap({}).agents).toEqual([]);
  });

  it("parses an authenticated payload into session + settings + threads", async () => {
    const data = await getBootstrap(
      mockFetch(200, {
        session: { authenticated: true, user: { id: "u1", email: "u1@example.com" } },
        settings: { workspace: { id: "w1", name: "W" }, agent: {}, providers: [] },
        threads: [{ threadId: "t1", title: "Hi" }],
        projects: [{ id: "p1", name: "Project 1" }],
        features: {
          voiceInput: true,
          workersAi: true,
          feedbackAdmin: true,
          backgroundWork: true,
          agentNetworkAllowlist: true,
        },
      }),
    );

    expect(data.session).toEqual({
      authenticated: true,
      user: { id: "u1", email: "u1@example.com" },
    });
    expect(data.settings?.workspace.id).toBe("w1");
    expect(data.threads).toHaveLength(1);
    expect(data.projects).toEqual([{ id: "p1", name: "Project 1" }]);
    expect(data.voiceEnabled).toBe(true);
    expect(data.workersAiEnabled).toBe(true);
    expect(data.feedbackAdminEnabled).toBe(true);
    expect(data.backgroundWorkEnabled).toBe(true);
    expect(data.agentNetworkAllowlistEnabled).toBe(true);
  });

  it("normalizes an unauthenticated payload and defaults settings/threads/projects", async () => {
    const data = await getBootstrap(mockFetch(200, { session: { authenticated: false } }));

    expect(data.session).toEqual({ authenticated: false });
    expect(data.settings).toBeNull();
    expect(data.threads).toEqual([]);
    expect(data.projects).toEqual([]);
    expect(data.backgroundWorkEnabled).toBe(false);
    expect(data.agentNetworkAllowlistEnabled).toBe(false);
  });

  it("treats a present session flag without a user as unauthenticated", async () => {
    const data = await getBootstrap(mockFetch(200, { session: { authenticated: true } }));
    expect(data.session).toEqual({ authenticated: false });
  });

  // The document title comes from here, so an absent or blank APP_NAME must
  // land on the product name rather than an empty tab.
  it("falls back to the product name when appName is absent or blank", () => {
    expect(parseBootstrap({}).appName).toBe("Nadi");
    expect(parseBootstrap({ appName: "   " }).appName).toBe("Nadi");
  });

  it("uses a self-hoster's configured appName, trimmed", () => {
    expect(parseBootstrap({ appName: "  Acme Agent " }).appName).toBe("Acme Agent");
  });

  it("throws on a non-ok response", async () => {
    await expect(getBootstrap(mockFetch(500, {}))).rejects.toThrow("bootstrap_failed_500");
  });
});
