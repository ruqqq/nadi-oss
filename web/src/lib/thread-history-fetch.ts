import type { historyFetchTargetForThread } from "../thread-runtime-routing";
import { readCachedHistory, writeCachedHistory } from "./thread-history-cache";
import type { CachedMessages } from "./thread-history-cache-policy";

export interface FetchThreadHistoryOptions {
  /** Enables the cache. Omit it and this function behaves exactly as it did
   *  before the cache existed. */
  threadId?: string;
  /**
   * Read the cache when the network is unreachable. OPT-IN, and only the
   * suspend-driving fetch in ThreadChat opts in.
   *
   * syncThreadHistory and the pending-first-message poller call this same
   * function. If the fallback were unconditional, a resync running while still
   * offline would "succeed" by re-reading our own cache: setMessages(stale),
   * historyReloading cleared, all reported as a sync that never touched the
   * server. Those callers must fail instead and leave the messages alone.
   */
  fallbackToCache?: boolean;
}

export interface DetailedThreadHistory {
  messages: CachedMessages;
  /**
   * The server replied but the load did not yield a usable transcript, so
   * `messages` is a degraded `[]` rather than a real empty thread. The caller
   * must not let this stand in for history: <ThreadChat> would otherwise render
   * an empty thread on a live socket, and the first settled turn would persist
   * a 2-message transcript over a good 40-message cache.
   *
   * An offline cache HIT is NOT degraded — those messages are the cached truth,
   * and writing them back is a no-op.
   */
  degraded: boolean;
}

/**
 * Load a thread's message history. This is plain HTTP, not the WebSocket —
 * which is exactly what makes offline history tractable: a cache hit here makes
 * the history load succeed offline with no change to useAgentChat.
 *
 * The three route shapes (archived / think / legacy) are normalized to one
 * message array here, so the cache stores parsed messages and never learns
 * which route answered.
 *
 * Callers that only need the transcript should use `fetchThreadHistory`.
 */
export async function fetchThreadHistoryDetailed(
  target: ReturnType<typeof historyFetchTargetForThread>,
  options: FetchThreadHistoryOptions = {},
): Promise<DetailedThreadHistory> {
  const { threadId, fallbackToCache = false } = options;

  let res: Response;
  try {
    res = await fetch(target.path, { credentials: "include" });
  } catch (error) {
    // The server was unreachable. This is the offline path, and the only one
    // the cache may answer.
    if (threadId && fallbackToCache) {
      const cached = await readCachedHistory(threadId);
      if (cached) return { messages: cached, degraded: false };
    }
    throw error;
  }

  // The server replied. A non-ok status is NOT an offline signal, so it never
  // reads the cache — and never writes one either: an expired-session 401
  // degrades to [] here, and persisting that would overwrite good history with
  // empty.
  if (!res.ok) return { messages: [], degraded: true };

  let body: unknown;
  try {
    body = await res.json();
  } catch {
    return { messages: [], degraded: true };
  }

  const messages = normalizeMessages(body);
  if (messages === null) return { messages: [], degraded: true };

  // Any caller passing a threadId writes; today only ThreadChat's suspend fetch
  // does. The resync paths deliberately pass no options at all — they refresh
  // the cache via the settle-write in ThreadChat instead, one debounce later,
  // and passing a threadId there would put it one word away from the
  // fallbackToCache they must never have.
  //
  // Not awaited: an IndexedDB round-trip here would sit on the thread-open
  // suspend path.
  if (threadId) void writeCachedHistory(threadId, messages);
  return { messages, degraded: false };
}

/** The transcript alone. The three callers that cannot act on `degraded`
 *  (syncThreadHistory, the pending-first-message poller, the archived-thread
 *  load) keep using this. */
export async function fetchThreadHistory(
  target: ReturnType<typeof historyFetchTargetForThread>,
  options: FetchThreadHistoryOptions = {},
): Promise<CachedMessages> {
  return (await fetchThreadHistoryDetailed(target, options)).messages;
}

/** `null` when the body is neither shape — distinct from a legitimately empty
 *  transcript, which must be cacheable. */
function normalizeMessages(body: unknown): CachedMessages | null {
  if (Array.isArray(body)) return body as CachedMessages;
  const bodyMessages = (body as { messages?: unknown[] } | null)?.messages;
  return Array.isArray(bodyMessages) ? (bodyMessages as CachedMessages) : null;
}
