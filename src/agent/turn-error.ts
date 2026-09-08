/**
 * The transcript's record of a turn that died before it produced anything.
 *
 * A turn driven by a durable submission (a queued send, an automaton run) has
 * no client streaming it, so Think's live `chat:response` error broadcast
 * reaches nobody — and when the failure happens before the first assistant
 * part, nothing is persisted either. The thread was then indistinguishable
 * from one still thinking: typing dots forever, nothing in the log, nothing in
 * the transcript. This part is the durable half of that error.
 *
 * Written as an AI SDK `data-*` part for the same two reasons as
 * `data-model-switch`: the UI can read it, and `convertToModelMessages` drops
 * it, so a provider's own error text structurally cannot be replayed back to a
 * provider as conversation.
 */
export const TURN_ERROR_PART_TYPE = "data-turn-error" as const;

export interface TurnErrorData {
  /** Human-readable failure text, already client-safe. */
  message: string;
}

export function turnErrorPart(data: TurnErrorData): {
  type: typeof TURN_ERROR_PART_TYPE;
  data: TurnErrorData;
} {
  return { type: TURN_ERROR_PART_TYPE, data };
}

export function readTurnErrorPart(part: unknown): TurnErrorData | null {
  if (!isRecord(part) || part.type !== TURN_ERROR_PART_TYPE) return null;
  const data = part.data;
  if (!isRecord(data)) return null;
  const { message } = data;
  if (typeof message !== "string" || !message.trim()) return null;
  return { message };
}

/**
 * Stable id for a submission's failure message, so a replayed terminal status
 * upserts the one row rather than stacking duplicates — `addMessages` is a
 * no-op for an id already in history, and celld replays alarms.
 */
export function turnErrorMessageId(submissionId: string): string {
  return `turnerr_${submissionId}`;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}
