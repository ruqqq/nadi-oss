import { describe, expect, it, vi } from "vitest";
import { ACTIVITY_EVENTS, IDLE_AFTER_MS, isUserActive, trackUserActivity } from "./user-activity";

describe("isUserActive", () => {
  it("is false whenever the page is hidden, however recent the interaction", () => {
    expect(isUserActive({ visible: false, lastInteractionAt: 1_000, now: 1_000 })).toBe(false);
  });

  it("is true just inside the idle window and false just outside it", () => {
    expect(
      isUserActive({ visible: true, lastInteractionAt: 0, now: IDLE_AFTER_MS - 1 }),
    ).toBe(true);
    expect(isUserActive({ visible: true, lastInteractionAt: 0, now: IDLE_AFTER_MS })).toBe(false);
  });

  it("catches the case this exists for: visible, ticking, nobody there", () => {
    // A tab left frontmost on a desk. `visible` says yes forever; this says no.
    expect(
      isUserActive({ visible: true, lastInteractionAt: 0, now: 30 * 60_000 }),
    ).toBe(false);
  });
});

describe("trackUserActivity", () => {
  function fakeTarget() {
    const listeners = new Map<string, EventListener>();
    return {
      listeners,
      addEventListener: vi.fn((type: string, listener: EventListener) => {
        listeners.set(type, listener);
      }),
      removeEventListener: vi.fn((type: string) => {
        listeners.delete(type);
      }),
    };
  }

  it("stamps the holder on every activity event", () => {
    const target = fakeTarget();
    const holder = { current: 0 };
    let clock = 5_000;
    trackUserActivity(holder, target, () => clock);

    for (const event of ACTIVITY_EVENTS) {
      clock += 1_000;
      target.listeners.get(event)?.(new Event(event));
      expect(holder.current).toBe(clock);
    }
  });

  it("does not stamp for an unrelated event", () => {
    const target = fakeTarget();
    const holder = { current: 0 };
    trackUserActivity(holder, target, () => 9_999);

    // Returning to a tab is `visible`'s job; a ticking tab is what we are
    // catching, so neither may count as a human being present.
    expect(target.listeners.has("visibilitychange")).toBe(false);
    expect(holder.current).toBe(0);
  });

  it("removes every listener it added", () => {
    const target = fakeTarget();
    const stop = trackUserActivity({ current: 0 }, target);
    expect(target.listeners.size).toBe(ACTIVITY_EVENTS.length);

    stop();

    expect(target.listeners.size).toBe(0);
  });
});
