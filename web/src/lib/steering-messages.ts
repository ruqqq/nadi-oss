// Client-side chip state for user steering messages (see
// docs/superpowers/specs/2026-07-07-user-steering-message-design.md). A steer
// the user sends is tracked locally by clientMessageId until it settles into the
// transcript. Its visible state is derived — purely — from three inputs:
//   • local rows       — what the user sent (text + optimistic cancelling flag)
//   • pendingKeys      — server pendingSteerKeys() poll: key present = still buffered
//   • messageIds       — grown-only set of transcript ids: id present = settled
//
// Lifecycle: Steering (buffered) → Sent (drained, gone from pending, turn not yet
// ended) → Settled (id in transcript → chip drops). Cancelling is a transient
// local overlay while a cancel RPC is in flight. Unlike queued messages the
// server returns no rows to merge, so this is leaner than queued-messages.ts.

import type { UIMessage } from "ai";

// Mirrors src/agent/steering-message.ts: a settled steer is a real user message
// tagged with this kind, shown in the transcript with a "steered" badge.
export const NADI_STEERED_MESSAGE_KIND = "steered";

export function isSteeredMessage(message: UIMessage): boolean {
  const m = message.metadata;
  return (
    typeof m === "object" &&
    m !== null &&
    (m as { nadiKind?: string }).nadiKind === NADI_STEERED_MESSAGE_KIND
  );
}

export type SteeringChipState = "steering" | "cancelling" | "sent";

export interface SteeringMessage {
  clientMessageId: string;
  text: string;
  createdAt: number;
  /** Optimistic flag set the instant the user clicks cancel, cleared when the
   *  server refuses (too-late). On success the row is removed entirely. */
  cancelling?: boolean;
}

export interface SteeringChip extends SteeringMessage {
  state: SteeringChipState;
}

/** A steer is done once its message id shows up in the transcript (the SDK
 *  broadcasts the stored message at turn end). Grown-only ids → never flickers. */
export function isSettledSteer(steer: SteeringMessage, messageIds: ReadonlySet<string>): boolean {
  return messageIds.has(steer.clientMessageId);
}

/** Drop steers that have settled into the transcript. */
export function activeSteeringMessages(
  local: SteeringMessage[],
  messageIds: ReadonlySet<string>,
): SteeringMessage[] {
  return local.filter((s) => !isSettledSteer(s, messageIds));
}

/**
 * Per-steer chip state for every still-active (unsettled) steer.
 *
 * `sent` requires the steer to be absent from `pendingKeys` AND present in
 * `seenKeys` (the poll observed it in the buffer, then observed it gone). A
 * steer that is merely absent from `pendingKeys` — because no poll has observed
 * it yet — stays `steering`. This prevents a brand-new steer from flashing a
 * false "Sent" (and hiding its cancel affordance) before the first poll returns.
 */
export function deriveSteeringChips(
  local: SteeringMessage[],
  pendingKeys: ReadonlySet<string>,
  seenKeys: ReadonlySet<string>,
  messageIds: ReadonlySet<string>,
): SteeringChip[] {
  return activeSteeringMessages(local, messageIds).map((s) => ({
    ...s,
    state: s.cancelling
      ? "cancelling"
      : pendingKeys.has(s.clientMessageId)
        ? "steering"
        : seenKeys.has(s.clientMessageId)
          ? "sent"
          : "steering",
  }));
}

/** Cancel is offered only while the steer is still buffered (Steering). Once it
 *  flips to Sent the agent already has it, so the affordance is retracted. */
export function isCancellableSteerState(state: SteeringChipState): boolean {
  return state === "steering";
}

/** Toggle the optimistic cancelling flag for one steer (by clientMessageId). */
export function withCancelling(
  local: SteeringMessage[],
  clientMessageId: string,
  cancelling: boolean,
): SteeringMessage[] {
  return local.map((s) => (s.clientMessageId === clientMessageId ? { ...s, cancelling } : s));
}

/** Append a newly-sent steer, deduped by clientMessageId (idempotent retries). */
export function addSteer(local: SteeringMessage[], steer: SteeringMessage): SteeringMessage[] {
  if (local.some((s) => s.clientMessageId === steer.clientMessageId)) return local;
  return [...local, steer];
}

/** Remove a steer (on confirmed cancel). */
export function removeSteer(local: SteeringMessage[], clientMessageId: string): SteeringMessage[] {
  return local.filter((s) => s.clientMessageId !== clientMessageId);
}
