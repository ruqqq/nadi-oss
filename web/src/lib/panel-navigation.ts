import { nextRouteState } from "./app-history";

/** The slice of History/Location these need — so they can be driven in a test. */
export type HistoryLike = Pick<History, "pushState" | "replaceState" | "back"> & {
  readonly state: unknown;
};
export type LocationLike = { readonly pathname: string };

/**
 * Go to `path`, stamping the new entry with its depth and the path it came from.
 * The stamp is what lets a later "up one level" tell an entry we pushed from a
 * deep link with nothing behind it.
 */
export function pushPath(history: HistoryLike, location: LocationLike, path: string): void {
  if (location.pathname === path) return;
  history.pushState(nextRouteState(history.state, location.pathname), "", path);
}

/**
 * Swap the current entry for `path`, keeping its stamp. Used where a change is a
 * different view of the same place rather than a new one — switching tabs,
 * landing on the first item of a list, or clearing a deleted item's id.
 */
export function replacePath(history: HistoryLike, location: LocationLike, path: string): void {
  if (location.pathname === path) return;
  history.replaceState(history.state, "", path);
}
