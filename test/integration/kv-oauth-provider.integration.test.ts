import { env, runInDurableObject } from "cloudflare:test";
import { beforeEach, describe, expect, it } from "vitest";
import type { WorkspaceMcpAgent } from "../../src/agent/workspace-mcp-agent";
import { putMcpOAuthTokens } from "../../src/mcp/oauth-store";

// The provider needs real DurableObjectStorage, so it is constructed via the
// agent's own createMcpOAuthProvider() override inside a DO. The WorkspaceMcpAgent
// derives the workspace id from its instance name ("workspace:<id>"), so we name
// the DO accordingly and store tokens under that workspace id.
//
// NOTE (live-verify): the saveTokens() refresh writeback, the saveClientInformation()
// consent-time mirror, and the end-to-end token-reuse short-circuit through the MCP
// transport all require a real OAuth MCP server + egress and cannot be exercised
// in-harness — see docs/superpowers/specs/2026-06-28-mcp-oauth-spike2-findings.md
// "Still needs live confirmation" (items 1 & 2). This test covers the load-bearing
// read path (tokens() supplies the stored bearer) and the serverId-timing guard.

const WS = "ws-prov-1";
const SERVER = "sprov123";

async function clearKv() {
  const list = await env.SECRETS_KV.list({ prefix: `workspaces/${WS}/` });
  for (const k of list.keys) await env.SECRETS_KV.delete(k.name);
}

describe("KvMcpOAuthProvider", () => {
  beforeEach(clearKv);

  it("registers with MCP OAuth servers using APP_NAME, not the workspace DO name", async () => {
    const stub = env.WORKSPACE_MCP_AGENT.get(env.WORKSPACE_MCP_AGENT.idFromName(`workspace:${WS}`));
    await runInDurableObject(stub, async (instance: WorkspaceMcpAgent) => {
      expect(instance.name).toBe(`workspace:${WS}`);
      const provider = instance.createMcpOAuthProvider("https://nadi.test/cb");
      // OAuth dynamic client registration sends clientMetadata.client_name to the
      // authorization server — resolveAppName(APP_NAME), never workspace:<id>.
      // Custom APP_NAME values are covered by test/unit/app-name.test.ts.
      expect(provider.clientMetadata.client_name).toBe("Nadi");
      expect(provider.clientMetadata.client_name).not.toBe(instance.name);
    });
  });

  it("tokens() guards the serverId-not-yet-set timing and reads from KV once set", async () => {
    const stub = env.WORKSPACE_MCP_AGENT.get(env.WORKSPACE_MCP_AGENT.idFromName(`workspace:${WS}`));
    await runInDurableObject(stub, async (instance: WorkspaceMcpAgent) => {
      const provider = instance.createMcpOAuthProvider("https://nadi.test/cb");

      // serverId not assigned yet → no throw, returns undefined.
      expect(await provider.tokens()).toBeUndefined();

      // serverId set, but nothing stored → undefined.
      provider.serverId = SERVER;
      expect(await provider.tokens()).toBeUndefined();

      // tokens present in KV → returned (the bearer-injection short-circuit input).
      const tokens = { access_token: "at-9", token_type: "bearer" };
      await putMcpOAuthTokens(env, WS, SERVER, tokens);
      expect(await provider.tokens()).toEqual(tokens);
    });
  });
});
