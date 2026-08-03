/**
 * MCP policy keying integration tests.
 *
 * Verifies that getMcpToolPolicyMap keys policies by the SDK's namespaced
 * tool key (mcpToolKey), so wrapToolsWithPolicy lookups in the thread agent hit
 * correctly.
 *
 * Step 5 — live pin test decision:
 * A DO-level test that calls this.mcp.addMcpServer(..., { id }) and asserts
 * every getAITools() key equals mcpToolKey(id, toolName) is NOT included here.
 * The test harness has no connectable mock MCP server; tests that need tools
 * inject them directly via _testToolOverride (bypassing the SDK's MCP client
 * entirely), so getAITools() always returns an empty map in integration tests.
 * The live key format is covered by:
 *   1. The Task 1 spike (docs/superpowers/specs/2026-06-28-mcp-oauth-spike-findings.md),
 *      which empirically verified the SDK's `tool_<serverId>_<toolName>` format.
 *   2. The Task 2 unit test (test/unit/mcp/tool-key.test.ts), which pins
 *      mcpToolKey("srvabc123", "search") === "tool_srvabc123_search".
 */
import { env } from "cloudflare:test";
import { beforeAll, beforeEach, describe, expect, it } from "vitest";
import { drizzle } from "drizzle-orm/d1";
import * as schema from "../../src/db/schema";
import { applyRegistryTestSchema } from "./helpers/registry";
import { mcpServerId, mcpToolKey } from "../../src/mcp/tool-key";
import { getMcpToolPolicyMap } from "../../src/mcp/policy-repo";

const now = 1_800_000_000_000;

describe("mcp policy keying", () => {
  beforeAll(async () => {
    await applyRegistryTestSchema(env.REGISTRY_DB);
  });
  beforeEach(async () => {
    const db = drizzle(env.REGISTRY_DB, { schema });
    await db.delete(schema.mcpToolPolicies);
    await db.delete(schema.mcpServers);
    await db.delete(schema.workspaces);
  });

  it("keys the policy map by the SDK namespaced tool key", async () => {
    const db = drizzle(env.REGISTRY_DB, { schema });
    const workspaceId = "ws-1";
    const serverId = mcpServerId();
    await db
      .insert(schema.workspaces)
      .values({ id: workspaceId, name: workspaceId, createdAt: now });
    await db.insert(schema.mcpServers).values({
      id: serverId,
      workspaceId,
      name: "srv",
      url: "https://example.test/mcp",
      enabled: true,
      createdAt: now,
    });
    await db.insert(schema.mcpToolPolicies).values({
      id: "pol-1",
      workspaceId,
      serverId,
      toolName: "search",
      policy: "auto_allow",
      createdAt: now,
      updatedAt: now,
    });

    const map = await getMcpToolPolicyMap(env, workspaceId);
    expect(map[mcpToolKey(serverId, "search")]).toBe("auto_allow");
  });
});
