import { describe, expect, it } from "vitest";
import { isThreadListEmpty } from "./thread-list-state";

describe("isThreadListEmpty", () => {
  it("is empty once the server confirms zero rows", () => {
    expect(isThreadListEmpty({ count: 0, loading: false, exhausted: true })).toBe(true);
  });

  it("is not empty while a fetch for a supposedly exhausted list is in flight (loading wins)", () => {
    expect(isThreadListEmpty({ count: 0, loading: true, exhausted: true })).toBe(false);
  });

  it("is not empty before the server has confirmed there is no more (not exhausted)", () => {
    expect(isThreadListEmpty({ count: 0, loading: false, exhausted: false })).toBe(false);
  });

  it("is not empty when rows are present", () => {
    expect(isThreadListEmpty({ count: 3, loading: false, exhausted: true })).toBe(false);
  });
});
