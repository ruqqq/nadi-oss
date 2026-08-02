import { describe, expect, test } from "vitest";
import { formatAbsoluteDate, formatCreatedAt, formatRelativeTime } from "./thread-time";

const NOW = Date.UTC(2026, 6, 8, 12, 0, 0); // 2026-07-08T12:00:00Z
const sec = 1000;
const min = 60 * sec;
const hr = 60 * min;
const day = 24 * hr;

describe("formatRelativeTime", () => {
  test("recent is 'just now'", () => {
    expect(formatRelativeTime(NOW - 10 * sec, NOW)).toBe("just now");
    expect(formatRelativeTime(NOW, NOW)).toBe("just now");
  });

  test("minutes / hours / days / weeks", () => {
    expect(formatRelativeTime(NOW - 5 * min, NOW)).toBe("5m ago");
    expect(formatRelativeTime(NOW - 3 * hr, NOW)).toBe("3h ago");
    expect(formatRelativeTime(NOW - 2 * day, NOW)).toBe("2d ago");
    expect(formatRelativeTime(NOW - 21 * day, NOW)).toBe("3w ago");
  });

  test("older than ~5 weeks falls back to an absolute date", () => {
    const old = NOW - 60 * day;
    expect(formatRelativeTime(old, NOW)).toBe(formatAbsoluteDate(old));
  });

  test("future timestamps read as 'just now', not negative", () => {
    expect(formatRelativeTime(NOW + 5 * min, NOW)).toBe("just now");
  });

  test("invalid input yields a dash", () => {
    expect(formatRelativeTime(Number.NaN, NOW)).toBe("—");
    expect(formatAbsoluteDate(Number.NaN)).toBe("—");
  });
});

describe("formatCreatedAt", () => {
  test("combines absolute date with a relative suffix", () => {
    expect(formatCreatedAt(NOW - 2 * hr, NOW)).toBe(`${formatAbsoluteDate(NOW - 2 * hr)} · 2h ago`);
  });

  test("invalid input yields a dash", () => {
    expect(formatCreatedAt(Number.NaN, NOW)).toBe("—");
  });
});
