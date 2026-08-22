// @vitest-environment jsdom

import "@testing-library/jest-dom/vitest";
import { cleanup, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { ThreadHeaderMenu } from "./ThreadHeaderMenu";

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

beforeAll(() => {
  Element.prototype.hasPointerCapture = vi.fn(() => false) as never;
  Element.prototype.setPointerCapture = vi.fn() as never;
  Element.prototype.releasePointerCapture = vi.fn() as never;
  Element.prototype.scrollIntoView = vi.fn() as never;
});

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

describe("ThreadHeaderMenu", () => {
  it("opens artifacts and details from the overflow menu", async () => {
    const user = userEvent.setup();
    const onOpenArtifacts = vi.fn();
    const onOpenDetails = vi.fn();
    render(<ThreadHeaderMenu onOpenArtifacts={onOpenArtifacts} onOpenDetails={onOpenDetails} />);

    await user.click(screen.getByRole("button", { name: "Thread actions" }));
    await user.click(await screen.findByRole("menuitem", { name: "Artifacts & downloads" }));
    expect(onOpenArtifacts).toHaveBeenCalledOnce();

    await user.click(screen.getByRole("button", { name: "Thread actions" }));
    await user.click(await screen.findByRole("menuitem", { name: "Thread details" }));
    expect(onOpenDetails).toHaveBeenCalledOnce();
  });
});
