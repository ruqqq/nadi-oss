import type { FileUIPart } from "ai";

export type QueuedMessageStatus =
  | "pending"
  | "running"
  | "completed"
  | "aborted"
  | "skipped"
  | "error";

export interface QueuedMessage {
  submissionId: string;
  requestId?: string;
  error?: string;
  startedAt?: number;
  completedAt?: number;
  status: QueuedMessageStatus;
  createdAt: number;
  textPreview: string;
  /** Full untruncated message text (textPreview caps at 240 chars); absent on
   *  legacy rows. Restored into the composer when the row is cancelled. */
  text?: string;
  attachmentCount: number;
  clientMessageId: string;
  attachments: FileUIPart[];
  cancelling?: boolean;
}

export function shouldUseQueuedSubmit({
  runtime,
  busy,
  hasContent,
}: {
  runtime: "legacy" | "think";
  busy: boolean;
  hasContent: boolean;
}): boolean {
  return runtime === "think" && busy && hasContent;
}

// "running" only means the drain loop has claimed the submission — that
// happens the moment it is submitted, while its turn still waits behind the
// active one. Such a row is still "queued" from the user's perspective and
// stays cancellable; the server refuses the cancel once the message has
// actually been applied to the conversation (see canCancelQueuedUserMessage
// on the agent side), which is when cancelling would abort the active turn.
export function isCancellableQueuedStatus(status: QueuedMessageStatus): boolean {
  return status === "pending" || status === "running";
}

// "Active" = still owned by the queue machinery (not yet terminal). The client
// mirrors every active submission so it can tell when the queue has fully
// drained; this is NOT the same as what the strip renders (see
// displayableQueuedMessages).
export function isActiveQueuedStatus(status: QueuedMessageStatus): boolean {
  return status === "pending" || status === "running";
}

export function activeQueuedMessages(rows: QueuedMessage[]): QueuedMessage[] {
  return rows.filter((row) => row.cancelling || isActiveQueuedStatus(row.status));
}

// Cancelling flags key on clientMessageId, not submissionId: a server-side
// batch rebuild (merge or per-item cancel) reissues the rows under a new
// submissionId while clientMessageId stays stable.
export function mergeQueuedMessages(
  local: QueuedMessage[],
  server: QueuedMessage[],
): QueuedMessage[] {
  const cancellingByClientId = new Map(local.map((row) => [row.clientMessageId, row.cancelling]));
  return activeQueuedMessages(
    server.map((row) =>
      cancellingByClientId.get(row.clientMessageId) ? { ...row, cancelling: true } : row,
    ),
  );
}

// What the strip actually renders: non-terminal messages not already represented
// by either the streamed conversation or a local optimistic bubble. Status
// alone cannot tell
// "waiting" from "active turn": the SDK flips a submission to "running" the
// instant the drain loop claims it (at submit time), while its turn still
// waits behind the active one. The reliable "turn actually started" signal is
// the SDK appending + broadcasting the stored user message — i.e. its id
// showing up in `messageIds`. The extra optimistic set covers the first-message
// handoff before that stream catches up.
export function displayableQueuedMessages(
  rows: QueuedMessage[],
  messageIds: ReadonlySet<string>,
  optimisticMessageIds?: ReadonlySet<string>,
): QueuedMessage[] {
  return rows.filter(
    (row) =>
      (row.cancelling || isActiveQueuedStatus(row.status)) &&
      !messageIds.has(row.clientMessageId) &&
      !optimisticMessageIds?.has(row.clientMessageId),
  );
}
