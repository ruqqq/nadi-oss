import { describe, expect, test } from "vitest";
import { nextPanelSelection } from "./projects-panel-selection";

const ids = ["alpha", "beta"];

describe("nextPanelSelection", () => {
  test("preserves an existing selected item", () => {
    expect(nextPanelSelection("beta", ids)).toBe("beta");
  });

  test("selects the first item when the selected item is removed", () => {
    expect(nextPanelSelection("missing", ids)).toBe("alpha");
  });

  test("selects the first item when no item is selected outside create mode", () => {
    expect(nextPanelSelection(null, ids, false)).toBe("alpha");
  });

  test("preserves create mode when requested", () => {
    expect(nextPanelSelection(null, ids, true)).toBeNull();
  });

  test("clears selection when the list is empty", () => {
    expect(nextPanelSelection("alpha", [])).toBeNull();
  });
});
