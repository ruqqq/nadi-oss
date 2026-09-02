// @vitest-environment jsdom

import "@testing-library/jest-dom/vitest";
import { cleanup, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { useState, type ReactElement, type ReactNode } from "react";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { AgentSummary } from "../agents-api";
import { SettingsFooterContext } from "./footer-slot";

// The api module is imported for its side-effecting calls (fetch wrappers). Mock
// it wholesale so the component renders without a Worker; each test seeds the
// GET response and inspects the save payloads.
const api = vi.hoisted(() => ({
  listAgents: vi.fn(),
  createAgent: vi.fn(),
  updateAgent: vi.fn(),
  deleteAgent: vi.fn(),
  setAgentRepositories: vi.fn(),
  setAgentEnvVars: vi.fn(),
  setAgentSecret: vi.fn(),
  deleteAgentSecret: vi.fn(),
}));

vi.mock("../agents-api", async () => {
  const actual = await vi.importActual<typeof import("../agents-api")>("../agents-api");
  return {
    ...actual,
    listAgents: api.listAgents,
    createAgent: api.createAgent,
    updateAgent: api.updateAgent,
    deleteAgent: api.deleteAgent,
    setAgentRepositories: api.setAgentRepositories,
    setAgentEnvVars: api.setAgentEnvVars,
    setAgentSecret: api.setAgentSecret,
    deleteAgentSecret: api.deleteAgentSecret,
  };
});

// The Knowledge band embeds the two library sections, which fetch on mount.
// This file is about the agent page's own behaviour, so they are stubbed rather
// than served — an unmocked fetch here would be an unhandled rejection, not a
// signal.
vi.mock("./AgentSkillsSection", () => ({ AgentSkillsSection: () => null }));
vi.mock("./MemorySection", () => ({ MemorySection: () => null }));

import { AgentsSection } from "./AgentsSection";

// Mirror the Settings shell: AgentsSection portals its Save/Create actions into
// the shell's footer slot, so a test rendering it in isolation must supply that
// slot or the actions never mount.
function renderSection(ui: ReactElement) {
  function Harness({ children }: { children: ReactNode }) {
    const [footerEl, setFooterEl] = useState<HTMLDivElement | null>(null);
    return (
      <>
        <SettingsFooterContext.Provider value={footerEl}>{children}</SettingsFooterContext.Provider>
        <div ref={setFooterEl} />
      </>
    );
  }
  return render(<Harness>{ui}</Harness>);
}

// Radix Select relies on a few DOM APIs jsdom does not implement.
beforeAll(() => {
  Element.prototype.hasPointerCapture = vi.fn(() => false) as never;
  Element.prototype.setPointerCapture = vi.fn() as never;
  Element.prototype.releasePointerCapture = vi.fn() as never;
  Element.prototype.scrollIntoView = vi.fn() as never;
  if (!globalThis.ResizeObserver) {
    globalThis.ResizeObserver = class {
      observe() {}
      unobserve() {}
      disconnect() {}
    } as never;
  }
});

beforeEach(() => {
  // Desktop path throughout: master-detail renders both panes at once so
  // selecting an agent doesn't depend on a drill-down navigation.
  window.matchMedia = (query: string) =>
    ({
      matches: true,
      media: query,
      onchange: null,
      addEventListener: () => {},
      removeEventListener: () => {},
      addListener: () => {},
      removeListener: () => {},
      dispatchEvent: () => false,
    }) as unknown as MediaQueryList;
});

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

const AGENT: AgentSummary = {
  id: "wb_1",
  workspaceId: "ws_1",
  name: "Staging",
  description: "Staging agent",
  systemPrompt: "You are helpful.",
  provider: "opencode-go",
  model: "deepseek-v4-flash",
  modelInputModalities: '["text"]',
  reasoningEffort: "medium",
  modelSupportsReasoning: null,
  enabled: true,
  setupScript: "pnpm install",
  resourceProfile: "small",
  repositories: [],
  envVars: {},
  secretEnvNames: [],
  networkDomainAllowlist: "",
  archivedAt: null,
  createdAt: 1,
  updatedAt: 1,
};

const SECOND_AGENT: AgentSummary = { ...AGENT, id: "wb_2", name: "Production" };

function renderAgent(
  props: Partial<Parameters<typeof AgentsSection>[0]> = {},
): ReturnType<typeof renderSection> {
  return renderSection(
    <AgentsSection
      providers={[]}
      networkAllowlistEnabled={false}
      selectedId={AGENT.id}
      onSelectAgent={() => {}}
      onNewAgent={() => {}}
      onBackToList={() => {}}
      {...props}
    />,
  );
}

describe("AgentsSection machine settings", () => {
  it("saves a changed machine size", async () => {
    const user = userEvent.setup({ pointerEventsCheck: 0 });
    api.listAgents.mockResolvedValue([AGENT]);
    api.updateAgent.mockResolvedValue(AGENT);
    api.setAgentRepositories.mockResolvedValue(AGENT);

    renderAgent();

    await screen.findByLabelText("Machine size");

    await user.click(screen.getByLabelText("Machine size"));
    await user.click(await screen.findByRole("option", { name: /medium/i }));
    await user.click(screen.getByRole("button", { name: /save agent/i }));

    await waitFor(() => expect(api.updateAgent).toHaveBeenCalled());
    const [, patch] = api.updateAgent.mock.calls[0]!;
    expect(patch).toEqual(expect.objectContaining({ resourceProfile: "medium" }));
  });

  it("says when a machine-size change takes effect", async () => {
    api.listAgents.mockResolvedValue([AGENT]);

    renderAgent();

    await screen.findByLabelText("Machine size");
    expect(
      screen.getByText(/next time this agent\u2019s machine is created/i),
    ).toBeInTheDocument();
  });

  it("says when an allowed-domains change reaches the machine", async () => {
    api.listAgents.mockResolvedValue([AGENT]);

    renderAgent({ networkAllowlistEnabled: true });

    await screen.findByLabelText("Allowed domains");
    // Deliberately NOT the machine-size wording: the allowlist is re-applied
    // when the machine next starts (a sprite waking from hibernation counts),
    // while the size is pinned to the machine that already exists.
    expect(
      screen.getByText(/next time it starts up, not while it is running/i),
    ).toBeInTheDocument();
    expect(
      screen.queryByText(/allowlist.*machine is created/i),
    ).not.toBeInTheDocument();
  });

  it("does not expose the network allowlist field when the capability is disabled", async () => {
    api.listAgents.mockResolvedValue([AGENT]);

    renderAgent();

    await screen.findByLabelText("Machine size");
    expect(screen.queryByLabelText("Allowed domains")).not.toBeInTheDocument();
  });

  it("saves the network allowlist when the capability is enabled", async () => {
    const user = userEvent.setup({ pointerEventsCheck: 0 });
    api.listAgents.mockResolvedValue([AGENT]);
    api.updateAgent.mockResolvedValue(AGENT);
    api.setAgentRepositories.mockResolvedValue(AGENT);

    renderAgent({ networkAllowlistEnabled: true });

    const allowlist = await screen.findByLabelText("Allowed domains");
    await user.type(allowlist, "api.example.com");
    await user.click(screen.getByRole("button", { name: /save agent/i }));

    await waitFor(() =>
      expect(api.updateAgent).toHaveBeenCalledWith(
        AGENT.id,
        expect.objectContaining({ networkDomainAllowlist: "api.example.com" }),
      ),
    );
  });

  it("defaults a new agent's machine size to small", async () => {
    const user = userEvent.setup({ pointerEventsCheck: 0 });
    api.listAgents.mockResolvedValue([]);
    api.createAgent.mockResolvedValue(AGENT);

    renderAgent({ selectedId: "new" });

    await screen.findByLabelText("Machine size");
    await user.type(screen.getByPlaceholderText("e.g. Staging"), "New agent");
    await user.click(screen.getByRole("button", { name: /create agent/i }));

    await waitFor(() => expect(api.createAgent).toHaveBeenCalled());
    const [payload] = api.createAgent.mock.calls[0]!;
    expect(payload).toEqual(expect.objectContaining({ resourceProfile: "small" }));
  });
});

describe("AgentsSection behaviour band", () => {
  it("saves the instructions with the rest of the agent", async () => {
    const user = userEvent.setup({ pointerEventsCheck: 0 });
    api.listAgents.mockResolvedValue([AGENT]);
    api.updateAgent.mockResolvedValue(AGENT);
    api.setAgentRepositories.mockResolvedValue(AGENT);

    renderAgent();

    const prompt = await screen.findByDisplayValue("You are helpful.");
    await user.clear(prompt);
    await user.type(prompt, "Be terse.");
    await user.click(screen.getByRole("button", { name: /save agent/i }));

    await waitFor(() =>
      expect(api.updateAgent).toHaveBeenCalledWith(
        AGENT.id,
        expect.objectContaining({ systemPrompt: "Be terse." }),
      ),
    );
  });

  // Create has no instructions field: `system_prompt` is NOT NULL with no
  // default and the route copies it from the workspace's first agent, so
  // offering an empty box here would promise an edit the route ignores.
  it("does not offer instructions on the create form", async () => {
    api.listAgents.mockResolvedValue([]);

    renderAgent({ selectedId: "new" });

    await screen.findByLabelText("Machine size");
    expect(screen.queryByText("Instructions")).not.toBeInTheDocument();
  });
});

describe("AgentsSection danger zone", () => {
  it("disables the agent, keeping its machine", async () => {
    const user = userEvent.setup({ pointerEventsCheck: 0 });
    api.listAgents.mockResolvedValue([AGENT, SECOND_AGENT]);
    api.updateAgent.mockResolvedValue({ ...AGENT, enabled: false });

    renderAgent();

    const toggle = await screen.findByRole("switch", { name: "Available for new work" });
    await user.click(toggle);

    await waitFor(() =>
      expect(api.updateAgent).toHaveBeenCalledWith(AGENT.id, { enabled: false }),
    );
  });

  it("only deletes once the agent's name is typed", async () => {
    const user = userEvent.setup({ pointerEventsCheck: 0 });
    api.listAgents.mockResolvedValue([AGENT, SECOND_AGENT]);
    api.deleteAgent.mockResolvedValue({ ...AGENT, archivedAt: 2 });

    renderAgent();

    await user.click(await screen.findByRole("button", { name: /delete agent/i }));

    const confirm = await screen.findByRole("button", { name: "Delete agent" });
    expect(confirm).toBeDisabled();
    expect(api.deleteAgent).not.toHaveBeenCalled();

    await user.type(screen.getByLabelText(/type .* to confirm/i), AGENT.name);
    await user.click(confirm);

    await waitFor(() => expect(api.deleteAgent).toHaveBeenCalledWith(AGENT.id));
  });

  // A workspace with no usable agent cannot start a chat at all, so the last
  // one is refused here as well as by the server.
  it("refuses to disable or delete the workspace's last agent", async () => {
    api.listAgents.mockResolvedValue([AGENT]);

    renderAgent();

    expect(await screen.findByRole("switch", { name: "Available for new work" })).toBeDisabled();
    expect(screen.getByRole("button", { name: /delete agent/i })).toBeDisabled();
    expect(
      screen.getByText(/only agent, so it can't be disabled or deleted/i),
    ).toBeInTheDocument();
  });

  // Two agents where the OTHER one is already off still leaves this the last
  // usable one — counting rows rather than usable rows would let a workspace
  // switch off its way to zero.
  it("counts only enabled agents when deciding the last one", async () => {
    api.listAgents.mockResolvedValue([AGENT, { ...SECOND_AGENT, enabled: false }]);

    renderAgent();

    expect(await screen.findByRole("switch", { name: "Available for new work" })).toBeDisabled();
    expect(screen.getByRole("button", { name: /delete agent/i })).toBeDisabled();
  });
});
