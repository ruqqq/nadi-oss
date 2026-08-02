/**
 * Depth-aware history entries.
 *
 * The panels need a back button that means "up one level" and agrees with the
 * browser's own Back. Calling history.back() blindly can't do that: on a deep
 * link (a pasted /automata/auto_x, a reload) there is no entry of ours behind
 * the current one, and Back would leave the app entirely.
 *
 * So every entry we push records how deep it is and where it came from. A
 * depth of 0 means "nothing of ours behind this" — step up by synthesizing the
 * parent instead of going back.
 */

import { parsePanelRoute } from "./panel-routes";

export type RouteHistoryState = {
  depth: number;
  from: string;
  /**
   * Where this entry's Back should return to, when it was opened from a place
   * worth returning to (a run in Automata) rather than from the rail. Set by the
   * navigation itself, not inferred from `from`: the rail is a drawer that opens
   * over any screen, so the path behind an entry doesn't say whether the user
   * came from that screen or just from the drawer covering it.
   */
  backTo?: string;
} | null;

export function readRouteState(state: unknown): RouteHistoryState {
  if (!state || typeof state !== "object") return null;
  const { depth, from, backTo } = state as { depth?: unknown; from?: unknown; backTo?: unknown };
  if (typeof depth !== "number" || typeof from !== "string") return null;
  return typeof backTo === "string" ? { depth, from, backTo } : { depth, from };
}

/**
 * The path this entry offers a Back to, or null when the rail toggle is the
 * right control.
 *
 * A stamp on an entry with nothing of ours behind it is not honoured: the Back
 * it promises is `history.back()`, which would leave the app. Enforcing that
 * here is what lets callers treat "there is a backTo" as "back() is safe".
 */
export function readBackTo(state: unknown): string | null {
  const route = readRouteState(state);
  if (!route || route.depth < 1) return null;
  return route.backTo ?? null;
}

/**
 * The place a Back should return to, given where the user is now. Includes the
 * search: All chats keeps its archived view in `?view=archived`, so a pathname
 * alone would name a different list than the one being read.
 */
export function backToHere(location: { pathname: string; search: string }): string {
  return `${location.pathname}${location.search}`;
}

/** Names the destination of a Back, so the control says where it goes. */
export function backLabel(path: string): string {
  // A backTo can carry a query (/chats?view=archived), which is part of where
  // Back lands but not part of what the place is called.
  const pathname = path.split("?")[0] ?? path;
  if (pathname === "/chats") return "Back to all chats";
  const route = parsePanelRoute(pathname);
  switch (route?.kind) {
    case "automata":
      return route.selectedId ? "Back to automaton" : "Back to automata";
    case "projects":
      return route.selectedId ? "Back to project" : "Back to projects";
    case "invites":
      return "Back to invites";
    default:
      return "Back";
  }
}

/** True when history.back() lands on an entry we pushed, rather than leaving the app. */
export function canStepBack(state: unknown): boolean {
  return (readRouteState(state)?.depth ?? 0) > 0;
}

/**
 * True when the current entry was pushed from `path` — so stepping back lands
 * there. Distinguishes a mobile drill-down (the detail is its own entry, pushed
 * from the list) from a desktop selection (the detail *is* the list's entry, so
 * going back would leave the panel instead).
 */
export function cameFrom(state: unknown, path: string): boolean {
  const route = readRouteState(state);
  return route !== null && route.depth > 0 && route.from === path;
}

/** What the panel's close button should say, given the entry it would return to. */
export function closeLabel(state: unknown): string {
  const from = readRouteState(state)?.from;
  if (from?.startsWith("/threads/")) return "Back to chat";
  return "Back to chats";
}

export function nextRouteState(
  currentState: unknown,
  fromPath: string,
  backTo?: string,
): RouteHistoryState {
  const depth = readRouteState(currentState)?.depth ?? 0;
  const next = { depth: depth + 1, from: fromPath };
  return backTo ? { ...next, backTo } : next;
}
