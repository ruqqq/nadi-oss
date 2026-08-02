// @vitest-environment jsdom

import "@testing-library/jest-dom/vitest";
import { cleanup, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { availableEffortOptions } from "../../lib/reasoning-effort";
import type { ReasoningEffort } from "../../settings-api";
import { EffortDial } from "./EffortDial";

beforeAll(() => {
  Element.prototype.scrollIntoView = vi.fn() as never;
  // Radix menus measure; jsdom has neither.
  vi.stubGlobal(
    "ResizeObserver",
    class {
      observe() {}
      unobserve() {}
      disconnect() {}
    },
  );
});

afterEach(cleanup);

describe("EffortDial", () => {
  it("announces the current level, since nothing is drawn in words", () => {
    // The control is icon-only by design, so the accessible name is the ONLY
    // way the level reaches a screen reader.
    render(<EffortDial effort="high" options={availableEffortOptions(undefined)} onEffortChange={() => {}} />);
    expect(screen.getByRole("button", { name: "Thinking effort: High" })).toBeInTheDocument();

    cleanup();
    render(<EffortDial effort="off" options={availableEffortOptions(undefined)} onEffortChange={() => {}} />);
    expect(screen.getByRole("button", { name: "Thinking effort: Off" })).toBeInTheDocument();
  });

  it("offers all four levels and reports the chosen one", async () => {
    const onEffortChange = vi.fn<(effort: ReasoningEffort) => void>();
    render(<EffortDial effort="medium" options={availableEffortOptions(undefined)} onEffortChange={onEffortChange} />);

    await userEvent.click(screen.getByRole("button", { name: "Thinking effort: Medium" }));

    for (const label of ["Off", "Low", "Medium", "High"]) {
      expect(screen.getByRole("menuitem", { name: new RegExp(label) })).toBeInTheDocument();
    }

    await userEvent.click(screen.getByRole("menuitem", { name: /High/ }));
    expect(onEffortChange).toHaveBeenCalledWith("high");
  });

  it("does not open when disabled", async () => {
    const onEffortChange = vi.fn();
    render(<EffortDial effort="low" options={availableEffortOptions(undefined)} onEffortChange={onEffortChange} disabled />);
    const trigger = screen.getByRole("button", { name: "Thinking effort: Low" });
    expect(trigger).toBeDisabled();
    // Count BEFORE, so a portal left behind by an earlier test can't be mistaken
    // for this menu opening.
    const before = document.querySelectorAll("[role=menuitem]").length;
    await userEvent.click(trigger);
    expect(document.querySelectorAll("[role=menuitem]").length).toBe(before);
    expect(trigger).toHaveAttribute("aria-expanded", "false");
    expect(onEffortChange).not.toHaveBeenCalled();
  });
});

describe("EffortDial per-model granularity", () => {
  it("offers two states for a toggle-only model, and does not call one of them High", () => {
    render(
      <EffortDial
        effort="medium"
        options={availableEffortOptions([{ type: "toggle" }])}
        onEffortChange={() => {}}
      />,
    );
    expect(screen.getByRole("button", { name: "Thinking effort: On" })).toBeInTheDocument();
  });

  it("uses the model's own words for its scale", async () => {
    const onEffortChange = vi.fn<(effort: ReasoningEffort) => void>();
    render(
      <EffortDial
        effort="off"
        // glm-5.2 / deepseek-v4-flash: two intensities, neither called "medium".
        options={availableEffortOptions([{ type: "effort", values: ["high", "max"] }])}
        onEffortChange={onEffortChange}
      />,
    );
    await userEvent.click(screen.getByRole("button", { name: "Thinking effort: Off" }));
    expect(screen.getByRole("menuitem", { name: /Max/ })).toBeInTheDocument();
    expect(screen.queryByRole("menuitem", { name: /Medium/ })).not.toBeInTheDocument();
  });

  it("renders nothing when the model exposes no control at all", () => {
    const { container } = render(
      <EffortDial effort="medium" options={availableEffortOptions([])} onEffortChange={() => {}} />,
    );
    expect(container).toBeEmptyDOMElement();
  });

  it("falls back to an offered level when the stored one is not on this model's menu", () => {
    // Switching models can leave a stored "medium" that this model never offers.
    render(
      <EffortDial
        effort="medium"
        options={availableEffortOptions([{ type: "effort", values: ["high", "max"] }])}
        onEffortChange={() => {}}
      />,
    );
    expect(screen.getByRole("button", { name: "Thinking effort: High" })).toBeInTheDocument();
  });
});
