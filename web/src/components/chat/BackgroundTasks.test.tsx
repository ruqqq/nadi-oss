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
    progress: null,
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
    progress: null,
    terminal: {
      outcome: "exited",
      reason: "process_exit",
      exitCode: 7,
      subagentStatus: null,
      at: 8_000,
    },
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
    progress: null,
    terminal: {
      outcome: "exited",
      reason: "process_exit",
      exitCode: 0,
      subagentStatus: null,
      at: 8_000,
    },
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
    progress: null,
    terminal: {
      outcome: "exited",
      reason: "process_exit",
      exitCode: null,
      subagentStatus: null,
      at: 8_000,
    },
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
    const { container } = render(
      <BackgroundTasksRow enabled={false} rows={[running()]} onOpen={noop} />,
    );
    expect(container).toBeEmptyDOMElement();
  });

  it("renders nothing when empty", () => {
    const { container } = render(<BackgroundTasksRow enabled rows={[]} onOpen={noop} />);
    expect(container).toBeEmptyDOMElement();
  });

  it("is labelled 'Background tasks' (an accessible name for the button, not just its state), and carries no per-task labels", () => {
    const onOpen = vi.fn();
    render(<BackgroundTasksRow enabled rows={[running()]} onOpen={onOpen} />);
    expect(screen.queryByText("make build")).not.toBeInTheDocument();
    const button = screen.getByRole("button", { name: /Background tasks/ });
    fireEvent.click(button);
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
    resultFor: () => undefined,
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
        resultFor={() => undefined}
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
        resultFor={() => undefined}
        onChanged={noop}
      />,
    );
    fireEvent.click(screen.getByRole("button", { name: /output/i }));
    expect(await screen.findByText("No output yet")).toBeInTheDocument();
  });

  it("shows a distinct 'not available' message — never an empty box — when readOutput resolves null", async () => {
    // `null` covers: background work disabled, the row is no longer a
    // tracked process, the sandbox couldn't be resolved, or a server-side
    // throw. It must read differently from a genuinely empty stream.
    const readOutput = vi.fn(async () => null);
    render(
      <BackgroundTasksSheet
        open
        onOpenChange={noop}
        rows={[failed({ id: "row-x" })]}
        readOutput={readOutput}
        cancel={vi.fn(async () => ({ ok: true }))}
        clearFinished={vi.fn(async () => ({ cleared: 0 }))}
        resultFor={() => undefined}
        onChanged={noop}
      />,
    );
    fireEvent.click(screen.getByRole("button", { name: /output/i }));
    expect(await screen.findByText("Output isn't available for this task.")).toBeInTheDocument();
    expect(screen.queryByText("No output yet")).not.toBeInTheDocument();
  });

  it("renders a distinct note when retention truncated earlier output", async () => {
    const readOutput = vi.fn(async () => ({
      head: ["line one"],
      tail: [],
      hiddenLines: 0,
      truncated: true,
      stream: "stdout" as const,
    }));
    render(
      <BackgroundTasksSheet
        open
        onOpenChange={noop}
        rows={[clean({ id: "row-y" })]}
        readOutput={readOutput}
        cancel={vi.fn(async () => ({ ok: true }))}
        clearFinished={vi.fn(async () => ({ cleared: 0 }))}
        resultFor={() => undefined}
        onChanged={noop}
      />,
    );
    fireEvent.click(screen.getByRole("button", { name: /output/i }));
    expect(await screen.findByText(/no longer retained/i)).toBeInTheDocument();
  });
});

describe("BackgroundTasksSheet — kind glyph carries state", () => {
  it("tones the glyph by the row's state, since there is no separate severity stripe", () => {
    render(
      <BackgroundTasksSheet
        open
        onOpenChange={noop}
        rows={[failed({ id: "row-g" })]}
        readOutput={vi.fn(async () => null)}
        cancel={vi.fn(async () => ({ ok: true }))}
        clearFinished={vi.fn(async () => ({ cleared: 0 }))}
        resultFor={() => undefined}
        onChanged={noop}
      />,
    );
    const glyph = screen.getByTestId("bg-kind-glyph");
    expect(glyph).toHaveAttribute("data-tone", "failed");
    expect(glyph).toHaveClass("text-reject");
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
          rows={[
            failed({
              id: "row-f",
              startedAt: 1_000,
              terminal: {
                outcome: "exited",
                reason: "process_exit",
                exitCode: 7,
                subagentStatus: null,
                at: 8_000,
              },
            }),
          ]}
          readOutput={vi.fn(async () => null)}
          cancel={vi.fn(async () => ({ ok: true }))}
          clearFinished={vi.fn(async () => ({ cleared: 0 }))}
          resultFor={() => undefined}
          onChanged={noop}
        />,
      );
      expect(screen.getByText("7s")).toBeInTheDocument();
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
        resultFor={() => undefined}
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
        resultFor={() => undefined}
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

describe("BackgroundTasksSheet — subagent progress", () => {
  const base = {
    open: true,
    onOpenChange: noop,
    readOutput: vi.fn(async () => null),
    cancel: vi.fn(async () => ({ ok: true })),
    clearFinished: vi.fn(async () => ({ cleared: 0 })),
    onChanged: noop,
    resultFor: () => undefined,
  };

  function subagent(overrides?: Partial<BackgroundWorkRow>): BackgroundWorkRow {
    seq += 1;
    return {
      id: `sub_${seq}`,
      kind: "subagent",
      label: "List the 10 largest files",
      startedAt: 1_000,
      progress: null,
      terminal: null,
      ...overrides,
    };
  }

  /** A subagent's real terminal shape: NO exit code, ever — its outcome lives
   *  in `subagentStatus`. Reading `exitCode` here is what made every completed
   *  subagent render "Exit unknown" and count as a dock failure. */
  function finishedSubagent(
    status: "completed" | "error" | "aborted" | "interrupted",
  ): BackgroundWorkRow {
    return subagent({
      terminal: {
        outcome: status === "aborted" ? "stopped" : "exited",
        reason: status === "aborted" ? "process_stopped" : "process_exit",
        exitCode: null,
        subagentStatus: status,
        at: 8_000,
      },
    });
  }

  it("names a completed subagent's outcome instead of an absent exit code", () => {
    render(<BackgroundTasksSheet {...base} rows={[finishedSubagent("completed")]} />);
    expect(screen.getByText("Completed")).toBeInTheDocument();
    // The bug: a subagent has no exit code, so the process-flavoured label
    // reported the NORMAL successful case as a malfunction.
    expect(screen.queryByText(/Exit unknown/)).not.toBeInTheDocument();
  });

  it("distinguishes a failed subagent from a completed one", () => {
    render(<BackgroundTasksSheet {...base} rows={[finishedSubagent("error")]} />);
    expect(screen.getByText("Error")).toBeInTheDocument();
    // `outcome` alone cannot see this: `error` and `completed` both arrive as
    // "exited", so toning on the outcome would paint this row as a success.
    expect(screen.getByTestId("bg-kind-glyph")).toHaveAttribute("data-tone", "failed");
  });

  it("tones a completed subagent as clean, not unknown", () => {
    render(<BackgroundTasksSheet {...base} rows={[finishedSubagent("completed")]} />);
    expect(screen.getByTestId("bg-kind-glyph")).toHaveAttribute("data-tone", "clean");
  });

  it("renders the progress message, labelled as progress and not output", () => {
    const row = subagent({
      progress: { message: "working (step 7)", phase: "working", at: 5_000 },
    });
    render(<BackgroundTasksSheet {...base} rows={[row]} />);
    expect(screen.getByText("working (step 7)")).toBeInTheDocument();
    expect(screen.getByText(/Progress/)).toBeInTheDocument();
    // It is liveness, not output — calling it "Output" would imply the run
    // produced nothing else.
    expect(screen.queryByText(/^Output$/)).not.toBeInTheDocument();
  });

  it("says it is waiting when a running subagent has not reported a step yet", () => {
    render(<BackgroundTasksSheet {...base} rows={[subagent()]} />);
    expect(screen.getByText(/Waiting for the first update/)).toBeInTheDocument();
    // The server reads progress from the SDK's durable child-run row, so there
    // is no longer a "this page missed the run's start" state to explain away.
    expect(screen.queryByText(/before this page loaded/)).not.toBeInTheDocument();
    // Must NOT borrow the process-flavoured copy, which would be wrong here.
    expect(screen.queryByText(/Output isn't available for this task/)).not.toBeInTheDocument();
  });

  it("shows no progress line for a finished subagent, stale or otherwise", () => {
    const done = finishedSubagent("completed");
    render(
      <BackgroundTasksSheet
        {...base}
        rows={[{ ...done, progress: { message: "working (step 3)", phase: null, at: 5_000 } }]}
      />,
    );
    expect(screen.queryByText("working (step 3)")).not.toBeInTheDocument();
    expect(screen.queryByText(/Waiting for the first update/)).not.toBeInTheDocument();
  });

  it("counts a completed subagent as clean in the dock summary, never as failed", () => {
    // The reported bug, at the surface the user actually saw it: the dock read
    // "1 failed" for a subagent that had finished successfully.
    render(<BackgroundTasksRow enabled rows={[finishedSubagent("completed")]} onOpen={noop} />);
    expect(screen.getByText(/1 clean/)).toBeInTheDocument();
    expect(screen.queryByText(/failed/)).not.toBeInTheDocument();
    expect(screen.getByTestId("bg-indicator")).toHaveAttribute("data-state", "clean");
  });

  it("shows a finished subagent's result, read from the transcript", () => {
    const done = finishedSubagent("completed");
    render(
      <BackgroundTasksSheet
        {...base}
        rows={[done]}
        resultFor={(id) =>
          id === done.id
            ? {
                segments: [],
                state: "idle",
                label: "",
                title: "List the 10 largest files",
                statusLabel: "Completed",
                tone: "ok",
                body: "the answer body",
                kind: "subagent",
              }
            : undefined
        }
      />,
    );
    // Collapsed by default — a sheet full of expanded results is a wall of text.
    expect(screen.queryByText("the answer body")).not.toBeInTheDocument();
    fireEvent.click(screen.getByText("Result"));
    expect(screen.getByText("the answer body")).toBeInTheDocument();
  });

  it("shows NO result disclosure when the completion is no longer in the transcript", () => {
    // Compaction. An empty "Result" panel would state that the run returned
    // nothing, which is a different and false claim than "we no longer have it".
    render(
      <BackgroundTasksSheet
        {...base}
        rows={[finishedSubagent("completed")]}
        resultFor={() => undefined}
      />,
    );
    expect(screen.queryByText("Result")).not.toBeInTheDocument();
  });

  it("offers no result for a RUNNING subagent — it shows progress instead", () => {
    render(
      <BackgroundTasksSheet
        {...base}
        rows={[subagent({ progress: { message: "3 tool calls", phase: "working", at: 5_000 } })]}
        resultFor={() => ({
          segments: [],
          state: "idle",
          label: "",
          title: "x",
          statusLabel: "Completed",
          tone: "ok",
          body: "premature body",
          kind: "subagent",
        })}
      />,
    );
    expect(screen.getByText("3 tool calls")).toBeInTheDocument();
    expect(screen.queryByText("Result")).not.toBeInTheDocument();
  });

  it("still counts a crashed subagent as failed in the dock summary", () => {
    render(<BackgroundTasksRow enabled rows={[finishedSubagent("error")]} onOpen={noop} />);
    expect(screen.getByText(/1 failed/)).toBeInTheDocument();
    expect(screen.getByTestId("bg-indicator")).toHaveAttribute("data-state", "failed");
  });
});
