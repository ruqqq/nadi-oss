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

import { ModelPicker } from "./ModelPicker";

const CURATED: ProviderModelSearchResult[] = [
  { id: "claude-opus-5", name: "Claude Opus 5", inputModalities: ["text"], source: "live" },
  { id: "claude-sonnet-5", name: "Claude Sonnet 5", inputModalities: ["text"], source: "live" },
];

const FULL_CATALOG: ProviderModelSearchResult[] = [
  ...CURATED,
  { id: "claude-haiku-4-5", name: "Claude Haiku 4.5", inputModalities: ["text"], source: "live" },
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

type PickerProvider = "anthropic" | "openai" | "openrouter";

function renderMultiProviderPicker(
  providers: Array<{
    value: PickerProvider;
    label: string;
    whitelistModels: ProviderModelSearchResult[] | null;
  }>,
  current: PickerProvider,
) {
  return render(
    <ModelPicker
      providers={providers}
      provider={current}
      model="some-model"
      placeholder="Search models"
      triggerId="model-trigger"
      triggerLabel="Model"
      onProviderChange={() => {}}
      onModelChange={() => {}}
    />,
  );
}

function renderPicker(overrides: {
  whitelistModels: ProviderModelSearchResult[] | null;
  model: string;
  onModelSelected?: (model: ProviderModelSearchResult) => void;
  onModelChange?: (model: string) => void;
}) {
  return render(
    <ModelPicker
      providers={[
        { value: "anthropic", label: "Anthropic", whitelistModels: overrides.whitelistModels },
      ]}
      provider="anthropic"
      model={overrides.model}
      placeholder="Search models"
      triggerId="model-trigger"
      triggerLabel="Model"
      onProviderChange={() => {}}
      onModelChange={overrides.onModelChange ?? (() => {})}
      {...(overrides.onModelSelected ? { onModelSelected: overrides.onModelSelected } : {})}
    />,
  );
}

describe("ModelPicker with a curated provider", () => {
  it("shows only the curated models and makes no request", async () => {
    renderPicker({ whitelistModels: CURATED, model: "claude-opus-5" });

    await userEvent.click(screen.getByLabelText("Model"));

    expect(await screen.findByText("Claude Opus 5")).toBeInTheDocument();
    expect(screen.getByText("Claude Sonnet 5")).toBeInTheDocument();
    expect(screen.queryByText("Claude Haiku 4.5")).not.toBeInTheDocument();
    expect(api.getProviderModelCatalog).not.toHaveBeenCalled();
  });

  it("surfaces the thread's pinned model when it is not in the curated list", async () => {
    // Un-whitelisting never stops a running thread, so the trigger can name a
    // model outside the list. It must still appear in the list it opens.
    renderPicker({ whitelistModels: CURATED, model: "claude-haiku-4-5" });

    await userEvent.click(screen.getByLabelText("Model"));

    expect(await screen.findByText("Current")).toBeInTheDocument();
    // The row has no name, so the id renders as both title and subtitle.
    expect(screen.getAllByText(/claude-haiku-4-5/).length).toBeGreaterThan(0);
  });

  it("does not report a selection when the Current row is re-picked", async () => {
    // That row is built from an id alone and cannot know the model's real
    // modalities. Reporting it would overwrite them with ["text"] and strip
    // image upload from a vision model the thread is already using.
    const onModelSelected = vi.fn();
    const onModelChange = vi.fn();
    renderPicker({
      whitelistModels: CURATED,
      model: "claude-haiku-4-5",
      onModelSelected,
      onModelChange,
    });

    await userEvent.click(screen.getByLabelText("Model"));
    await screen.findByText("Current");
    const row = document.querySelector('[cmdk-item][data-value="claude-haiku-4-5"]');
    expect(row).not.toBeNull();
    await userEvent.click(row as HTMLElement);

    // Proves the click actually selected the row — without this the assertion
    // below would pass on a click that never landed.
    expect(onModelChange).toHaveBeenCalledWith("claude-haiku-4-5");
    expect(onModelSelected).not.toHaveBeenCalled();
  });

  it("reports a selection for a genuinely different model", async () => {
    const onModelSelected = vi.fn();
    renderPicker({ whitelistModels: CURATED, model: "claude-haiku-4-5", onModelSelected });

    await userEvent.click(screen.getByLabelText("Model"));
    await userEvent.click(await screen.findByText("Claude Opus 5"));

    expect(onModelSelected).toHaveBeenCalledWith(
      expect.objectContaining({ id: "claude-opus-5" }),
    );
  });

  it("omits the Current group when the pinned model is curated", async () => {
    renderPicker({ whitelistModels: CURATED, model: "claude-opus-5" });

    await userEvent.click(screen.getByLabelText("Model"));

    await screen.findByText("Claude Opus 5");
    expect(screen.queryByText("Current")).not.toBeInTheDocument();
  });

  it("loads the full catalog only when the user asks to search all models", async () => {
    api.getProviderModelCatalog.mockResolvedValue({
      provider: "anthropic",
      models: FULL_CATALOG,
      source: "live",
      fetchedAt: Date.now(),
      stale: false,
    });

    renderPicker({ whitelistModels: CURATED, model: "claude-opus-5" });
    await userEvent.click(screen.getByLabelText("Model"));
    await screen.findByText("Claude Opus 5");
    expect(api.getProviderModelCatalog).not.toHaveBeenCalled();

    await userEvent.click(screen.getByRole("button", { name: "Search all models" }));

    expect(await screen.findByText("Claude Haiku 4.5")).toBeInTheDocument();
    expect(api.getProviderModelCatalog).toHaveBeenCalledTimes(1);
  });

  it("directs the user to Settings when nothing is selected", async () => {
    renderPicker({ whitelistModels: [], model: "" });

    await userEvent.click(screen.getByLabelText("Model"));

    expect(await screen.findByText(/No models chosen for Anthropic/)).toBeInTheDocument();
  });

  it("loads the catalog immediately for an uncurated provider", async () => {
    api.getProviderModelCatalog.mockResolvedValue({
      provider: "anthropic",
      models: FULL_CATALOG,
      source: "live",
      fetchedAt: Date.now(),
      stale: false,
    });

    renderPicker({ whitelistModels: null, model: "claude-opus-5" });
    await userEvent.click(screen.getByLabelText("Model"));

    expect(await screen.findByText("Claude Haiku 4.5")).toBeInTheDocument();
    await waitFor(() => {
      expect(api.getProviderModelCatalog).toHaveBeenCalledTimes(1);
    });
  });
});

describe("ModelPicker provider list", () => {
  it("hides a provider curated down to zero models", async () => {
    // Three providers, so two survive and the provider step still renders. With
    // only one left the picker skips that step entirely (asserted below).
    renderMultiProviderPicker(
      [
        { value: "anthropic", label: "Anthropic", whitelistModels: CURATED },
        { value: "openrouter", label: "OpenRouter", whitelistModels: null },
        { value: "openai", label: "OpenAI", whitelistModels: [] },
      ],
      "anthropic",
    );

    await userEvent.click(screen.getByLabelText("Model"));

    expect(await screen.findByText("Anthropic")).toBeInTheDocument();
    expect(screen.getByText("OpenRouter")).toBeInTheDocument();
    expect(screen.queryByText("OpenAI")).not.toBeInTheDocument();
  });

  it("keeps a zero-model provider listed while it is the one in use", async () => {
    // The trigger names this provider; dropping it would leave the label
    // pointing at something absent from the list it opens.
    renderMultiProviderPicker(
      [
        { value: "anthropic", label: "Anthropic", whitelistModels: CURATED },
        { value: "openrouter", label: "OpenRouter", whitelistModels: null },
        { value: "openai", label: "OpenAI", whitelistModels: [] },
      ],
      "openai",
    );

    await userEvent.click(screen.getByLabelText("Model"));

    expect(await screen.findByText("OpenAI")).toBeInTheDocument();
    expect(screen.getByText("Anthropic")).toBeInTheDocument();
  });

  it("keeps an uncurated provider listed", async () => {
    renderMultiProviderPicker(
      [
        { value: "anthropic", label: "Anthropic", whitelistModels: CURATED },
        { value: "openai", label: "OpenAI", whitelistModels: null },
      ],
      "anthropic",
    );

    await userEvent.click(screen.getByLabelText("Model"));

    expect(await screen.findByText("OpenAI")).toBeInTheDocument();
  });

  it("skips the provider step when hiding leaves exactly one provider", async () => {
    // With one provider left the two-step flow is friction; the picker already
    // goes straight to models in that case.
    renderMultiProviderPicker(
      [
        { value: "anthropic", label: "Anthropic", whitelistModels: CURATED },
        { value: "openai", label: "OpenAI", whitelistModels: [] },
      ],
      "anthropic",
    );

    await userEvent.click(screen.getByLabelText("Model"));

    expect(await screen.findByText("Claude Opus 5")).toBeInTheDocument();
  });
});
