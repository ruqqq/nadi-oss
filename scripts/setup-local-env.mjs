#!/usr/bin/env node
// Idempotently create the local dev env files so `wrangler dev` and the SPA can
// run with no Cloudflare credentials. Safe to run repeatedly: it only writes a
// file that is missing and never overwrites your edits (so generated secrets and
// any local tweaks are stable across runs). Invoked by the VM startup update
// script; also fine to run by hand: `node scripts/setup-local-env.mjs`.
import { randomBytes } from "node:crypto";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), "..");
const rand = () => randomBytes(32).toString("base64");

/** Set (or replace) a `KEY=value` line in a dotenv-style string. */
function setVar(text, key, value) {
  const line = `${key}=${value}`;
  const re = new RegExp(`^${key}=.*$`, "m");
  return re.test(text) ? text.replace(re, line) : `${text.replace(/\n?$/, "\n")}${line}\n`;
}

function ensureDevVars() {
  const target = join(repoRoot, ".dev.vars");
  if (existsSync(target)) return `.dev.vars already exists — left unchanged`;
  const example = join(repoRoot, ".dev.vars.example");
  if (!existsSync(example)) return `.dev.vars.example missing — skipped .dev.vars`;
  let text = readFileSync(example, "utf8");
  // Local defaults: the offline mock model + mock sandbox need no external keys.
  text = setVar(text, "DEFAULT_MODEL_PROVIDER", "mock");
  text = setVar(text, "DEFAULT_MODEL", "mock");
  text = setVar(text, "DEFAULT_SANDBOX_PROVIDER", "mock");
  text = setVar(text, "APP_BASE_URL", "http://localhost:8787");
  // Better Auth + HITL + KV encryption need real random values to function.
  text = setVar(text, "BETTER_AUTH_SECRET", rand());
  text = setVar(text, "TOOL_APPROVAL_SECRET", rand());
  text = setVar(text, "SECRETS_STORE_KEK_RAW_B64", rand());
  writeFileSync(target, text);
  return `wrote .dev.vars (mock model + mock sandbox, generated secrets)`;
}

function ensureWebEnv() {
  const target = join(repoRoot, "web", ".env.local");
  if (existsSync(target)) return `web/.env.local already exists — left unchanged`;
  const example = join(repoRoot, "web", ".env.local.example");
  const text = existsSync(example)
    ? readFileSync(example, "utf8")
    : "VITE_AGENT_HOST=http://localhost:8787\n";
  writeFileSync(target, text);
  return `wrote web/.env.local`;
}

console.log(`[setup-local-env] ${ensureDevVars()}`);
console.log(`[setup-local-env] ${ensureWebEnv()}`);
