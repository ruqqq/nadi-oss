// @vitest-environment jsdom
import "@testing-library/jest-dom/vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import type { UIMessage } from "ai";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { CompletionGroup } from "./CompletionGroup";
import { NADI_WATCHER_COMPLETION_KIND } from "@/lib/watcher-runs";

afterEach(cleanup);

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
  // `useMediaQuery` reads matchMedia; jsdom has none. Desktop (Dialog) path.
  if (!window.matchMedia) {
    window.matchMedia = ((query: string) => ({
      matches: false,
      media: query,
      onchange: null,
      addListener: vi.fn(),
      removeListener: vi.fn(),
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
      dispatchEvent: vi.fn(),
    })) as never;
  }
});

const subagent = (label: string, status: string, runId: string, body: string): UIMessage => ({
  id: `m_${runId}`,
  role: "user",
  parts: [
    {
      type: "text",
      text: `<system-reminder>\nSubagent "${label}" finished: ${status}. [${runId}]\n${body}\n</system-reminder>`,
    },
  ],
});

const watcher = (id: string, w: unknown): UIMessage => ({
  id,
  role: "user",
  parts: [{ type: "text", text: "<system-reminder>\nx\n</system-reminder>" }],
  metadata: { nadiKind: NADI_WATCHER_COMPLETION_KIND, watcher: w },
});

describe("CompletionGroup — a single completion", () => {
  it("renders one recessed line, not a card", () => {
    render(
      <CompletionGroup
        run={[subagent("Eight checks", "completed", "sub_1", "all good")]}
        runsById={{}}
      />,
    );
    // The line is the whole element: one button, carrying the verb-led phrase.
    const line = screen.getByRole("button", { name: "Subagent finished — Eight checks" });
    expect(line).toBeInTheDocument();
    // Nothing is announced until it is opened — the body lives in the inspector.
    expect(screen.queryByText("all good")).not.toBeInTheDocument();
  });

  it("shows no status glyph on success", () => {
    const { container } = render(
      <CompletionGroup run={[subagent("a", "completed", "sub_1", "x")]} runsById={{}} />,
    );
    // ActivityLine renders exactly one svg (the chevron) when idle; a marker
    // would make two. This is the "success is silent" contract.
    expect(container.querySelectorAll("svg")).toHaveLength(1);
  });

  it("marks a failure", () => {
    const { container } = render(
      <CompletionGroup run={[subagent("a", "error", "sub_1", "boom")]} runsById={{}} />,
    );
    expect(screen.getByRole("button", { name: "Subagent failed — a" })).toBeInTheDocument();
    // Warning marker + chevron.
    expect(container.querySelectorAll("svg")).toHaveLength(2);
  });

  it("opens the result in an inspector when tapped", () => {
    render(
      <CompletionGroup
        run={[subagent("Eight checks", "completed", "sub_1", "all good")]}
        runsById={{}}
      />,
    );
    fireEvent.click(screen.getByRole("button", { name: "Subagent finished — Eight checks" }));
    expect(screen.getByRole("dialog")).toBeInTheDocument();
    expect(screen.getByText("all good")).toBeInTheDocument();
    // The outcome is stated ONCE, in the chip — the point of the redesign.
    expect(screen.getByTestId("completion-status")).toHaveAttribute("data-tone", "ok");
  });

  it("renders two completions as two lines, still not a summary", () => {
    render(
      <CompletionGroup
        run={[
          subagent("first", "completed", "sub_1", "one"),
          subagent("second", "completed", "sub_2", "two"),
        ]}
        runsById={{}}
      />,
    );
    expect(screen.getByRole("button", { name: "Subagent finished — first" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Subagent finished — second" })).toBeInTheDocument();
    expect(screen.queryByText(/background results/)).not.toBeInTheDocument();
  });

  it("names a process by its command and outcome", () => {
    render(
      <CompletionGroup
        run={[
          watcher("w1", {
            title: "pnpm build",
            command: "pnpm build",
            outcome: "exited",
            exitCode: 7,
          }),
        ]}
        runsById={{}}
      />,
    );
    expect(
      screen.getByRole("button", { name: "Process exited 7 — pnpm build" }),
    ).toBeInTheDocument();
  });
});

describe("CompletionGroup — a run of three or more", () => {
  const three = [
    subagent("first", "completed", "sub_1", "one"),
    subagent("second", "completed", "sub_2", "two"),
    subagent("third", "completed", "sub_3", "three"),
  ];

  it("collapses into one summary line", () => {
    render(<CompletionGroup run={three} runsById={{}} />);
    expect(
      screen.getByRole("button", { name: "3 background results — first, second, third" }),
    ).toBeInTheDocument();
    expect(
      screen.queryByRole("button", { name: /Subagent finished — first/ }),
    ).not.toBeInTheDocument();
  });

  it("lists every result inside the inspector", () => {
    render(<CompletionGroup run={three} runsById={{}} />);
    fireEvent.click(screen.getByRole("button", { name: /3 background results/ }));
    expect(screen.getByText("one")).toBeInTheDocument();
    expect(screen.getByText("two")).toBeInTheDocument();
    expect(screen.getByText("three")).toBeInTheDocument();
    expect(screen.getAllByTestId("completion-status")).toHaveLength(3);
  });

  it("counts only what it can actually show", () => {
    // A watcher message whose payload is unparseable still renders (it degrades
    // to a nameless process line), so the tally must match the panel count.
    render(<CompletionGroup run={[...three, watcher("bad", undefined)]} runsById={{}} />);
    fireEvent.click(screen.getByRole("button", { name: /4 background results/ }));
    expect(screen.getAllByTestId("completion-status")).toHaveLength(4);
  });
});
