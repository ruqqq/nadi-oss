import { Agent, callable } from "agents";
import type { AgentMcpOAuthProvider } from "agents";
import type { Env } from "../env";
import type { DiscoveredTool } from "../mcp/merge-tools";
import { KvMcpOAuthProvider } from "../mcp/kv-oauth-provider";
import { log } from "../log";

/**
 * One Durable Object per workspace that owns MCP connections for management:
 * discovery (listServerTools) and OAuth consent (beginServerAuth + the SDK's
 * auto-wrapped onRequest callback). Reached from the Worker via
 * getAgentByName(env.WORKSPACE_MCP_AGENT, `workspace:<id>`) and its @callable
 * methods. Chat ThreadAgents keep their own connections for inference but reuse
 * the credentials this DO persists to KV.
 */
export class WorkspaceMcpAgent extends Agent<Env> {
  /**
   * Inject the KV-backed OAuth provider so consent-exchanged tokens/client-info
   * are mirrored into the central encrypted workspace store. Overriding this
   * covers both the live addMcpServer path and the storage-restore path. The
   * DO instance name is `workspace:<id>`, so the workspace id is derived from
   * it directly.
   */
  createMcpOAuthProvider(callbackUrl: string): AgentMcpOAuthProvider {
    const workspaceId = this.name.replace(/^workspace:/, "");
    return new KvMcpOAuthProvider(this.ctx.storage, callbackUrl, this.env, () =>
      Promise.resolve(workspaceId),
    );
  }

  async ping(): Promise<string> {
    return "ok";
  }

  /**
   * Tear down a server's live connection + storage in this DO. Called when a
   * server is deleted so its connection (and any OAuth registration) doesn't
   * linger — otherwise a deleted-then-recreated server leaves an orphaned,
   * still-authorized connection whose tools show up in listTools().
   */
  async evictServer(serverId: string): Promise<{ evicted: true }> {
    await this.removeMcpServer(serverId).catch(() => {});
    return { evicted: true };
  }

  /**
   * Debug-only: connect a server and dump the raw discovery state — the
   * addMcpServer result (state/authUrl), any error, per-connection state, and
   * every tool with its SDK serverId — so a token-gated /api/debug endpoint can
   * see exactly why discovery yields no tools / no auth prompt. Cleans up after.
   */
  async debugDiscover(serverId: string, serverUrl: string): Promise<unknown> {
    let addResult: unknown;
    let addError: string | undefined;
    await this.removeMcpServer(serverId).catch(() => {}); // fresh connect
    try {
      addResult = await this.addMcpServer("debug", serverUrl, {
        id: serverId,
        callbackHost: this.env.APP_BASE_URL,
        transport: { type: "streamable-http" },
      });
    } catch (error) {
      addError = error instanceof Error ? `${error.name}: ${error.message}` : String(error);
    }
    let waitError: string | undefined;
    try {
      await this.mcp.waitForConnections({ timeout: 10000 });
    } catch (error) {
      waitError = error instanceof Error ? error.message : String(error);
    }
    const allTools = this.mcp.listTools();
    const conns = this.mcp.mcpConnections ?? {};
    const servers = this.mcp.listServers().map((s) => ({
      id: s.id,
      name: s.name,
      url: s.server_url,
      state: conns[s.id]?.connectionState,
      error: conns[s.id]?.connectionError,
    }));
    try {
      await this.removeMcpServer(serverId);
    } catch {
      /* best-effort cleanup so re-runs reconnect fresh */
    }
    return {
      requestedServerId: serverId,
      serverUrl,
      addResult,
      addError,
      waitError,
      toolCount: allTools.length,
      tools: allTools.map((t) => ({ name: t.name, serverId: t.serverId })),
      servers,
    };
  }

  async listServerTools(
    serverId: string,
    serverUrl: string,
  ): Promise<{ tools: DiscoveredTool[] } | { needsAuth: true }> {
    // Discovery connects and RETAINS the server in this per-workspace DO. Re-calls
    // short-circuit to READY, so retention is bounded by the number of distinct
    // servers in the workspace (not per-request). The connection lifecycle
    // (release-after-list vs. reuse) is revisited in Plan 5, where OAuth servers
    // need persistent, authorized connections — don't assume a clean slate there.
    //
    // callbackHost installs the KvMcpOAuthProvider (via createMcpOAuthProvider),
    // which injects any stored tokens for an already-authorized server. If the
    // server returns 401 and no stored token exists, addMcpServer returns
    // { state: "authenticating" } — we surface that as needsAuth instead of
    // throwing so the route can return a structured 200 to the client.
    // NOTE (live-verify): the token-injection short-circuit (stored token →
    // READY without authUrl) and the authenticating branch (401 → authUrl) both
    // require a real OAuth MCP server + egress.
    // Remove any retained connection first so this is always a FRESH connect.
    // The DO persists connection state but not the provider's in-memory authUrl
    // across hibernation, so a stale "authenticating" connection makes the SDK's
    // addMcpServer short-circuit to READY (→ no tools, no prompt). A fresh
    // connect reproduces the true state + authUrl every time.
    await this.removeMcpServer(serverId).catch(() => {});
    const result = await this.addMcpServer("discovery", serverUrl, {
      id: serverId,
      callbackHost: this.env.APP_BASE_URL,
      transport: { type: "streamable-http" },
    });
    const state = (result as { state?: string }).state;
    if (state === "authenticating") {
      await this.removeMcpServer(serverId); // no half-open connection
      return { needsAuth: true };
    }
    if (state !== "ready") {
      throw new Error(`mcp_discovery_not_ready:${state}`);
    }
    await this.mcp.waitForConnections();
    return {
      tools: this.mcp
        .listTools()
        // serverId is mcpServerId() output (normalize-safe), so it equals the SDK's
        // stored/normalized serverId — this exact match is reliable for repo-created
        // servers. If the id generator ever changes, this filter would silently
        // return [] instead of erroring; keep ids normalize-safe.
        .filter((tool) => tool.serverId === serverId)
        .map((tool) => ({ name: tool.name, description: tool.description ?? null })),
    };
  }

  /**
   * Begin the OAuth consent flow for an MCP server. Passing callbackHost
   * installs createMcpOAuthProvider; the SDK returns AUTHENTICATING with an
   * authUrl when consent is required, or READY when it connected without OAuth
   * (or stored tokens already short-circuited re-auth). sendIdentityOnConnect
   * is left at its default (true) so the default callback URL
   * (/agents/workspace-mcp-agent/<instance>/callback) is used and no
   * callbackPath is required.
   *
   * The subsequent callback is handled by the SDK's auto-wrapped onRequest
   * (handleMcpOAuthCallback), which completes the code exchange and calls
   * saveTokens/saveClientInformation on the provider above — mirroring the
   * credentials into KV. No onRequest override is needed here.
   *
   * NOTE (live-verify): the full consent→callback→token-persist→reuse loop
   * requires a real OAuth MCP server + egress and cannot run in-harness. See
   * docs/superpowers/specs/2026-06-28-mcp-oauth-spike2-findings.md "Still needs
   * live confirmation" items 1 & 3 (real token acceptance, callback routing
   * round-trip).
   */
  async beginServerAuth(
    serverId: string,
    serverUrl: string,
  ): Promise<{ authUrl: string } | { ready: true }> {
    // Fresh reconnect: the returned authUrl embeds a PKCE code_challenge + state
    // nonce that the callback validates against the verifier stored on THIS
    // connection. Reusing a stale connection would hand back an authUrl whose
    // verifier no longer matches, failing the exchange. Remove first.
    await this.removeMcpServer(serverId).catch(() => {});
    const result = await this.addMcpServer("oauth", serverUrl, {
      id: serverId,
      callbackHost: this.env.APP_BASE_URL,
      transport: { type: "streamable-http" },
    });
    const r = result as { state: string; authUrl?: string };
    if (r.state === "authenticating" && r.authUrl) {
      log.info("mcp.oauth.begin", { workspaceId: this.name, serverId, state: r.state });
      return { authUrl: r.authUrl };
    }
    log.info("mcp.oauth.begin_ready", { workspaceId: this.name, serverId, state: r.state });
    return { ready: true };
  }
}

// Apply @callable() decorators manually (TC39-compatible, no @ syntax needed for runtime)
callable()(WorkspaceMcpAgent.prototype.ping, null as unknown as ClassMethodDecoratorContext);
callable()(
  WorkspaceMcpAgent.prototype.listServerTools,
  null as unknown as ClassMethodDecoratorContext,
);
callable()(
  WorkspaceMcpAgent.prototype.beginServerAuth,
  null as unknown as ClassMethodDecoratorContext,
);
callable()(
  WorkspaceMcpAgent.prototype.debugDiscover,
  null as unknown as ClassMethodDecoratorContext,
);
callable()(WorkspaceMcpAgent.prototype.evictServer, null as unknown as ClassMethodDecoratorContext);
