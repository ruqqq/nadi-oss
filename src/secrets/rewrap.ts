import { decrypt, encrypt, importRawKey, unpackB64 } from "./aead";
import { honoursAdditionalData } from "./aad-conformance";
import { SecretsError } from "./errors";
import {
  buildWorkspaceDekKey,
  buildWorkspaceSecretIndexKey,
  buildWorkspaceSecretKey,
  parseWorkspaceDekRecord,
  parseWorkspaceSecretIndex,
  parseWorkspaceSecretRecord,
  type StoredWorkspaceDek,
  type StoredWorkspaceSecret,
} from "./kv-records";
import { dekAad, secretAad } from "./kv-store";

/**
 * One-shot re-wrap of records sealed by a runtime that discarded AES-GCM
 * `additionalData` (celld v0.4.0 — see `aad-conformance.ts`).
 *
 * Everything such a node wrote is authenticated with NO AAD, so a correct
 * runtime cannot open it: `AES-GCM decrypt failed` out of `loadDek`, which is
 * what a v0.4.1 upgrade looked like from the outside. The fix is to decrypt
 * each record the way it was actually sealed — with an empty AAD — and
 * re-encrypt it bound to the AAD it should always have carried.
 *
 * It must run ON the corrected runtime. On v0.4.0 every record would decrypt
 * under the intended AAD (because the AAD is ignored), the migration would
 * report everything already bound, and it would write nothing — so
 * `honoursAdditionalData` gates the whole thing.
 *
 * Safety. Nothing is written unless the plaintext is in hand, so a record that
 * opens under neither AAD is reported and left exactly as it is. The DEK's
 * plaintext does not change — only its wrapping — so secrets stay readable
 * throughout and the order of the two passes does not matter. Every write is a
 * single self-contained KV put, and re-running finds the work already done:
 * the migration is idempotent and safe to interrupt.
 */

export type RecordOutcome =
  /** Already bound to its AAD — nothing to do. */
  | "bound"
  /** Was sealed with no AAD; re-encrypted (or would be, on a dry run). */
  | "rewrapped"
  /** Opens under neither AAD. Left untouched — this needs a human. */
  | "unreadable"
  /** Named in the index but the value is gone. */
  | "missing";

export interface RewrapReport {
  workspaceId: string;
  dryRun: boolean;
  dek: RecordOutcome | "absent";
  secrets: Array<{ name: string; outcome: RecordOutcome }>;
  /** Set when the workspace has a DEK but no secret index (needs the backfill). */
  indexMissing?: boolean;
}

interface Kv {
  get(key: string): Promise<string | null>;
  put(key: string, value: string): Promise<void>;
}

/** Decrypt under the intended AAD, else under the empty one a v0.4.0 node used. */
async function openEitherWay(
  key: CryptoKey,
  packed: string,
  aad: string,
): Promise<{ plaintext: string; outcome: "bound" | "rewrapped" } | null> {
  try {
    return { plaintext: await decrypt(key, packed, aad), outcome: "bound" };
  } catch {
    // Fall through — an unbound record is exactly what we are here to fix.
  }
  try {
    return { plaintext: await decrypt(key, packed, ""), outcome: "rewrapped" };
  } catch {
    return null;
  }
}

export async function rewrapWorkspaceSecrets(
  kv: Kv,
  kek: CryptoKey,
  workspaceId: string,
  options: { dryRun: boolean },
): Promise<RewrapReport> {
  if (!(await honoursAdditionalData())) {
    throw new SecretsError(
      "store_error",
      "refusing to re-wrap: this runtime ignores AES-GCM additionalData, so every " +
        "record would read as already bound and nothing would be fixed. Run the " +
        "migration on celld v0.4.1 or later.",
    );
  }

  const report: RewrapReport = { workspaceId, dryRun: options.dryRun, dek: "absent", secrets: [] };

  const rawDek = await kv.get(buildWorkspaceDekKey(workspaceId));
  if (rawDek === null) return report;

  const dekRecord = parseWorkspaceDekRecord(rawDek, workspaceId);
  const openedDek = await openEitherWay(kek, dekRecord.wrapped_dek, dekAad(workspaceId));
  if (openedDek === null) {
    report.dek = "unreadable";
    return report;
  }

  report.dek = openedDek.outcome;
  if (openedDek.outcome === "rewrapped" && !options.dryRun) {
    const rewrapped: StoredWorkspaceDek = {
      ...dekRecord,
      wrapped_dek: await encrypt(kek, openedDek.plaintext, dekAad(workspaceId)),
    };
    await kv.put(buildWorkspaceDekKey(workspaceId), JSON.stringify(rewrapped));
  }

  const dek = await importRawKey(unpackB64(openedDek.plaintext));

  // Names come from the index, never a KV list — celld rejects a prefix past
  // 49 bytes, and `workspaces/<uuid>/secrets/` is already over it.
  const rawIndex = await kv.get(buildWorkspaceSecretIndexKey(workspaceId));
  if (rawIndex === null) {
    // A DEK with no index predates the index and has not been backfilled.
    // Reporting zero secrets here would be a lie that reads as success.
    report.indexMissing = true;
    return report;
  }

  for (const name of Object.keys(parseWorkspaceSecretIndex(rawIndex, workspaceId).entries).sort()) {
    const key = buildWorkspaceSecretKey(workspaceId, name);
    const raw = await kv.get(key);
    if (raw === null) {
      report.secrets.push({ name, outcome: "missing" });
      continue;
    }

    const record = parseWorkspaceSecretRecord(raw, workspaceId, name);
    const opened = await openEitherWay(dek, record.ciphertext, secretAad(workspaceId, name));
    if (opened === null) {
      report.secrets.push({ name, outcome: "unreadable" });
      continue;
    }

    report.secrets.push({ name, outcome: opened.outcome });
    if (opened.outcome === "rewrapped" && !options.dryRun) {
      const rewrapped: StoredWorkspaceSecret = {
        ...record,
        ciphertext: await encrypt(dek, opened.plaintext, secretAad(workspaceId, name)),
      };
      await kv.put(key, JSON.stringify(rewrapped));
    }
  }

  return report;
}
