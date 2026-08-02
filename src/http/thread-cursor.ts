/**
 * An opaque position in a thread list: the sort column's value, a fingerprint
 * of the query that produced it, plus the id that breaks sortValue ties. All
 * three are needed — `updated_at` is not unique, so a cursor of "everything
 * older than T" silently drops every other row sharing T; and a cursor from
 * one query (e.g. status=archived, or a different `q`) is not a position in a
 * different query, even though both are plain numbers that compare fine.
 */
export type ThreadCursor = { sortValue: number; id: string; fingerprint: string };

/**
 * Identifies the query a cursor was issued for: everything that changes which
 * rows are in the list or what order they come back in. Two calls with the
 * same shape always fingerprint the same; anything that would reorder or
 * refilter the list changes it.
 */
export function fingerprintThreadQuery(query: {
  sortKey: "updatedAt" | "archivedAt";
  q?: string | undefined;
  project: "all" | "unassigned" | { projectId: string };
}): string {
  const projectPart =
    query.project === "all" || query.project === "unassigned"
      ? query.project
      : `project:${query.project.projectId}`;
  const raw = `${query.sortKey}|${projectPart}|${query.q?.trim() ?? ""}`;
  // FNV-1a 32-bit: a plain hash, not a delimiter-encoding scheme. Hex output
  // can never contain ":", so it's safe to sit between the other two fields
  // no matter what characters `q` or a project id contain.
  let hash = 0x811c9dc5;
  for (let i = 0; i < raw.length; i++) {
    hash ^= raw.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193);
  }
  return (hash >>> 0).toString(16).padStart(8, "0");
}

export function encodeThreadCursor(cursor: ThreadCursor): string {
  // The id is opaque and may contain anything, so it goes last and is never
  // split — only the first two delimiters (ending sortValue and fingerprint)
  // are structural. The fingerprint is a fixed-width hex hash, so it can
  // never itself contain a delimiter and confuse this split.
  return btoa(`${cursor.sortValue}:${cursor.fingerprint}:${cursor.id}`);
}

export function decodeThreadCursor(raw: string): ThreadCursor | null {
  let decoded: string;
  try {
    decoded = atob(raw);
  } catch {
    return null;
  }
  const firstSplit = decoded.indexOf(":");
  if (firstSplit <= 0) return null;
  const secondSplit = decoded.indexOf(":", firstSplit + 1);
  if (secondSplit <= firstSplit + 1) return null;
  const sortValue = Number(decoded.slice(0, firstSplit));
  const fingerprint = decoded.slice(firstSplit + 1, secondSplit);
  const id = decoded.slice(secondSplit + 1);
  if (!Number.isFinite(sortValue) || fingerprint === "" || id === "") return null;
  return { sortValue, id, fingerprint };
}
