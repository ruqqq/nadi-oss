// @vitest-environment jsdom

import "@testing-library/jest-dom/vitest";
import { cleanup, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { AgentListItem } from "../../agents-api";
import { AgentOverridePicker, AgentPicker } from "./AgentPicker";

const NADI: AgentListItem = { id: "env_nadi", name: "Nadi", description: "", enabled: true };
const DOCS: AgentListItem = { id: "env_docs", name: "Docs", description: "", enabled: true };
const RETIRED: AgentListItem = {
  id: "env_retired",
  name: "Retired",
  description: "",
  enabled: false,
};

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

beforeEach(() => {
  // Desktop: the popover branch, not the mobile bottom sheet.
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

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

async function openPicker(name: RegExp) {
  const user = userEvent.setup({ pointerEventsCheck: 0 });
  const trigger = screen.getByRole("button", { name });
  // Radix opens its popover on pointerdown, not click.
  await user.pointer({ target: trigger, keys: "[MouseLeft]" });
  return user;
}

describe("AgentPicker", () => {
  // Routing a thread onto a disabled agent does not fail: the thread runs with
  // no exec_* tools and nothing says why. The picker must not offer that.
  it("does not offer a disabled agent", async () => {
    render(<AgentPicker value={NADI.id} agents={[NADI, DOCS, RETIRED]} onValueChange={() => {}} />);

    await openPicker(/agent: nadi/i);

    expect(await screen.findByRole("option", { name: /Docs/ })).toBeInTheDocument();
    expect(screen.queryByRole("option", { name: /Retired/ })).not.toBeInTheDocument();
  });

  // The exception, so a thread already on a disabled agent still reads
  // correctly instead of blanking or appearing to be on some other agent.
  it("keeps a disabled agent listed while it is the current selection", async () => {
    render(<AgentPicker value={RETIRED.id} agents={[NADI, RETIRED]} onValueChange={() => {}} />);

    expect(screen.getByRole("button", { name: /agent: retired/i })).toBeInTheDocument();

    await openPicker(/agent: retired/i);
    expect(await screen.findByRole("option", { name: /Retired/ })).toBeInTheDocument();
  });

  it("reports the chosen agent id", async () => {
    const onValueChange = vi.fn();
    render(<AgentPicker value={NADI.id} agents={[NADI, DOCS]} onValueChange={onValueChange} />);

    const user = await openPicker(/agent: nadi/i);
    await user.click(await screen.findByRole("option", { name: /Docs/ }));

    expect(onValueChange).toHaveBeenCalledWith(DOCS.id);
  });
});

describe("AgentOverridePicker", () => {
  it("hides disabled agents but keeps the inherit option", async () => {
    render(
      <AgentOverridePicker
        value={null}
        agents={[NADI, RETIRED]}
        inheritLabel="Inherit"
        onValueChange={() => {}}
      />,
    );

    await openPicker(/agent: inherit/i);

    expect(await screen.findByRole("option", { name: /Inherit/ })).toBeInTheDocument();
    expect(screen.queryByRole("option", { name: /Retired/ })).not.toBeInTheDocument();
  });

  it("reports null when inherit is chosen", async () => {
    const onValueChange = vi.fn();
    render(
      <AgentOverridePicker
        value={NADI.id}
        agents={[NADI]}
        inheritLabel="Inherit"
        onValueChange={onValueChange}
      />,
    );

    const user = await openPicker(/agent: nadi/i);
    await user.click(await screen.findByRole("option", { name: /Inherit/ }));

    expect(onValueChange).toHaveBeenCalledWith(null);
  });
});
