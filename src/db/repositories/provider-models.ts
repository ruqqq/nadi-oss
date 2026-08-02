import { and, eq } from "drizzle-orm";
import { registryDb } from "../client";
import { providerModelCatalogs, providerModelWhitelists } from "../schema";
import type { Env } from "../../env";
import type { ProviderConfigProvider } from "./provider-configs";
import type { ProviderModelSearchResult } from "../../providers/model-search";

/**
 * Storage for the two halves of model curation: the workspace's chosen models
 * (`provider_model_whitelists`, user data) and the cached provider catalog
 * (`provider_model_catalogs`, disposable).
 *
 * Both are keyed by workspace + provider. They are separate tables on purpose —
 * clearing a cache must never touch a user's curation, and the catalog is
 * deleted whenever a credential or endpoint changes.
 */

export interface ProviderModelCatalogRow {
  models: ProviderModelSearchResult[];
  source: "live" | "static";
  fetchedAt: number;
}

/** Runaway guard, not a product limit: no real catalog approaches this. */
const MAX_STORED_CATALOG_MODELS = 1000;

/**
 * The workspace's curated models, or `null` when the provider is uncurated.
 *
 * `null` and `[]` are different answers and callers must keep them apart: the
 * first means "show the whole catalog", the second means "the user chose
 * nothing". Collapsing them would silently re-expose every model.
 */
export async function getProviderModelWhitelist(
  env: Env,
  workspaceId: string,
  provider: ProviderConfigProvider,
): Promise<ProviderModelSearchResult[] | null> {
  const row = await registryDb(env)
    .select()
    .from(providerModelWhitelists)
    .where(
      and(
        eq(providerModelWhitelists.workspaceId, workspaceId),
        eq(providerModelWhitelists.provider, provider),
      ),
    )
    .get();
  if (!row) return null;
  return parseModels(row.modelsJson);
}

/** Every curated provider in the workspace, for the settings/bootstrap payload. */
export async function listProviderModelWhitelists(
  env: Env,
  workspaceId: string,
): Promise<Map<string, ProviderModelSearchResult[]>> {
  const rows = await registryDb(env)
    .select()
    .from(providerModelWhitelists)
    .where(eq(providerModelWhitelists.workspaceId, workspaceId))
    .all();
  return new Map(rows.map((row) => [row.provider, parseModels(row.modelsJson)]));
}

/** `null` clears curation (back to "show everything"); `[]` is a valid choice. */
export async function setProviderModelWhitelist(
  env: Env,
  workspaceId: string,
  provider: ProviderConfigProvider,
  models: ProviderModelSearchResult[] | null,
  now: number,
): Promise<void> {
  if (models === null) {
    await registryDb(env)
      .delete(providerModelWhitelists)
      .where(
        and(
          eq(providerModelWhitelists.workspaceId, workspaceId),
          eq(providerModelWhitelists.provider, provider),
        ),
      )
      .run();
    return;
  }

  await registryDb(env)
    .insert(providerModelWhitelists)
    .values({
      workspaceId,
      provider,
      modelsJson: JSON.stringify(models),
      updatedAt: now,
    })
    .onConflictDoUpdate({
      target: [providerModelWhitelists.workspaceId, providerModelWhitelists.provider],
      set: { modelsJson: JSON.stringify(models), updatedAt: now },
    })
    .run();
}

export async function getProviderModelCatalogRow(
  env: Env,
  workspaceId: string,
  provider: ProviderConfigProvider,
): Promise<ProviderModelCatalogRow | null> {
  const row = await registryDb(env)
    .select()
    .from(providerModelCatalogs)
    .where(
      and(
        eq(providerModelCatalogs.workspaceId, workspaceId),
        eq(providerModelCatalogs.provider, provider),
      ),
    )
    .get();
  if (!row) return null;
  return { models: parseModels(row.modelsJson), source: row.source, fetchedAt: row.fetchedAt };
}

export async function putProviderModelCatalogRow(
  env: Env,
  workspaceId: string,
  provider: ProviderConfigProvider,
  input: ProviderModelCatalogRow,
): Promise<void> {
  const models = input.models.slice(0, MAX_STORED_CATALOG_MODELS);
  const modelsJson = JSON.stringify(models);
  await registryDb(env)
    .insert(providerModelCatalogs)
    .values({
      workspaceId,
      provider,
      modelsJson,
      source: input.source,
      fetchedAt: input.fetchedAt,
    })
    .onConflictDoUpdate({
      target: [providerModelCatalogs.workspaceId, providerModelCatalogs.provider],
      set: { modelsJson, source: input.source, fetchedAt: input.fetchedAt },
    })
    .run();
}

/** Called whenever a credential or endpoint changes — the catalog those
 *  produced is no longer the catalog this provider would return. */
export async function deleteProviderModelCatalog(
  env: Env,
  workspaceId: string,
  provider: ProviderConfigProvider,
): Promise<void> {
  await registryDb(env)
    .delete(providerModelCatalogs)
    .where(
      and(
        eq(providerModelCatalogs.workspaceId, workspaceId),
        eq(providerModelCatalogs.provider, provider),
      ),
    )
    .run();
}

/** Stored JSON → models, degrading to an empty list rather than throwing: a
 *  corrupt row must not take out the settings payload. */
function parseModels(value: string): ProviderModelSearchResult[] {
  try {
    const parsed: unknown = JSON.parse(value);
    if (!Array.isArray(parsed)) return [];
    return parsed.filter(isModelRecord);
  } catch {
    return [];
  }
}

function isModelRecord(value: unknown): value is ProviderModelSearchResult {
  return (
    typeof value === "object" &&
    value !== null &&
    typeof (value as { id?: unknown }).id === "string" &&
    Array.isArray((value as { inputModalities?: unknown }).inputModalities)
  );
}

export function isMaxStoredCatalogModelsExceeded(count: number): boolean {
  return count > MAX_STORED_CATALOG_MODELS;
}
