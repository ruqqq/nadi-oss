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

if (failed) {
  console.error("\nAdd the missing entry to whichever file lacks it. Values may differ; the");
  console.error("SET of bindings and var keys may not.");
  process.exit(1);
}

console.log("wrangler config parity: OK");
