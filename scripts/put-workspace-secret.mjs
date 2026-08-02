#!/usr/bin/env node
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const IV_BYTES = 12;

const workspaceId = requireEnv("WORKSPACE_ID");
const secretName = requireEnv("SECRET_NAME");
const secretValue = readSecretValue();
const kekRawB64 = requireEnv("SECRETS_STORE_KEK_RAW_B64");
const namespaceId = requireEnv("KV_NAMESPACE_ID");
const remote = process.env.LOCAL === "1" ? [] : ["--remote"];

const dekKey = `workspaces/${workspaceId}/dek`;
const secretKey = `workspaces/${workspaceId}/secrets/${secretName}`;
const kek = await importRawKey(unpackB64(kekRawB64));

let rawDek;
let dekRecord = getKvJson(dekKey);
if (dekRecord === null) {
  rawDek = crypto.getRandomValues(new Uint8Array(32));
  dekRecord = {
    wrapped_dek: await encrypt(kek, packB64(rawDek), `${workspaceId}:dek`),
    kek_version: 1,
    created_at: new Date().toISOString(),
  };
  putKvJson(dekKey, dekRecord);
} else {
  rawDek = unpackB64(await decrypt(kek, dekRecord.wrapped_dek, `${workspaceId}:dek`));
}

const dek = await importRawKey(rawDek);
putKvJson(secretKey, {
  ciphertext: await encrypt(dek, secretValue, `${workspaceId}:${secretName}`),
  dek_version: 1,
  updated_at: new Date().toISOString(),
});

console.log(`Stored encrypted secret "${secretName}" for workspace "${workspaceId}".`);

function requireEnv(name) {
  const value = process.env[name];
  if (!value) throw new Error(`${name} is required`);
  return value;
}

function getKvJson(key) {
  let stderr = "";
  try {
    const raw = execFileSync(
      "pnpm",
      ["exec", "wrangler", "kv", "key", "get", key, "--namespace-id", namespaceId, ...remote],
      {
        encoding: "utf8",
        stdio: ["ignore", "pipe", "pipe"],
      },
    ).trim();
    return raw ? JSON.parse(raw) : null;
  } catch (error) {
    stderr =
      error && typeof error === "object" && "stderr" in error
        ? String(error.stderr)
        : String(error);
    if (stderr.includes("404: Not Found")) return null;
    throw new Error(`Failed to read KV key ${key}: ${stderr}`);
  }
}

function readSecretValue() {
  if (process.env.SECRET_VALUE_FILE) {
    return readFileSync(process.env.SECRET_VALUE_FILE, "utf8");
  }
  if (process.env.SECRET_VALUE) {
    return process.env.SECRET_VALUE;
  }
  if (!process.stdin.isTTY) {
    return readFileSync(0, "utf8").replace(/\n$/, "");
  }
  throw new Error("Provide secret via stdin, SECRET_VALUE_FILE, or SECRET_VALUE");
}

function putKvJson(key, value) {
  const dir = mkdtempSync(join(tmpdir(), "nadi-secret-"));
  const file = join(dir, "value.json");
  try {
    writeFileSync(file, JSON.stringify(value), { mode: 0o600 });
    execFileSync(
      "pnpm",
      [
        "exec",
        "wrangler",
        "kv",
        "key",
        "put",
        key,
        "--namespace-id",
        namespaceId,
        "--path",
        file,
        ...remote,
      ],
      { stdio: "ignore" },
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

async function importRawKey(raw) {
  if (raw.byteLength !== 32) throw new Error("AES-GCM key must be 32 bytes");
  return crypto.subtle.importKey("raw", raw, { name: "AES-GCM" }, false, ["encrypt", "decrypt"]);
}

async function encrypt(key, plaintext, aad) {
  const iv = crypto.getRandomValues(new Uint8Array(IV_BYTES));
  const additionalData = new TextEncoder().encode(aad);
  const ciphertext = new Uint8Array(
    await crypto.subtle.encrypt(
      { name: "AES-GCM", iv, additionalData },
      key,
      new TextEncoder().encode(plaintext),
    ),
  );
  const payload = new Uint8Array(iv.byteLength + ciphertext.byteLength);
  payload.set(iv, 0);
  payload.set(ciphertext, iv.byteLength);
  return packB64(payload);
}

async function decrypt(key, packed, aad) {
  const payload = unpackB64(packed);
  const iv = payload.slice(0, IV_BYTES);
  const ciphertext = payload.slice(IV_BYTES);
  const plaintext = await crypto.subtle.decrypt(
    { name: "AES-GCM", iv, additionalData: new TextEncoder().encode(aad) },
    key,
    ciphertext,
  );
  return new TextDecoder().decode(plaintext);
}

function packB64(bytes) {
  return Buffer.from(bytes).toString("base64");
}

function unpackB64(value) {
  return new Uint8Array(Buffer.from(value, "base64"));
}
