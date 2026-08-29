#!/usr/bin/env node
// Keep wrangler.jsonc (local dev, committed) and wrangler.prod.example.jsonc
// (the deploy template) structurally identical.
//
// Only the VALUES are meant to differ between them — identifiers are
// deployment-specific. If the two drift in the set of BINDINGS or the set of
// `vars` KEYS, someone's first deploy fails at runtime with a missing binding,
// which is a miserable way to find out. The real wrangler.prod.jsonc is
// gitignored, so this example file is the only thing CI can hold the line on.
//
// No dependency on a JSONC parser: `jsonc-parser` is only a transitive dep here,
// so importing it would break a fresh `pnpm install --frozen-lockfile`.

import { readFileSync } from "node:fs";

/** Strip // and /* *\/ comments and trailing commas, respecting string literals. */
function parseJsonc(text) {
  let out = "";
  let inString = false;
  let escaped = false;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (inString) {
      out += ch;
      if (escaped) escaped = false;
      else if (ch === "\\") escaped = true;
      else if (ch === '"') inString = false;
      continue;
    }
    if (ch === '"') {
      inString = true;
      out += ch;
      continue;
    }
    if (ch === "/" && text[i + 1] === "/") {
      while (i < text.length && text[i] !== "\n") i++;
      out += "\n";
      continue;
    }
    if (ch === "/" && text[i + 1] === "*") {
      i += 2;
      while (i < text.length && !(text[i] === "*" && text[i + 1] === "/")) i++;
      i++;
      continue;
    }
    out += ch;
  }
  // Trailing commas are legal in jsonc, not in JSON.
  return JSON.parse(out.replace(/,(\s*[}\]])/g, "$1"));
}

/** Every binding name the Worker can reach at runtime, as a sorted set. */
function bindingNames(config) {
  const names = [];
  for (const b of config.durable_objects?.bindings ?? []) names.push(`durable_object:${b.name}`);
  for (const d of config.d1_databases ?? []) names.push(`d1:${d.binding}`);
  for (const r of config.r2_buckets ?? []) names.push(`r2:${r.binding}`);
  for (const k of config.kv_namespaces ?? []) names.push(`kv:${k.binding}`);
  for (const e of config.send_email ?? []) names.push(`email:${e.name}`);
  for (const c of config.containers ?? []) names.push(`container:${c.class_name}`);
  if (config.ai?.binding) names.push(`ai:${config.ai.binding}`);
  if (config.browser?.binding) names.push(`browser:${config.browser.binding}`);
  if (config.assets?.binding) names.push(`assets:${config.assets.binding}`);
  return names.sort();
}

function diff(a, b) {
  return { onlyInA: a.filter((x) => !b.includes(x)), onlyInB: b.filter((x) => !a.includes(x)) };
}

const local = parseJsonc(readFileSync("wrangler.jsonc", "utf8"));
const example = parseJsonc(readFileSync("wrangler.prod.example.jsonc", "utf8"));

let failed = false;

const bindings = diff(bindingNames(local), bindingNames(example));
if (bindings.onlyInA.length || bindings.onlyInB.length) {
  failed = true;
  console.error("Binding mismatch between wrangler.jsonc and wrangler.prod.example.jsonc:");
  for (const n of bindings.onlyInA) console.error(`  only in wrangler.jsonc:              ${n}`);
  for (const n of bindings.onlyInB) console.error(`  only in wrangler.prod.example.jsonc: ${n}`);
}

const vars = diff(Object.keys(local.vars ?? {}).sort(), Object.keys(example.vars ?? {}).sort());
if (vars.onlyInA.length || vars.onlyInB.length) {
  failed = true;
  console.error("`vars` key mismatch between wrangler.jsonc and wrangler.prod.example.jsonc:");
  for (const n of vars.onlyInA) console.error(`  only in wrangler.jsonc:              ${n}`);
  for (const n of vars.onlyInB) console.error(`  only in wrangler.prod.example.jsonc: ${n}`);
}

// ---------------------------------------------------------------------------
// wrangler.celld.jsonc — the non-Cloudflare deploy.
//
// This one cannot be a set-equality check: some binding kinds genuinely do not
// exist on celld, so the whole point of the file is that it differs. What must
// NOT happen is a var key or a binding of a kind celld DOES support being added
// to wrangler.jsonc and quietly missed here — the celld deploy then reads
// `undefined` and a feature is off with no signal.
//
// So the rule is: celld carries everything, except what is explicitly listed
// below as Cloudflare-only. The allowlist is the point — dropping something
// has to be a decision someone wrote down, not an omission.

const CLOUDFLARE_ONLY_VARS = {
  R2_ACCOUNT_ID: "R2 attachments; celld signs S3 instead (S3_ATTACHMENTS_BUCKET_NAME)",
  R2_BUCKET_NAME: "R2 attachments; celld signs S3 instead (S3_ATTACHMENTS_BUCKET_NAME)",
  BACKUP_BUCKET_NAME: "R2 compute backups; celld uses S3_BACKUP_BUCKET_NAME",
  CLOUDFLARE_ACCOUNT_ID: "only used to presign R2 backup URLs",
  // The three above are a DECISION as of celld v0.4.0, which does implement R2
  // — see the note in CLOUDFLARE_ONLY_BINDINGS — not a missing binding.
  SANDBOX_TRANSPORT: "Cloudflare Sandbox container transport; celld has no containers",
  MAX_ACTIVE_CONTAINERS_PER_WORKSPACE: "caps Cloudflare containers; celld has none",
  WORKERS_AI_EMAILS: "Workers AI provider allowlist; celld has no AI binding",
  ATTACHMENT_EXTRACTION: "vision + toMarkdown extraction; needs the AI binding",
  VOICE_INPUT_ENABLED:
    "voiceInputEnabled() refuses on any platform without speechToText, so the var cannot turn it on here",
};

const CLOUDFLARE_ONLY_BINDINGS = {
  "durable_object:NADI_SANDBOX_SMALL": "Cloudflare container class",
  "durable_object:NADI_SANDBOX_MEDIUM": "Cloudflare container class",
  // celld v0.4.0 DOES implement R2, so this is a choice rather than a limit:
  // its buckets live inside the fleet bucket and cannot presign, and Nadi hands
  // presigned URLs to a sandbox that fetches them without the Worker in the
  // path. src/storage/s3-bucket.ts serves both buckets on celld instead.
  "r2:ATTACHMENTS_BUCKET": "deliberate — celld R2 cannot presign; celld signs S3 directly",
  "r2:BACKUP_BUCKET": "deliberate — celld R2 cannot presign; celld signs S3 directly",
};

// Binding kinds celld implements, and therefore compares. A kind absent here
// (r2, ai, browser, email, container) is not checked at all, because celld
// either cannot have it or does not want it — those are covered by
// CLOUDFLARE_ONLY_BINDINGS above where the distinction matters.
const CELLD_BINDING_KINDS = ["durable_object", "d1", "kv", "assets"];

const celld = parseJsonc(readFileSync("wrangler.celld.jsonc", "utf8"));

const celldVars = Object.keys(celld.vars ?? {});
const missingVars = Object.keys(local.vars ?? {}).filter(
  (k) => !celldVars.includes(k) && !(k in CLOUDFLARE_ONLY_VARS),
);
if (missingVars.length) {
  failed = true;
  console.error("\n`vars` keys in wrangler.jsonc but missing from wrangler.celld.jsonc:");
  for (const n of missingVars) console.error(`  ${n}`);
  console.error("\nAdd each to wrangler.celld.jsonc, or — if it genuinely cannot work on celld —");
  console.error("to CLOUDFLARE_ONLY_VARS in this script, with the reason.");
}

// Compare every binding kind celld implements. Before v0.4.0 this checked only
// Durable Objects, because D1 was the only other kind celld had; KV and assets
// were facades and Caddy. Both are real bindings now, so both are covered — a
// second KV namespace added on Cloudflare and forgotten here would otherwise
// read as `undefined` on celld with nothing to catch it.
const ofCelldKinds = (names) =>
  names.filter((n) => CELLD_BINDING_KINDS.includes(n.slice(0, n.indexOf(":"))));

const celldBindings = ofCelldKinds(bindingNames(celld));
const missingBindings = ofCelldKinds(bindingNames(local)).filter(
  (n) => !celldBindings.includes(n) && !(n in CLOUDFLARE_ONLY_BINDINGS),
);
if (missingBindings.length) {
  failed = true;
  console.error("\nBindings in wrangler.jsonc but missing from wrangler.celld.jsonc:");
  for (const n of missingBindings) console.error(`  ${n}`);
  console.error("\nAdd each to wrangler.celld.jsonc (a Durable Object also needs an entry in");
  console.error("its `migrations` list), or to CLOUDFLARE_ONLY_BINDINGS in this script, with");
  console.error("the reason.");
}

// A Durable Object class with no migration entry fails the celld deploy — loud,
// but only at deploy time, which is a slow way to learn it.
const migratedClasses = new Set(
  (celld.migrations ?? []).flatMap((m) => [
    ...(m.new_sqlite_classes ?? []),
    ...(m.new_classes ?? []),
  ]),
);
const unmigrated = (celld.durable_objects?.bindings ?? [])
  .map((b) => b.class_name)
  .filter((c) => !migratedClasses.has(c));
if (unmigrated.length) {
  failed = true;
  console.error("\nDurable Object classes in wrangler.celld.jsonc with no `migrations` entry:");
  for (const c of unmigrated) console.error(`  ${c}`);
}

if (failed) {
  console.error("\nValues may differ between configs; the SET of bindings and var keys may not.");
  process.exit(1);
}

console.log("wrangler config parity: OK (cloudflare + celld)");
