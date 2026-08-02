import { describe, expect, it } from "vitest";
import {
  backLabel,
  backToHere,
  canStepBack,
  closeLabel,
  nextRouteState,
  readBackTo,
  readRouteState,
} from "./app-history";

describe("readRouteState", () => {
  it("accepts an entry we stamped", () => {
    expect(readRouteState({ depth: 2, from: "/chats" })).toEqual({ depth: 2, from: "/chats" });
  });

  it("rejects entries that aren't ours", () => {
    // A deep link, a reload, or a foreign pushState all land here.
    expect(readRouteState(null)).toBeNull();
    expect(readRouteState(undefined)).toBeNull();
    expect(readRouteState("nope")).toBeNull();
    expect(readRouteState({ depth: "2", from: "/chats" })).toBeNull();
    expect(readRouteState({ depth: 2 })).toBeNull();
  });
});

describe("canStepBack", () => {
  it("is false on a deep link, so Back can't leave the app", () => {
    expect(canStepBack(null)).toBe(false);
    expect(canStepBack({ depth: 0, from: "/chats" })).toBe(false);
  });

  it("is true once we've pushed an entry", () => {
    expect(canStepBack({ depth: 1, from: "/chats" })).toBe(true);
  });
});

describe("closeLabel", () => {
  it("names the thread you came from", () => {
    expect(closeLabel({ depth: 1, from: "/threads/thr_abc" })).toBe("Back to chat");
  });

  it("falls back to chats for every other origin", () => {
    expect(closeLabel({ depth: 1, from: "/chats" })).toBe("Back to chats");
    expect(closeLabel({ depth: 1, from: "/" })).toBe("Back to chats");
    expect(closeLabel(null)).toBe("Back to chats");
  });
});

describe("nextRouteState", () => {
  it("counts depth up from the current entry", () => {
    expect(nextRouteState(null, "/chats")).toEqual({ depth: 1, from: "/chats" });
    expect(nextRouteState({ depth: 1, from: "/chats" }, "/automata")).toEqual({
      depth: 2,
      from: "/automata",
    });
  });

  it("treats a foreign entry as the floor", () => {
    expect(nextRouteState("nope", "/chats")).toEqual({ depth: 1, from: "/chats" });
  });

  it("carries a backTo only when one is given", () => {
    expect(nextRouteState(null, "/automata/auto_x", "/automata/auto_x")).toEqual({
      depth: 1,
      from: "/automata/auto_x",
      backTo: "/automata/auto_x",
    });
    // Absent, not undefined: the key must not exist, or an entry from the rail
    // would look stamped to anything doing a key check.
    expect(nextRouteState(null, "/chats")).not.toHaveProperty("backTo");
  });
});

describe("readBackTo", () => {
  it("is null for a thread opened from the rail, so the toggle stays", () => {
    // The rail pushes an unstamped entry; a deep link has no state at all.
    expect(readBackTo(null)).toBeNull();
    expect(readBackTo({ depth: 1, from: "/chats" })).toBeNull();
  });

  it("names the place a run thread came from", () => {
    expect(readBackTo({ depth: 2, from: "/automata/auto_x", backTo: "/automata/auto_x" })).toBe(
      "/automata/auto_x",
    );
  });

  it("ignores a backTo that isn't a string", () => {
    expect(readBackTo({ depth: 1, from: "/chats", backTo: 7 })).toBeNull();
  });

  it("won't honour a stamp with nothing of ours behind it", () => {
    // Back is history.back(); at depth 0 that leaves the app. Callers rely on
    // "there is a backTo" meaning "back() is safe", so it must not report one.
    expect(readBackTo({ depth: 0, from: "/chats", backTo: "/chats" })).toBeNull();
  });

  it("keeps the query, so Back returns to the list actually being read", () => {
    expect(
      readBackTo({ depth: 1, from: "/chats", backTo: "/chats?view=archived" }),
    ).toBe("/chats?view=archived");
  });

  it("survives a round trip through structured clone, as history.state does", () => {
    // history.state is cloned by the browser, so the stamp must be plain data —
    // a lost backTo here would silently downgrade Back to a hamburger.
    const state = nextRouteState(null, "/automata/auto_x", "/automata/auto_x");
    expect(readBackTo(structuredClone(state))).toBe("/automata/auto_x");
  });
});

describe("backLabel", () => {
  it("names the automaton a run thread returns to", () => {
    expect(backLabel("/automata/auto_x")).toBe("Back to automaton");
    expect(backLabel("/automata")).toBe("Back to automata");
  });

  it("names the other panels", () => {
    expect(backLabel("/projects/proj_x")).toBe("Back to project");
    expect(backLabel("/projects")).toBe("Back to projects");
    expect(backLabel("/invites")).toBe("Back to invites");
  });

  it("names All chats, archived or not — the view is not a different place", () => {
    expect(backLabel("/chats")).toBe("Back to all chats");
    expect(backLabel("/chats?view=archived")).toBe("Back to all chats");
  });

  it("stays generic rather than guessing at a path with no name", () => {
    expect(backLabel("/threads/thr_abc")).toBe("Back");
  });
});

describe("backToHere", () => {
  it("keeps the search, so the archived list is a distinct destination", () => {
    // App builds every backTo through this, so forgetting the query here is the
    // one way a Back lands on the wrong list.
    expect(backToHere({ pathname: "/chats", search: "?view=archived" })).toBe(
      "/chats?view=archived",
    );
    expect(backToHere({ pathname: "/chats", search: "" })).toBe("/chats");
    expect(backToHere({ pathname: "/automata/auto_x", search: "" })).toBe("/automata/auto_x");
  });
});
