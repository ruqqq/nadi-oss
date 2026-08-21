import type { UIMessage } from "ai";
import type { CompactThreadResult, ThreadCompactionStatus } from "../threads-api";
import { shouldUseQueuedSubmit } from "./queued-messages";

type ToastId = string | number;

type ManualThreadCompactionToast = {
  loading(message: string): ToastId;
  success(message: string, data?: { id?: ToastId }): ToastId;
  info(message: string, data?: { id?: ToastId }): ToastId;
  error(message: string, data?: { id?: ToastId }): ToastId;
};

export async function runManualThreadCompaction({
  threadId,
  compactThread,
  toast,
}: {
  threadId: string;
  compactThread: (threadId: string) => Promise<CompactThreadResult>;
  toast: ManualThreadCompactionToast;
}): Promise<CompactThreadResult> {
  const toastId = toast.loading("Compacting thread…");
  try {
    const result = await compactThread(threadId);
    if (result.compacted) toast.success(result.message, { id: toastId });
    else toast.info(result.message, { id: toastId });
    return result;
  } catch (err) {
    const error = err instanceof Error ? err : new Error(String(err));
    toast.error(error.message, { id: toastId });
    throw error;
  }
}

export function isCompactionMessage(message: { id: string }): boolean {
  return message.id.startsWith("compaction_");
}

/**
 * The markdown summary a compaction message carries — the persisted digest of
 * everything before it (Topic / Key Points / Current State / Open Items). Joins
 * all text parts so the timeline can reveal it under the "Thread compacted"
 * divider. Returns "" when the message has no text (nothing to expand).
 */
export function getCompactionSummary(message: UIMessage): string {
  return message.parts
    .filter(
      (part): part is Extract<UIMessage["parts"][number], { type: "text" }> => part.type === "text",
    )
    .map((part) => part.text)
    .join("\n\n")
    .trim();
}

export function shouldQueueSubmitForThreadState({
  busy,
  manualCompacting,
  hasContent,
}: {
  busy: boolean;
  manualCompacting: boolean;
  hasContent: boolean;
}): boolean {
  return shouldUseQueuedSubmit({ busy: busy || manualCompacting, hasContent });
}

export type CompactionNotice = "none" | "not-needed" | "declined";

/**
 * A decline is not a no-op. There IS a middle; it just cannot shrink without
 * discarding history, which a manual `/compact` never does. Both report
 * `compacted: false`, so collapsing them left the divider saying "No compaction
 * needed" while the toast said the opposite.
 *
 * Keyed on the server's `reason`, never on the prose, and defaulting to
 * "not-needed" so an older server build reads exactly as it used to.
 */
export function manualCompactionNoticeForResult(result: CompactThreadResult): CompactionNotice {
  if (result.compacted) return "none";
  return result.reason === "declined" ? "declined" : "not-needed";
}

export function compactionNoticeLabel(notice: CompactionNotice): string | null {
  if (notice === "not-needed") return "No compaction needed";
  if (notice === "declined") return "Couldn't compact further";
  return null;
}

export type CompactionSessionEvent = ThreadCompactionStatus & {
  tokenEstimate?: number;
  tokenThreshold?: number | null;
};

export type CompactionPhase = ThreadCompactionStatus["phase"];

export function shouldApplyCompactionStatus({
  currentPhase,
  incomingPhase,
  manualCompactionInFlight,
}: {
  currentPhase: CompactionPhase;
  incomingPhase: CompactionPhase;
  manualCompactionInFlight: boolean;
}): boolean {
  return !(incomingPhase === "idle" && currentPhase === "compacting" && manualCompactionInFlight);
}

export function parseCompactionSessionEvent(raw: string): CompactionSessionEvent | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return null;
  }
  if (parsed === null || typeof parsed !== "object") return null;
  const record = parsed as Record<string, unknown>;
  if (record.type !== "cf_agent_session" && record.type !== "CF_AGENT_SESSION") return null;
  if (record.phase !== "idle" && record.phase !== "compacting") return null;

  return {
    phase: record.phase,
    ...(typeof record.tokenEstimate === "number" ? { tokenEstimate: record.tokenEstimate } : {}),
    ...(typeof record.tokenThreshold === "number" || record.tokenThreshold === null
      ? { tokenThreshold: record.tokenThreshold }
      : {}),
  };
}
