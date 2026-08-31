// @vitest-environment jsdom

import "@testing-library/jest-dom/vitest";
import { cleanup, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { ThreadSummary } from "../../threads-api";
import type { WorkbenchSummary } from "../../workbenches-api";
import { ThreadDetailsSheet } from "./ThreadDetailsSheet";

// jsdom has no matchMedia; useMediaQuery reads it synchronously on mount.
// Desktop (Popover/Sheet-right) path: never matches "(max-width: 640px)".
beforeEach(() => {
  window.matchMedia = (query: string) =>
    ({
      matches: false,
      media: query,
      onchange: null,
      addEventListener: () => {},
      removeEventListener: () => {},
      addListener: () => {},
      removeListener: () => {},
      dispatchEvent: () => false,
    }) as unknown as MediaQueryList;
});

// Radix Popover/Command rely on a few DOM APIs jsdom does not implement.
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

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

function makeThread(overrides: Partial<ThreadSummary> = {}): ThreadSummary {
  return {
    threadId: "thr_1",
    kind: "regular",
    workspaceId: "ws_1",
    agentId: "agent_1",
    provider: "anthropic",
    model: "claude-sonnet-4-5",
    modelInputModalities: ["text"],
    reasoningEffort: "medium",
    modelSupportsReasoning: true,
    runtime: "think",
    title: "Untitled thread",
    source: "manual",
    lastMessagePreview: "",
    archivedAt: null,
    readOnly: false,
    status: "active",
    projectId: null,
    projectName: null,
    workbenchId: "wb_nadi",
    workbenchName: "nadi",
    resourceProfile: "small",
    automatonId: null,
    automatonName: null,
    automatonNotifyMode: null,
    outcomeDismissedAt: null,
    recentDismissedAt: null,
    repositorySnapshotCount: 0,
    lastContextTokens: null,
    lastContextWindow: null,
    lastCompactAfterTokens: null,
    createdAt: 1000,
    updatedAt: 1000,
    ...overrides,
  };
}

const workbenches: WorkbenchSummary[] = [
  {
    id: "wb_nadi",
    workspaceId: "ws_1",
    name: "nadi",
    description: "",
    setupScript: "",
    resourceProfile: "small",
    repositories: [],
    envVars: {},
    secretEnvNames: [],
    networkDomainAllowlist: "",
    archivedAt: null,
    createdAt: 1000,
    updatedAt: 1000,
  },
  {
    id: "wb_docs",
    workspaceId: "ws_1",
    name: "Docs",
    description: "",
    setupScript: "",
    resourceProfile: "medium",
    repositories: [],
    envVars: {},
    secretEnvNames: [],
    networkDomainAllowlist: "",
    archivedAt: null,
    createdAt: 1000,
    updatedAt: 1000,
  },
];

const baseProps = {
  open: true,
  onOpenChange: () => undefined,
  projects: [],
  workbenches,
};

describe("ThreadDetailsSheet workbench switch", () => {
  it("shows the sandbox size implied by the frozen snapshot", () => {
    render(
      <ThreadDetailsSheet {...baseProps} thread={makeThread({ resourceProfile: "medium" })} />,
    );
    expect(screen.getByText("medium")).toBeInTheDocument();
  });

  it("confirming the switch calls onSwitchWorkbench with the thread and new workbench ids", async () => {
    const user = userEvent.setup();
    const onSwitchWorkbench = vi.fn().mockResolvedValue(undefined);
    render(
      <ThreadDetailsSheet {...baseProps} thread={makeThread()} onSwitchWorkbench={onSwitchWorkbench} />,
    );

    await user.click(screen.getByRole("button", { name: /workbench: nadi/i }));
    await user.click(screen.getByRole("option", { name: "Docs" }));

    // The dialog is up; the API must not be hit until confirmed.
    expect(screen.getByText(/uncommitted files will be discarded/i)).toBeInTheDocument();
    expect(onSwitchWorkbench).not.toHaveBeenCalled();

    await user.click(screen.getByRole("button", { name: /switch workbench/i }));
    expect(onSwitchWorkbench).toHaveBeenCalledWith("thr_1", "wb_docs");
    expect(onSwitchWorkbench).toHaveBeenCalledTimes(1);
  });

  it("dismissing the confirm dialog does not call onSwitchWorkbench", async () => {
    const user = userEvent.setup();
    const onSwitchWorkbench = vi.fn().mockResolvedValue(undefined);
    render(
      <ThreadDetailsSheet {...baseProps} thread={makeThread()} onSwitchWorkbench={onSwitchWorkbench} />,
    );

    await user.click(screen.getByRole("button", { name: /workbench: nadi/i }));
    await user.click(screen.getByRole("option", { name: "Docs" }));
    expect(screen.getByText(/uncommitted files will be discarded/i)).toBeInTheDocument();

    await user.click(screen.getByRole("button", { name: "Cancel" }));

    expect(
      screen.queryByText(/uncommitted files will be discarded/i),
    ).not.toBeInTheDocument();
    expect(onSwitchWorkbench).not.toHaveBeenCalled();
  });

  it("keeps the picker enabled for an assigned workbench: switching is immediate", () => {
    render(
      <ThreadDetailsSheet
        {...baseProps}
        thread={makeThread({
          workbenchId: "wb_docs",
          workbenchName: "Docs",
        })}
        onSwitchWorkbench={vi.fn()}
      />,
    );
    expect(screen.queryByText(/switching to docs/i)).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: /workbench: docs/i })).not.toBeDisabled();
  });

  it("does not offer the switch for a read-only thread", () => {
    render(
      <ThreadDetailsSheet
        {...baseProps}
        thread={makeThread({ readOnly: true, status: "archived" })}
        onSwitchWorkbench={vi.fn()}
      />,
    );
    expect(screen.queryByRole("button", { name: /workbench:/i })).not.toBeInTheDocument();
  });
});
