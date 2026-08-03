// @vitest-environment jsdom
import "@testing-library/jest-dom/vitest";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, render, screen } from "@testing-library/react";
import type { FeaturedConnection } from "../../lib/featured-connections";
import type { McpServer } from "../../mcp-api";

const mocks = vi.hoisted(() => ({
  listMcpServerTools: vi.fn(),
  createMcpServer: vi.fn(),
  authorizeMcpServer: vi.fn(),
}));

vi.mock("../../mcp-api", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../mcp-api")>()),
  listMcpServerTools: mocks.listMcpServerTools,
  createMcpServer: mocks.createMcpServer,
  authorizeMcpServer: mocks.authorizeMcpServer,
}));

import { FeaturedConnectionCard } from "./FeaturedConnectionCard";

const connection: FeaturedConnection = {
  id: "composio",
  serverName: "Composio",
  title: "Connected accounts",
  pitch: "Connect Gmail, Calendar, Drive and more.",
  url: "https://connect.composio.dev/mcp",
};

const server: McpServer = {
  id: "srv_composio",
  name: "Composio",
  url: "https://connect.composio.dev/mcp",
  enabled: true,
  createdAt: 0,
};

describe("FeaturedConnectionCard onResolved", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });
  afterEach(cleanup);

  // The whole point of narrowing the lifted contract to `string[] | null`:
  // a connected server that genuinely has zero tools ("we looked, and there
  // is nothing") must NOT read the same as "not connected, nothing to say
  // yet". Collapsing these back into one falsy signal is exactly the
  // regression this type exists to make impossible to write by accident.
  it("reports [] (not null) for a connected server with zero tools", async () => {
    mocks.listMcpServerTools.mockResolvedValue({ needsAuth: false, tools: [] });
    const onResolved = vi.fn();

    render(
      <FeaturedConnectionCard
        connection={connection}
        icon={null}
        server={server}
        onAdded={() => {}}
        onResolved={onResolved}
      />,
    );

    await screen.findByText(/Connected · 0 tools/);
    expect(onResolved).toHaveBeenLastCalledWith("composio", []);
    // Not null, not undefined, and not merely falsy — exactly an empty array.
    expect(onResolved.mock.calls.at(-1)?.[1]).not.toBeNull();
    expect(Array.isArray(onResolved.mock.calls.at(-1)?.[1])).toBe(true);
  });

  it("reports null (not []) for a row that still needs authorization", async () => {
    mocks.listMcpServerTools.mockResolvedValue({ needsAuth: true, tools: [] });
    const onResolved = vi.fn();

    render(
      <FeaturedConnectionCard
        connection={connection}
        icon={null}
        server={server}
        onAdded={() => {}}
        onResolved={onResolved}
      />,
    );

    await screen.findByRole("button", { name: /authorize/i });
    expect(onResolved).toHaveBeenLastCalledWith("composio", null);
  });

  it("reports null while the row is still resolving (no server yet)", () => {
    const onResolved = vi.fn();

    render(
      <FeaturedConnectionCard
        connection={connection}
        icon={null}
        server={undefined}
        onAdded={() => {}}
        onResolved={onResolved}
      />,
    );

    expect(onResolved).toHaveBeenLastCalledWith("composio", null);
  });
});
