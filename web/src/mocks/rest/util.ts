/**
 * Shared helpers for the MSW handlers.
 *
 * The error shape here is not cosmetic: `lib/http-error.ts` only surfaces a
 * server message from a body that is non-empty, under 300 chars, doesn't start
 * with `<`, and — when it is JSON — carries `error` or `message`. Anything else
 * degrades to a generic sentence, which makes a mocked failure indistinguishable
 * from a broken handler.
 */

import { HttpResponse } from "msw";
import { getStore } from "../store";

/**
 * Whether this thread's history load should fail at the transport level.
 *
 * Shared because both history routes (archived / think) are split across two
 * handler modules and must agree — reaching the error state depends on which
 * route the thread picks, so failing only one of them means the state is
 * reachable for some threads and silently not for others.
 */
export function historyUnreachable(threadId: string): boolean {
  return getStore().faults.historyUnreachableThreadIds.includes(threadId);
}

export function errorResponse(status: number, message: string): Response {
  return HttpResponse.json({ error: message }, { status });
}

export const notFound = (what: string): Response =>
  errorResponse(404, `${what} couldn't be found — it may have already been removed.`);

/**
 * MSW types a path param as `string | readonly string[] | undefined` (a repeated
 * segment yields an array). Every route here has exactly one value per param, so
 * collapse it once rather than at each call site.
 */
export function pathParam(
  params: Record<string, string | readonly string[] | undefined>,
  key: string,
): string {
  const raw = params[key];
  if (Array.isArray(raw)) return raw[0] ?? "";
  return typeof raw === "string" ? raw : "";
}

/** Cursors are opaque to the app, so an offset is enough. */
export function encodeCursor(offset: number): string {
  return `off:${offset}`;
}

export function decodeCursor(cursor: string | null): number {
  if (!cursor) return 0;
  const parsed = Number.parseInt(cursor.replace(/^off:/, ""), 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : 0;
}

/** Slices a list into a page and reports the cursor for the next one. */
export function paginate<T>(
  items: T[],
  options: { limit: number | null; cursor: string | null },
): { page: T[]; nextCursor: string | null } {
  const offset = decodeCursor(options.cursor);
  if (options.limit === null) return { page: items.slice(offset), nextCursor: null };
  const end = offset + options.limit;
  return {
    page: items.slice(offset, end),
    nextCursor: end < items.length ? encodeCursor(end) : null,
  };
}

export function readLimit(url: URL): number | null {
  const raw = url.searchParams.get("limit");
  if (raw === null) return null;
  const parsed = Number.parseInt(raw, 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : null;
}

/** A stable-ish id with a readable prefix, so mock data reads like real data. */
export function mockId(prefix: string): string {
  return `${prefix}_${Math.random().toString(36).slice(2, 10)}`;
}
