// @vitest-environment jsdom

import "@testing-library/jest-dom/vitest";
import { cleanup, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { ThreadSummary } from "../../threads-api";
import type { AgentListItem } from "../../agents-api";
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
    agentId: "wb_nadi",
    agentName: "nadi",
    resourceProfile: "small",
    automatonId: null,
    automatonName: null,
    automatonNotifyMode: null,
    outcomeDismissedAt: null,
    recentDismissedAt: null,
    repositoryCount: 0,
    lastContextTokens: null,
    lastContextWindow: null,
    lastCompactAfterTokens: null,
    createdAt: 1000,
    updatedAt: 1000,
    ...overrides,
  };
}

const agents: AgentListItem[] = [
  { id: "wb_nadi", name: "Nadi", description: "", enabled: true },
  { id: "wb_docs", name: "Docs", description: "", enabled: true },
];

const baseProps = {
  open: true,
  onOpenChange: () => undefined,
  projects: [],
  agents,
};

describe("ThreadDetailsSheet agent switch", () => {
  it("shows the sandbox size implied by the frozen snapshot", () => {
    render(
      <ThreadDetailsSheet {...baseProps} thread={makeThread({ resourceProfile: "medium" })} />,
    );
    expect(screen.getByText("medium")).toBeInTheDocument();
  });

  it("confirming the switch calls onSwitchAgent with the thread and new agent ids", async () => {
    const user = userEvent.setup();
    const onSwitchAgent = vi.fn().mockResolvedValue(undefined);
    render(
      <ThreadDetailsSheet {...baseProps} thread={makeThread()} onSwitchAgent={onSwitchAgent} />,
    );

    await user.click(screen.getByRole("button", { name: /agent: nadi/i }));
    await user.click(screen.getByRole("option", { name: "Docs" }));

    // The dialog is up; the API must not be hit until confirmed.
    expect(screen.getByText(/uncommitted files will be discarded/i)).toBeInTheDocument();
    expect(onSwitchAgent).not.toHaveBeenCalled();

    await user.click(screen.getByRole("button", { name: /switch agent/i }));
    expect(onSwitchAgent).toHaveBeenCalledWith("thr_1", "wb_docs");
    expect(onSwitchAgent).toHaveBeenCalledTimes(1);
  });

  it("dismissing the confirm dialog does not call onSwitchAgent", async () => {
    const user = userEvent.setup();
    const onSwitchAgent = vi.fn().mockResolvedValue(undefined);
    render(
      <ThreadDetailsSheet {...baseProps} thread={makeThread()} onSwitchAgent={onSwitchAgent} />,
    );

    await user.click(screen.getByRole("button", { name: /agent: nadi/i }));
    await user.click(screen.getByRole("option", { name: "Docs" }));
    expect(screen.getByText(/uncommitted files will be discarded/i)).toBeInTheDocument();

    await user.click(screen.getByRole("button", { name: "Cancel" }));

    expect(
      screen.queryByText(/uncommitted files will be discarded/i),
    ).not.toBeInTheDocument();
    expect(onSwitchAgent).not.toHaveBeenCalled();
  });

  it("keeps the picker enabled for an assigned agent: switching is immediate", () => {
    render(
      <ThreadDetailsSheet
        {...baseProps}
        thread={makeThread({
          agentId: "wb_docs",
          agentName: "Docs",
        })}
        onSwitchAgent={vi.fn()}
      />,
    );
    expect(screen.queryByText(/switching to docs/i)).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: /agent: docs/i })).not.toBeDisabled();
  });

  it("does not offer the switch for a read-only thread", () => {
    render(
      <ThreadDetailsSheet
        {...baseProps}
        thread={makeThread({ readOnly: true, status: "archived" })}
        onSwitchAgent={vi.fn()}
      />,
    );
    expect(screen.queryByRole("button", { name: /agent:/i })).not.toBeInTheDocument();
  });
});
