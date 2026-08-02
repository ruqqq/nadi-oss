/**
 * Durable handoff for "the user tapped a push notification, open this thread".
 *
 * The service worker's `notificationclick` handler used to hand the target
 * thread to the page with a bare `client.postMessage`, which is fire-and-forget
 * and loses the message whenever the page is not already listening:
 *
 *  - A ServiceWorkerContainer buffers incoming messages only until the
 *    document's `load` event, then flushes them. The app's `message` listener
 *    lives inside the signed-in workspace, which mounts after the session
 *    probe — routinely after `load`, so the flush lands on no listener.
 *  - Tapping a notification for an installed PWA launches (or restores) the app
 *    at `start_url` — "/" — *before* the click handler runs, so a client
 *    usually exists and the `openWindow(/threads/:id)` fallback never fires.
 *
 * Together those put the app on the chat list with the target thread dropped on
 * the floor. So the intent is written somewhere both sides can see instead:
 * the worker records it, the page claims it on mount and on resume. IndexedDB
 * is shared between the two, needs no live client, and survives the worker
 * going to sleep.
 *
 * Failure-tolerant like bootstrap-cache.ts and thread-history-cache.ts: a read
 * that throws is "nothing pending", a write that throws is dropped. Losing the
 * record degrades to the old behavior (the app opens where it was), never to a
 * crash — and this code runs inside the service worker, where an unhandled
 * rejection in `notificationclick` would cost the focus/openWindow too.
 */

const DB_NAME = "nadi-pending-nav";
const DB_VERSION = 1;
const STORE = "pending";
/** One record, always: the newest tap is the only one worth acting on. */
const RECORD_KEY = "thread";

/**
 * How long a tap stays actionable. Long enough for a cold PWA launch on a slow
 * device to boot and claim it, short enough that a record nothing consumed (the
 * app was killed before it mounted, the user navigated away themselves) cannot
 * resurface on some unrelated resume hours later and yank them into a thread
 * they never asked for.
 */
export const PENDING_NAVIGATION_TTL_MS = 120_000;

interface PendingRecord {
  key: string;
  threadId: string;
  savedAt: number;
}

function isPendingRecord(value: unknown): value is PendingRecord {
  if (typeof value !== "object" || value === null) return false;
  const record = value as Partial<PendingRecord>;
  return typeof record.threadId === "string" && typeof record.savedAt === "number";
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
      if (!db.objectStoreNames.contains(STORE)) db.createObjectStore(STORE, { keyPath: "key" });
    };
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
    // Another client holds an older version open; treat as unavailable rather
    // than hang the notificationclick handler forever.
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

function promisify<T>(request: IDBRequest<T>): Promise<T> {
  return new Promise((resolve, reject) => {
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
}

/** Service-worker side: record the thread a notification tap points at. */
export async function savePendingThreadNavigation(
  threadId: string,
  now: number = Date.now(),
): Promise<void> {
  let db: IDBDatabase | undefined;
  try {
    db = await openDb();
    const tx = db.transaction(STORE, "readwrite");
    tx.objectStore(STORE).put({ key: RECORD_KEY, threadId, savedAt: now } satisfies PendingRecord);
    await txDone(tx);
  } catch {
    // Dropped: the postMessage/openWindow paths in the worker still stand.
  } finally {
    db?.close();
  }
}

/**
 * Page side: take the pending thread, if any, and consume it. Destructive by
 * design — a tap must move the user exactly once, so a later resume (or the
 * live postMessage racing this call) cannot replay it.
 */
export async function claimPendingThreadNavigation(
  now: number = Date.now(),
): Promise<string | null> {
  let db: IDBDatabase | undefined;
  try {
    db = await openDb();
    // Read and delete in one readwrite transaction: two clients claiming at
    // once must not both see the record.
    const tx = db.transaction(STORE, "readwrite");
    const store = tx.objectStore(STORE);
    const record = await promisify(store.get(RECORD_KEY));
    store.delete(RECORD_KEY);
    await txDone(tx);
    if (!isPendingRecord(record)) return null;
    if (now - record.savedAt > PENDING_NAVIGATION_TTL_MS) return null;
    return record.threadId;
  } catch {
    return null;
  } finally {
    db?.close();
  }
}

/**
 * Drop the record without navigating — for when the live postMessage already
 * moved the user, so the same tap cannot fire again on the next resume.
 */
export async function clearPendingThreadNavigation(): Promise<void> {
  let db: IDBDatabase | undefined;
  try {
    db = await openDb();
    const tx = db.transaction(STORE, "readwrite");
    tx.objectStore(STORE).delete(RECORD_KEY);
    await txDone(tx);
  } catch {
    // Nothing to do; the TTL is the backstop.
  } finally {
    db?.close();
  }
}
