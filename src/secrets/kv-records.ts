export interface StoredWorkspaceDek {
  wrapped_dek: string;
  kek_version: number;
  created_at: string;
}

export interface StoredWorkspaceSecret {
  ciphertext: string;
  dek_version: number;
  updated_at: string;
}

export function buildWorkspaceDekKey(workspaceId: string): string {
  return `workspaces/${workspaceId}/dek`;
}

export function buildWorkspaceSecretKey(workspaceId: string, name: string): string {
  return `workspaces/${workspaceId}/secrets/${name}`;
}

export function buildWorkspaceSecretPrefix(workspaceId: string): string {
  return `workspaces/${workspaceId}/secrets/`;
}

/**
 * One key per workspace listing the secret names it holds, so listing never
 * needs `kv.list({ prefix })`. Named `secret-index` rather than
 * `secrets/index` deliberately: it must NOT sit under
 * `buildWorkspaceSecretPrefix`, or a backfill would ingest the index as if it
 * were a secret.
 */
export function buildWorkspaceSecretIndexKey(workspaceId: string): string {
  return `workspaces/${workspaceId}/secret-index`;
}

export interface StoredWorkspaceSecretIndex {
  version: 1;
  entries: Record<string, { updated_at: string }>;
}

export function parseWorkspaceSecretIndex(
  raw: string,
  workspaceId: string,
): StoredWorkspaceSecretIndex {
  const message = `invalid workspace secret index for ${workspaceId}`;
  const parsed = parseJson(raw, message);
  if (
    typeof parsed !== "object" ||
    parsed === null ||
    (parsed as { version?: unknown }).version !== 1 ||
    typeof (parsed as { entries?: unknown }).entries !== "object" ||
    (parsed as { entries?: unknown }).entries === null
  ) {
    throw new Error(message);
  }
  const entries = (parsed as { entries: Record<string, unknown> }).entries;
  for (const value of Object.values(entries)) {
    if (
      typeof value !== "object" ||
      value === null ||
      typeof (value as { updated_at?: unknown }).updated_at !== "string"
    ) {
      throw new Error(message);
    }
  }
  return parsed as StoredWorkspaceSecretIndex;
}

export function parseSecretNameFromKey(workspaceId: string, key: string): string | null {
  const prefix = buildWorkspaceSecretPrefix(workspaceId);
  if (!key.startsWith(prefix)) return null;
  const name = key.slice(prefix.length);
  return name.length === 0 ? null : name;
}

export function parseWorkspaceDekRecord(raw: string, workspaceId: string): StoredWorkspaceDek {
  const parsed = parseJson(raw, `invalid workspace dek record for ${workspaceId}`);
  if (
    typeof parsed !== "object" ||
    parsed === null ||
    typeof (parsed as { wrapped_dek?: unknown }).wrapped_dek !== "string" ||
    typeof (parsed as { kek_version?: unknown }).kek_version !== "number" ||
    typeof (parsed as { created_at?: unknown }).created_at !== "string"
  ) {
    throw new Error(`invalid workspace dek record for ${workspaceId}`);
  }
  return parsed as StoredWorkspaceDek;
}

export function parseWorkspaceSecretRecord(
  raw: string,
  workspaceId: string,
  name: string,
): StoredWorkspaceSecret {
  const parsed = parseJson(raw, `invalid workspace secret record for ${workspaceId}:${name}`);
  if (
    typeof parsed !== "object" ||
    parsed === null ||
    typeof (parsed as { ciphertext?: unknown }).ciphertext !== "string" ||
    typeof (parsed as { dek_version?: unknown }).dek_version !== "number" ||
    typeof (parsed as { updated_at?: unknown }).updated_at !== "string"
  ) {
    throw new Error(`invalid workspace secret record for ${workspaceId}:${name}`);
  }
  return parsed as StoredWorkspaceSecret;
}

function parseJson(raw: string, message: string): unknown {
  try {
    return JSON.parse(raw);
  } catch {
    throw new Error(message);
  }
}
