import { useMediaQuery } from "./use-media-query";

/**
 * The viewport shape that earns the two-column layout (pinned rail): a tablet
 * or desktop, NOT merely a wide viewport.
 *
 * A phone in landscape is ~932x430 — wide enough to clear 768, so width alone
 * hands it the tablet layout. Height breaks the tie: phone landscapes top out
 * near 480px tall, while the shortest tablet landscape (iPad) is 768. 600 sits
 * in the gap.
 *
 * Must stay identical to the `wide` @custom-variant in index.css, which is the
 * CSS half of the same decision — use-wide-layout.test.ts asserts they match.
 */
export const WIDE_LAYOUT_QUERY = "(min-width: 768px) and (min-height: 600px)";

/** True when the layout should be two-column. `wide:` is the CSS equivalent. */
export function useWideLayout(): boolean {
  return useMediaQuery(WIDE_LAYOUT_QUERY);
}
