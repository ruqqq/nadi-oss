// @vitest-environment jsdom
import { describe, it, expect, vi, beforeAll, beforeEach, afterEach } from "vitest";
import { render, screen, cleanup, waitFor, fireEvent } from "@testing-library/react";

// Mock the automata + agents API layers so the test can assert exactly
// what payload a submit sends, without a running Worker.
const listAutomata = vi.fn();
const createAutomaton = vi.fn();
const getAutomaton = vi.fn();
vi.mock("../../automata-api", async () => {
  const actual = await vi.importActual<typeof import("../../automata-api")>("../../automata-api");
  return {
    ...actual,
    listAutomata: (...a: unknown[]) => listAutomata(...a),
    createAutomaton: (...a: unknown[]) => createAutomaton(...a),
    getAutomaton: (...a: unknown[]) => getAutomaton(...a),
    updateAutomaton: vi.fn(),
    archiveAutomaton: vi.fn(),
    runAutomatonNow: vi.fn(),
  };
});

const listAgentsMock = vi.fn();
vi.mock("../../agents-api", () => ({
  listAgents: (...a: unknown[]) => listAgentsMock(...a),
}));

const getDefaultAgentSettings = vi.fn();
vi.mock("../../settings-api", async () => {
  const actual =
    await vi.importActual<typeof import("../../settings-api")>("../../settings-api");
  return {
    ...actual,
    getDefaultAgentSettings: (...a: unknown[]) => getDefaultAgentSettings(...a),
  };
});

import { AutomataPanel } from "./AutomataPanel";

const AGENT_FIXTURE = {
  id: "wbk_1",
  workspaceId: "ws",
  name: "Backend",
  description: "",
  setupScript: "",
  repositories: [],
  envVars: {},
  secretEnvNames: [],
  networkDomainAllowlist: "",
  archivedAt: null,
  createdAt: 0,
  updatedAt: 0,
};

// cmdk / Radix rely on DOM APIs jsdom doesn't implement.
beforeAll(() => {
  Element.prototype.scrollIntoView = vi.fn() as never;
  Element.prototype.hasPointerCapture = vi.fn(() => false) as never;
  Element.prototype.setPointerCapture = vi.fn() as never;
  Element.prototype.releasePointerCapture = vi.fn() as never;
  if (!globalThis.ResizeObserver) {
    globalThis.ResizeObserver = class {
      observe() {}
      unobserve() {}
      disconnect() {}
    } as never;
  }
});

beforeEach(() => {
  window.matchMedia = (query: string) =>
    ({
      matches: false, // desktop path -> anchored Popover
      media: query,
      onchange: null,
      addEventListener: () => {},
      removeEventListener: () => {},
      addListener: () => {},
      removeListener: () => {},
      dispatchEvent: () => false,
    }) as unknown as MediaQueryList;
  listAutomata.mockResolvedValue([]);
  listAgentsMock.mockResolvedValue([AGENT_FIXTURE]);
  getDefaultAgentSettings.mockResolvedValue({
    workspace: { id: "ws", name: "Workspace" },
    agent: {
      id: "agent1",
      name: "Nadi",
      systemPrompt: "",
      provider: "openai",
      model: "gpt-5.5",
      modelInputModalities: ["text"],
    },
    providers: [{ provider: "openai", displayName: "OpenAI", usable: true }],
  });
  createAutomaton.mockResolvedValue({
    id: "auto_new",
    workspaceId: "ws",
    ownerUserId: "u1",
    agentId: "agent1",
    projectId: null,
    name: "Daily briefing",
    prompt: "Give me my briefing",
    modelProvider: null,
    model: null,
    modelInputModalities: null,
    scheduleJson: JSON.stringify({ kind: "weekdays", hour: 8, minute: 0 }),
    timezone: "UTC",
    enabled: true,
    disabledReason: null,
    nextDueAt: null,
    lastFiredAt: null,
    archivedAt: null,
    createdAt: 0,
    updatedAt: 0,
    notifyMode: "all",
    lastRun: null,
  });
  getAutomaton.mockResolvedValue({
    automaton: {
      id: "auto_new",
      workspaceId: "ws",
      ownerUserId: "u1",
      agentId: "agent1",
      projectId: null,
      name: "Daily briefing",
      prompt: "Give me my briefing",
      modelProvider: null,
      model: null,
      modelInputModalities: null,
      scheduleJson: JSON.stringify({ kind: "weekdays", hour: 8, minute: 0 }),
      timezone: "UTC",
      enabled: true,
      disabledReason: null,
      nextDueAt: null,
      lastFiredAt: null,
      archivedAt: null,
      createdAt: 0,
      updatedAt: 0,
      notifyMode: "all",
      lastRun: null,
    },
    runs: [],
  });
});

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

function renderPanel() {
  return render(
    <AutomataPanel
      projects={[]}
      selectedId={null}
      onSelect={() => {}}
      onBackToList={() => {}}
      onOpenThread={() => {}}
      closeLabel="Back"
      onClose={() => {}}
    />,
  );
}

async function fillRequiredFields() {
  // Mobile-shaped viewport (matchMedia mocked false) starts on the list; "New"
  // drills into the create form.
  fireEvent.click(screen.getByRole("button", { name: /^new$/i }));
  fireEvent.change(screen.getByLabelText("Name"), { target: { value: "Daily briefing" } });
  fireEvent.change(screen.getByLabelText("Prompt"), {
    target: { value: "Give me my briefing" },
  });
}

describe("AutomataPanel agent override", () => {
  it("submits the selected agent's id", async () => {
    renderPanel();
    await waitFor(() => expect(listAgentsMock).toHaveBeenCalled());
    await fillRequiredFields();

    fireEvent.click(screen.getByRole("button", { name: /agent/i }));
    fireEvent.click(await screen.findByText("Backend"));

    fireEvent.click(screen.getByRole("button", { name: /create automaton/i }));

    await waitFor(() => expect(createAutomaton).toHaveBeenCalled());
    const payload = createAutomaton.mock.calls[0]![0];
    expect(payload.agentId).toBe("wbk_1");
  });

  it("submits null when left on Inherit from project", async () => {
    renderPanel();
    await waitFor(() => expect(listAgentsMock).toHaveBeenCalled());
    await fillRequiredFields();

    fireEvent.click(screen.getByRole("button", { name: /create automaton/i }));

    await waitFor(() => expect(createAutomaton).toHaveBeenCalled());
    const payload = createAutomaton.mock.calls[0]![0];
    expect(payload.agentId).toBeNull();
  });
});
