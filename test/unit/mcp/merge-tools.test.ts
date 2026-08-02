import { describe, it, expect } from "vitest";
import { mergeServerTools } from "../../../src/mcp/merge-tools";

describe("mergeServerTools", () => {
  it("defaults an unconfigured tool to approval_required", () => {
    const merged = mergeServerTools([{ name: "search", description: "Find" }], {});
    expect(merged).toEqual([{ name: "search", description: "Find", policy: "approval_required" }]);
  });

  it("applies a stored policy when present and defaults the rest", () => {
    const merged = mergeServerTools(
      [
        { name: "search", description: null },
        { name: "write", description: null },
      ],
      { search: "auto_allow" },
    );
    expect(merged.find((t) => t.name === "search")?.policy).toBe("auto_allow");
    expect(merged.find((t) => t.name === "write")?.policy).toBe("approval_required");
  });

  it("preserves tool order and descriptions", () => {
    const merged = mergeServerTools(
      [
        { name: "a", description: "first" },
        { name: "b", description: null },
      ],
      { b: "deny" },
    );
    expect(merged.map((t) => t.name)).toEqual(["a", "b"]);
    expect(merged[0]?.description).toBe("first");
  });
});
