// @vitest-environment jsdom

import "@testing-library/jest-dom/vitest";
import { cleanup, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import type { ProviderModelSearchResult } from "../../settings-api";

const api = vi.hoisted(() => ({ getProviderModelCatalog: vi.fn() }));

vi.mock("../../settings-api", async () => {
  const actual = await vi.importActual<typeof import("../../settings-api")>("../../settings-api");
  return { ...actual, ...api };
});

import { ComposerModelPicker } from "./ComposerModelPicker";

const providers = [{ value: "openai" as const, label: "OpenAI", whitelistModels: null }];

const FULL_CATALOG: ProviderModelSearchResult[] = [
  { id: "gpt-5", name: "GPT-5", inputModalities: ["text"], reasoning: true, source: "live" },
  { id: "gpt-5-mini", name: "GPT-5 mini", inputModalities: ["text", "image"], source: "live" },
];

const MIXED_WINDOW_CATALOG: ProviderModelSearchResult[] = [
  { id: "gpt-5", name: "GPT-5", inputModalities: ["text"], contextLength: 500_000, source: "live" },
  {
    id: "gpt-5-mini",
    name: "GPT-5 mini",
    inputModalities: ["text"],
    contextLength: 128_000,
    source: "live",
  },
  // No `contextLength` at all — an uncurated/catalog-miss model. Must never
  // be marked: unknown is not "too small".
  { id: "gpt-5-nano", name: "GPT-5 nano", inputModalities: ["text"], source: "live" },
];

beforeAll(() => {
  Element.prototype.scrollIntoView = vi.fn() as never;
  Element.prototype.hasPointerCapture = vi.fn(() => false) as never;
  vi.stubGlobal(
    "ResizeObserver",
    class {
      observe() {}
      unobserve() {}
      disconnect() {}
    },
  );
});

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

describe("ComposerModelPicker", () => {
  it("renders the model it is given", () => {
    render(
      <ComposerModelPicker
        value={{ provider: "openai", model: "gpt-5" }}
        providers={providers}
        onSelect={vi.fn()}
      />,
    );
    expect(screen.getByLabelText(/Model: gpt-5/)).toBeInTheDocument();
  });

  it("renders an uncommitted selection identically to a committed one", () => {
    const { container: committed } = render(
      <ComposerModelPicker
        value={{ provider: "anthropic", model: "claude-opus-5" }}
        providers={providers}
        onSelect={vi.fn()}
      />,
    );
    expect(committed.textContent).toContain("claude-opus-5");
    expect(committed.textContent).not.toMatch(/pending|applies on send/i);
  });

  it("calls onSelect with the chosen tuple", async () => {
    api.getProviderModelCatalog.mockResolvedValue({
      provider: "openai",
      models: FULL_CATALOG,
      source: "live",
      fetchedAt: Date.now(),
      stale: false,
    });

    const onSelect = vi.fn();
    render(
      <ComposerModelPicker
        value={{ provider: "openai", model: "gpt-5" }}
        providers={providers}
        onSelect={onSelect}
      />,
    );
    await userEvent.click(screen.getByRole("button"));

    await userEvent.click(await screen.findByText("GPT-5 mini"));

    expect(onSelect).toHaveBeenCalledWith(
      { provider: "openai", model: "gpt-5-mini" },
      expect.objectContaining({ id: "gpt-5-mini", inputModalities: ["text", "image"] }),
    );
  });

  it("does not report a selection when re-picking the model already in use", async () => {
    api.getProviderModelCatalog.mockResolvedValue({
      provider: "openai",
      models: FULL_CATALOG,
      source: "live",
      fetchedAt: Date.now(),
      stale: false,
    });

    const onSelect = vi.fn();
    render(
      <ComposerModelPicker
        value={{ provider: "openai", model: "gpt-5" }}
        providers={providers}
        onSelect={onSelect}
      />,
    );
    await userEvent.click(screen.getByRole("button"));
    await userEvent.click(await screen.findByText("GPT-5"));

    expect(onSelect).not.toHaveBeenCalled();
  });

  it("marks models whose window cannot hold the current thread, and no others", async () => {
    api.getProviderModelCatalog.mockResolvedValue({
      provider: "openai",
      models: MIXED_WINDOW_CATALOG,
      source: "live",
      fetchedAt: Date.now(),
      stale: false,
    });

    render(
      <ComposerModelPicker
        value={{ provider: "openai", model: "gpt-5" }}
        providers={providers}
        currentUsageTokens={400_000}
        onSelect={vi.fn()}
      />,
    );
    await userEvent.click(screen.getByRole("button"));

    const miniRow = (await screen.findByText("GPT-5 mini")).closest('[data-slot="command-item"]');
    expect(miniRow).not.toBeNull();
    expect(miniRow).toHaveTextContent(/will compact/i);

    const bigRow = screen.getByText("GPT-5").closest('[data-slot="command-item"]');
    expect(bigRow).not.toHaveTextContent(/will compact/i);

    const unknownRow = screen.getByText("GPT-5 nano").closest('[data-slot="command-item"]');
    expect(unknownRow).not.toHaveTextContent(/will compact/i);
  });

  it("confirms once before storing a switch that will compact the conversation", async () => {
    api.getProviderModelCatalog.mockResolvedValue({
      provider: "openai",
      models: MIXED_WINDOW_CATALOG,
      source: "live",
      fetchedAt: Date.now(),
      stale: false,
    });

    const onSelect = vi.fn();
    render(
      <ComposerModelPicker
        value={{ provider: "openai", model: "gpt-5" }}
        providers={providers}
        currentUsageTokens={400_000}
        onSelect={onSelect}
      />,
    );
    await userEvent.click(screen.getByRole("button"));
    await userEvent.click(await screen.findByText("GPT-5 mini"));

    // Not stored yet — the confirm is still open, and it's not disabled: the
    // option must remain pickable, just gated behind one confirmation.
    expect(onSelect).not.toHaveBeenCalled();
    const dialog = await screen.findByRole("alertdialog");
    expect(dialog).toHaveTextContent(/compact/i);

    await userEvent.click(screen.getByRole("button", { name: /switch and compact/i }));

    expect(onSelect).toHaveBeenCalledWith(
      { provider: "openai", model: "gpt-5-mini" },
      expect.objectContaining({ id: "gpt-5-mini" }),
    );
  });

  it("does not warn or confirm when the thread's usage is unknown", async () => {
    api.getProviderModelCatalog.mockResolvedValue({
      provider: "openai",
      models: MIXED_WINDOW_CATALOG,
      source: "live",
      fetchedAt: Date.now(),
      stale: false,
    });

    const onSelect = vi.fn();
    render(
      <ComposerModelPicker
        value={{ provider: "openai", model: "gpt-5" }}
        providers={providers}
        currentUsageTokens={null}
        onSelect={onSelect}
      />,
    );
    await userEvent.click(screen.getByRole("button"));

    const miniRow = (await screen.findByText("GPT-5 mini")).closest('[data-slot="command-item"]');
    expect(miniRow).not.toHaveTextContent(/will compact/i);

    await userEvent.click(screen.getByText("GPT-5 mini"));
    expect(screen.queryByRole("alertdialog")).not.toBeInTheDocument();
    expect(onSelect).toHaveBeenCalledWith(
      { provider: "openai", model: "gpt-5-mini" },
      expect.objectContaining({ id: "gpt-5-mini" }),
    );
  });
});
