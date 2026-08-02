import { describe, expect, it, vi } from "vitest";

// debug-routes.ts imports "agents" (getAgentByName), which pulls in
// cloudflare:workers — unsupported by the plain-node "unit" vitest project.
vi.mock("agents", () => ({ getAgentByName: vi.fn() }));

import { resolveDebugWorkspaceId } from "../../src/http/debug-routes";

describe("resolveDebugWorkspaceId", () => {
  it("prefers an explicit query param", () => {
    const env = { DEBUG_WORKSPACE_ID: "ws_debug", DEFAULT_WORKSPACE_ID: "default" };
    expect(resolveDebugWorkspaceId(env as never, "ws_explicit")).toBe("ws_explicit");
  });

  it("prefers DEBUG_WORKSPACE_ID over DEFAULT_WORKSPACE_ID", () => {
    const env = { DEBUG_WORKSPACE_ID: "ws_debug", DEFAULT_WORKSPACE_ID: "default" };
    expect(resolveDebugWorkspaceId(env as never, null)).toBe("ws_debug");
  });

  it("falls back to DEFAULT_WORKSPACE_ID when DEBUG_WORKSPACE_ID is unset", () => {
    const env = { DEFAULT_WORKSPACE_ID: "default" };
    expect(resolveDebugWorkspaceId(env as never, null)).toBe("default");
  });
});
