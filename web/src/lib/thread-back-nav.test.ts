// @vitest-environment jsdom
import { beforeEach, describe, expect, it } from "vitest";
import { backToHere, nextRouteState, readBackTo } from "./app-history";

/**
 * The stamp only pays off if it survives a real history stack, so these drive
 * `window.history` the way App does rather than passing state objects around:
 * the browser structured-clones what it stores, and a Back has to land on the
 * entry the stamp names.
 */

/** What App's navigateToThread does, reduced to the part under test. */
function navigateToThread(threadId: string, backTo?: string) {
  const path = `/threads/${encodeURIComponent(threadId)}`;
  const state = backTo
    ? nextRouteState(window.history.state, window.location.pathname, backTo)
    : null;
  window.history.pushState(state, "", path);
}

function popped(): Promise<void> {
  return new Promise((resolve) => {
    window.addEventListener("popstate", () => resolve(), { once: true });
    window.history.back();
  });
}

describe("thread back navigation", () => {
  beforeEach(() => {
    window.history.replaceState(null, "", "/chats");
  });

  it("gives a run thread a way back to the automaton it came from", async () => {
    window.history.pushState(nextRouteState(null, "/chats"), "", "/automata/auto_x");
    navigateToThread("thr_run", "/automata/auto_x");

    expect(window.location.pathname).toBe("/threads/thr_run");
    expect(readBackTo(window.history.state)).toBe("/automata/auto_x");

    // The Back button is history.back(), so it must land on the automaton.
    await popped();
    expect(window.location.pathname).toBe("/automata/auto_x");
  });

  it("leaves a thread picked from the rail with the toggle", () => {
    window.history.pushState(nextRouteState(null, "/chats"), "", "/automata/auto_x");
    // The rail is a drawer: it opens over the automata panel, so a thread picked
    // from it must NOT inherit a back button just because that panel is behind.
    navigateToThread("thr_other");

    expect(readBackTo(window.history.state)).toBeNull();
  });

  it("keeps the stamp per-entry when a rail pick follows a run thread", async () => {
    window.history.pushState(nextRouteState(null, "/chats"), "", "/automata/auto_x");
    navigateToThread("thr_run", "/automata/auto_x");
    navigateToThread("thr_other");
    expect(readBackTo(window.history.state)).toBeNull();

    // Going back to the run thread restores its back button — state lives on the
    // entry, so it can't be clobbered by wherever the user went next.
    await popped();
    expect(window.location.pathname).toBe("/threads/thr_run");
    expect(readBackTo(window.history.state)).toBe("/automata/auto_x");
  });

  it("has nothing to go back to on a deep link", () => {
    window.history.replaceState(null, "", "/threads/thr_linked");
    expect(readBackTo(window.history.state)).toBeNull();
  });

  it("returns to All chats when a thread was picked from it", async () => {
    window.history.pushState(nextRouteState(null, "/"), "", "/chats");
    navigateToThread("thr_a", backToHere(window.location));

    expect(readBackTo(window.history.state)).toBe("/chats");
    await popped();
    expect(window.location.pathname).toBe("/chats");
  });

  it("returns to the archived list, not the active one", async () => {
    // The archived view lives in a query, so a backTo built from pathname alone
    // would quietly land the user on a different list than the one they left.
    window.history.pushState(nextRouteState(null, "/"), "", "/chats?view=archived");
    navigateToThread("thr_old", backToHere(window.location));

    expect(readBackTo(window.history.state)).toBe("/chats?view=archived");
    await popped();
    expect(`${window.location.pathname}${window.location.search}`).toBe("/chats?view=archived");
  });
});
