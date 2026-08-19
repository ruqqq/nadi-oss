// @vitest-environment jsdom

import "@testing-library/jest-dom/vitest";
import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import { ModelSwitchDivider } from "./ModelSwitchDivider";

afterEach(() => cleanup());

describe("ModelSwitchDivider", () => {
  it("names the model being switched to", () => {
    render(
      <ModelSwitchDivider
        from={{ provider: "openai", model: "gpt-5" }}
        to={{ provider: "anthropic", model: "claude-opus-5" }}
      />,
    );
    expect(screen.getByText(/claude-opus-5/)).toBeInTheDocument();
  });

  it("renders as a separator for assistive tech", () => {
    render(
      <ModelSwitchDivider
        from={{ provider: "openai", model: "gpt-5" }}
        to={{ provider: "anthropic", model: "claude-opus-5" }}
      />,
    );
    expect(screen.getByRole("separator")).toBeInTheDocument();
  });
});
