import { APICallError } from "ai";

const MAX_ERROR_CAUSE_ENTRIES = 10;
const MAX_SUBMISSION_ERROR_CHARS = 300;
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

/** Keep actionable provider failures, but never expose internal turn errors. */
export function chatErrorForClient(error: unknown): Error {
  if (APICallError.isInstance(error)) return error;
  return new Error(CHAT_RETRY_MESSAGE);
}

/**
 * Shape a durable submission's failure text for the transcript.
 *
 * Unlike {@link chatErrorForClient} this gets a string, not an Error — Think
 * stores only `error_message` on the submission row, so the original object is
 * gone by the time the failure is surfaced. The provider's own wording is the
 * actionable part ("Missing API key", "this account has been blocked"), so it
 * is kept rather than collapsed into the generic retry line.
 *
 * TRUNCATED at the first URL-ish marker rather than having URLs stripped out:
 * a model endpoint can carry credentials in its query string, and truncating
 * cannot leak on a runtime whose error phrasing we have never seen.
 */
export function submissionErrorForClient(message: string | undefined): string {
  const raw = (message ?? "").trim();
  if (!raw) return CHAT_RETRY_MESSAGE;
  const urlAt = raw.search(/\bhttps?:\/\/|:\/\//);
  const cut = urlAt === -1 ? raw : raw.slice(0, urlAt);
  const trimmed = cut.trim().replace(/[\s(<[{,;:-]+$/, "");
  if (!trimmed) return CHAT_RETRY_MESSAGE;
  return trimmed.length > MAX_SUBMISSION_ERROR_CHARS
    ? `${trimmed.slice(0, MAX_SUBMISSION_ERROR_CHARS).trimEnd()}…`
    : trimmed;
}
