import { describe, expect, it } from "vitest";
import { EDGE_GUARD_PX, shouldPreventEdgeSwipe } from "./edge-swipe-guard";

const W = 400;

describe("shouldPreventEdgeSwipe", () => {
  it("claims a horizontal swipe from the left edge (back)", () => {
    expect(
      shouldPreventEdgeSwipe({ startX: 5, startY: 200, x: 90, y: 210, innerWidth: W }),
    ).toBe(true);
  });

  it("claims a horizontal swipe from the right edge (forward)", () => {
    expect(
      shouldPreventEdgeSwipe({ startX: W - 5, startY: 200, x: W - 90, y: 205, innerWidth: W }),
    ).toBe(true);
  });

  it("ignores a swipe that starts away from either edge", () => {
    expect(
      shouldPreventEdgeSwipe({ startX: 200, startY: 200, x: 300, y: 205, innerWidth: W }),
    ).toBe(false);
  });

  it("ignores a vertical-dominant swipe at the edge (a scroll)", () => {
    expect(
      shouldPreventEdgeSwipe({ startX: 5, startY: 100, x: 20, y: 300, innerWidth: W }),
    ).toBe(false);
  });

  it("treats the boundary as inside the edge strip", () => {
    expect(
      shouldPreventEdgeSwipe({
        startX: EDGE_GUARD_PX,
        startY: 100,
        x: EDGE_GUARD_PX + 40,
        y: 105,
        innerWidth: W,
      }),
    ).toBe(true);
    expect(
      shouldPreventEdgeSwipe({
        startX: EDGE_GUARD_PX + 1,
        startY: 100,
        x: EDGE_GUARD_PX + 41,
        y: 105,
        innerWidth: W,
      }),
    ).toBe(false);
  });
});
