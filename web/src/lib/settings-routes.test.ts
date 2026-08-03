import { describe, expect, it } from "vitest";
import {
  MCP_RETURN_PATH_KEY,
  SETTINGS_TABS,
  isOnboardingPath,
  isSettingsPath,
  parseSettingsTab,
  parseWorkbenchesRoute,
  settingsPath,
  takeMcpReturnPath,
  workbenchesPath,
} from "./settings-routes";

describe("isSettingsPath", () => {
  it("matches settings, with or without a tab", () => {
    expect(isSettingsPath("/settings")).toBe(true);
    expect(isSettingsPath("/settings/tools")).toBe(true);
  });

  it("does not match other routes", () => {
    expect(isSettingsPath("/")).toBe(false);
    expect(isSettingsPath("/chats")).toBe(false);
    // Guard against a startsWith("/settings") that would swallow a sibling route.
    expect(isSettingsPath("/settings-export")).toBe(false);
  });
});

describe("parseSettingsTab", () => {
  it("round-trips every tab", () => {
    for (const tab of SETTINGS_TABS) {
      expect(parseSettingsTab(settingsPath(tab))).toBe(tab);
    }
  });

  it("falls back to general for a missing or unknown tab", () => {
    expect(parseSettingsTab("/settings")).toBe("general");
    expect(parseSettingsTab("/settings/nope")).toBe("general");
  });
});

describe("parseWorkbenchesRoute", () => {
  it("returns null selectedId for the bare tab (the list)", () => {
    expect(parseWorkbenchesRoute("/settings/workbenches")).toEqual({
      tab: "workbenches",
      selectedId: null,
    });
  });

  it("returns \"new\" for the create form", () => {
    expect(parseWorkbenchesRoute("/settings/workbenches/new")).toEqual({
      tab: "workbenches",
      selectedId: "new",
    });
  });

  it("returns the id for a selected workbench", () => {
    expect(parseWorkbenchesRoute("/settings/workbenches/wb_123")).toEqual({
      tab: "workbenches",
      selectedId: "wb_123",
    });
  });

  it("returns null when the path is not under the workbenches tab", () => {
    expect(parseWorkbenchesRoute("/settings/repositories")).toBeNull();
    expect(parseWorkbenchesRoute("/settings")).toBeNull();
    expect(parseWorkbenchesRoute("/projects/abc")).toBeNull();
  });

  it("decodes an escaped id", () => {
    expect(parseWorkbenchesRoute("/settings/workbenches/wb%20123")).toEqual({
      tab: "workbenches",
      selectedId: "wb 123",
    });
  });
});

describe("workbenchesPath", () => {
  it("round-trips list, new, and an id through the parser", () => {
    for (const selectedId of [null, "new", "wb_123"] as const) {
      expect(parseWorkbenchesRoute(workbenchesPath(selectedId))?.selectedId).toBe(selectedId);
    }
  });

  it("still parses as the workbenches tab via parseSettingsTab", () => {
    expect(parseSettingsTab(workbenchesPath("wb_1"))).toBe("workbenches");
    expect(parseSettingsTab(workbenchesPath("new"))).toBe("workbenches");
  });
});

function storageWith(value: string | null) {
  const removed: string[] = [];
  return {
    removed,
    getItem: () => value,
    removeItem: (key: string) => removed.push(key),
  };
}

describe("isOnboardingPath", () => {
  it("accepts the forced-onboarding root with a step", () => {
    expect(isOnboardingPath("/?onboarding=force&step=empower")).toBe(true);
  });

  it("rejects the root without the force flag", () => {
    expect(isOnboardingPath("/")).toBe(false);
    expect(isOnboardingPath("/?step=empower")).toBe(false);
  });

  it("rejects any other path even when it carries the flag", () => {
    expect(isOnboardingPath("/threads/abc?onboarding=force")).toBe(false);
    expect(isOnboardingPath("https://evil.example/?onboarding=force")).toBe(false);
  });
});

describe("takeMcpReturnPath", () => {
  it("restores an onboarding path", () => {
    const storage = storageWith("/?onboarding=force&step=empower");
    expect(takeMcpReturnPath(storage)).toBe("/?onboarding=force&step=empower");
    expect(storage.removed).toEqual([MCP_RETURN_PATH_KEY]);
  });

  it("still restores a settings path", () => {
    expect(takeMcpReturnPath(storageWith("/settings/tools"))).toBe("/settings/tools");
  });

  it("still rejects anything else, and consumes it either way", () => {
    const storage = storageWith("/threads/abc");
    expect(takeMcpReturnPath(storage)).toBe(null);
    expect(storage.removed).toEqual([MCP_RETURN_PATH_KEY]);
  });
});
