import { describe, expect, it, vi } from "vitest";
import {
  authorizeMcpServer,
  createMcpServer,
  deleteMcpServer,
  listMcpServerTools,
  listMcpServers,
  setMcpServerPolicies,
  updateMcpServer,
} from "../../../web/src/mcp-api";

const server = {
  id: "ssrv1",
  name: "GitHub",
  url: "https://mcp.example/sse",
  enabled: true,
  createdAt: 1,
};

describe("mcp api helpers", () => {
  it("lists servers", async () => {
    const fetch = vi.fn(async () => Response.json({ servers: [server] }));
    await expect(listMcpServers(fetch)).resolves.toEqual([server]);
    expect(fetch).toHaveBeenCalledWith("/api/mcp/servers", { credentials: "include" });
  });

  it("creates a server", async () => {
    const fetch = vi.fn(async () => Response.json({ server }, { status: 201 }));
    await expect(
      createMcpServer({ name: "GitHub", url: "https://mcp.example/sse" }, fetch),
    ).resolves.toEqual(server);
    expect(fetch).toHaveBeenCalledWith("/api/mcp/servers", {
      method: "POST",
      credentials: "include",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ name: "GitHub", url: "https://mcp.example/sse" }),
    });
  });

  it("updates a server with an encoded id", async () => {
    const fetch = vi.fn(async () => Response.json({ server: { ...server, enabled: false } }));
    await expect(updateMcpServer("a/b", { enabled: false }, fetch)).resolves.toEqual({
      ...server,
      enabled: false,
    });
    expect(fetch).toHaveBeenCalledWith("/api/mcp/servers/a%2Fb", {
      method: "PATCH",
      credentials: "include",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ enabled: false }),
    });
  });

  it("deletes a server", async () => {
    const fetch = vi.fn(async () => new Response(null, { status: 204 }));
    await expect(deleteMcpServer("ssrv1", fetch)).resolves.toBeUndefined();
    expect(fetch).toHaveBeenCalledWith("/api/mcp/servers/ssrv1", {
      method: "DELETE",
      credentials: "include",
    });
  });

  it("lists a server's tools (needsAuth: false)", async () => {
    const tools = [{ name: "search", description: "Find", policy: "approval_required" }];
    const fetch = vi.fn(async () => Response.json({ needsAuth: false, tools }));
    await expect(listMcpServerTools("ssrv1", fetch)).resolves.toEqual({ needsAuth: false, tools });
    expect(fetch).toHaveBeenCalledWith("/api/mcp/servers/ssrv1/tools", { credentials: "include" });
  });

  it("listMcpServerTools returns needsAuth: true with empty tools for OAuth servers", async () => {
    const fetch = vi.fn(async () => Response.json({ needsAuth: true, tools: [] }));
    await expect(listMcpServerTools("ssrv1", fetch)).resolves.toEqual({
      needsAuth: true,
      tools: [],
    });
  });

  it("listMcpServerTools defaults needsAuth to false when field is absent", async () => {
    const tools = [{ name: "ping", description: null, policy: "auto_allow" }];
    const fetch = vi.fn(async () => Response.json({ tools }));
    await expect(listMcpServerTools("ssrv1", fetch)).resolves.toEqual({ needsAuth: false, tools });
  });

  it("authorizeMcpServer returns authUrl when server needs consent", async () => {
    const authUrl = "https://auth.example.com/oauth/authorize?client_id=abc";
    const fetch = vi.fn(async () => Response.json({ authUrl }));
    await expect(authorizeMcpServer("ssrv1", fetch)).resolves.toEqual({ authUrl });
    expect(fetch).toHaveBeenCalledWith("/api/mcp/servers/ssrv1/authorize", {
      method: "POST",
      credentials: "include",
    });
  });

  it("authorizeMcpServer returns ready: true when already authorized", async () => {
    const fetch = vi.fn(async () => Response.json({ ready: true }));
    await expect(authorizeMcpServer("ssrv1", fetch)).resolves.toEqual({ ready: true });
  });

  it("authorizeMcpServer surfaces the server's message on a non-ok response", async () => {
    const fetch = vi.fn(async () => new Response("Bad Gateway", { status: 502 }));
    await expect(authorizeMcpServer("ssrv1", fetch)).rejects.toThrow("Bad Gateway");
  });

  it("authorizeMcpServer encodes the server id", async () => {
    const fetch = vi.fn(async () => Response.json({ ready: true }));
    await authorizeMcpServer("a/b", fetch);
    expect(fetch).toHaveBeenCalledWith("/api/mcp/servers/a%2Fb/authorize", expect.any(Object));
  });

  it("sets policies", async () => {
    const policies = [{ toolName: "search", policy: "deny" as const }];
    const fetch = vi.fn(async () => Response.json({ policies }));
    await expect(setMcpServerPolicies("ssrv1", policies, fetch)).resolves.toEqual(policies);
    expect(fetch).toHaveBeenCalledWith("/api/mcp/servers/ssrv1/policies", {
      method: "PUT",
      credentials: "include",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ policies }),
    });
  });

  it("throws human-readable errors for non-ok responses", async () => {
    await expect(
      listMcpServers(vi.fn(async () => new Response("", { status: 401 }))),
    ).rejects.toThrow("Your session expired. Refresh the page and sign in again.");
    await expect(
      listMcpServerTools(
        "x",
        vi.fn(async () => new Response("", { status: 502 })),
      ),
    ).rejects.toThrow("Something went wrong while trying to load tools. Please try again.");
  });
});
