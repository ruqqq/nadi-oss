import { describe, expect, it } from "vitest";
import {
  PRESENCE_FRESHNESS_MS,
  hasFreshVisiblePresence,
  hasFreshVisibleThreadPresence,
} from "../../../src/agent/user-presence";

const now = 1_000_000;
const fresh = { activeThreadId: "thr_a", visible: true, updatedAt: now };

describe("hasFreshVisiblePresence", () => {
  it("is true for a visible client whatever it is looking at", () => {
    // The whole point of the broader predicate: a user sitting on the chat list
    // or on some other thread is still using the app.
    expect(hasFreshVisiblePresence([{ ...fresh, activeThreadId: null }], now)).toBe(true);
    expect(hasFreshVisiblePresence([{ ...fresh, activeThreadId: "thr_other" }], now)).toBe(true);
  });

  it("is false for a hidden client", () => {
    expect(hasFreshVisiblePresence([{ ...fresh, visible: false }], now)).toBe(false);
  });

  it("is false once the heartbeat goes stale", () => {
    // A phone that slept, or wifi that died, leaves a socket the runtime has not
    // torn down yet. Suppressing on that would drop the notification entirely.
    expect(hasFreshVisiblePresence([fresh], now + PRESENCE_FRESHNESS_MS)).toBe(true);
    expect(hasFreshVisiblePresence([fresh], now + PRESENCE_FRESHNESS_MS + 1)).toBe(false);
  });

  it("is false with no clients, or with a socket that never sent presence", () => {
    expect(hasFreshVisiblePresence([], now)).toBe(false);
    expect(hasFreshVisiblePresence([undefined], now)).toBe(false);
  });

  it("takes any visible client, not the first one", () => {
    expect(hasFreshVisiblePresence([{ ...fresh, visible: false }, fresh], now)).toBe(true);
  });
});

describe("hasFreshVisibleThreadPresence", () => {
  it("still requires the matching thread — it drives unread state, not push", () => {
    expect(hasFreshVisibleThreadPresence([fresh], "thr_a", now)).toBe(true);
    expect(hasFreshVisibleThreadPresence([fresh], "thr_other", now)).toBe(false);
    expect(hasFreshVisibleThreadPresence([{ ...fresh, activeThreadId: null }], "thr_a", now)).toBe(
      false,
    );
  });

  it("applies the same freshness and visibility rules", () => {
    expect(hasFreshVisibleThreadPresence([{ ...fresh, visible: false }], "thr_a", now)).toBe(false);
    expect(hasFreshVisibleThreadPresence([fresh], "thr_a", now + PRESENCE_FRESHNESS_MS + 1)).toBe(
      false,
    );
  });
});

describe("hasFreshVisiblePresence — idle clients", () => {
  it("does not count a visible tab nobody is at", () => {
    // The reported hole: a laptop tab left frontmost heartbeats `visible: true`
    // forever and silenced push on every device.
    expect(hasFreshVisiblePresence([{ ...fresh, active: false }], now)).toBe(false);
  });

  it("counts a visible tab that is being used", () => {
    expect(hasFreshVisiblePresence([{ ...fresh, active: true }], now)).toBe(true);
  });

  it("falls back to `visible` for a client that does not report activity", () => {
    // An older build still running against a new worker keeps the behaviour it
    // had, rather than suddenly pushing on every turn.
    expect(hasFreshVisiblePresence([fresh], now)).toBe(true);
  });

  it("still requires freshness — an idle flag cannot revive a stale beat", () => {
    expect(hasFreshVisiblePresence([{ ...fresh, active: true }], now + 46_000)).toBe(false);
  });

  it("takes any ACTIVE client, not merely any visible one", () => {
    expect(
      hasFreshVisiblePresence(
        [
          { ...fresh, active: false },
          { ...fresh, active: true },
        ],
        now,
      ),
    ).toBe(true);
  });

  it("leaves unread state alone — that asks about visibility, not attention", () => {
    // A thread you are sitting in front of must not start marking itself unread
    // just because you paused for a minute.
    expect(hasFreshVisibleThreadPresence([{ ...fresh, active: false }], "thr_a", now)).toBe(true);
  });
});
