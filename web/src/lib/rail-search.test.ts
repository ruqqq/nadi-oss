import { describe, expect, test } from "vitest";
import { hasOlderChats, isSearchEmpty } from "./rail-search";

describe("isSearchEmpty", () => {
  test("false when not searching, regardless of the rest", () => {
    expect(
      isSearchEmpty({
        searching: false,
        loading: false,
        exhausted: true,
        matchCount: 0,
        queryUnsettled: false,
      }),
    ).toBe(false);
  });

  test("false while the search fetch is still loading, even with zero local matches", () => {
    expect(
      isSearchEmpty({
        searching: true,
        loading: true,
        exhausted: false,
        matchCount: 0,
        queryUnsettled: false,
      }),
    ).toBe(false);
  });

  test("false until the query has settled (exhausted), even if not loading", () => {
    // e.g. the debounce window between keystrokes: not loading yet, not exhausted yet.
    expect(
      isSearchEmpty({
        searching: true,
        loading: false,
        exhausted: false,
        matchCount: 0,
        queryUnsettled: false,
      }),
    ).toBe(false);
  });

  test("false when there are matches, even if settled", () => {
    expect(
      isSearchEmpty({
        searching: true,
        loading: false,
        exhausted: true,
        matchCount: 3,
        queryUnsettled: false,
      }),
    ).toBe(false);
  });

  test("true only once searching, settled, not loading, and zero matches", () => {
    expect(
      isSearchEmpty({
        searching: true,
        loading: false,
        exhausted: true,
        matchCount: 0,
        queryUnsettled: false,
      }),
    ).toBe(true);
  });

  test("false when the debounced query hasn't caught up, even if the PREVIOUS query settled empty", () => {
    // Regression guard: `exhausted`/`loading` are keyed on the debounced
    // query while `matchCount` is keyed on the raw one. A prior query's
    // settled `exhausted: true` must never be read as the new query's answer
    // during the debounce window.
    expect(
      isSearchEmpty({
        searching: true,
        loading: false,
        exhausted: true,
        matchCount: 0,
        queryUnsettled: true,
      }),
    ).toBe(false);
  });
});

describe("hasOlderChats", () => {
  test("false when there is no next page and the count is under the cap", () => {
    expect(hasOlderChats({ threadsNextCursor: null, threadCount: 10, recentLimit: 15 })).toBe(
      false,
    );
  });

  test("true when the server says there is another page, even under the local cap", () => {
    // e.g. page one merged only a handful of threads locally, but the server
    // has more — a count derived from array length alone would miss this.
    expect(hasOlderChats({ threadsNextCursor: "cursor_1", threadCount: 5, recentLimit: 15 })).toBe(
      true,
    );
  });

  test("true when the merged array already exceeds the cap, even with no next cursor", () => {
    expect(hasOlderChats({ threadsNextCursor: null, threadCount: 16, recentLimit: 15 })).toBe(
      true,
    );
  });

  test("false at exactly the cap", () => {
    expect(hasOlderChats({ threadsNextCursor: null, threadCount: 15, recentLimit: 15 })).toBe(
      false,
    );
  });
});
