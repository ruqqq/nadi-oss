import { drizzle } from "drizzle-orm/d1";
import type { Env } from "../env";
import * as schema from "./schema";

/**
 * The D1 binding every registry consumer gets.
 *
 * Both platforms now bind real D1: Cloudflare's managed D1, and celld's own
 * since v0.3.0 (a celld D1 database is a cell, so it gets the same fencing,
 * replication and durable write acknowledgement as any other cell). Before
 * that, celld had no D1 and this returned a `RegistryD1` facade over a
 * `RegistryDatabase` Durable Object; that facade, the DO, its hand-rolled
 * batch runner and its boot-time migration bundle are all gone.
 */
export function registryBinding(env: Env): D1Database {
  if (!env.REGISTRY_DB) {
    throw new Error(
      "registryBinding: REGISTRY_DB is not bound — the registry has no backing store",
    );
  }
  return env.REGISTRY_DB;
}

export function registryDb(env: Env) {
  return drizzle(registryBinding(env), { schema });
}

/**
 * Whether a registry is reachable at all.
 *
 * Now a single binding on every platform, so this is a thin wrapper — but it
 * stays, because the call sites that need "is the registry available?" should
 * not be spelled as a binding test. That is exactly what made `env.REGISTRY_DB`
 * mean "is this Cloudflare?" for as long as celld was on the DO facade, and a
 * binding used as a platform predicate silently disables whatever it guards.
 */
export function hasRegistry(env: Partial<Env>): boolean {
  return Boolean(env.REGISTRY_DB);
}
