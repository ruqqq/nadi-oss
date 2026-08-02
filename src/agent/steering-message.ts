import type { UIMessage } from "ai";

// A steering message is a REAL user message the user injected into a running
// turn as an interjection (see docs/superpowers/specs/2026-07-07-user-steering-
// message-design.md). Unlike a system-reminder it carries no `<system-reminder>`
// wrapper — the model sees it as the user's actual speech — and the web UI SHOWS
// it in the transcript with a "steered" badge. The metadata marker only
// distinguishes it from a normal turn-starting user message. Pure primitive:
// build + recognize + read text, no I/O. Client counterpart lives in
// web/src/lib/steering-messages.ts.

export const NADI_STEERED_MESSAGE_KIND = "steered";

export type SteeredMessageMetadata = { nadiKind: typeof NADI_STEERED_MESSAGE_KIND };

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

/** Build the user message a steer injects. `id` = the client-supplied message id
 * (also the injection dedupeKey), so the client can correlate the settled
 * transcript row back to its chip. */
export function buildSteeredUserMessage(text: string, id: string): UIMessage {
  return {
    id,
    role: "user",
    parts: [{ type: "text", text }],
    metadata: { nadiKind: NADI_STEERED_MESSAGE_KIND },
  };
}

export function isSteeredMessage(message: UIMessage): boolean {
  return isObject(message.metadata) && message.metadata.nadiKind === NADI_STEERED_MESSAGE_KIND;
}

/** Concatenated text of a user message's text parts — used to restore the
 * composer when a steer is cancelled while still pending. */
export function steeredMessageText(message: UIMessage): string {
  return (message.parts ?? [])
    .filter((p): p is { type: "text"; text: string } => p.type === "text")
    .map((p) => p.text)
    .join("");
}
