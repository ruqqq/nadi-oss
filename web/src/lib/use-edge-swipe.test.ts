import { describe, expect, it } from "vitest";
import { FLING_VELOCITY, OPEN_PROGRESS, settlesClosed, settlesOpen } from "./use-edge-swipe";

describe("settlesOpen", () => {
  it("opens when the drag is past the threshold", () => {
    expect(settlesOpen(OPEN_PROGRESS, 0)).toBe(true);
    expect(settlesOpen(1, 0)).toBe(true);
  });

  it("falls back shut when the drag stops short", () => {
    expect(settlesOpen(OPEN_PROGRESS - 0.01, 0)).toBe(false);
    expect(settlesOpen(0, 0)).toBe(false);
  });

  it("opens on a fast flick that never got far", () => {
    // A flick is a decision, even at 10% of the width.
    expect(settlesOpen(0.1, FLING_VELOCITY)).toBe(true);
  });

  it("does not open on a slow half-drag the user thought better of", () => {
    expect(settlesOpen(0.2, 0.05)).toBe(false);
  });

  it("does not let a leftward flick open it", () => {
    // Velocity is signed: dragging back toward the edge must not count as a fling.
    expect(settlesOpen(0.2, -1)).toBe(false);
  });
});

describe("settlesClosed", () => {
  it("closes once the rail is dragged far enough out", () => {
    expect(settlesClosed(1 - OPEN_PROGRESS, 0)).toBe(true);
    expect(settlesClosed(0, 0)).toBe(true);
  });

  it("springs back open when the drag barely moved", () => {
    expect(settlesClosed(1, 0)).toBe(false);
    expect(settlesClosed(0.9, 0)).toBe(false);
  });

  it("closes on a fast leftward fling that barely moved", () => {
    expect(settlesClosed(0.95, -FLING_VELOCITY)).toBe(true);
  });

  it("does not close on a rightward fling", () => {
    // Shoving it further open must never close it.
    expect(settlesClosed(0.9, FLING_VELOCITY)).toBe(false);
  });
});
