// @vitest-environment jsdom
import "@testing-library/jest-dom/vitest";
import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import { BackgroundWorkDock } from "./BackgroundWorkDock";

afterEach(cleanup);

describe("BackgroundWorkDock", () => {
  it("renders process and subagent rows in one dock with their outcomes", () => {
    render(
      <BackgroundWorkDock
        enabled
        rows={[
          { id: "p1", kind: "process", label: "make build", terminal: { outcome: "exited" } },
          { id: "s1", kind: "subagent", label: "review the diff", terminal: null },
        ]}
      />,
    );
    expect(screen.getByText("make build")).toBeInTheDocument();
    expect(screen.getByText("review the diff")).toBeInTheDocument();
    // Terminal outcomes are the thing neither old dock (WatcherDock,
    // SubagentDock) could show for the other kind.
    expect(screen.getByTestId("bg-p1")).toHaveAttribute("data-outcome", "exited");
    expect(screen.getByTestId("bg-s1")).toHaveAttribute("data-outcome", "running");
  });

  it("renders nothing when background work is disabled", () => {
    const { container } = render(
      <BackgroundWorkDock
        enabled={false}
        rows={[{ id: "p1", kind: "process", label: "make build", terminal: { outcome: "exited" } }]}
      />,
    );
    expect(container).toBeEmptyDOMElement();
  });

  it("renders nothing when there are no rows", () => {
    const { container } = render(<BackgroundWorkDock enabled rows={[]} />);
    expect(container).toBeEmptyDOMElement();
  });
});
