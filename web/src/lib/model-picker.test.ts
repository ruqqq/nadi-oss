import { describe, expect, it } from "vitest";
import { addCustomModel, mergeCatalogWithCurated } from "./model-picker";
import type { ProviderModelSearchResult } from "../settings-api";

function model(id: string, name?: string): ProviderModelSearchResult {
  return { id, ...(name ? { name } : {}), inputModalities: ["text"], source: "static" };
}

const CATALOG = [model("a"), model("b")];

describe("mergeCatalogWithCurated", () => {
  it("returns the catalog when nothing is curated", () => {
    expect(mergeCatalogWithCurated(CATALOG, null)).toEqual(CATALOG);
  });

  it("appends a curated model the catalog has never heard of", () => {
    // The whole point for an endpoint with no /models route: a hand-added model
    // must render, or it vanishes the moment it is saved.
    const merged = mergeCatalogWithCurated(CATALOG, [model("a"), model("custom")]);
    expect(merged.map((entry) => entry.id)).toEqual(["a", "b", "custom"]);
  });

  it("does not duplicate a curated model that is already in the catalog", () => {
    const merged = mergeCatalogWithCurated(CATALOG, [model("a")]);
    expect(merged.map((entry) => entry.id)).toEqual(["a", "b"]);
  });

  it("surfaces hand-added models when the catalog is empty", () => {
    const merged = mergeCatalogWithCurated([], [model("only-one")]);
    expect(merged.map((entry) => entry.id)).toEqual(["only-one"]);
  });
});

describe("addCustomModel", () => {
  it("seeds from the whole catalog when the provider is uncurated", () => {
    // Registering one id must not silently drop every model the user could
    // already pick.
    const next = addCustomModel(CATALOG, null, model("custom"));
    expect(next.map((entry) => entry.id)).toEqual(["a", "b", "custom"]);
  });

  it("appends to an existing curated list rather than replacing it", () => {
    const next = addCustomModel(CATALOG, [model("b")], model("custom"));
    expect(next.map((entry) => entry.id)).toEqual(["b", "custom"]);
  });

  it("replaces an existing entry instead of duplicating the id", () => {
    const next = addCustomModel(CATALOG, [model("custom", "Old")], model("custom", "New"));
    expect(next).toHaveLength(1);
    expect(next[0]?.name).toBe("New");
  });

  it("produces just the added model when the catalog is empty and uncurated", () => {
    const next = addCustomModel([], null, model("solo"));
    expect(next.map((entry) => entry.id)).toEqual(["solo"]);
  });
});
