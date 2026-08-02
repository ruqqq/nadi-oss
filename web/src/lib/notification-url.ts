/**
 * Extract a thread ID from a push notification's target path.
 *
 * The server sends `url = /threads/${encodeURIComponent(threadId)}` (see
 * `src/notifications/thread-notifications.ts`), so this matches a bare
 * `/threads/:id` path and reverses the encoding. Any other route ("/",
 * "/chats", a full origin URL, a nested path) yields null — the caller then
 * falls back to a plain openWindow of the raw URL.
 */
export function extractThreadId(url: string): string | null {
  const match = url.match(/^\/threads\/([^/]+)$/);
  return match?.[1] ? decodeURIComponent(match[1]) : null;
}
