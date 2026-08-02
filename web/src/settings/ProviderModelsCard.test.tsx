// @vitest-environment jsdom

import "@testing-library/jest-dom/vitest";
import { cleanup, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { useState } from "react";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import type { ProviderModelSearchResult, ProviderSettingsView } from "../settings-api";

const api = vi.hoisted(() => ({
  getProviderModelCatalog: vi.fn(),
  saveProviderModelWhitelist: vi.fn(),
}));

vi.mock("../settings-api", async () => {
  const actual = await vi.importActual<typeof import("../settings-api")>("../settings-api");
  return { ...actual, ...api };
});

const toasts = vi.hoisted(() => ({ error: vi.fn(), success: vi.fn() }));
vi.mock("sonner", () => ({ toast: toasts }));

import { ProviderModelsCard } from "./ProviderModelsCard";

const CATALOG: ProviderModelSearchResult[] = [
  {
    id: "claude-opus-5",
    name: "Claude Opus 5",
    inputModalities: ["text"],
    reasoning: true,
    source: "live",
  },
  {
    id: "claude-sonnet-5",
    name: "Claude Sonnet 5",
    inputModalities: ["text"],
    reasoning: true,
    source: "live",
  },
  { id: "claude-haiku-4-5", name: "Claude Haiku 4.5", inputModalities: ["text"], source: "live" },
];

function baseProvider(whitelistModels: ProviderModelSearchResult[] | null): ProviderSettingsView {
  return {
    provider: "anthropic",
    displayName: "Anthropic",
    defaultSecretName: "provider:anthropic",
    configuredSecretName: "provider:anthropic",
    secretPresent: true,
    secretUpdatedAt: null,
    previewAvailable: true,
    endpointConfig: { baseUrl: "", proxyUrl: "", auth: "bearer", body: {} },
    usable: true,
    whitelistModels,
  };
}

/** Mirrors the real parent: the card is controlled and never writes. */
function Harness({ initial }: { initial: ProviderSettingsView }) {
  const [draft, setDraft] = useState<ProviderModelSearchResult[] | null | undefined>(undefined);
  return (
    <>
      <ProviderModelsCard provider={initial} draft={draft} onDraftChange={setDraft} />
      <output data-testid="draft">
        {draft === undefined ? "untouched" : JSON.stringify(draft)}
      </output>
    </>
  );
}

const draftValue = () => screen.getByTestId("draft").textContent ?? "";
const modelCheckboxes = () =>
  screen.getAllByRole("checkbox").filter((el) => el.id.startsWith("model-"));

beforeAll(() => {
  Element.prototype.scrollIntoView = vi.fn() as never;
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

function seedCatalog(models = CATALOG) {
  api.getProviderModelCatalog.mockResolvedValue({
    provider: "anthropic",
    models,
    source: "live",
    fetchedAt: Date.now(),
    stale: false,
  });
}

describe("ProviderModelsCard save behaviour", () => {
  it("does NOT write when a checkbox is toggled", async () => {
    // The whole point of the change: the pane's Save is the commit point, and a
    // card that writes on its own makes that button look broken.
    seedCatalog();
    render(<Harness initial={baseProvider(null)} />);
    await screen.findByText("Claude Opus 5");

    await userEvent.click(modelCheckboxes()[0] as HTMLElement);

    expect(api.saveProviderModelWhitelist).not.toHaveBeenCalled();
    expect(draftValue()).not.toBe("untouched");
  });

  it("unticking one model on an uncurated provider keeps the rest", async () => {
    // Every row renders ticked when uncurated, so unticking is the only first
    // action available — and it used to start from an empty list, emptying the
    // picker instead of removing one model.
    seedCatalog();
    render(<Harness initial={baseProvider(null)} />);
    await screen.findByText("Claude Opus 5");

    await userEvent.click(modelCheckboxes()[0] as HTMLElement);

    const draft = JSON.parse(draftValue()) as ProviderModelSearchResult[];
    expect(draft.map((m) => m.id).sort()).toEqual(["claude-haiku-4-5", "claude-sonnet-5"]);
  });

  it("shows the draft, not the saved list, once touched", async () => {
    seedCatalog();
    render(<Harness initial={baseProvider(null)} />);
    await screen.findByText("Claude Opus 5");
    expect(modelCheckboxes().every((el) => el.getAttribute("data-state") === "checked")).toBe(true);

    await userEvent.click(screen.getByRole("button", { name: "Select none" }));

    expect(draftValue()).toBe("[]");
    await waitFor(() => {
      expect(modelCheckboxes().some((el) => el.getAttribute("data-state") === "checked")).toBe(
        false,
      );
    });
  });

  it("keeps `null` and `[]` distinct in the draft", async () => {
    // Uncurated (offer everything) vs curated to nothing — collapsing them
    // silently re-exposes every model.
    seedCatalog();
    render(<Harness initial={baseProvider([])} />);
    await screen.findByText("Claude Opus 5");

    await userEvent.click(screen.getByRole("button", { name: "Show all" }));
    expect(draftValue()).toBe("null");
  });
});

describe("ProviderModelsCard add-model dialog", () => {
  it("registers a model through the dialog and folds it into the draft", async () => {
    seedCatalog();
    render(<Harness initial={baseProvider(null)} />);
    await screen.findByText("Claude Opus 5");

    await userEvent.click(screen.getAllByRole("button", { name: /Add model/ })[0] as HTMLElement);
    await userEvent.type(screen.getByLabelText("Model ID"), "custom-thinker");
    await userEvent.click(screen.getByLabelText("Supports thinking"));
    await userEvent.click(screen.getByRole("button", { name: "Add" }));

    await waitFor(() => {
      const draft = JSON.parse(draftValue()) as ProviderModelSearchResult[];
      expect(draft).toEqual(
        expect.arrayContaining([expect.objectContaining({ id: "custom-thinker", reasoning: true })]),
      );
    });
    // Still not written — it joins the pending list like any other edit.
    expect(api.saveProviderModelWhitelist).not.toHaveBeenCalled();
  });

  it("refuses a duplicate id rather than silently replacing the record", async () => {
    seedCatalog();
    render(<Harness initial={baseProvider(null)} />);
    await screen.findByText("Claude Opus 5");

    await userEvent.click(screen.getAllByRole("button", { name: /Add model/ })[0] as HTMLElement);
    await userEvent.type(screen.getByLabelText("Model ID"), "claude-opus-5");

    expect(screen.getByRole("alert")).toHaveTextContent("already in the list");
    expect(screen.getByRole("button", { name: "Add" })).toBeDisabled();
  });

  it("makes adding the primary action when the provider publishes no list", async () => {
    // openai-compatible: without this there is nothing to tick and the provider
    // cannot be configured at all.
    seedCatalog([]);
    render(<Harness initial={baseProvider(null)} />);
    await screen.findByText(/doesn’t publish a model list/);

    // Header button plus the empty-state call to action.
    expect(screen.getAllByRole("button", { name: /Add model/ }).length).toBeGreaterThan(1);
  });

  it("clears the form between openings", async () => {
    // A stale id on reopen reads as "my last add failed".
    seedCatalog();
    render(<Harness initial={baseProvider(null)} />);
    await screen.findByText("Claude Opus 5");

    await userEvent.click(screen.getAllByRole("button", { name: /Add model/ })[0] as HTMLElement);
    await userEvent.type(screen.getByLabelText("Model ID"), "abandoned");
    await userEvent.click(screen.getByRole("button", { name: "Cancel" }));

    await userEvent.click(screen.getAllByRole("button", { name: /Add model/ })[0] as HTMLElement);
    expect(screen.getByLabelText("Model ID")).toHaveValue("");
  });
});

describe("ProviderModelsCard rows", () => {
  it("marks hand-registered models as Custom", async () => {
    seedCatalog();
    render(
      <Harness
        initial={baseProvider([
          { id: "hand-added", name: "Hand Added", inputModalities: ["text"], source: "static" },
        ])}
      />,
    );
    await screen.findByText("Hand Added");

    // Exactly one row is not from the catalogue.
    expect(screen.getAllByText("Custom")).toHaveLength(1);
  });

  it("offers a thinking declaration only where capability is unknown", async () => {
    seedCatalog();
    render(<Harness initial={baseProvider(null)} />);
    await screen.findByText("Claude Haiku 4.5");

    const buttons = screen.getAllByRole("button", { name: "Thinking?" });
    expect(buttons).toHaveLength(1);

    await userEvent.click(buttons[0] as HTMLElement);
    const draft = JSON.parse(draftValue()) as ProviderModelSearchResult[];
    expect(draft).toEqual(
      expect.arrayContaining([expect.objectContaining({ id: "claude-haiku-4-5", reasoning: true })]),
    );
  });
});
