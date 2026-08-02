import { describe, expect, test } from "vitest";
import { buildProjectThreadQuery } from "./project-thread-filter";

describe("buildProjectThreadQuery", () => {
  test("returns an empty query for the all filter", () => {
    expect(buildProjectThreadQuery("all")).toEqual({});
  });

  test("returns the unassigned query for the unassigned filter", () => {
    expect(buildProjectThreadQuery("unassigned")).toEqual({ project: "unassigned" });
  });

  test("returns the projectId query for a project filter", () => {
    expect(buildProjectThreadQuery("proj_123")).toEqual({ projectId: "proj_123" });
  });
});
