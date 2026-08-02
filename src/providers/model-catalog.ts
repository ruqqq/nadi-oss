import type { Env } from "../env";
import { log } from "../log";
import {
  deleteProviderModelCatalog,
  getProviderModelCatalogRow,
  isMaxStoredCatalogModelsExceeded,
  putProviderModelCatalogRow,
} from "../db/repositories/provider-models";
import type {
  ProviderConfigProvider,
  ProviderEndpointConfig,
} from "../db/repositories/provider-configs";
import { loadProviderModels, type ProviderModelSearchResult } from "./model-search";
import { getModelCapabilityCatalog } from "./model-capabilities";
import { findModelProfile } from "./models-dev";

/**
 * The cached provider catalog, with stale-while-revalidate.
 *
 * Before this, every model-picker keystroke reached the provider's live
 * `/models` endpoint. The cache is what makes the picker open without a
 * spinner; the SWR half is what keeps a stale row from ever costing the user a
 * wait — a stale answer returns immediately and the refresh happens behind the
 * response.
 */

export const CATALOG_TTL_MS = 6 * 60 * 60 * 1000;

export interface ProviderCatalog {
  provider: ProviderConfigProvider;
  models: ProviderModelSearchResult[];
  source: "live" | "static";
  fetchedAt: number;
  /** True when the models returned came from an expired row, refreshed behind
   *  this response. The client uses it only to caption "Updated N ago". */
  stale: boolean;
}

export interface GetProviderCatalogInput {
  env: Env;
  ctx: ExecutionContext | null;
  workspaceId: string;
  provider: ProviderConfigProvider;
  secret: string | null;
  endpointConfig: ProviderEndpointConfig;
  /** Force a live refetch, ignoring a fresh row. The UI's Refresh control. */
  refresh?: boolean;
  now?: number;
}

/**
 * What to do with a cached row. Pure, so the freshness rules can be tested
 * without a database — the TTL boundary and the forced-refresh interaction are
 * where this would quietly go wrong.
 */
export function decideCatalogAction(input: {
  row: { fetchedAt: number } | null;
  now: number;
  refresh: boolean;
}): "serve-fresh" | "await-refresh" | "serve-stale-and-revalidate" | "fetch" {
  if (!input.row) return "fetch";
  // A forced refresh still keeps the row in hand as a fallback, so it awaits
  // rather than fetching blind.
  if (input.refresh) return "await-refresh";
  if (input.now - input.row.fetchedAt < CATALOG_TTL_MS) return "serve-fresh";
  return "serve-stale-and-revalidate";
}

export async function getProviderCatalog(input: GetProviderCatalogInput): Promise<ProviderCatalog> {
  const now = input.now ?? Date.now();
  // Read the row even on a forced refresh: if the live fetch then fails, the
  // old list is a far better answer than an empty picker.
  const row = await getProviderModelCatalogRow(input.env, input.workspaceId, input.provider);
  const action = decideCatalogAction({ row, now, refresh: input.refresh ?? false });

  if (row && action === "serve-fresh") {
    return { provider: input.provider, ...row, stale: false };
  }

  if (row && action === "await-refresh") {
    // The user asked for fresh data and is watching.
    return (await refreshCatalog(input, now)) ?? { provider: input.provider, ...row, stale: true };
  }

  if (row) {
    // Stale: answer from the old row now, refresh behind the response. With no
    // ExecutionContext to defer onto, awaiting is better than dropping it — a
    // background promise the runtime never runs leaves the row stale forever.
    const refresh = refreshCatalog(input, now);
    if (input.ctx) {
      input.ctx.waitUntil(refresh);
      return { provider: input.provider, ...row, stale: true };
    }
    return (await refresh) ?? { provider: input.provider, ...row, stale: true };
  }

  const fetched = await refreshCatalog(input, now);
  if (fetched) return fetched;

  // Nothing cached and the load failed outright. An empty catalog is the honest
  // answer; the picker still free-types a model id.
  return {
    provider: input.provider,
    models: [],
    source: "static",
    fetchedAt: now,
    stale: false,
  };
}

async function enrichWithReasoningCapability(
  env: GetProviderCatalogInput["env"],
  provider: string,
  models: ProviderModelSearchResult[],
): Promise<ProviderModelSearchResult[]> {
  const capabilities = await getModelCapabilityCatalog(env).catch((error: unknown) => {
    log.warn("provider.capability_lookup_failed", { provider, error: String(error) });
    return null;
  });
  if (!capabilities) return models;
  return models.map((model) => {
    const profile = findModelProfile(capabilities, provider, model.id);
    if (!profile) return model;
    return {
      ...model,
      reasoning: profile.reasoning,
      ...(profile.controls.length > 0 ? { reasoningControls: profile.controls } : {}),
    };
  });
}

async function refreshCatalog(
  input: GetProviderCatalogInput,
  now: number,
): Promise<ProviderCatalog | null> {
  try {
    const { models: rawModels, source } = await loadProviderModels({
      provider: input.provider,
      fetchImpl: fetch,
      secret: input.secret,
      endpointConfig: input.endpointConfig,
    });
    // models.dev knows per-model reasoning capability for every provider we
    // support, including the ones whose own /models returns bare ids. Its answer
    // outranks the static table; a miss leaves whatever we already had, so an
    // outage degrades to the previous behaviour rather than to "nothing reasons".
    const models = await enrichWithReasoningCapability(input.env, input.provider, rawModels);
    if (isMaxStoredCatalogModelsExceeded(models.length)) {
      // Truncation that isn't logged reads as a complete list.
      log.warn("provider.catalog_truncated", {
        provider: input.provider,
        returned: models.length,
      });
    }
    await putProviderModelCatalogRow(input.env, input.workspaceId, input.provider, {
      models,
      source,
      fetchedAt: now,
    });
    return { provider: input.provider, models, source, fetchedAt: now, stale: false };
  } catch (error: unknown) {
    log.error("provider.catalog_refresh_failed", {
      provider: input.provider,
      error: error instanceof Error ? error.message : String(error),
    });
    return null;
  }
}

/** A changed key or endpoint means a different catalog. Called from the
 *  provider secret and provider config writers. */
export async function invalidateProviderCatalog(
  env: Env,
  workspaceId: string,
  provider: ProviderConfigProvider,
): Promise<void> {
  await deleteProviderModelCatalog(env, workspaceId, provider).catch((error: unknown) => {
    // A stale cache is a worse outcome than a slow one, but it is not worth
    // failing the credential save the user actually asked for.
    log.error("provider.catalog_invalidate_failed", {
      provider,
      error: error instanceof Error ? error.message : String(error),
    });
  });
}
