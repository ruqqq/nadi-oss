// @vitest-environment jsdom
import "@testing-library/jest-dom/vitest";
import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { SubagentRunsState } from "@/lib/use-subagent-runs";
import { SubagentDock } from "./SubagentDock";
import { WatcherDock } from "./WatcherDock";

afterEach(cleanup);

const subagentRuns: SubagentRunsState = {
  runsById: { sub_1: { runId: "sub_1", status: "running" } },
  runs: [{ runId: "sub_1", status: "running" }],
  runningCount: 1,
  finishedCount: 0,
  firstSeen: new Map([["sub_1", 1]]),
  timings: {},
  cancelRun: vi.fn(),
  clearFinished: vi.fn(),
  hasFinished: false,
};

describe("background-work docks", () => {
  it("hides a populated watcher dock while disabled", () => {
    render(
      <WatcherDock
        enabled={false}
        watchers={[
          {
            processId: "proc_1",
            label: "build",
            command: "pnpm build",
            createdAt: 1,
            deadlineAt: 10_000,
          },
        ]}
      />,
    );
    expect(screen.queryByText("Watching")).not.toBeInTheDocument();
  });

  it("hides populated subagent controls while disabled", () => {
    render(<SubagentDock enabled={false} subagentRuns={subagentRuns} servers={[]} />);
    expect(screen.queryByText("Subagents")).not.toBeInTheDocument();
  });
});
