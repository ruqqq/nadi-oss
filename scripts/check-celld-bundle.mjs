#!/usr/bin/env node
// Fail if src/db/migrations/celld-bundle.ts is out of date with migrations/.
//
// celld has no D1: the registry Durable Object applies the schema from a
// bundle generated out of migrations/ at boot. `pnpm db:generate` chains the
// bundler, but that is a convention, not a guarantee — running drizzle-kit
// directly, or hand-writing a migration file (which the D1 table-rebuild
// workaround requires), leaves the bundle behind. Nothing then fails: the
// celld deploy simply boots without the newest tables, and the first query
// against one is where you find out.
//
// Regenerating and diffing is the whole check.

import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";

const BUNDLE = "src/db/migrations/celld-bundle.ts";

const before = readFileSync(BUNDLE, "utf8");
execFileSync(process.execPath, ["scripts/bundle-celld-migrations.mjs"], { stdio: "inherit" });
const after = readFileSync(BUNDLE, "utf8");

if (before !== after) {
  // Put the file back so a failing check does not also dirty the tree.
  const { writeFileSync } = await import("node:fs");
  writeFileSync(BUNDLE, before);
  console.error(`${BUNDLE} is stale — migrations/ has changed since it was generated.`);
  console.error("Regenerate it and commit the result:\n");
  console.error("    pnpm celld:db:bundle\n");
  console.error("Until then a celld deploy boots without the newest migrations, silently.");
  process.exit(1);
}

console.log("celld migration bundle: up to date");
