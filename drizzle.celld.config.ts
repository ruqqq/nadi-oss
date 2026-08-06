// Second drizzle-kit config for the celld edition: same schema, same
// migrations/ directory as drizzle.config.ts. It exists so schema changes can
// be generated (and checked with `drizzle-kit check`) without switching
// configs, and so the durable-sqlite migration bundle consumed by the celld
// RegistryDatabase is always generated from the same source of truth.
//
// `pnpm db:generate` (chained with scripts/bundle-celld-migrations.mjs) is what
// keeps the bundle fresh — there is no separate celld generate step.
import { defineConfig } from "drizzle-kit";

export default defineConfig({
  schema: "./src/db/schema.ts",
  out: "./migrations",
  dialect: "sqlite",
  driver: "durable-sqlite",
});
