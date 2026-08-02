import type { BootstrapData } from "../bootstrap-api";

/**
 * Synchronous localStorage cache of the `/api/bootstrap` payload, so a cold
 * launch paints the workspace shell on frame one instead of waiting on the
 * network. Synchronous is the whole point: an async store (IndexedDB, Cache
 * Storage) could not be read inside a `useState` initializer, which is what
 * lets the first render already have the data.
 *
 * Only signed-in payloads are stored, and the entry is purged on sign-out —
 * it holds thread titles and message previews (the user's own content).
 */
export const BOOTSTRAP_CACHE_KEY = "nadi-bootstrap-cache";
/** Confirmed inactive thread IDs survive stale bootstrap revalidation writes. */
export const INACTIVE_THREAD_IDS_KEY = "nadi-bootstrap-inactive-thread-ids";

/**
 * Envelope version. BUMP THIS whenever `BootstrapData` changes shape. Without
 * it, a deploy that changes the payload would rehydrate an incompatible object
 * straight into React state and crash on launch — with no network round trip
 * able to correct it, because the crash happens before one is made.
 */
export const BOOTSTRAP_CACHE_VERSION = 5;

interface Envelope {
  v: number;
  cachedAt: number;
  data: BootstrapData;
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** Every element must be a plain object with string values at every key in `keys` —
 *  enough to cover what the launch path dereferences without deep-validating the
 *  rest of the shape. */
function isArrayOfShallow(value: unknown, keys: string[]): boolean {
  return (
    Array.isArray(value) &&
    value.every((el) => isPlainObject(el) && keys.every((key) => typeof el[key] === "string"))
  );
}

/** `settings` is nullable; when present, only the fields the launch path
 *  unconditionally dereferences (`settings.workspace.id`, `settings.providers`)
 *  are checked here. */
function isValidSettings(value: unknown): boolean {
  if (value === null) return true;
  if (!isPlainObject(value)) return false;
  const workspace = value.workspace;
  if (!isPlainObject(workspace) || typeof workspace.id !== "string") return false;
  return Array.isArray(value.providers);
}

function readInactiveThreadIds(): Set<string> {
  try {
    const raw = localStorage.getItem(INACTIVE_THREAD_IDS_KEY);
    if (!raw) return new Set();
    const value: unknown = JSON.parse(raw);
    return new Set(
      Array.isArray(value) ? value.filter((id): id is string => typeof id === "string") : [],
    );
  } catch {
    return new Set();
  }
}

function recordInactiveThreadIds(threadIds: Iterable<string>): Set<string> {
  const inactive = readInactiveThreadIds();
  for (const id of threadIds) inactive.add(id);
  try {
    localStorage.setItem(INACTIVE_THREAD_IDS_KEY, JSON.stringify([...inactive]));
  } catch {
    // Storage may be disabled or full; the in-memory transition remains authoritative.
  }
  return inactive;
}

/** Structural check — a stale or hand-edited entry must never reach React state.
 *  This validates the top-level envelope shape plus every field the launch path
 *  dereferences unconditionally (before any network call can correct a bad
 *  cache) — including `thread.lastMessagePreview`, which the sidebar and thread
 *  list read `.length` off with no fallback; it deliberately does not
 *  deep-validate every field of `BootstrapData`. Field-level drift beyond the
 *  launch path is handled by bumping `BOOTSTRAP_CACHE_VERSION`. */
function isBootstrapData(value: unknown): value is BootstrapData {
  if (!isPlainObject(value)) return false;
  const data = value as Partial<BootstrapData>;
  const session = data.session as { authenticated?: unknown; user?: unknown } | undefined;
  if (!isPlainObject(session) || session.authenticated !== true) return false;
  if (!isPlainObject(session.user) || typeof session.user.id !== "string") return false;
  if (!isValidSettings(data.settings)) return false;
  if (data.threadsNextCursor !== null && typeof data.threadsNextCursor !== "string") return false;
  return (
    isArrayOfShallow(data.threads, ["threadId", "workspaceId", "lastMessagePreview"]) &&
    isArrayOfShallow(data.projects, ["id"]) &&
    typeof data.voiceEnabled === "boolean" &&
    typeof data.workersAiEnabled === "boolean" &&
    typeof data.feedbackAdminEnabled === "boolean" &&
    typeof data.backgroundWorkEnabled === "boolean" &&
    typeof data.workbenchNetworkAllowlistEnabled === "boolean"
  );
}

export function readCachedBootstrap(): BootstrapData | null {
  let raw: string | null;
  try {
    raw = localStorage.getItem(BOOTSTRAP_CACHE_KEY);
  } catch {
    return null; // Private-mode / disabled storage.
  }
  if (!raw) return null;

  let envelope: Partial<Envelope>;
  try {
    envelope = JSON.parse(raw) as Partial<Envelope>;
  } catch {
    return null;
  }
  if (envelope.v !== BOOTSTRAP_CACHE_VERSION) return null;
  if (!isBootstrapData(envelope.data)) return null;
  const inactive = readInactiveThreadIds();
  if (inactive.size === 0) return envelope.data;
  return {
    ...envelope.data,
    threads: envelope.data.threads.filter((thread) => !inactive.has(thread.threadId)),
  };
}

/** No-op for a signed-out payload — there is nothing worth caching, and it must
 *  never resurrect a signed-in-looking shell. */
export function writeCachedBootstrap(data: BootstrapData): void {
  if (!data.session.authenticated) return;
  const inactive = readInactiveThreadIds();
  const filtered = inactive.size
    ? { ...data, threads: data.threads.filter((thread) => !inactive.has(thread.threadId)) }
    : data;
  const envelope: Envelope = { v: BOOTSTRAP_CACHE_VERSION, cachedAt: Date.now(), data: filtered };
  try {
    localStorage.setItem(BOOTSTRAP_CACHE_KEY, JSON.stringify(envelope));
  } catch {
    // Quota exceeded / disabled storage: a missing cache is always survivable.
  }
}

export function removeThreadsFromCachedBootstrap(threadIds: Iterable<string>): void {
  const removed = new Set(threadIds);
  if (removed.size === 0) return;
  recordInactiveThreadIds(removed);
  const cached = readCachedBootstrap();
  if (!cached) return;
  const threads = cached.threads.filter((thread) => !removed.has(thread.threadId));
  if (threads.length !== cached.threads.length) writeCachedBootstrap({ ...cached, threads });
}

export function purgeCachedBootstrap(): void {
  try {
    localStorage.removeItem(BOOTSTRAP_CACHE_KEY);
    localStorage.removeItem(INACTIVE_THREAD_IDS_KEY);
  } catch {
    // Nothing to do.
  }
}
