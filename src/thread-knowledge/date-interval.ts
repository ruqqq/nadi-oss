import type { DateInterval } from "./types";

export type DateIntervalInput = {
  since?: string;
  until?: string;
};

export function parseDateInterval(input: DateIntervalInput): DateInterval {
  const interval: DateInterval = {};

  if (input.since !== undefined) {
    const since = Date.parse(input.since);
    if (!Number.isFinite(since)) {
      throw new Error("invalid_since");
    }
    interval.since = since;
  }

  if (input.until !== undefined) {
    const until = Date.parse(input.until);
    if (!Number.isFinite(until)) {
      throw new Error("invalid_until");
    }
    interval.until = until;
  }

  if (
    interval.since !== undefined &&
    interval.until !== undefined &&
    interval.since >= interval.until
  ) {
    throw new Error("invalid_interval");
  }

  return interval;
}

export function timestampInInterval(
  createdAt: number | null | undefined,
  interval: DateInterval,
): boolean {
  if (createdAt === null || createdAt === undefined) {
    return interval.since === undefined && interval.until === undefined;
  }
  if (interval.since !== undefined && createdAt < interval.since) {
    return false;
  }
  if (interval.until !== undefined && createdAt >= interval.until) {
    return false;
  }
  return true;
}
