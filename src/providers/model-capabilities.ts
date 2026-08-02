/**
 * Cached access to models.dev's reasoning metadata.
 *
 * Global, not per-workspace: it describes models, not configuration. Cached in
 * D1 with stale-while-revalidate so a turn never waits on an external service,
 * and a models.dev outage degrades to the last good copy rather than to "no
 * model can reason".
 */
import { eq } from "drizzle-orm";
import { registryDb } from "../db/client";
import { modelCapabilityCatalog } from "../db/schema";
import type { Env } from "../env";
import { log } from "../log";
import {
  fetchModelsDevCatalog,
  findModelProfile,
  type ModelReasoningProfile,
  type ModelsDevCatalog,
} from "./models-dev";

const ROW_ID = "models-dev";

/**
 * How long to stop retrying after a failed fetch, per isolate.
 *
 * Without this, an empty cache means EVERY turn attempts a live fetch: once per
 * turn during a models.dev outage in production, and once per turn against the
 * real service from CI, where the cache starts empty in every test. The failure
 * is already swallowed, so the only symptom is latency and an external
 * dependency in the hot path.
 */
const FETCH_COOLDOWN_MS = 60_000;
let cooldownUntil = 0;

/** Test seam: integration tests reset module state between cases. */
export function resetModelCapabilityCooldown(): void {
  cooldownUntil = 0;
}

/** Model metadata changes on the order of weeks, so a day is plenty. */
export const MODEL_CAPABILITY_TTL_MS = 24 * 60 * 60 * 1000;

/** Pure so the refresh policy is testable without a database or a network. */
export function decideCapabilityAction(input: {
  row: { fetchedAt: number } | null;
  now: number;
}): "serve-fresh" | "serve-stale-and-revalidate" | "fetch" {
  if (!input.row) return "fetch";
  if (input.now - input.row.fetchedAt < MODEL_CAPABILITY_TTL_MS) return "serve-fresh";
  return "serve-stale-and-revalidate";
}

function parseRow(payloadJson: string): ModelsDevCatalog | null {
  try {
    const parsed = JSON.parse(payloadJson) as unknown;
    return typeof parsed === "object" && parsed !== null ? (parsed as ModelsDevCatalog) : null;
  } catch {
    return null;
  }
}

async function readRow(env: Env): Promise<{ catalog: ModelsDevCatalog; fetchedAt: number } | null> {
  const row = await registryDb(env)
    .select()
    .from(modelCapabilityCatalog)
    .where(eq(modelCapabilityCatalog.id, ROW_ID))
    .get();
  if (!row) return null;
  const catalog = parseRow(row.payloadJson);
  return catalog ? { catalog, fetchedAt: row.fetchedAt } : null;
}

async function writeRow(env: Env, catalog: ModelsDevCatalog, now: number): Promise<void> {
  await registryDb(env)
    .insert(modelCapabilityCatalog)
    .values({ id: ROW_ID, payloadJson: JSON.stringify(catalog), fetchedAt: now })
    .onConflictDoUpdate({
      target: modelCapabilityCatalog.id,
      set: { payloadJson: JSON.stringify(catalog), fetchedAt: now },
    });
}

/** Both ExecutionContext and DurableObjectState have waitUntil; neither is
 *  assignable to the other, so accept the capability rather than the type. */
export interface WaitUntilHost {
  waitUntil(promise: Promise<unknown>): void;
}

export async function getModelCapabilityCatalog(
  env: Env,
  opts: { fetchImpl?: typeof fetch; ctx?: WaitUntilHost | null; now?: number } = {},
): Promise<ModelsDevCatalog | null> {
  const now = opts.now ?? Date.now();
  const fetchImpl = opts.fetchImpl ?? fetch;
  const stored = await readRow(env);
  const action = decideCapabilityAction({ row: stored, now });

  if (action === "serve-fresh" && stored) return stored.catalog;

  if (action === "serve-stale-and-revalidate" && stored) {
    const refresh = fetchModelsDevCatalog(fetchImpl)
      .then(async (next) => {
        if (next && Object.keys(next).length > 0) await writeRow(env, next, now);
      })
      .catch((error: unknown) => {
        log.warn("models_dev.revalidate_failed", { error: String(error) });
      });
    if (opts.ctx) opts.ctx.waitUntil(refresh);
    return stored.catalog;
  }

  if (now < cooldownUntil) return stored?.catalog ?? null;
  const fetched = await fetchModelsDevCatalog(fetchImpl);
  // An empty result is a failure, not an answer: writing it would cache "no
  // model reasons" for a day.
  if (!fetched || Object.keys(fetched).length === 0) {
    cooldownUntil = now + FETCH_COOLDOWN_MS;
    return stored?.catalog ?? null;
  }
  cooldownUntil = 0;
  await writeRow(env, fetched, now);
  return fetched;
}

/** `null` when the catalog is unavailable or the model is unknown to it. */
export async function resolveModelReasoningProfile(
  env: Env,
  provider: string,
  model: string,
  opts: { fetchImpl?: typeof fetch; ctx?: WaitUntilHost | null } = {},
): Promise<ModelReasoningProfile | null> {
  const catalog = await getModelCapabilityCatalog(env, opts);
  if (!catalog) return null;
  return findModelProfile(catalog, provider, model);
}
