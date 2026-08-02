import { describe, expect, it } from "vitest";
import { panelDetailPath, panelListPath, panelPath, parsePanelRoute } from "./panel-routes";

describe("parsePanelRoute", () => {
  it("reads the list routes", () => {
    expect(parsePanelRoute("/projects")).toEqual({ kind: "projects", selectedId: null });
    expect(parsePanelRoute("/automata")).toEqual({ kind: "automata", selectedId: null });
    expect(parsePanelRoute("/invites")).toEqual({ kind: "invites", selectedId: null });
    expect(parsePanelRoute("/admin/feedback")).toEqual({
      kind: "feedback-inbox",
      selectedId: null,
    });
  });

  it("reads the detail routes", () => {
    expect(parsePanelRoute("/projects/proj_abc")).toEqual({
      kind: "projects",
      selectedId: "proj_abc",
    });
    expect(parsePanelRoute("/automata/auto_abc")).toEqual({
      kind: "automata",
      selectedId: "auto_abc",
    });
    expect(parsePanelRoute("/admin/feedback/fbr_abc")).toEqual({
      kind: "feedback-inbox",
      selectedId: "fbr_abc",
    });
  });

  it("tolerates trailing slashes", () => {
    expect(parsePanelRoute("/projects/")).toEqual({ kind: "projects", selectedId: null });
    expect(parsePanelRoute("/automata/auto_abc/")).toEqual({
      kind: "automata",
      selectedId: "auto_abc",
    });
    expect(parsePanelRoute("/admin/feedback/fbr_abc/")).toEqual({
      kind: "feedback-inbox",
      selectedId: "fbr_abc",
    });
  });

  it("decodes escaped ids, and survives a malformed escape", () => {
    expect(parsePanelRoute("/projects/proj%20one")).toEqual({
      kind: "projects",
      selectedId: "proj one",
    });
    expect(parsePanelRoute("/admin/feedback/fbr%20one")).toEqual({
      kind: "feedback-inbox",
      selectedId: "fbr one",
    });
    expect(parsePanelRoute("/projects/proj%")).toEqual({ kind: "projects", selectedId: "proj%" });
  });

  it("returns null for non-panel paths", () => {
    expect(parsePanelRoute("/")).toBeNull();
    expect(parsePanelRoute("/chats")).toBeNull();
    expect(parsePanelRoute("/threads/thr_abc")).toBeNull();
    expect(parsePanelRoute("/settings")).toBeNull();
  });
});

describe("panel paths", () => {
  it("round-trips every panel route", () => {
    const cases = [
      { kind: "projects", selectedId: null },
      { kind: "projects", selectedId: "proj_abc" },
      { kind: "automata", selectedId: null },
      { kind: "automata", selectedId: "auto_abc" },
      { kind: "invites", selectedId: null },
      { kind: "feedback-inbox", selectedId: null },
      { kind: "feedback-inbox", selectedId: "fbr_abc" },
    ] as const;

    for (const route of cases) {
      expect(parsePanelRoute(panelPath(route.kind, route.selectedId))).toEqual(route);
    }
  });

  it("escapes ids in detail paths", () => {
    expect(panelDetailPath("projects", "proj one")).toBe("/projects/proj%20one");
    expect(panelDetailPath("feedback-inbox", "fbr one")).toBe("/admin/feedback/fbr%20one");
  });

  it("points a detail view back at its list", () => {
    expect(panelListPath("projects")).toBe("/projects");
    expect(panelListPath("automata")).toBe("/automata");
    expect(panelListPath("feedback-inbox")).toBe("/admin/feedback");
  });

  it("leaves repositories to Settings — they are not a panel route", () => {
    // /settings/repositories owns them now; a project id sits directly under /projects.
    expect(parsePanelRoute("/projects/repo_abc")).toEqual({
      kind: "projects",
      selectedId: "repo_abc",
    });
  });
});
