import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { WIDE_LAYOUT_QUERY } from "./use-wide-layout";

const indexCss = () =>
  readFileSync(fileURLToPath(new URL("../index.css", import.meta.url)), "utf8");

describe("the wide layout breakpoint", () => {
  it("is declared identically in index.css and in TS", () => {
    // The same decision is expressed twice, in two languages, in two files.
    // Nothing but this test makes them agree.
    const declared = /@custom-variant wide \(@media (.+)\);/.exec(indexCss());

    expect(declared, "no `@custom-variant wide` found in index.css").not.toBeNull();
    expect(declared?.[1]?.trim()).toBe(WIDE_LAYOUT_QUERY);
  });

  it("keeps a phone in landscape out of the two-column layout", () => {
    // Widest phone landscape in circulation (iPhone Pro Max) is ~932x430: it
    // clears the 768 width, so only the height test can catch it.
    expect(matchesQuery(WIDE_LAYOUT_QUERY, { width: 932, height: 430 })).toBe(false);
    expect(matchesQuery(WIDE_LAYOUT_QUERY, { width: 430, height: 932 })).toBe(false);
  });

  it("gives tablets and desktops the two-column layout", () => {
    expect(matchesQuery(WIDE_LAYOUT_QUERY, { width: 1024, height: 768 })).toBe(true); // iPad landscape
    expect(matchesQuery(WIDE_LAYOUT_QUERY, { width: 768, height: 1024 })).toBe(true); // iPad portrait
    expect(matchesQuery(WIDE_LAYOUT_QUERY, { width: 1440, height: 900 })).toBe(true); // desktop
  });
});

/** Evaluate the query's own terms against a viewport, without a browser. */
function matchesQuery(query: string, vp: { width: number; height: number }): boolean {
  const minWidth = Number(/min-width:\s*(\d+)px/.exec(query)?.[1]);
  const minHeight = Number(/min-height:\s*(\d+)px/.exec(query)?.[1]);
  expect(Number.isFinite(minWidth) && Number.isFinite(minHeight)).toBe(true);
  return vp.width >= minWidth && vp.height >= minHeight;
}
