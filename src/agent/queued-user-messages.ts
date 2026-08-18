import type { ThinkSubmissionInspection } from "@cloudflare/think";
import type { FileUIPart, UIMessage } from "ai";
import { extractAttachmentIdsFromUiMessages } from "./prepare-attachments";
import { isReasoningEffort } from "./reasoning-options";
import { isSupportedAgentProvider, parseModelInputModalities } from "../settings/model-selection";
import type { ThreadModelSnapshotValue } from "../settings/thread-model-snapshot";
import { isSystemReminderMessage, isWatcherCompletionMessage } from "./system-reminder";

export const NADI_QUEUED_USER_MESSAGE_KIND = "queued_user_message";

export type QueuedUserMessageStatus =
  | "pending"
  | "running"
  | "completed"
  | "aborted"
  | "skipped"
  | "error";

export type QueuedAttachmentPreview = {
  type: "file";
  url: string;
  mediaType?: string;
  filename?: string;
};

export type QueuedUserMessageItem = {
  clientMessageId: string;
  textPreview: string;
  attachmentCount: number;
  attachments: QueuedAttachmentPreview[];
  /**
   * The model switch parked mid-conversation at the moment THIS item was
   * queued (see `think-thread-agent.ts`'s `submitQueuedUserMessage`). Stored
   * per item, never per batch: the queue holds one waiting submission
   * carrying every waiting message, and cancellation is per-item, so a
   * batch-level switch would outlive the message that requested it and
   * silently apply to a sibling the user never chose it for.
   */
  modelSwitch?: ThreadModelSnapshotValue;
};

// The queue holds AT MOST ONE waiting submission at a time, carrying every
// waiting message — that is what makes all of them flush as one combined turn
// (the SDK applies a submission's whole message array, then runs one turn).
// The SDK does not expose a submission's stored messages via inspection, so
// the metadata carries them too: items[i] describes messages[i].
export type QueuedUserMessageBatchMetadata = {
  nadiKind: typeof NADI_QUEUED_USER_MESSAGE_KIND;
  items: QueuedUserMessageItem[];
  messages: UIMessage[];
  feedback?: {
    nadiKind: "feedback-interview";
    interviewId: string;
  };
};

export type QueuedUserMessageBatch = {
  items: QueuedUserMessageItem[];
  /** null when the batch cannot be rebuilt (legacy v1 metadata, corrupt messages) */
  messages: UIMessage[] | null;
};

/** One strip row. Rows of the same batch share submissionId. */
export type QueuedUserMessageSubmission = {
  submissionId: string;
  requestId?: string;
  status: QueuedUserMessageStatus;
  error?: string;
  createdAt: number;
  startedAt?: number;
  completedAt?: number;
  textPreview: string;
  /** Full untruncated message text (textPreview is capped at 240 chars) —
   *  restored into the composer when the row is cancelled. Absent for legacy
   *  v1 submissions, which don't store their messages in metadata. */
  text?: string;
  attachmentCount: number;
  clientMessageId: string;
  attachments: QueuedAttachmentPreview[];
  /** The model this item will (or did) run on, so the queued chip can show
   *  it. Absent when the item carries no captured switch. */
  model?: string;
};

export type QueuedUserMessageInput = {
  message: UIMessage;
  clientMessageId?: string;
};

export type NormalizedQueuedUserMessage = {
  message: UIMessage;
  item: QueuedUserMessageItem;
  attachmentIds: string[];
};

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function isFilePart(part: UIMessage["parts"][number]): part is FileUIPart {
  return part.type === "file" && typeof part.url === "string";
}

function hasContent(message: UIMessage): boolean {
  return message.parts.some((part) => {
    if (part.type === "text") return part.text.trim().length > 0;
    return part.type === "file" && typeof part.url === "string" && part.url.length > 0;
  });
}

function textPreview(message: UIMessage): string {
  return fullMessageText(message).replace(/\s+/g, " ").slice(0, 240);
}

function fullMessageText(message: UIMessage): string {
  return message.parts
    .flatMap((part) => (part.type === "text" ? [part.text] : []))
    .join("\n")
    .trim();
}

function attachmentPreviews(message: UIMessage): QueuedAttachmentPreview[] {
  return message.parts.flatMap((part) => {
    if (!isFilePart(part)) return [];
    const preview: QueuedAttachmentPreview = { type: "file", url: part.url };
    if (part.mediaType !== undefined) preview.mediaType = part.mediaType;
    if (part.filename !== undefined) preview.filename = part.filename;
    return [preview];
  });
}

export function normalizeQueuedUserMessageInput(input: unknown): NormalizedQueuedUserMessage {
  if (!isObject(input) || !isObject(input.message)) throw new Error("queued_message_invalid");

  const message = input.message as unknown as UIMessage;
  if (message.role !== "user") throw new Error("queued_message_role");
  if (typeof message.id !== "string" || !Array.isArray(message.parts)) {
    throw new Error("queued_message_invalid");
  }
  if (!hasContent(message)) throw new Error("queued_message_empty");

  const attachments = attachmentPreviews(message);
  const clientMessageId =
    typeof input.clientMessageId === "string" && input.clientMessageId.length > 0
      ? input.clientMessageId
      : message.id;

  return {
    message,
    item: {
      clientMessageId,
      textPreview: textPreview(message),
      attachmentCount: attachments.length,
      attachments,
    },
    attachmentIds: extractAttachmentIdsFromUiMessages([message]),
  };
}

/**
 * Binds a pending model switch onto the item being queued — the ONE place a
 * switch enters the queue, so it travels with this message and no other. A
 * `null` switch (nothing was pending) leaves the item untouched: a message
 * queued with no pending switch must carry none, never inherit a sibling's.
 */
export function withCapturedModelSwitch(
  normalized: NormalizedQueuedUserMessage,
  modelSwitch: ThreadModelSnapshotValue | null,
): NormalizedQueuedUserMessage {
  if (!modelSwitch) return normalized;
  return { ...normalized, item: { ...normalized.item, modelSwitch } };
}

export function appendToQueuedBatch(
  existing: { items: QueuedUserMessageItem[]; messages: UIMessage[] } | null,
  normalized: NormalizedQueuedUserMessage,
  feedback?: QueuedUserMessageBatchMetadata["feedback"],
): { metadata: QueuedUserMessageBatchMetadata; messages: UIMessage[] } {
  const items = [...(existing?.items ?? []), normalized.item];
  const messages = [...(existing?.messages ?? []), normalized.message];
  return {
    metadata: {
      nadiKind: NADI_QUEUED_USER_MESSAGE_KIND,
      items,
      messages,
      ...(feedback ? { feedback } : {}),
    },
    messages,
  };
}

export function removeFromQueuedBatch(
  batch: { items: QueuedUserMessageItem[]; messages: UIMessage[] },
  clientMessageId: string,
): { metadata: QueuedUserMessageBatchMetadata; messages: UIMessage[] } | null {
  const index = batch.items.findIndex((item) => item.clientMessageId === clientMessageId);
  if (index === -1) return null;
  const items = batch.items.filter((_, i) => i !== index);
  if (items.length === 0) return null;
  const messages = batch.messages.filter((_, i) => i !== index);
  return {
    metadata: { nadiKind: NADI_QUEUED_USER_MESSAGE_KIND, items, messages },
    messages,
  };
}

function isQueuedAttachmentPreview(value: unknown): value is QueuedAttachmentPreview {
  if (!isObject(value)) return false;
  if (value.type !== "file") return false;
  if (typeof value.url !== "string") return false;
  if (value.mediaType !== undefined && typeof value.mediaType !== "string") return false;
  if (value.filename !== undefined && typeof value.filename !== "string") return false;
  return true;
}

function isQueuedUserMessageStatus(value: unknown): value is QueuedUserMessageStatus {
  return (
    value === "pending" ||
    value === "running" ||
    value === "completed" ||
    value === "aborted" ||
    value === "skipped" ||
    value === "error"
  );
}

function isOptionalString(value: unknown): value is string | undefined {
  return value === undefined || typeof value === "string";
}

function isOptionalNumber(value: unknown): value is number | undefined {
  return value === undefined || typeof value === "number";
}

function isQueuedUserMessageItem(value: unknown): value is QueuedUserMessageItem {
  if (!isObject(value)) return false;
  if (typeof value.clientMessageId !== "string") return false;
  if (typeof value.textPreview !== "string") return false;
  if (typeof value.attachmentCount !== "number") return false;
  if (!Array.isArray(value.attachments) || !value.attachments.every(isQueuedAttachmentPreview)) {
    return false;
  }
  return true;
}

/**
 * Defensive parse of a captured switch pulled off submission metadata — a
 * client-controlled channel over the wire, same trust level as everything
 * else read here. Anything malformed degrades to `null` ("no switch") rather
 * than rejecting the item: a user's queued text is more valuable than their
 * model choice.
 */
function readStoredModelSwitch(value: unknown): ThreadModelSnapshotValue | null {
  if (!isObject(value)) return null;
  const { provider, model, modelInputModalities, showReasoning, reasoningEffort } = value;
  if (typeof provider !== "string" || !provider || !isSupportedAgentProvider(provider)) {
    return null;
  }
  if (typeof model !== "string" || !model) return null;
  const modalities = parseModelInputModalities(modelInputModalities);
  if (!modalities) return null;
  if (typeof showReasoning !== "boolean") return null;
  if (!isReasoningEffort(reasoningEffort)) return null;
  const modelSupportsReasoning = value.modelSupportsReasoning;
  if (modelSupportsReasoning !== null && typeof modelSupportsReasoning !== "boolean") return null;
  return {
    provider,
    model,
    modelInputModalities: modalities,
    showReasoning,
    reasoningEffort,
    modelSupportsReasoning,
  };
}

/** Sanitizes a structurally-valid item's `modelSwitch`, degrading a
 *  malformed capture to "no switch" rather than rejecting the item. */
function sanitizeQueuedUserMessageItem(value: QueuedUserMessageItem): QueuedUserMessageItem {
  const { clientMessageId, textPreview, attachmentCount, attachments } = value;
  const modelSwitch = readStoredModelSwitch((value as { modelSwitch?: unknown }).modelSwitch);
  return {
    clientMessageId,
    textPreview,
    attachmentCount,
    attachments,
    ...(modelSwitch ? { modelSwitch } : {}),
  };
}

function isStoredUiMessage(value: unknown): value is UIMessage {
  return isObject(value) && typeof value.id === "string" && Array.isArray(value.parts);
}

export function queuedBatchFromMetadata(metadata: unknown): QueuedUserMessageBatch | null {
  if (!isObject(metadata) || metadata.nadiKind !== NADI_QUEUED_USER_MESSAGE_KIND) return null;

  if (Array.isArray(metadata.items)) {
    if (metadata.items.length === 0 || !metadata.items.every(isQueuedUserMessageItem)) return null;
    const items = metadata.items.map(sanitizeQueuedUserMessageItem);
    const messages =
      Array.isArray(metadata.messages) &&
      metadata.messages.length === items.length &&
      metadata.messages.every(isStoredUiMessage)
        ? (metadata.messages as UIMessage[])
        : null;
    return { items, messages };
  }

  // Legacy v1 shape (single message, previews at the top level, no stored
  // messages): listable and cancellable-whole, but never merged into. Legacy
  // items never carried a `modelSwitch`, so this reads as "no switch".
  if (isQueuedUserMessageItem(metadata)) {
    const { clientMessageId, textPreview: preview, attachmentCount, attachments } = metadata;
    return {
      items: [{ clientMessageId, textPreview: preview, attachmentCount, attachments }],
      messages: null,
    };
  }
  return null;
}

/**
 * All of a batch's messages run in ONE turn, so at most one switch can
 * apply: the last surviving item that carries one — the user's most recent
 * expressed intent. Cancelling that item drops its switch and the previous
 * one takes over, which is what makes per-item cancellation carry the
 * switch away for free (see `queued-user-messages.ts`'s per-item storage
 * note on `QueuedUserMessageItem`).
 */
export function effectiveModelSwitch(
  items: QueuedUserMessageItem[],
): ThreadModelSnapshotValue | null {
  for (let i = items.length - 1; i >= 0; i -= 1) {
    const found = items[i]?.modelSwitch;
    if (found) return found;
  }
  return null;
}

export function isQueuedBatchApplied(
  items: QueuedUserMessageItem[],
  appliedMessageIds: ReadonlySet<string>,
): boolean {
  return items.some((item) => appliedMessageIds.has(item.clientMessageId));
}

// A batch may be cancelled (whole or per-item) until its messages have been
// applied to the conversation. "running" alone does not mean active turn: the
// SDK marks a submission running as soon as the drain loop claims it, while
// its turn still waits behind the active one — cancelling then is safe. Once
// applied, the batch IS the active turn and the server must refuse.
export function canCancelQueuedUserMessageBatch(
  status: QueuedUserMessageStatus,
  items: QueuedUserMessageItem[],
  appliedMessageIds: ReadonlySet<string>,
): boolean {
  if (status !== "pending" && status !== "running") return false;
  return !isQueuedBatchApplied(items, appliedMessageIds);
}

export function serializeQueuedUserMessageSubmissionRows(
  submission: ThinkSubmissionInspection,
): QueuedUserMessageSubmission[] {
  if (
    !isQueuedUserMessageStatus(submission.status) ||
    !isOptionalString(submission.requestId) ||
    !isOptionalString(submission.error) ||
    !isOptionalNumber(submission.startedAt) ||
    !isOptionalNumber(submission.completedAt) ||
    typeof submission.createdAt !== "number"
  ) {
    return [];
  }
  const batch = queuedBatchFromMetadata(submission.metadata);
  if (!batch) return [];

  return batch.items.flatMap((item, index) => {
    const storedMessage = batch.messages?.[index];
    // A system-reminder — and its watcher-completion variant — is
    // server-initiated (proactive delivery), never a user submission; never
    // surface either as a row on the queued strip. (The watcher-completion is
    // still visible in the transcript as a card; that is a separate concern.)
    if (
      storedMessage &&
      (isSystemReminderMessage(storedMessage) || isWatcherCompletionMessage(storedMessage))
    )
      return [];

    const row: QueuedUserMessageSubmission = {
      submissionId: submission.submissionId,
      status: submission.status as QueuedUserMessageStatus,
      createdAt: submission.createdAt,
      textPreview: item.textPreview,
      attachmentCount: item.attachmentCount,
      clientMessageId: item.clientMessageId,
      attachments: item.attachments,
    };
    if (storedMessage) row.text = fullMessageText(storedMessage);
    if (item.modelSwitch) row.model = item.modelSwitch.model;
    if (submission.requestId !== undefined) row.requestId = submission.requestId;
    if (submission.error !== undefined) row.error = submission.error;
    if (submission.startedAt !== undefined) row.startedAt = submission.startedAt;
    if (submission.completedAt !== undefined) row.completedAt = submission.completedAt;
    return [row];
  });
}

// Orchestration is written against this port (implemented by the agent over
// the Think SDK) so the merge/cancel flows are deterministically unit-testable
// — integration tests cannot control when the SDK drain loop claims or runs a
// submission. appliedMessageIds MUST be synchronous: the applied re-check must
// have no await between it and cancelSubmission, so a submission cannot become
// the active turn in between (the DO is single-threaded outside awaits).
export type QueuedSubmissionPort = {
  listSubmissions(options: { limit: number }): Promise<ThinkSubmissionInspection[]>;
  inspectSubmission(submissionId: string): Promise<ThinkSubmissionInspection | null | undefined>;
  cancelSubmission(submissionId: string, reason: string): Promise<void>;
  submitMessages(
    messages: UIMessage[],
    options: { metadata: QueuedUserMessageBatchMetadata },
  ): Promise<ThinkSubmissionInspection>;
  appliedMessageIds(): ReadonlySet<string>;
};

async function findWaitingQueuedBatch(port: QueuedSubmissionPort): Promise<{
  submissionId: string;
  createdAt: number;
  items: QueuedUserMessageItem[];
  messages: UIMessage[];
} | null> {
  const submissions = await port.listSubmissions({ limit: 50 });
  const applied = port.appliedMessageIds();
  let waiting: Awaited<ReturnType<typeof findWaitingQueuedBatch>> = null;
  for (const submission of submissions) {
    if (submission.status !== "pending" && submission.status !== "running") continue;
    if (typeof submission.createdAt !== "number") continue;
    const batch = queuedBatchFromMetadata(submission.metadata);
    if (!batch || !batch.messages) continue;
    if (isQueuedBatchApplied(batch.items, applied)) continue;
    if (waiting && waiting.createdAt >= submission.createdAt) continue;
    waiting = {
      submissionId: submission.submissionId,
      createdAt: submission.createdAt,
      items: batch.items,
      messages: batch.messages,
    };
  }
  return waiting;
}

export async function submitQueuedUserMessageBatch(
  port: QueuedSubmissionPort,
  normalized: NormalizedQueuedUserMessage,
  feedback?: QueuedUserMessageBatchMetadata["feedback"],
): Promise<void> {
  const waiting = await findWaitingQueuedBatch(port);
  if (waiting) {
    // Synchronous applied re-check directly before the cancel (see port note).
    const applied = port.appliedMessageIds();
    if (!isQueuedBatchApplied(waiting.items, applied)) {
      const merged = appendToQueuedBatch(waiting, normalized, feedback);
      await port.cancelSubmission(waiting.submissionId, "superseded_by_merge");
      await port.submitMessages(merged.messages, { metadata: merged.metadata });
      return;
    }
  }
  const single = appendToQueuedBatch(null, normalized, feedback);
  await port.submitMessages(single.messages, { metadata: single.metadata });
}

export async function cancelQueuedUserMessageFromBatch(
  port: QueuedSubmissionPort,
  submissionId: string,
  clientMessageId: string,
): Promise<void> {
  const current = await port.inspectSubmission(submissionId);
  if (!current || !isQueuedUserMessageStatus(current.status)) return;
  const batch = queuedBatchFromMetadata(current.metadata);
  if (!batch) return;
  if (!batch.items.some((item) => item.clientMessageId === clientMessageId)) return;

  // Synchronous applied check directly before the cancel (see port note).
  const applied = port.appliedMessageIds();
  if (!canCancelQueuedUserMessageBatch(current.status, batch.items, applied)) return;

  const remaining = batch.messages
    ? removeFromQueuedBatch({ items: batch.items, messages: batch.messages }, clientMessageId)
    : null;
  await port.cancelSubmission(submissionId, "cancelled_by_user");
  if (remaining) {
    await port.submitMessages(remaining.messages, { metadata: remaining.metadata });
  }
}
