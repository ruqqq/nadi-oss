// @vitest-environment jsdom

import { beforeEach, describe, expect, it } from "vitest";
import { cameFrom, canStepBack, closeLabel } from "./app-history";
import { panelListPath, panelPath } from "./panel-routes";
import { pushPath, replacePath } from "./panel-navigation";

/**
 * The real journeys, against the real History. These are the sequences the back
 * button has to survive: the arrow in the panel and the browser's own Back must
 * land in the same place at every level.
 */

/** history.back() is async — popstate lands on a later task. */
function back(): Promise<string> {
  return new Promise((resolve) => {
    window.addEventListener("popstate", () => resolve(window.location.pathname), { once: true });
    window.history.back();
  });
}

/** "Up one level", exactly as App does it: step back when the entry is ours. */
async function stepUp(fallbackPath: string): Promise<string> {
  if (canStepBack(window.history.state)) return back();
  replacePath(window.history, window.location, fallbackPath);
  return window.location.pathname;
}

beforeEach(() => {
  // A fresh, unstamped entry — as if the app had just loaded here.
  window.history.replaceState(null, "", "/chats");
});

describe("opening a panel from a thread", () => {
  it("returns to that thread, not to /chats", async () => {
    window.history.replaceState(null, "", "/threads/thr_1");

    pushPath(window.history, window.location, panelListPath("automata"));
    expect(window.location.pathname).toBe("/automata");
    // The close button names where it will actually land.
    expect(closeLabel(window.history.state)).toBe("Back to chat");

    expect(await stepUp("/chats")).toBe("/threads/thr_1");
  });
});

describe("mobile drill-down", () => {
  it("steps list → detail → list → back where it came from", async () => {
    window.history.replaceState(null, "", "/threads/thr_1");
    pushPath(window.history, window.location, panelListPath("automata"));

    // Mobile pushes: the detail replaces the list on screen, so it's a level.
    pushPath(window.history, window.location, panelPath("automata", "auto_1"));
    expect(window.location.pathname).toBe("/automata/auto_1");

    // The panel's back arrow, and the browser's Back, agree: up to the list.
    expect(await stepUp(panelListPath("automata"))).toBe("/automata");
    // And again: out of the panel, to the thread we came from.
    expect(await stepUp("/chats")).toBe("/threads/thr_1");
  });

  it("browser Back from a detail lands on the list, same as the arrow", async () => {
    window.history.replaceState(null, "", "/threads/thr_1");
    pushPath(window.history, window.location, panelListPath("automata"));
    pushPath(window.history, window.location, panelPath("automata", "auto_1"));

    expect(await back()).toBe("/automata");
  });
});

describe("desktop selection", () => {
  it("does not stack history — both panes are already on screen", async () => {
    window.history.replaceState(null, "", "/threads/thr_1");
    pushPath(window.history, window.location, panelListPath("automata"));

    // Desktop replaces: picking an item is not a navigation there.
    replacePath(window.history, window.location, panelPath("automata", "auto_1"));
    replacePath(window.history, window.location, panelPath("automata", "auto_2"));
    expect(window.location.pathname).toBe("/automata/auto_2");

    // So closing still leaves the panel in one step, rather than walking back
    // through every automaton the user clicked.
    expect(await stepUp("/chats")).toBe("/threads/thr_1");
  });
});

describe("deep links", () => {
  it("steps up to the list instead of leaving the app", async () => {
    // A pasted link: nothing of ours behind this entry.
    window.history.replaceState(null, "", "/automata/auto_1");
    expect(canStepBack(window.history.state)).toBe(false);

    expect(await stepUp(panelListPath("automata"))).toBe("/automata");
  });

  it("labels close honestly when there is no thread to return to", () => {
    window.history.replaceState(null, "", "/projects/proj_1");
    expect(closeLabel(window.history.state)).toBe("Back to chats");
  });
});

/** "Back to the list", exactly as App does it after a delete or a back arrow. */
async function returnToList(kind: "automata" | "projects"): Promise<string> {
  const listPath = panelListPath(kind);
  if (cameFrom(window.history.state, listPath)) return back();
  replacePath(window.history, window.location, listPath);
  return window.location.pathname;
}

describe("deleting an item", () => {
  it("leaves no dead Back press behind on mobile", async () => {
    window.history.replaceState(null, "", "/chats");
    pushPath(window.history, window.location, panelListPath("automata"));
    pushPath(window.history, window.location, panelPath("automata", "auto_1"));

    // Deleting pops the detail entry rather than replacing it — otherwise the
    // list entry it was pushed from would still sit behind it, and the next Back
    // would land on the same URL and look like it did nothing.
    expect(await returnToList("automata")).toBe("/automata");

    // So the very next Back actually leaves the panel.
    expect(await back()).toBe("/chats");
  });

  it("stays in the panel on desktop, where the detail is not its own entry", async () => {
    window.history.replaceState(null, "", "/threads/thr_1");
    pushPath(window.history, window.location, panelListPath("automata"));
    // Desktop selection replaced, so the current entry came from the thread.
    replacePath(window.history, window.location, panelPath("automata", "auto_1"));

    // Stepping back here would leave the panel entirely, so it must replace.
    expect(await returnToList("automata")).toBe("/automata");
    // The thread is still the entry behind us — the panel wasn't torn down.
    expect(await back()).toBe("/threads/thr_1");
  });

  it("never leaves an entry pointing at the deleted item", async () => {
    window.history.replaceState(null, "", "/chats");
    pushPath(window.history, window.location, panelListPath("automata"));
    pushPath(window.history, window.location, panelPath("automata", "auto_1"));
    await returnToList("automata");

    expect(await back()).toBe("/chats");
  });
});
