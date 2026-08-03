// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type { McpServer } from "./mcp-api";
import { AUTOMATON_NUDGE_KEY } from "./lib/automaton-nudge";

const mocks = vi.hoisted(() => ({
  listMcpServers: vi.fn(),
  listMcpServerTools: vi.fn(),
  createMcpServer: vi.fn(),
  authorizeMcpServer: vi.fn(),
  getWebToolsSettings: vi.fn(),
}));

vi.mock("./mcp-api", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./mcp-api")>()),
  listMcpServers: mocks.listMcpServers,
  listMcpServerTools: mocks.listMcpServerTools,
  createMcpServer: mocks.createMcpServer,
  authorizeMcpServer: mocks.authorizeMcpServer,
}));

vi.mock("./settings-api", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./settings-api")>()),
  getWebToolsSettings: mocks.getWebToolsSettings,
}));

import { Onboarding } from "./Onboarding";

const settings = {
  workspace: { id: "workspace_1", name: "default" },
  agent: {
    id: "agent_1",
    name: "Assistant",
    systemPrompt: "Be useful.",
    provider: "openai",
    model: "gpt-5.4-mini",
    modelInputModalities: ["text" as const],
    showReasoning: false,
    reasoningEffort: "medium" as const,
    modelSupportsReasoning: null,
  },
  providers: [{ provider: "openai" as const, secretPresent: true, usable: true }],
};

const composio: McpServer = {
  id: "srv_composio",
  name: "Composio",
  url: "https://connect.composio.dev/mcp",
  enabled: true,
  createdAt: 0,
};

function renderWizard(props: Partial<Parameters<typeof Onboarding>[0]> = {}) {
  return render(
    <Onboarding
      user={{ email: "you@example.com" }}
      settings={settings as never}
      installed
      onComplete={() => {}}
      {...props}
    />,
  );
}

describe("Onboarding empower step", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    localStorage.clear();
    window.history.replaceState(null, "", "/");
    mocks.getWebToolsSettings.mockResolvedValue({ exaSecretPresent: false });
    mocks.listMcpServers.mockResolvedValue([]);
    mocks.listMcpServerTools.mockResolvedValue({ needsAuth: false, tools: [] });
  });
  afterEach(cleanup);

  // A Composio ROW is not a Composio CONNECTION. Denying (or abandoning) the
  // consent screen leaves the row behind; seeding a calendar briefing then
  // makes the agent's very first reply an apology.
  it("does not promise calendar data when Composio was never authorized", async () => {
    mocks.listMcpServers.mockResolvedValue([composio]);
    mocks.listMcpServerTools.mockResolvedValue({ needsAuth: true, tools: [] });
    renderWizard({ initialStep: "empower" });

    await screen.findByRole("button", { name: /authorize/i });
    await userEvent.click(screen.getByRole("button", { name: /^continue$/i }));

    await waitFor(() => {
      expect(localStorage.getItem(AUTOMATON_NUDGE_KEY)).not.toBeNull();
    });
    expect(localStorage.getItem(AUTOMATON_NUDGE_KEY)).not.toMatch(/calendar/i);
  });

  // The reported bug: Composio finishing OAuth means the PLATFORM is
  // authorized, not that any calendar account is attached inside it. A user
  // can connect Gmail only and finish the wizard with no calendar reachable
  // at all — the nudge must not promise one.
  it("REGRESSION does not promise calendar data when Composio is connected but no calendar tool exists", async () => {
    mocks.listMcpServers.mockResolvedValue([composio]);
    mocks.listMcpServerTools.mockResolvedValue({
      needsAuth: false,
      tools: [{ name: "gmail_send_email", description: null, policy: "auto_allow" as const }],
    });
    renderWizard({ initialStep: "empower" });

    await screen.findByText(/Connected · 1 tool/);
    await userEvent.click(screen.getByRole("button", { name: /^continue$/i }));

    await waitFor(() => {
      expect(localStorage.getItem(AUTOMATON_NUDGE_KEY)).not.toBeNull();
    });
    expect(localStorage.getItem(AUTOMATON_NUDGE_KEY)).not.toMatch(/calendar/i);
  });

  it("promises calendar data once Composio is authorized", async () => {
    mocks.listMcpServers.mockResolvedValue([composio]);
    mocks.listMcpServerTools.mockResolvedValue({
      needsAuth: false,
      tools: [{ name: "calendar", description: null, policy: "auto_allow" as const }],
    });
    renderWizard({ initialStep: "empower" });

    await screen.findByText(/Connected · 1 tool/);
    await userEvent.click(screen.getByRole("button", { name: /^continue$/i }));

    await waitFor(() => {
      expect(localStorage.getItem(AUTOMATON_NUDGE_KEY)).toMatch(/calendar/i);
    });
  });
});

describe("Onboarding step clamping", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    localStorage.clear();
    window.history.replaceState(null, "", "/");
    mocks.getWebToolsSettings.mockResolvedValue({ exaSecretPresent: false });
    mocks.listMcpServers.mockResolvedValue([]);
  });
  afterEach(cleanup);

  // `?step=install` inside the installed PWA names a step that is not shown.
  // Left unclamped the indicator announces step one while the install card
  // renders, and Done navigates backwards instead of finishing.
  it("falls back to the first visible step when the URL names a hidden one", () => {
    renderWizard({ initialStep: "install" });
    expect(screen.getByText(/Step 1 of 3 · Connect a provider/)).toBeTruthy();
    expect(screen.getByLabelText(/API key/i)).toBeTruthy();
  });
});
