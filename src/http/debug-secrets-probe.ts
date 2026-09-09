import type { Env } from "../env";
import { resolvePlatform } from "../edition";
import { decrypt, encrypt, packB64, unpackB64 } from "../secrets/aead";
import { buildWorkspaceDekKey, parseWorkspaceDekRecord } from "../secrets/kv-records";
import { dekAad } from "../secrets/kv-store";
import { loadKek } from "../secrets/load-kek";
import { secretsBinding } from "../secrets";

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
  try {
    const packed = await encrypt(key, "nadi-secrets-probe", "probe:aad");
    const back = await decrypt(key, packed, "probe:aad");
    return { ok: back === "nadi-secrets-probe" };
  } catch (error) {
    return { ok: false, error: describe(error) };
  }
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
  const [base64, kek] = await Promise.all([probeBase64(), probeKek(env)]);
  const roundTrip = kek.key
    ? await probeRoundTrip(kek.key)
    : { ok: false, error: "kek unavailable" };
  const dek = await probeDek(env, workspaceId, kek.key);

  return Response.json({
    workspaceId,
    platform: resolvePlatform(env),
    base64,
    kek: kek.report,
    kekRoundTrip: roundTrip,
    dek,
  });
}
