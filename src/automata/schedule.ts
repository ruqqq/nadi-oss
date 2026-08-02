import { CronExpressionParser } from "cron-parser";

/**
 * Presets are a UI affordance, not a second engine: each normalizes to a cron
 * expression, so `computeNextDueAt` has exactly one evaluation path and the raw
 * cron escape hatch is that same path with no normalization step.
 */
export type AutomatonSchedule =
  | { kind: "hourly"; minute: number }
  | { kind: "daily"; hour: number; minute: number }
  | { kind: "weekdays"; hour: number; minute: number }
  | { kind: "weekly"; weekday: number; hour: number; minute: number }
  | { kind: "cron"; expr: string };

const WEEKDAY_NAMES = [
  "Sundays",
  "Mondays",
  "Tuesdays",
  "Wednesdays",
  "Thursdays",
  "Fridays",
  "Saturdays",
];

export function scheduleToCron(schedule: AutomatonSchedule): string {
  switch (schedule.kind) {
    case "hourly":
      return `${schedule.minute} * * * *`;
    case "daily":
      return `${schedule.minute} ${schedule.hour} * * *`;
    case "weekdays":
      return `${schedule.minute} ${schedule.hour} * * 1-5`;
    case "weekly":
      return `${schedule.minute} ${schedule.hour} * * ${schedule.weekday}`;
    case "cron":
      return schedule.expr;
  }
}

export function isValidTimezone(timezone: string): boolean {
  try {
    new Intl.DateTimeFormat("en-US", { timeZone: timezone });
    return true;
  } catch {
    return false;
  }
}

/**
 * `currentDate` is exclusive, so passing a run's own `dueAt` yields the NEXT
 * occurrence rather than repeating the one that just fired.
 */
export function computeNextDueAt(
  schedule: AutomatonSchedule,
  timezone: string,
  after: number,
): number {
  const iterator = CronExpressionParser.parse(scheduleToCron(schedule), {
    currentDate: new Date(after),
    tz: timezone,
  });
  return iterator.next().toDate().getTime();
}

function invalid(reason: string): never {
  throw new Error(`invalid schedule: ${reason}`);
}

function intInRange(value: unknown, min: number, max: number, field: string): number {
  if (typeof value !== "number" || !Number.isInteger(value) || value < min || value > max) {
    invalid(`${field} must be an integer in [${min}, ${max}]`);
  }
  return value;
}

export function parseSchedule(json: string): AutomatonSchedule {
  let raw: unknown;
  try {
    raw = JSON.parse(json);
  } catch {
    invalid("not valid JSON");
  }
  if (typeof raw !== "object" || raw === null) invalid("not an object");
  const value = raw as Record<string, unknown>;

  switch (value.kind) {
    case "hourly":
      return { kind: "hourly", minute: intInRange(value.minute, 0, 59, "minute") };
    case "daily":
      return {
        kind: "daily",
        hour: intInRange(value.hour, 0, 23, "hour"),
        minute: intInRange(value.minute, 0, 59, "minute"),
      };
    case "weekdays":
      return {
        kind: "weekdays",
        hour: intInRange(value.hour, 0, 23, "hour"),
        minute: intInRange(value.minute, 0, 59, "minute"),
      };
    case "weekly":
      return {
        kind: "weekly",
        weekday: intInRange(value.weekday, 0, 6, "weekday"),
        hour: intInRange(value.hour, 0, 23, "hour"),
        minute: intInRange(value.minute, 0, 59, "minute"),
      };
    case "cron": {
      if (typeof value.expr !== "string") invalid("expr must be a string");
      try {
        CronExpressionParser.parse(value.expr);
      } catch {
        invalid(`cron expression does not parse: ${value.expr}`);
      }
      return { kind: "cron", expr: value.expr };
    }
    default:
      invalid(`unknown kind: ${String(value.kind)}`);
  }
}

const pad = (n: number) => String(n).padStart(2, "0");

export function describeSchedule(schedule: AutomatonSchedule): string {
  switch (schedule.kind) {
    case "hourly":
      return `Hourly at :${pad(schedule.minute)}`;
    case "daily":
      return `Daily at ${pad(schedule.hour)}:${pad(schedule.minute)}`;
    case "weekdays":
      return `Weekdays at ${pad(schedule.hour)}:${pad(schedule.minute)}`;
    case "weekly":
      return `${WEEKDAY_NAMES[schedule.weekday]} at ${pad(schedule.hour)}:${pad(schedule.minute)}`;
    case "cron":
      return `Custom (${schedule.expr})`;
  }
}
