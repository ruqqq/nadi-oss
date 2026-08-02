import type { ProviderModelSearchResult, ProviderSettingsView } from "@/settings-api";

/**
 * The rules for turning a provider's curated list into what the picker shows.
 * Pure and shared, because getting the `null` vs `[]` distinction wrong in any
 * one caller silently re-exposes every model — or hides them all.
 */

/** Curated means the workspace has chosen a list, even an empty one. */
export function isCuratedProvider(provider: ProviderSettingsView | undefined): boolean {
  return Array.isArray(provider?.whitelistModels);
}

export function curatedModels(
  provider: ProviderSettingsView | undefined,
): ProviderModelSearchResult[] {
  return provider?.whitelistModels ?? [];
}

/**
 * Match a model against what the user typed. Mirrors the server's
 * `filterProviderModels` so a search means the same thing whether it runs
 * against the cached catalog here or the search route there.
 */
export function matchesModelQuery(model: ProviderModelSearchResult, query: string): boolean {
  const normalized = query.trim().toLowerCase();
  if (!normalized) return true;
  return (
    model.id.toLowerCase().includes(normalized) ||
    (model.name?.toLowerCase().includes(normalized) ?? false) ||
    (model.description?.toLowerCase().includes(normalized) ?? false)
  );
}

export function filterModels(
  models: ProviderModelSearchResult[],
  query: string,
): ProviderModelSearchResult[] {
  return models.filter((model) => matchesModelQuery(model, query));
}

/**
 * The model a thread is pinned to, when it is not in the curated list.
 *
 * Un-whitelisting a model never stops a thread using it, so the picker has to
 * be able to show it — otherwise the trigger displays a model that appears
 * nowhere in the list it opens, which reads as a bug.
 */
export function pinnedModelOutsideList(
  models: ProviderModelSearchResult[],
  currentModelId: string,
): ProviderModelSearchResult | null {
  const id = currentModelId.trim();
  if (!id) return null;
  if (models.some((model) => model.id === id)) return null;
  return { id, inputModalities: ["text"], source: "static" };
}

/**
 * A provider curated down to nothing has nothing to offer, so it is withheld
 * from the picker rather than listed as an empty dead end.
 *
 * `null`/absent (uncurated) and a non-empty list both stay. Only an explicit
 * empty array hides — which is exactly the state a user reaches by unticking
 * everything.
 */
export function hasOfferableModels(provider: { whitelistModels?: unknown }): boolean {
  const models = provider.whitelistModels;
  return !Array.isArray(models) || models.length > 0;
}

/**
 * The providers worth showing, keeping the one in use even when it has been
 * curated to nothing.
 *
 * Dropping the current provider would leave the trigger naming a provider that
 * appears nowhere in the list it opens — the same trap the "Current" model row
 * exists to avoid.
 */
export function visibleProviders<T extends { value: string; whitelistModels?: unknown }>(
  providers: T[],
  currentProvider: string | null,
): T[] {
  return providers.filter(
    (entry) => hasOfferableModels(entry) || entry.value === currentProvider,
  );
}

/**
 * Catalog rows plus any curated model the catalog doesn't know about.
 *
 * An OpenAI-compatible endpoint that serves no `/models` route has an empty
 * catalog, so every model it can run is hand-entered. Rendering the catalog
 * alone would hide exactly those.
 */
export function mergeCatalogWithCurated(
  catalog: ProviderModelSearchResult[],
  curated: ProviderModelSearchResult[] | null,
): ProviderModelSearchResult[] {
  if (!curated || curated.length === 0) return catalog;
  const known = new Set(catalog.map((model) => model.id));
  return [...catalog, ...curated.filter((model) => !known.has(model.id))];
}

/**
 * The list an "add this model by id" action should produce.
 *
 * Adding to an *uncurated* provider seeds from the whole catalog, so nothing
 * the user could already pick silently vanishes because they registered one
 * extra id. Re-adding an existing id replaces it rather than duplicating.
 */
export function addCustomModel(
  catalog: ProviderModelSearchResult[],
  curated: ProviderModelSearchResult[] | null,
  model: ProviderModelSearchResult,
): ProviderModelSearchResult[] {
  const base = curated ?? catalog;
  return [...base.filter((entry) => entry.id !== model.id), model];
}

/** "All 41 models" / "2 of 41 selected" — the one-line state of a provider's list. */
export function describeSelection(selectedCount: number | null, catalogCount: number): string {
  if (selectedCount === null) return `All ${catalogCount} models`;
  return `${selectedCount} of ${catalogCount} selected`;
}
