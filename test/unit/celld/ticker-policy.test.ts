import { describe, expect, it } from "vitest";
import {
  DAILY_INTERVAL_MS,
  isDailyWorkDue,
  TICKER_LAST_DAILY_RUN_KEY,
  TICKER_LAST_TICK_KEY,
  TICK_INTERVAL_MS,
} from "../../../src/celld/ticker-policy";

describe("ticker policy constants", () => {
  it("ticks every minute, matching AUTOMATA_CRON's per-minute cadence", () => {
    // The eviction coupling in ticker-policy.ts spells out why this must stay
    // comfortably above the celld idle-eviction threshold (~15 s): the
    // registry cell — touched by every tick — must idle long enough between
    // ticks to be evicted and replicated.
    expect(TICK_INTERVAL_MS).toBe(60_000);
  });

  it("runs the daily sweep about once a day", () => {
    expect(DAILY_INTERVAL_MS).toBe(86_400_000);
  });

  it("keeps the liveness markers in the registry's system namespace", () => {
    expect(TICKER_LAST_TICK_KEY).toMatch(/^system\//);
    expect(TICKER_LAST_DAILY_RUN_KEY).toMatch(/^system\//);
    expect(TICKER_LAST_TICK_KEY).not.toBe(TICKER_LAST_DAILY_RUN_KEY);
  });
});

describe("isDailyWorkDue", () => {
  const now = 1_800_000_000_000;

  it("is due when the registry has never recorded a daily run (fresh or restored deployment)", () => {
    expect(isDailyWorkDue(null, now)).toBe(true);
  });

  it("is due exactly at the interval boundary", () => {
    expect(isDailyWorkDue(now - DAILY_INTERVAL_MS, now)).toBe(true);
  });

  it("is due once the interval has elapsed", () => {
    expect(isDailyWorkDue(now - DAILY_INTERVAL_MS - 60_000, now)).toBe(true);
  });

  it("is not due for a run recorded less than a day ago", () => {
    expect(isDailyWorkDue(now - DAILY_INTERVAL_MS + 1, now)).toBe(false);
  });

  it("is not due for a run recorded minutes ago", () => {
    expect(isDailyWorkDue(now - 60_000, now)).toBe(false);
  });

  it("is not due for a run recorded hours ago", () => {
    expect(isDailyWorkDue(now - 23 * 60 * 60 * 1000, now)).toBe(false);
  });
});
