import { env, runInDurableObject } from "cloudflare:test";
import { describe, it, expect } from "vitest";
import type { WorkspaceMcpAgent } from "../../src/agent/workspace-mcp-agent";
import { getAgentByName } from "agents";

describe("WorkspaceMcpAgent", () => {
  it("instantiates and responds to ping", async () => {
    const stub = env.WORKSPACE_MCP_AGENT.get(env.WORKSPACE_MCP_AGENT.idFromName("workspace:test"));
    const result = await runInDurableObject(stub, async (instance: WorkspaceMcpAgent) =>
      instance.ping(),
    );
    expect(result).toBe("ok");
  });

  it("responds to ping over the getAgentByName RPC path", async () => {
    const stub = await getAgentByName(env.WORKSPACE_MCP_AGENT, "workspace:rpc-test");
    const result = await stub.ping();
    expect(result).toBe("ok");
  });
});
