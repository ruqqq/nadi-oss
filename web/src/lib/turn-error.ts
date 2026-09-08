/**
 * The web-side twin of the transcript's turn-failure marker.
 *
 * Mirrors `src/agent/turn-error.ts` (the server's `TURN_ERROR_PART_TYPE`,
 * `TurnErrorData`, `readTurnErrorPart`), kept as a hand copy for the same
 * reason `web/src/lib/model-switch.ts` is — the worker and the SPA do not
 * share a module graph. Change one, change the other.
 */
export const TURN_ERROR_PART_TYPE = "data-turn-error" as const;

export interface TurnErrorData {
  message: string;
}

export function readTurnErrorPart(part: unknown): TurnErrorData | null {
  if (!isRecord(part) || part.type !== TURN_ERROR_PART_TYPE) return null;
  const data = part.data;
  if (!isRecord(data)) return null;
  const { message } = data;
  if (typeof message !== "string" || !message.trim()) return null;
  return { message };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}
