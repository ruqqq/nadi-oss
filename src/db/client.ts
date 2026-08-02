import { drizzle } from "drizzle-orm/d1";
import type { Env } from "../env";
import * as schema from "./schema";

export function registryDb(env: Env) {
  return drizzle(env.REGISTRY_DB, { schema });
}
