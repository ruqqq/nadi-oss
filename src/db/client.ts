import { drizzle } from "drizzle-orm/d1";
import type { Env } from "../env";
import * as schema from "./schema";
import { RegistryD1 } from "./registry-d1";

/**
 * The D1 binding every registry consumer gets. Cloudflare keeps the real D1
 * binding, unchanged; celld has no D1, so this hands out the RegistryD1 facade
 * over the RegistryDatabase Durable Object. Gate is binding presence, not a
 * platform flag: whatever the platform declares is what gets used, and a
 * misconfigured platform fails loudly instead of silently serving a facade.
 */
export function registryBinding(env: Env): D1Database {
  if (env.REGISTRY_DB) return env.REGISTRY_DB;
  if (!env.REGISTRY_DO) {
    throw new Error(
      "registryBinding: neither REGISTRY_DB nor REGISTRY_DO is bound — the registry has no backing store",
    );
  }
  return new RegistryD1(env.REGISTRY_DO);
}

export function registryDb(env: Env) {
  return drizzle(registryBinding(env), { schema });
}

/**
 * Whether a registry is reachable at all — real D1 on Cloudflare, the
 * `RegistryDatabase` Durable Object on celld.
 *
 * Use this instead of testing a binding directly. `env.REGISTRY_DB` answers
 * "is this Cloudflare?", which stopped meaning "is the registry available?"
 * the moment the facades landed — and a binding used as a predicate silently
 * disables whatever it guards on every other platform.
 */
export function hasRegistry(env: Partial<Env>): boolean {
  return Boolean(env.REGISTRY_DB || env.REGISTRY_DO);
}
