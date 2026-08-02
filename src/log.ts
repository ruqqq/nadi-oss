type Level = "debug" | "info" | "warn" | "error";

const order: Record<Level, number> = {
  debug: 10,
  info: 20,
  warn: 30,
  error: 40,
};

let currentLevel: Level = "debug";

export function setLogLevel(level: string | undefined): void {
  currentLevel = isLevel(level) ? level : "debug";
}

export const log = {
  debug: (event: string, fields?: Record<string, unknown>) => emit("debug", event, fields),
  info: (event: string, fields?: Record<string, unknown>) => emit("info", event, fields),
  warn: (event: string, fields?: Record<string, unknown>) => emit("warn", event, fields),
  error: (event: string, fields?: Record<string, unknown>) => emit("error", event, fields),
};

function emit(level: Level, event: string, fields: Record<string, unknown> = {}): void {
  if (order[level] < order[currentLevel]) return;
  console.log(JSON.stringify({ ts: new Date().toISOString(), level, event, ...fields }));
}

function isLevel(value: string | undefined): value is Level {
  return value === "debug" || value === "info" || value === "warn" || value === "error";
}
