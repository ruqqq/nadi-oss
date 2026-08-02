// @vitest-environment jsdom

import "@testing-library/jest-dom/vitest";
import { cleanup, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { useState, type ReactElement, type ReactNode } from "react";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { WorkbenchSummary } from "../workbenches-api";
import { SettingsFooterContext } from "./footer-slot";

// The api module is imported for its side-effecting calls (fetch wrappers). Mock
// it wholesale so the component renders without a Worker; each test seeds the
// GET response and inspects the save payloads.
const api = vi.hoisted(() => ({
  listWorkbenches: vi.fn(),
  createWorkbench: vi.fn(),
  updateWorkbench: vi.fn(),
  archiveWorkbench: vi.fn(),
  setWorkbenchRepositories: vi.fn(),
  setWorkbenchEnvVars: vi.fn(),
  setWorkbenchSecret: vi.fn(),
  deleteWorkbenchSecret: vi.fn(),
}));

vi.mock("../workbenches-api", async () => {
  const actual = await vi.importActual<typeof import("../workbenches-api")>("../workbenches-api");
  return { ...actual, ...api };
});

import { WorkbenchesSection } from "./WorkbenchesSection";

// Mirror the Settings shell: WorkbenchesSection portals its Save/Archive/Create
// actions into the shell's footer slot, so a test rendering it in isolation must
// supply that slot or the actions never mount.
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
  // selecting a workbench doesn't depend on a drill-down navigation.
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

const WORKBENCH: WorkbenchSummary = {
  id: "wb_1",
  workspaceId: "ws_1",
  name: "Staging",
  description: "Staging workbench",
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

describe("WorkbenchesSection sandbox size", () => {
  it("saves a changed sandbox size", async () => {
    const user = userEvent.setup({ pointerEventsCheck: 0 });
    api.listWorkbenches.mockResolvedValue([WORKBENCH]);
    api.updateWorkbench.mockResolvedValue(WORKBENCH);
    api.setWorkbenchRepositories.mockResolvedValue(WORKBENCH);

    renderSection(
      <WorkbenchesSection
        networkAllowlistEnabled={false}
        selectedId={WORKBENCH.id}
        onSelectWorkbench={() => {}}
        onNewWorkbench={() => {}}
        onBackToList={() => {}}
      />,
    );

    await screen.findByLabelText("Sandbox size");

    await user.click(screen.getByLabelText("Sandbox size"));
    await user.click(await screen.findByRole("option", { name: /medium/i }));
    await user.click(screen.getByRole("button", { name: /save workbench/i }));

    await waitFor(() => expect(api.updateWorkbench).toHaveBeenCalled());
    const [, patch] = api.updateWorkbench.mock.calls[0]!;
    expect(patch).toEqual(expect.objectContaining({ resourceProfile: "medium" }));
  });

  it("does not expose the network allowlist field when the capability is disabled", async () => {
    api.listWorkbenches.mockResolvedValue([WORKBENCH]);

    renderSection(
      <WorkbenchesSection
        networkAllowlistEnabled={false}
        selectedId={WORKBENCH.id}
        onSelectWorkbench={() => {}}
        onNewWorkbench={() => {}}
        onBackToList={() => {}}
      />,
    );

    await screen.findByLabelText("Sandbox size");
    expect(screen.queryByLabelText("Allowed domains")).not.toBeInTheDocument();
  });

  it("saves the network allowlist when the capability is enabled", async () => {
    const user = userEvent.setup({ pointerEventsCheck: 0 });
    api.listWorkbenches.mockResolvedValue([WORKBENCH]);
    api.updateWorkbench.mockResolvedValue(WORKBENCH);
    api.setWorkbenchRepositories.mockResolvedValue(WORKBENCH);

    renderSection(
      <WorkbenchesSection
        networkAllowlistEnabled
        selectedId={WORKBENCH.id}
        onSelectWorkbench={() => {}}
        onNewWorkbench={() => {}}
        onBackToList={() => {}}
      />,
    );

    const allowlist = await screen.findByLabelText("Allowed domains");
    expect(screen.getByText(/On Daytona.*default allowed hosts/i)).toBeInTheDocument();
    await user.type(allowlist, "api.example.com");
    await user.click(screen.getByRole("button", { name: /save workbench/i }));

    await waitFor(() =>
      expect(api.updateWorkbench).toHaveBeenCalledWith(
        WORKBENCH.id,
        expect.objectContaining({ networkDomainAllowlist: "api.example.com" }),
      ),
    );
  });

  it("defaults a new workbench's sandbox size to small", async () => {
    const user = userEvent.setup({ pointerEventsCheck: 0 });
    api.listWorkbenches.mockResolvedValue([]);
    api.createWorkbench.mockResolvedValue(WORKBENCH);

    renderSection(
      <WorkbenchesSection
        networkAllowlistEnabled={false}
        selectedId="new"
        onSelectWorkbench={() => {}}
        onNewWorkbench={() => {}}
        onBackToList={() => {}}
      />,
    );

    await screen.findByLabelText("Sandbox size");
    await user.type(screen.getByPlaceholderText("e.g. Staging"), "New bench");
    await user.click(screen.getByRole("button", { name: /create workbench/i }));

    await waitFor(() => expect(api.createWorkbench).toHaveBeenCalled());
    const [payload] = api.createWorkbench.mock.calls[0]!;
    expect(payload).toEqual(expect.objectContaining({ resourceProfile: "small" }));
  });
});
