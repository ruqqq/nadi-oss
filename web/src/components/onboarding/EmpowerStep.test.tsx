// @vitest-environment jsdom
import "@testing-library/jest-dom/vitest";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
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

/**
 * The value is reported when Continue is pressed, not as connections resolve —
 * so every assertion about it has to go through the button. That is the point
 * of the design: the wizard reads this to arm the post-onboarding nudge, and
 * only a click-time read is guaranteed to reflect what had resolved by then.
 */
async function continueAfterLoad(): Promise<void> {
  await userEvent.click(screen.getByRole("button", { name: /^continue$/i }));
}

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
  // agent cannot reach — even if the (unresolved) tool list would otherwise
  // have matched "calendar".
  it("does not report calendarConnected for a row that only needs auth", async () => {
    mocks.listMcpServers.mockResolvedValue([markdump]);
    mocks.listMcpServerTools.mockResolvedValue({ needsAuth: true, tools: [] });
    const onCalendarConnectedChange = vi.fn();

    render(
      <EmpowerStep
        exaCard={null}
        onContinue={() => {}}
        onCalendarConnectedChange={onCalendarConnectedChange}
      />,
    );

    await screen.findByRole("button", { name: /authorize/i });
    await continueAfterLoad();
    expect(onCalendarConnectedChange).toHaveBeenLastCalledWith(false);
  });

  // The connection being authorized is not enough — the tool that resolved
  // has to actually be calendar-named. This is the lift path for the
  // reported bug: Composio (the platform) authorizing is not a calendar.
  it("does not report calendarConnected when authorized with no calendar-named tool", async () => {
    mocks.listMcpServers.mockResolvedValue([markdump]);
    mocks.listMcpServerTools.mockResolvedValue({
      needsAuth: false,
      tools: [{ name: "GMAIL_SEND_EMAIL", description: null, policy: "auto_allow" as const }],
    });
    const onCalendarConnectedChange = vi.fn();

    render(
      <EmpowerStep
        exaCard={null}
        onContinue={() => {}}
        onCalendarConnectedChange={onCalendarConnectedChange}
      />,
    );

    await screen.findByText(/Connected · 1 tool/);
    await continueAfterLoad();
    expect(onCalendarConnectedChange).toHaveBeenLastCalledWith(false);
  });

  it("reports calendarConnected when a calendar-named tool resolved before Continue", async () => {
    mocks.listMcpServers.mockResolvedValue([markdump]);
    mocks.listMcpServerTools.mockResolvedValue({
      needsAuth: false,
      tools: [{ name: "GOOGLECALENDAR_FIND_EVENT", description: null, policy: "auto_allow" as const }],
    });
    const onCalendarConnectedChange = vi.fn();

    render(
      <EmpowerStep
        exaCard={null}
        onContinue={() => {}}
        onCalendarConnectedChange={onCalendarConnectedChange}
      />,
    );

    await screen.findByText(/Connected · 1 tool/);
    // Deliberately no settling step between the text appearing and the click.
    // The text lands one commit before the card reports its tools upward, so a
    // click here is exactly the race that made the wizard arm a generic nudge
    // for a user with a calendar connected.
    await continueAfterLoad();
    expect(onCalendarConnectedChange).toHaveBeenLastCalledWith(true);
  });
});
