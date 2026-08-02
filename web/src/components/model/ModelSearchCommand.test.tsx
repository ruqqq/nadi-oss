// @vitest-environment jsdom

import "@testing-library/jest-dom/vitest";
import { cleanup, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import type { ProviderModelSearchResult } from "../../settings-api";

const api = vi.hoisted(() => ({ getProviderModelCatalog: vi.fn() }));

vi.mock("../../settings-api", async () => {
  const actual = await vi.importActual<typeof import("../../settings-api")>("../../settings-api");
  return { ...actual, ...api };
});

import { ModelSearchCommand } from "./ModelSearchCommand";

const CATALOG: ProviderModelSearchResult[] = [
  { id: "claude-opus-5", name: "Claude Opus 5", inputModalities: ["text"], source: "live" },
  { id: "claude-sonnet-5", name: "Claude Sonnet 5", inputModalities: ["text"], source: "live" },
  { id: "claude-haiku-4-5", name: "Claude Haiku 4.5", inputModalities: ["text"], source: "live" },
];

beforeAll(() => {
  Element.prototype.scrollIntoView = vi.fn() as never;
  // cmdk measures its list; jsdom has no ResizeObserver.
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

describe("ModelSearchCommand", () => {
  it("loads the catalog once and filters typing locally", async () => {
    // The whole point of the cached catalog: typing must not hit the network.
    // Before this, every keystroke fetched, and every fetch reached the
    // provider's live /models API.
    api.getProviderModelCatalog.mockResolvedValue({
      provider: "anthropic",
      models: CATALOG,
      source: "live",
      fetchedAt: Date.now(),
      stale: false,
    });

    render(
      <ModelSearchCommand
        provider="anthropic"
        initialQuery=""
        placeholder="Search models"
        onQueryChange={() => {}}
        onSelect={() => {}}
      />,
    );

    await screen.findByText("Claude Opus 5");
    expect(api.getProviderModelCatalog).toHaveBeenCalledTimes(1);

    await userEvent.type(screen.getByPlaceholderText("Search models"), "sonnet");

    await waitFor(() => {
      expect(screen.queryByText("Claude Opus 5")).not.toBeInTheDocument();
    });
    expect(screen.getByText("Claude Sonnet 5")).toBeInTheDocument();
    expect(api.getProviderModelCatalog).toHaveBeenCalledTimes(1);
  });

  it("renders a supplied list without any request", async () => {
    render(
      <ModelSearchCommand
        provider="anthropic"
        models={[CATALOG[0] as ProviderModelSearchResult]}
        initialQuery=""
        placeholder="Search models"
        onQueryChange={() => {}}
        onSelect={() => {}}
      />,
    );

    await screen.findByText("Claude Opus 5");
    expect(api.getProviderModelCatalog).not.toHaveBeenCalled();
    expect(screen.queryByText("Claude Sonnet 5")).not.toBeInTheDocument();
  });

  it("shows a leading group above the main list and filters it too", async () => {
    const pinned: ProviderModelSearchResult = {
      id: "claude-haiku-4-5",
      inputModalities: ["text"],
      source: "static",
    };

    render(
      <ModelSearchCommand
        provider="anthropic"
        models={[CATALOG[0] as ProviderModelSearchResult]}
        leadingGroup={{ heading: "Current", models: [pinned] }}
        initialQuery=""
        placeholder="Search models"
        onQueryChange={() => {}}
        onSelect={() => {}}
      />,
    );

    expect(await screen.findByText("Current")).toBeInTheDocument();
    expect(screen.getByText("claude-haiku-4-5")).toBeInTheDocument();

    await userEvent.type(screen.getByPlaceholderText("Search models"), "opus");
    await waitFor(() => {
      expect(screen.queryByText("Current")).not.toBeInTheDocument();
    });
  });

  it("keeps a free-typed model id usable when the catalog fails to load", async () => {
    api.getProviderModelCatalog.mockRejectedValue(new Error("upstream down"));
    const onQueryChange = vi.fn();

    render(
      <ModelSearchCommand
        provider="anthropic"
        initialQuery=""
        placeholder="Search models"
        onQueryChange={onQueryChange}
        onSelect={() => {}}
      />,
    );

    expect(await screen.findByText(/Couldn’t load models/)).toBeInTheDocument();
    await userEvent.type(screen.getByPlaceholderText("Search models"), "my-model");
    expect(onQueryChange).toHaveBeenLastCalledWith("my-model");
  });
});
