import type { Env } from "../env";
import { resolvePlatform } from "../edition";
import { decrypt, encrypt, packB64, unpackB64 } from "../secrets/aead";
import { buildWorkspaceDekKey, parseWorkspaceDekRecord } from "../secrets/kv-records";
import { dekAad } from "../secrets/kv-store";
import { loadKek } from "../secrets/load-kek";
import { secretsBinding } from "../secrets";
import { registryDb } from "../db/client";
import { workspaces } from "../db/schema";

/**
 * Why this endpoint exists.
 *
 * celld v0.4.1 made every workspace secret unreadable — `AES-GCM decrypt
 * failed` raised from `KVWorkspaceSecretsStore.loadDek` — on a build that was
 * byte-identical to a working v0.4.0 one, and v0.4.0 restored it immediately.
 * The cause was never identified, so the repo stayed pinned and PR #69 was
 * closed. Nothing in CI runs against celld, so a version bump ships with zero
 * signal; the only way to judge one is to measure the node.
 *
 * The unwrap that fails takes exactly three inputs: the KEK bytes, the wrapped
 * DEK bytes read back from KV, and the AAD string. This reports a fingerprint
 * of each, so the SAME probe run on v0.4.0 and on v0.4.1 says which of the
 * three moved — instead of leaving us to argue about it from a stack trace.
 *
 * It also self-tests base64 against fixed constants, because both the KEK and
 * the wrapped DEK reach AES-GCM through `atob`: a runtime that decodes `+` or
 * `/` differently yields a key of the RIGHT LENGTH and the WRONG VALUE, which
 * is precisely the observed shape (`importRawKey` enforces 32 bytes and it
 * passed). The KEK on this deployment does contain those characters.
 *
 * Fingerprints only — never a key, a ciphertext, or a plaintext. Each is a
 * salted SHA-256 truncated to 16 hex, so it identifies a value across two runs
 * without being a general-purpose digest oracle for it. The route is
 * `x-debug-token`-gated like the rest of `/api/debug/*`.
 */

const FINGERPRINT_SALT = "nadi-secrets-probe-v1:";

/** Canonical base64 of the bytes 0x00..0xff, fingerprinted with the salt above. */
const EXPECTED_B64_LENGTH = 344;
const EXPECTED_B64_FINGERPRINT = "9b4a4bacd8b97aea";
/** `atob("+/+/")` — the two characters that differ between standard and URL-safe. */
const EXPECTED_PLUS_SLASH_HEX = "fbffbf";

/**
 * An AES-256-GCM known-answer test. Fixed key, fixed IV, fixed AAD, fixed
 * plaintext — so the ciphertext+tag is a constant any conforming
 * implementation must produce. An in-process round trip cannot catch a
 * runtime that is self-consistently wrong (it decrypts its own output with
 * its own defect); this can, because the answer comes from outside.
 */
const KAT_KEY_HEX = "000102030405060708090a0b0c0d0e0f101112131415161718191a1b1c1d1e1f";
const KAT_IV_HEX = "000102030405060708090a0b";
const KAT_AAD = "nadi-kat-aad";
const KAT_PLAINTEXT = "nadi-known-answer-test";
const KAT_EXPECTED_HEX =
  "2963b272e88eac74fa2fbaeadf9a0f08f1fbf351830f873e1a7799c9c955b15263008be5d1ad";

function toHex(bytes: Uint8Array): string {
  let out = "";
  for (const byte of bytes) out += byte.toString(16).padStart(2, "0");
  return out;
}

async function fingerprint(input: Uint8Array | string): Promise<string> {
  const bytes = typeof input === "string" ? new TextEncoder().encode(input) : input;
  const salt = new TextEncoder().encode(FINGERPRINT_SALT);
  const salted = new Uint8Array(salt.byteLength + bytes.byteLength);
  salted.set(salt, 0);
  salted.set(bytes, salt.byteLength);
  const digest = await crypto.subtle.digest("SHA-256", salted);
  return toHex(new Uint8Array(digest)).slice(0, 16);
}

function fromHex(hex: string): Uint8Array<ArrayBuffer> {
  const bytes = new Uint8Array(new ArrayBuffer(hex.length / 2));
  for (let i = 0; i < bytes.length; i += 1)
    bytes[i] = Number.parseInt(hex.slice(i * 2, i * 2 + 2), 16);
  return bytes;
}

/**
 * Encrypt the fixed vector and compare against the constant. A mismatch means
 * the runtime's AES-GCM or its raw key import diverges from the standard —
 * which would explain a stored ciphertext failing to open while every input
 * to it fingerprints identical.
 */
async function probeKnownAnswer(): Promise<Record<string, unknown>> {
  try {
    const key = await crypto.subtle.importKey(
      "raw",
      fromHex(KAT_KEY_HEX),
      { name: "AES-GCM" },
      false,
      ["encrypt", "decrypt"],
    );
    const produced = new Uint8Array(
      await crypto.subtle.encrypt(
        {
          name: "AES-GCM",
          iv: fromHex(KAT_IV_HEX),
          additionalData: new TextEncoder().encode(KAT_AAD),
        },
        key,
        new TextEncoder().encode(KAT_PLAINTEXT),
      ),
    );
    const producedHex = toHex(produced);

    // And the other direction: open the constant ciphertext.
    let decrypts = false;
    let decryptError: string | undefined;
    try {
      const opened = await crypto.subtle.decrypt(
        {
          name: "AES-GCM",
          iv: fromHex(KAT_IV_HEX),
          additionalData: new TextEncoder().encode(KAT_AAD),
        },
        key,
        fromHex(KAT_EXPECTED_HEX),
      );
      decrypts = new TextDecoder().decode(opened) === KAT_PLAINTEXT;
    } catch (error) {
      decryptError = describe(error);
    }

    return {
      ok: producedHex === KAT_EXPECTED_HEX && decrypts,
      encryptMatches: producedHex === KAT_EXPECTED_HEX,
      producedHex,
      expectedHex: KAT_EXPECTED_HEX,
      decrypts,
      ...(decryptError === undefined ? {} : { decryptError }),
    };
  } catch (error) {
    return { ok: false, error: describe(error) };
  }
}

function describe(error: unknown): string {
  return error instanceof Error ? `${error.name}: ${error.message}` : String(error);
}

/** Which base64 alphabet the string uses. Reported, never the value itself. */
function alphabetOf(value: string): "standard" | "urlsafe" | "mixed" | "plain" {
  const standard = /[+/]/.test(value);
  const urlsafe = /[-_]/.test(value);
  if (standard && urlsafe) return "mixed";
  if (standard) return "standard";
  if (urlsafe) return "urlsafe";
  return "plain";
}

async function probeBase64(): Promise<Record<string, unknown>> {
  try {
    const bytes = new Uint8Array(256);
    for (let i = 0; i < 256; i += 1) bytes[i] = i;

    const encoded = packB64(bytes);
    const decoded = unpackB64(encoded);
    const roundTrips = toHex(decoded) === toHex(bytes);
    const encodedFingerprint = await fingerprint(encoded);
    const plusSlashHex = toHex(unpackB64("+/+/"));

    return {
      ok:
        roundTrips &&
        encoded.length === EXPECTED_B64_LENGTH &&
        encodedFingerprint === EXPECTED_B64_FINGERPRINT &&
        plusSlashHex === EXPECTED_PLUS_SLASH_HEX,
      roundTrips,
      encodedLength: encoded.length,
      expectedEncodedLength: EXPECTED_B64_LENGTH,
      encodedFingerprint,
      expectedEncodedFingerprint: EXPECTED_B64_FINGERPRINT,
      plusSlashHex,
      expectedPlusSlashHex: EXPECTED_PLUS_SLASH_HEX,
    };
  } catch (error) {
    return { ok: false, error: describe(error) };
  }
}

async function probeKek(
  env: Env,
): Promise<{ key: CryptoKey | null; report: Record<string, unknown> }> {
  const raw = env.SECRETS_STORE_KEK_RAW_B64 ?? "";
  const shape = {
    configured: raw.length > 0,
    rawLength: raw.length,
    rawEndsWithPad: raw.endsWith("="),
    rawAlphabet: alphabetOf(raw),
  };

  let decodedLength: number | null = null;
  let decodedFingerprint: string | null = null;
  try {
    const decoded = unpackB64(raw);
    decodedLength = decoded.byteLength;
    decodedFingerprint = await fingerprint(decoded);
  } catch (error) {
    return { key: null, report: { ...shape, decodeError: describe(error), imported: false } };
  }

  try {
    const key = await loadKek(env);
    return { key, report: { ...shape, decodedLength, decodedFingerprint, imported: true } };
  } catch (error) {
    return {
      key: null,
      report: {
        ...shape,
        decodedLength,
        decodedFingerprint,
        imported: false,
        error: describe(error),
      },
    };
  }
}

/**
 * Encrypt and decrypt a constant with the live KEK, in memory. If this fails,
 * the runtime's AES-GCM is the problem and nothing stored matters; if it passes
 * while the stored DEK does not, the difference is the bytes, not the crypto.
 */
async function probeRoundTrip(key: CryptoKey): Promise<Record<string, unknown>> {
  const report: Record<string, unknown> = {};
  try {
    const packed = await encrypt(key, "nadi-secrets-probe", "probe:aad");
    const back = await decrypt(key, packed, "probe:aad");
    report.ok = back === "nadi-secrets-probe";

    // The decisive test. Every stored record is bound to an AAD
    // (`<workspace>:dek`), so a runtime that silently DROPS `additionalData`
    // round-trips its own ciphertext happily while failing to open anything
    // written by a runtime that honoured it — which is the exact shape of the
    // v0.4.1 breakage, given the KEK bytes and the wrapped-DEK bytes both
    // fingerprint identical across the two versions.
    //
    // A conforming runtime MUST reject this: same key, same ciphertext,
    // different AAD.
    try {
      await decrypt(key, packed, "probe:aad:WRONG");
      report.rejectsWrongAad = false;
    } catch {
      report.rejectsWrongAad = true;
    }

    // And the other direction: a ciphertext written with NO aad must not open
    // with one.
    const packedNoAad = await encrypt(key, "nadi-secrets-probe", "");
    try {
      await decrypt(key, packedNoAad, "probe:aad");
      report.rejectsAddedAad = false;
    } catch {
      report.rejectsAddedAad = true;
    }
  } catch (error) {
    report.ok = false;
    report.error = describe(error);
  }
  return report;
}

async function probeDek(
  env: Env,
  workspaceId: string,
  key: CryptoKey | null,
): Promise<Record<string, unknown>> {
  const aad = dekAad(workspaceId);
  const report: Record<string, unknown> = { aad, aadLength: aad.length };

  let raw: string | null;
  try {
    raw = await secretsBinding(env).get(buildWorkspaceDekKey(workspaceId));
  } catch (error) {
    return { ...report, present: false, kvError: describe(error) };
  }
  if (raw === null) return { ...report, present: false };

  report.present = true;
  report.recordLength = raw.length;
  report.recordFingerprint = await fingerprint(raw);

  let record;
  try {
    record = parseWorkspaceDekRecord(raw, workspaceId);
  } catch (error) {
    return { ...report, parsed: false, error: describe(error) };
  }

  report.parsed = true;
  report.kekVersion = record.kek_version;
  report.wrappedLength = record.wrapped_dek.length;
  report.wrappedAlphabet = alphabetOf(record.wrapped_dek);
  try {
    const wrapped = unpackB64(record.wrapped_dek);
    report.wrappedDecodedLength = wrapped.byteLength;
    report.wrappedFingerprint = await fingerprint(wrapped);
  } catch (error) {
    return { ...report, unwrapped: false, error: describe(error) };
  }

  if (key === null) return { ...report, unwrapped: false, error: "kek unavailable" };

  try {
    const dekB64 = await decrypt(key, record.wrapped_dek, aad);
    report.unwrapped = true;
    // Length only. A successful unwrap already proves the bytes are right, so
    // there is nothing a fingerprint of the live DEK would add to pay for it.
    report.dekDecodedLength = unpackB64(dekB64).byteLength;
  } catch (error) {
    report.unwrapped = false;
    report.error = describe(error);
  }
  return report;
}

/**
 * `GET /api/debug/secrets-probe?workspaceId=…` — evidence for a celld version
 * bump. Run it on the pinned version first; the baseline is what makes the
 * numbers from the candidate version mean anything.
 */
export async function runSecretsProbe(env: Env, workspaceId: string): Promise<Response> {
  const [base64, knownAnswer, kek] = await Promise.all([
    probeBase64(),
    probeKnownAnswer(),
    probeKek(env),
  ]);
  const roundTrip = kek.key
    ? await probeRoundTrip(kek.key)
    : { ok: false, error: "kek unavailable" };
  // Probe every workspace, not just the requested one. The debug default is
  // `default`, which on this deployment holds no DEK at all — and a probe that
  // reports "nothing to unwrap" would have looked just as green on the broken
  // version. The wrapped DEK is the artifact under test, so go find one.
  const ids = await listWorkspaceIds(env, workspaceId);
  const dek: Record<string, unknown> = {};
  for (const id of ids) dek[id] = await probeDek(env, id, kek.key);

  return Response.json({
    workspaceId,
    platform: resolvePlatform(env),
    base64,
    knownAnswer,
    kek: kek.report,
    kekRoundTrip: roundTrip,
    dek,
  });
}

async function listWorkspaceIds(env: Env, requested: string): Promise<string[]> {
  const ids = new Set<string>([requested]);
  try {
    const rows = await registryDb(env).select({ id: workspaces.id }).from(workspaces).limit(25);
    for (const row of rows) ids.add(row.id);
  } catch {
    // D1 unavailable — the requested workspace alone still answers the question
    // whenever it is the one holding a DEK.
  }
  return [...ids];
}
