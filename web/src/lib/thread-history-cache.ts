/**
 * IndexedDB store for thread message history, so a thread you have already
 * opened stays readable offline. Thin by design: every decision lives in
 * thread-history-cache-policy.ts.
 *
 * localStorage was rejected (history dwarfs the bootstrap payload and would
 * blow the ~5MB origin quota), as was the service worker's Cache Storage —
 * the SW stays shell-only, and a sign-out purge must not have to cross a
 * postMessage boundary.
 *
 * Every operation is failure-tolerant, like bootstrap-cache.ts: a read that
 * throws or fails validation is a miss, a write that throws is dropped. A
 * missing cache degrades to the old online-only behavior, never to a crash.
 */
import {
  THREAD_HISTORY_CACHE_CAP,
  THREAD_HISTORY_CACHE_VERSION,
  type CachedHistoryEnvelope,
  type CachedMessages,
  evictionPlan,
  isCachedHistoryEnvelope,
} from "./thread-history-cache-policy";

const DB_NAME = "nadi-thread-history";
/**
 * Tied to the envelope version, deliberately. A version bump then arrives as an
 * IndexedDB upgrade, which clears the store — stale-shape records cease to
 * exist rather than lingering as rows the envelope filter skips but the LRU cap
 * never counts (they would be immortal: never valid, never evicted).
 */
const DB_VERSION = THREAD_HISTORY_CACHE_VERSION;
const STORE = "thread-history";
const LAST_OPENED_INDEX = "lastOpenedAt";

/**
 * Purge/write interlock. Sign-out purges the cache and then navigates, which
 * unmounts <ThreadChat> and flushes its debounced settle-write — so a write is
 * routinely in flight *across* a purge, and IndexedDB will happily serialize
 * its `put` after the `clear`, re-inserting the signed-out user's transcript.
 *
 * Ordering the callers cannot fix this (an await before navigate just moves the
 * race), so the invariant lives here, where no future caller can forget it. A
 * write is abandoned unless BOTH hold — they cover opposite orderings and
 * neither alone is sufficient:
 *
 *  - `purgesInFlight === 0` when the write starts. Otherwise the purge began
 *    first and this write's messages predate it (the sign-out flush exactly):
 *    the epoch cannot catch this, because such a write captures the
 *    already-bumped value and would sail through the put-time check.
 *  - `purgeEpoch` is unchanged at `put`. Otherwise a purge started, and perhaps
 *    finished, while we were opening the DB — so our `put` could land after its
 *    `clear` even though no purge is in flight by the time we look.
 */
let purgeEpoch = 0;
let purgesInFlight = 0;

function promisify<T>(request: IDBRequest<T>): Promise<T> {
  return new Promise((resolve, reject) => {
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
}

function openDb(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    if (typeof indexedDB === "undefined") {
      reject(new Error("IndexedDB unavailable"));
      return;
    }
    const request = indexedDB.open(DB_NAME, DB_VERSION);
    request.onupgradeneeded = () => {
      const db = request.result;
      if (!db.objectStoreNames.contains(STORE)) {
        const store = db.createObjectStore(STORE, { keyPath: "threadId" });
        store.createIndex(LAST_OPENED_INDEX, LAST_OPENED_INDEX);
        return;
      }
      // The store predates this DB_VERSION, so every record in it predates the
      // current envelope version. Drop them all.
      request.transaction?.objectStore(STORE).clear();
    };
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
    // Another tab holds the old version open, so the upgrade cannot proceed.
    // Reject rather than hang forever: every caller treats a throw as a miss.
    request.onblocked = () => reject(new Error("IndexedDB upgrade blocked"));
  });
}

function txDone(tx: IDBTransaction): Promise<void> {
  return new Promise((resolve, reject) => {
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
    tx.onabort = () => reject(tx.error);
  });
}

/** Walk an index's keys only — the values are never read, which is the whole
 *  point (see writeCachedHistory). Yields entries already ordered by
 *  lastOpenedAt, oldest first. */
function keyCursorEntries(index: IDBIndex): Promise<{ threadId: string; lastOpenedAt: number }[]> {
  return new Promise((resolve, reject) => {
    const entries: { threadId: string; lastOpenedAt: number }[] = [];
    const request = index.openKeyCursor();
    request.onsuccess = () => {
      const cursor = request.result;
      if (!cursor) {
        resolve(entries);
        return;
      }
      entries.push({
        threadId: String(cursor.primaryKey),
        lastOpenedAt: Number(cursor.key),
      });
      cursor.continue();
    };
    request.onerror = () => reject(request.error);
  });
}

export async function readCachedHistory(threadId: string): Promise<CachedMessages | null> {
  try {
    const db = await openDb();
    try {
      const tx = db.transaction(STORE, "readonly");
      const record = await promisify(tx.objectStore(STORE).get(threadId));
      if (!isCachedHistoryEnvelope(record)) return null;
      return record.messages;
    } finally {
      db.close();
    }
  } catch {
    return null; // Private mode / disabled storage / corrupt record.
  }
}

export async function writeCachedHistory(
  threadId: string,
  messages: CachedMessages,
): Promise<void> {
  // Both reads are synchronous at entry, before any await.
  const epoch = purgeEpoch;
  if (purgesInFlight > 0) return;
  try {
    const db = await openDb();
    try {
      // Re-checked synchronously against `put`: a purge that started while we
      // were opening the DB must win, whatever order IndexedDB serializes the
      // two transactions in.
      if (purgeEpoch !== epoch) return;

      const tx = db.transaction(STORE, "readwrite");
      const store = tx.objectStore(STORE);

      const now = Date.now();
      const envelope: CachedHistoryEnvelope = {
        v: THREAD_HISTORY_CACHE_VERSION,
        cachedAt: now,
        lastOpenedAt: now,
        threadId,
        messages,
      };
      store.put(envelope);

      // Evict in the same transaction, so the cap can never be exceeded by a
      // crash between the write and the eviction.
      //
      // A key cursor over the lastOpenedAt index, NOT getAll(): the plan needs
      // two numbers per thread, and getAll() would deserialize every cached
      // transcript (up to 50, tool-heavy, tens of MB) on the main thread — on
      // every settled turn, since the settle-write made this per-turn.
      const entries = await keyCursorEntries(store.index(LAST_OPENED_INDEX));
      for (const victim of evictionPlan(entries, THREAD_HISTORY_CACHE_CAP)) {
        store.delete(victim);
      }

      await txDone(tx);
    } finally {
      db.close();
    }
  } catch {
    // Quota exceeded / disabled storage: a missing cache is always survivable.
  }
}

/** Drop every cached transcript. Runs on sign-out: this is the user's own
 *  content and must not survive on a shared device. */
export async function purgeCachedHistory(): Promise<void> {
  // Synchronous, before any await: both are what a racing write reads, so they
  // must be visible the instant purge is *called*, not the instant it reaches
  // the store.
  purgeEpoch += 1;
  purgesInFlight += 1;
  try {
    const db = await openDb();
    try {
      const tx = db.transaction(STORE, "readwrite");
      tx.objectStore(STORE).clear();
      await txDone(tx);
    } finally {
      db.close();
    }
  } catch {
    // Nothing to do.
  } finally {
    // Only after the clear has committed (or failed) may writes resume, so the
    // gate can never be reopened while a `clear` is still pending.
    purgesInFlight -= 1;
  }
}
