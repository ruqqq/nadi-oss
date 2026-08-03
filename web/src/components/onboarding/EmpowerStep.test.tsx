// @vitest-environment jsdom
import "@testing-library/jest-dom/vitest";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, render, screen, waitFor } from "@testing-library/react";
import type { McpServer } from "../../mcp-api";

const mocks = vi.hoisted(() => ({
  listMcpServers: vi.fn(),
  listMcpServerTools: vi.fn(),
  createMcpServer: vi.fn(),
  authorizeMcpServer: vi.fn(),
}));

// Spread the original so the module's other exports (types aside, the rest of
// the MCP client) survive the mock.
vi.mock("../../mcp-api", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../mcp-api")>()),
  listMcpServers: mocks.listMcpServers,
  listMcpServerTools: mocks.listMcpServerTools,
  createMcpServer: mocks.createMcpServer,
  authorizeMcpServer: mocks.authorizeMcpServer,
}));

import { EmpowerStep } from "./EmpowerStep";

const markdump: McpServer = {
  id: "srv_markdump",
  name: "Markdump",
  url: "https://markdump.com/mcp",
  enabled: true,
  createdAt: 0,
};

function connectButtons(): HTMLButtonElement[] {
  return screen
    .getAllByRole("button")
    .filter((b) => /connect|authorize/i.test(b.textContent ?? "")) as HTMLButtonElement[];
}

describe("EmpowerStep", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.listMcpServerTools.mockResolvedValue({ needsAuth: false, tools: [] });
  });
  afterEach(cleanup);

  // The post-OAuth reload runs this list fetch again. If a card renders an
  // enabled "Connect" while it is in flight, the user who just authorized taps
  // it and gets a SECOND server row with its own consent flow.
  it("does not offer Connect until the server list has loaded", async () => {
    let resolveList: (servers: McpServer[]) => void = () => {};
    mocks.listMcpServers.mockReturnValue(
      new Promise<McpServer[]>((resolve) => {
        resolveList = resolve;
      }),
    );

    render(<EmpowerStep exaCard={null} onContinue={() => {}} />);

    const buttons = connectButtons();
    expect(buttons.length).toBeGreaterThan(0);
    for (const button of buttons) expect(button).toBeDisabled();

    resolveList([]);
    await waitFor(() => {
      for (const button of connectButtons()) expect(button).not.toBeDisabled();
    });
  });

  // A row that exists but has not been authorized is NOT a connection. Reporting
  // it as one is what makes the post-wizard nudge promise calendar data the
  // agent cannot reach.
  it("reports a connection only once it resolves as authorized", async () => {
    mocks.listMcpServers.mockResolvedValue([markdump]);
    mocks.listMcpServerTools.mockResolvedValue({ needsAuth: true, tools: [] });
    const onConnectedChange = vi.fn();

    render(
      <EmpowerStep exaCard={null} onContinue={() => {}} onConnectedChange={onConnectedChange} />,
    );

    await screen.findByRole("button", { name: /authorize/i });
    expect(onConnectedChange).toHaveBeenCalled();
    for (const call of onConnectedChange.mock.calls) {
      expect(call[0]).not.toContain("markdump");
    }
  });

  it("reports an authorized connection", async () => {
    mocks.listMcpServers.mockResolvedValue([markdump]);
    mocks.listMcpServerTools.mockResolvedValue({
      needsAuth: false,
      tools: [{ name: "read", description: null, policy: "auto_allow" as const }],
    });
    const onConnectedChange = vi.fn();

    render(
      <EmpowerStep exaCard={null} onContinue={() => {}} onConnectedChange={onConnectedChange} />,
    );

    await screen.findByText(/Connected · 1 tool/);
    await waitFor(() => {
      expect(onConnectedChange).toHaveBeenLastCalledWith(["markdump"]);
    });
  });
});
