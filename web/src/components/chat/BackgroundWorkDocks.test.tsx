// @vitest-environment jsdom
import "@testing-library/jest-dom/vitest";
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { BackgroundTasksRow } from "./BackgroundTasksRow";
import { BackgroundTasksSheet } from "./BackgroundTasksSheet";
import type { BackgroundWorkRow } from "../../lib/use-background-work";

afterEach(cleanup);

// Radix Dialog/Collapsible rely on a few DOM APIs jsdom does not implement.
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

const noop = () => {};

let seq = 0;
function running(overrides?: Partial<BackgroundWorkRow>): BackgroundWorkRow {
  seq += 1;
  return {
    id: `run-${seq}`,
    kind: "process",
    label: "make build",
    startedAt: 1_000,
    terminal: null,
    ...overrides,
  };
}
function failed(overrides?: Partial<BackgroundWorkRow>): BackgroundWorkRow {
  seq += 1;
  return {
    id: `fail-${seq}`,
    kind: "process",
    label: "make build",
    startedAt: 1_000,
    terminal: { outcome: "exited", reason: "process_exit", exitCode: 7, at: 8_000 },
    ...overrides,
  };
}
function clean(overrides?: Partial<BackgroundWorkRow>): BackgroundWorkRow {
  seq += 1;
  return {
    id: `clean-${seq}`,
    kind: "process",
    label: "make build",
    startedAt: 1_000,
    terminal: { outcome: "exited", reason: "process_exit", exitCode: 0, at: 8_000 },
    ...overrides,
  };
}
function unknownExit(overrides?: Partial<BackgroundWorkRow>): BackgroundWorkRow {
  seq += 1;
  return {
    id: `unknown-${seq}`,
    kind: "process",
    label: "make build",
    startedAt: 1_000,
    terminal: { outcome: "exited", reason: "process_exit", exitCode: null, at: 8_000 },
    ...overrides,
  };
}

describe("BackgroundTasksRow", () => {
  it("summarises the state mix, not a bare total", () => {
    render(<BackgroundTasksRow enabled rows={[running(), running(), failed()]} onOpen={noop} />);
    expect(screen.getByText("2 running · 1 failed")).toBeInTheDocument();
  });

  it("shows a failure indicator when nothing is running but something failed", () => {
    render(<BackgroundTasksRow enabled rows={[failed()]} onOpen={noop} />);
    expect(screen.getByTestId("bg-indicator")).toHaveAttribute("data-state", "failed");
  });

  it("shows a clean indicator when everything finished with exit 0", () => {
    render(<BackgroundTasksRow enabled rows={[clean()]} onOpen={noop} />);
    expect(screen.getByTestId("bg-indicator")).toHaveAttribute("data-state", "clean");
  });

  it("never shows a clean indicator for an unknown exit code", () => {
    render(<BackgroundTasksRow enabled rows={[unknownExit()]} onOpen={noop} />);
    expect(screen.getByTestId("bg-indicator")).toHaveAttribute("data-state", "failed");
  });

  it("renders nothing when disabled", () => {
    const { container } = render(<BackgroundTasksRow enabled={false} rows={[running()]} onOpen={noop} />);
    expect(container).toBeEmptyDOMElement();
  });

  it("renders nothing when empty", () => {
    const { container } = render(<BackgroundTasksRow enabled rows={[]} onOpen={noop} />);
    expect(container).toBeEmptyDOMElement();
  });

  it("opens the sheet on click, and carries no task labels", () => {
    const onOpen = vi.fn();
    render(<BackgroundTasksRow enabled rows={[running()]} onOpen={onOpen} />);
    expect(screen.queryByText("make build")).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: /running/ }));
    expect(onOpen).toHaveBeenCalledTimes(1);
  });
});

describe("BackgroundTasksSheet — the three exit-code states", () => {
  const sheetProps = {
    open: true,
    onOpenChange: noop,
    readOutput: vi.fn(async () => null),
    cancel: vi.fn(async () => ({ ok: true })),
    clearFinished: vi.fn(async () => ({ cleared: 0 })),
    onChanged: noop,
  };

  it("reads Exit 0 in the clean tone for a zero exit", () => {
    render(<BackgroundTasksSheet {...sheetProps} rows={[clean({ id: "row-a" })]} />);
    const exit = screen.getByText("Exit 0");
    expect(exit).toHaveClass("text-approve");
  });

  it("reads Exit N in the failure tone for a non-zero exit", () => {
    render(<BackgroundTasksSheet {...sheetProps} rows={[failed({ id: "row-b" })]} />);
    const exit = screen.getByText("Exit 7");
    expect(exit).toHaveClass("text-reject");
  });

  it("reads an unknown exit code as neutral, never as success", () => {
    render(<BackgroundTasksSheet {...sheetProps} rows={[unknownExit({ id: "row-c" })]} />);
    const exit = screen.getByText("Exit unknown");
    expect(exit).toHaveClass("text-muted-foreground");
    expect(exit).not.toHaveClass("text-approve");
  });
});

describe("BackgroundTasksSheet — output", () => {
  it("fetches output on first expand, not on render, and defaults a failed row to stderr", async () => {
    const readOutput = vi.fn(async () => ({
      head: ["boom"],
      tail: [],
      hiddenLines: 0,
      truncated: false,
      stream: "stderr" as const,
    }));
    render(
      <BackgroundTasksSheet
        open
        onOpenChange={noop}
        rows={[failed({ id: "row-d" })]}
        readOutput={readOutput}
        cancel={vi.fn(async () => ({ ok: true }))}
        clearFinished={vi.fn(async () => ({ cleared: 0 }))}
        onChanged={noop}
      />,
    );
    expect(readOutput).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole("button", { name: /output/i }));
    await waitFor(() => expect(readOutput).toHaveBeenCalledWith("row-d", "stderr"));
    expect(await screen.findByText("boom")).toBeInTheDocument();
  });

  it("shows 'No output yet' rather than an empty box", async () => {
    const readOutput = vi.fn(async () => ({
      head: [],
      tail: [],
      hiddenLines: 0,
      truncated: false,
      stream: "stdout" as const,
    }));
    render(
      <BackgroundTasksSheet
        open
        onOpenChange={noop}
        rows={[clean({ id: "row-e" })]}
        readOutput={readOutput}
        cancel={vi.fn(async () => ({ ok: true }))}
        clearFinished={vi.fn(async () => ({ cleared: 0 }))}
        onChanged={noop}
      />,
    );
    fireEvent.click(screen.getByRole("button", { name: /output/i }));
    expect(await screen.findByText("No output yet")).toBeInTheDocument();
  });
});

describe("BackgroundTasksSheet — duration", () => {
  it("derives a finished row's duration from terminal.at, not wall-clock-now", () => {
    // Date.now() is pinned far past the row's terminal timestamp — if the
    // sheet computed duration from wall-clock-now (the reload-resets-it bug
    // this was fixed to avoid) it would render a huge elapsed time instead
    // of the true `at - startedAt` (8_000 - 1_000 = 7s).
    const nowSpy = vi.spyOn(Date, "now").mockReturnValue(1_000_000);
    try {
      render(
        <BackgroundTasksSheet
          open
          onOpenChange={noop}
          rows={[failed({ id: "row-f", startedAt: 1_000, terminal: { outcome: "exited", reason: "process_exit", exitCode: 7, at: 8_000 } })]}
          readOutput={vi.fn(async () => null)}
          cancel={vi.fn(async () => ({ ok: true }))}
          clearFinished={vi.fn(async () => ({ cleared: 0 }))}
          onChanged={noop}
        />,
      );
      expect(screen.getByText("0:07")).toBeInTheDocument();
    } finally {
      nowSpy.mockRestore();
    }
  });
});

describe("BackgroundTasksSheet — sections", () => {
  it("splits Running from Finished with counts", () => {
    render(
      <BackgroundTasksSheet
        open
        onOpenChange={noop}
        rows={[running({ id: "r1" }), failed({ id: "f1" })]}
        readOutput={vi.fn(async () => null)}
        cancel={vi.fn(async () => ({ ok: true }))}
        clearFinished={vi.fn(async () => ({ cleared: 0 }))}
        onChanged={noop}
      />,
    );
    expect(screen.getByText("Running")).toBeInTheDocument();
    expect(screen.getByText("Finished")).toBeInTheDocument();
  });

  it("cancels a running row via the stop button", async () => {
    const cancel = vi.fn(async () => ({ ok: true }));
    const onChanged = vi.fn();
    render(
      <BackgroundTasksSheet
        open
        onOpenChange={noop}
        rows={[running({ id: "r2" })]}
        readOutput={vi.fn(async () => null)}
        cancel={cancel}
        clearFinished={vi.fn(async () => ({ cleared: 0 }))}
        onChanged={onChanged}
      />,
    );
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: /cancel task/i }));
    });
    expect(cancel).toHaveBeenCalledWith("r2");
    await waitFor(() => expect(onChanged).toHaveBeenCalled());
  });
});
