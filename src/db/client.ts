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
