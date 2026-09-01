import { APICallError } from "ai";

const MAX_ERROR_CAUSE_ENTRIES = 10;
const CHAT_RETRY_MESSAGE = "Something went wrong while sending your message. Please try again.";

export interface SerializedErrorDetail {
  name: string;
  message: string;
  stack?: string;
}

/** Serialize an unknown error and its causes for structured server-side logs. */
export function serializeErrorChain(error: unknown): SerializedErrorDetail[] {
  const details: SerializedErrorDetail[] = [];
  const seen = new Set<unknown>();
  let current: unknown = error;

  for (let depth = 0; depth < MAX_ERROR_CAUSE_ENTRIES; depth += 1) {
    if (typeof current === "object" && current !== null) {
      if (seen.has(current)) {
        details.push({
          name: "CircularErrorCause",
          message: "Cause chain contains a cycle",
        });
        return details;
      }
      seen.add(current);
    }

    if (!(current instanceof Error)) {
      details.push({ name: "NonErrorCause", message: String(current) });
      return details;
    }

    details.push({
      name: current.name,
      message: current.message,
      ...(current.stack ? { stack: current.stack } : {}),
    });
    if (current.cause === undefined) return details;
    current = current.cause;
  }

  details.push({
    name: "TruncatedErrorCause",
    message: `Cause chain exceeded ${MAX_ERROR_CAUSE_ENTRIES} entries`,
  });
  return details;
}

/**
 * A turn refused for a reason the USER changed and can change back — the
 * agent is turned off, or deleted. Its message is written for the person
 * reading the thread and is passed through to them verbatim.
 *
 * The default is the opposite (see {@link chatErrorForClient}): an internal
 * turn error collapses to a generic retry line so it cannot leak internals.
 * That default is right, and it is exactly why refusing a turn by throwing a
 * plain `Error("agent_disabled")` would show "Something went wrong… try again"
 * — advice that is wrong, since retrying cannot work.
 */
export class ThreadRefusedError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ThreadRefusedError";
  }
}

/** Keep actionable provider failures, but never expose internal turn errors. */
export function chatErrorForClient(error: unknown): Error {
  if (APICallError.isInstance(error)) return error;
  if (error instanceof ThreadRefusedError) return new Error(error.message);
  return new Error(CHAT_RETRY_MESSAGE);
}
