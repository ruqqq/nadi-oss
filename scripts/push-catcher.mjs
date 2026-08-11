#!/usr/bin/env node
// Stand-in for a browser push service, for verifying web push END TO END.
//
// Why this exists: the unit tests for src/notifications/web-push.ts check the
// encryption against itself, and a real push endpoint answers 201 whether or
// not the ciphertext is decryptable. Neither one can tell you the browser
// would actually be able to read the notification. This script can: it holds
// the subscription's PRIVATE key, so it decrypts what the Worker sent and
// prints the plaintext.
//
// That matters most on celld, whose WebCrypto has no ECDH — the aes128gcm
// key agreement is done in-repo with @noble/curves rather than by the
// platform. "It returned 201" is not evidence that shim is correct.
//
// Usage:
//
//     node scripts/push-catcher.mjs
//
// First run generates everything it needs into .push-catcher/ (gitignored):
// a P-256 subscription keypair, a 16-byte auth secret, and a self-signed TLS
// cert for 127.0.0.1. It then prints the subscription JSON to register with
// the app, and listens on https://127.0.0.1:9200.
//
// Point the app at it by registering a subscription whose endpoint is
// https://127.0.0.1:9200/push, with the printed p256dh and auth values. The
// Worker must be run with NODE_TLS_REJECT_UNAUTHORIZED=0 (or the cert added to
// its trust store) or the self-signed cert is refused before any body is sent.
//
// Every delivery is written to .push-catcher/received.json and logged.

import { createServer } from "node:https";
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { webcrypto as crypto } from "node:crypto";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { hkdf } from "@noble/hashes/hkdf.js";
import { sha256 } from "@noble/hashes/sha2.js";
import { p256 } from "@noble/curves/p256";

const PORT = Number(process.env.PUSH_CATCHER_PORT ?? 9200);
const STATE_DIR = join(dirname(dirname(fileURLToPath(import.meta.url))), ".push-catcher");
const KEYS_FILE = join(STATE_DIR, "keys.json");
const KEY_PEM = join(STATE_DIR, "tls-key.pem");
const CERT_PEM = join(STATE_DIR, "tls-cert.pem");
const RECEIVED_FILE = join(STATE_DIR, "received.json");

const b64u = (bytes) => Buffer.from(bytes).toString("base64url");
const fromB64u = (text) => new Uint8Array(Buffer.from(text, "base64url"));

/**
 * Subscription keypair + auth secret, exactly as a browser's PushManager would
 * mint them: a P-256 keypair whose public half is `p256dh`, and 16 random bytes
 * of `auth`. Persisted so a re-run keeps the same subscription and you do not
 * have to re-register between runs.
 */
function loadOrCreateKeys() {
  if (existsSync(KEYS_FILE)) return JSON.parse(readFileSync(KEYS_FILE, "utf8"));

  const privateKey = p256.utils.randomPrivateKey();
  const keys = {
    privateKey: b64u(privateKey),
    // Uncompressed point (0x04 || X || Y) — the only form `p256dh` takes.
    p256dh: b64u(p256.getPublicKey(privateKey, false)),
    auth: b64u(crypto.getRandomValues(new Uint8Array(16))),
  };
  writeFileSync(KEYS_FILE, `${JSON.stringify(keys, null, 2)}\n`);
  return keys;
}

/** Self-signed cert for 127.0.0.1. Regenerated only if missing. */
function ensureTlsCert() {
  if (existsSync(KEY_PEM) && existsSync(CERT_PEM)) return;
  execFileSync(
    "openssl",
    [
      "req",
      "-x509",
      "-newkey",
      "rsa:2048",
      "-nodes",
      "-keyout",
      KEY_PEM,
      "-out",
      CERT_PEM,
      "-days",
      "365",
      "-subj",
      "/CN=127.0.0.1",
      "-addext",
      "subjectAltName=IP:127.0.0.1",
    ],
    { stdio: ["ignore", "ignore", "inherit"] },
  );
}

function concat(...parts) {
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let offset = 0;
  for (const part of parts) {
    out.set(part, offset);
    offset += part.length;
  }
  return out;
}

/**
 * RFC 8291 aes128gcm decryption, from the RECEIVER's side. Deliberately
 * written against the RFC rather than shared with src/notifications/web-push.ts:
 * a checker that imports the code it checks agrees with its own bugs.
 */
async function decrypt(body, keys) {
  // Header: salt(16) | record size(4) | key id length(1) | key id(idlen)
  const salt = body.slice(0, 16);
  const idLength = body[20];
  const ephemeralPublic = body.slice(21, 21 + idLength);
  const ciphertext = body.slice(21 + idLength);

  const subPrivate = fromB64u(keys.privateKey);
  const subPublic = fromB64u(keys.p256dh);
  const auth = fromB64u(keys.auth);

  // Drop the leading 0x04 and the Y coordinate: ECDH yields only X.
  const shared = p256.getSharedSecret(subPrivate, ephemeralPublic, false).slice(1, 33);
  const prk = hkdf(
    sha256,
    shared,
    auth,
    concat(new TextEncoder().encode("WebPush: info\0"), subPublic, ephemeralPublic),
    32,
  );
  const cek = hkdf(
    sha256,
    prk,
    salt,
    new TextEncoder().encode("Content-Encoding: aes128gcm\0"),
    16,
  );
  const nonce = hkdf(sha256, prk, salt, new TextEncoder().encode("Content-Encoding: nonce\0"), 12);

  const key = await crypto.subtle.importKey("raw", cek, { name: "AES-GCM" }, false, ["decrypt"]);
  const plain = new Uint8Array(
    await crypto.subtle.decrypt({ name: "AES-GCM", iv: nonce }, key, ciphertext),
  );

  // Strip the padding delimiter: zero bytes back to a 0x02 (last record).
  let end = plain.length;
  while (end > 0 && plain[end - 1] === 0) end--;
  if (end > 0 && plain[end - 1] === 0x02) end--;
  return new TextDecoder().decode(plain.slice(0, end));
}

mkdirSync(STATE_DIR, { recursive: true });
const keys = loadOrCreateKeys();
ensureTlsCert();

const server = createServer(
  { key: readFileSync(KEY_PEM), cert: readFileSync(CERT_PEM) },
  (req, res) => {
    const chunks = [];
    req.on("data", (chunk) => chunks.push(chunk));
    req.on("end", async () => {
      const body = new Uint8Array(Buffer.concat(chunks));
      const authorization = String(req.headers.authorization ?? "");
      const record = {
        method: req.method,
        url: req.url,
        contentEncoding: req.headers["content-encoding"] ?? null,
        // The VAPID JWT proves the sender; the body proves the encryption.
        // Both have to be right, and they fail independently.
        hasVapidAuth: authorization.startsWith("vapid "),
        vapidPrefix: authorization.slice(0, 24),
        ttl: req.headers.ttl ?? null,
        bodyBytes: body.length,
      };
      try {
        record.decrypted = await decrypt(body, keys);
      } catch (error) {
        record.decryptError = String(error);
      }
      writeFileSync(RECEIVED_FILE, `${JSON.stringify(record, null, 2)}\n`);
      console.log(JSON.stringify(record, null, 2));
      // A real push service answers 201 Created.
      res.writeHead(201).end();
    });
  },
);

// Without this the process dies silently when the Worker refuses the cert,
// which looks identical to "the app never sent anything".
server.on("tlsClientError", (error) => {
  console.log(
    `TLS handshake failed (is the Worker rejecting the self-signed cert?): ${error.message}`,
  );
});

server.listen(PORT, "127.0.0.1", () => {
  console.log(`push catcher listening on https://127.0.0.1:${PORT}`);
  console.log("\nRegister this subscription with the app:\n");
  console.log(
    JSON.stringify(
      {
        endpoint: `https://127.0.0.1:${PORT}/push`,
        keys: { p256dh: keys.p256dh, auth: keys.auth },
      },
      null,
      2,
    ),
  );
  console.log(`\nDeliveries are written to ${RECEIVED_FILE}`);
});
