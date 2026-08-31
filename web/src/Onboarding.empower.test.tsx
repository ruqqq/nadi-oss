// @vitest-environment jsdom
import "@testing-library/jest-dom/vitest";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, render, screen, waitFor, within } from "@testing-library/react";
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
      tools: [{ name: "GMAIL_SEND_EMAIL", description: null, policy: "auto_allow" as const }],
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
      tools: [{ name: "GOOGLECALENDAR_FIND_EVENT", description: null, policy: "auto_allow" as const }],
    });
    renderWizard({ initialStep: "empower" });

    await screen.findByText(/Connected · 1 tool/);
    await userEvent.click(screen.getByRole("button", { name: /^continue$/i }));

    await waitFor(() => {
      expect(localStorage.getItem(AUTOMATON_NUDGE_KEY)).toMatch(/calendar/i);
    });
  });

  // One notch narrower than the reported bug: a server scoped to expose only
  // WRITE calendar tools is calendar-named end to end, but there is still no
  // tool that can read a calendar back. Promising a briefing here is the same
  // broken promise, just triggered by a scope instead of a missing account.
  it("does not promise calendar data when only write-shaped calendar tools resolve", async () => {
    mocks.listMcpServers.mockResolvedValue([composio]);
    mocks.listMcpServerTools.mockResolvedValue({
      needsAuth: false,
      tools: [
        { name: "GOOGLECALENDAR_CREATE_EVENT", description: null, policy: "auto_allow" as const },
        { name: "GOOGLECALENDAR_QUICK_ADD", description: null, policy: "auto_allow" as const },
        { name: "GOOGLECALENDAR_DELETE_EVENT", description: null, policy: "auto_allow" as const },
      ],
    });
    renderWizard({ initialStep: "empower" });

    await screen.findByText(/Connected · 3 tools/);
    await userEvent.click(screen.getByRole("button", { name: /^continue$/i }));

    await waitFor(() => {
      expect(localStorage.getItem(AUTOMATON_NUDGE_KEY)).not.toBeNull();
    });
    expect(localStorage.getItem(AUTOMATON_NUDGE_KEY)).not.toMatch(/calendar/i);
  });

  // A setup/connect tool's only job is connecting a calendar account the
  // user has NOT connected yet — matching on its name would arm the prompt
  // before any calendar is actually reachable.
  it("does not promise calendar data for a setup-shaped tool name", async () => {
    mocks.listMcpServers.mockResolvedValue([composio]);
    mocks.listMcpServerTools.mockResolvedValue({
      needsAuth: false,
      tools: [{ name: "CONNECT_CALENDAR_ACCOUNT", description: null, policy: "auto_allow" as const }],
    });
    renderWizard({ initialStep: "empower" });

    await screen.findByText(/Connected · 1 tool/);
    await userEvent.click(screen.getByRole("button", { name: /^continue$/i }));

    await waitFor(() => {
      expect(localStorage.getItem(AUTOMATON_NUDGE_KEY)).not.toBeNull();
    });
    expect(localStorage.getItem(AUTOMATON_NUDGE_KEY)).not.toMatch(/calendar/i);
  });

  // Arming reads whatever has resolved so far, synchronously, at the moment
  // Continue is pressed — it does not wait for cards still in flight. A
  // refactor toward "await the resolve before arming" would silently let a
  // late resolve retro-arm (or fail to arm) the calendar promise, which is
  // exactly the failure mode this pins against.
  it("arms the generic prompt if Continue is pressed before a card finishes resolving, and a later resolve does not retroactively change it", async () => {
    mocks.listMcpServers.mockResolvedValue([composio]);
    let resolveTools: (value: { needsAuth: boolean; tools: unknown[] }) => void = () => {};
    mocks.listMcpServerTools.mockReturnValue(
      new Promise((resolve) => {
        resolveTools = resolve;
      }),
    );
    renderWizard({ initialStep: "empower" });

    // The Composio card specifically is still resolving: its own
    // Connect/Authorize button is disabled, but the wizard's Continue is not
    // gated on that at all — it's a different card (Markdump) that resolves
    // immediately here, precisely to prove Continue doesn't wait for ALL
    // cards, just reads whatever each one has reported so far.
    const composioCard = (await screen.findByText("Connected accounts")).closest(
      '[data-slot="card"]',
    ) as HTMLElement;
    await waitFor(() => {
      expect(within(composioCard).getByRole("button")).toBeDisabled();
    });
    await userEvent.click(screen.getByRole("button", { name: /^continue$/i }));

    await waitFor(() => {
      expect(localStorage.getItem(AUTOMATON_NUDGE_KEY)).not.toBeNull();
    });
    expect(localStorage.getItem(AUTOMATON_NUDGE_KEY)).not.toMatch(/calendar/i);

    // Resolve AFTER arming, as a calendar tool — if arming were ever made to
    // read live instead of at the moment of the click, this is what would
    // start promising a calendar retroactively.
    resolveTools({
      needsAuth: false,
      tools: [{ name: "GOOGLECALENDAR_FIND_EVENT", description: null, policy: "auto_allow" }],
    });
    await screen.findByText(/Connected · 1 tool/);
    expect(localStorage.getItem(AUTOMATON_NUDGE_KEY)).not.toMatch(/calendar/i);
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
