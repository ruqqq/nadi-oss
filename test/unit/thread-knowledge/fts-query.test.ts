import { describe, expect, it } from "vitest";
import { buildFtsMatchQuery } from "../../../src/thread-knowledge/fts-query";

describe("buildFtsMatchQuery", () => {
  it("quotes tokens and joins with AND", () => {
    expect(buildFtsMatchQuery("deployment Friday")).toBe('"deployment" AND "Friday"');
    expect(buildFtsMatchQuery('alpha OR "beta"')).toBe('"alpha" AND "OR" AND "beta"');
    expect(buildFtsMatchQuery("café 東京")).toBe('"café" AND "東京"');
  });

  it("rejects empty and overlong queries", () => {
    expect(() => buildFtsMatchQuery("   ")).toThrow("empty_search_query");
    expect(() => buildFtsMatchQuery("x".repeat(501))).toThrow("search_query_too_long");
  });
});
