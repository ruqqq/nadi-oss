import type { UIMessage } from "ai";
import type { WorkOutcome, WorkReason } from "./work-ledger";

// A system-reminder is a hidden, model-visible message: the LLM sees it
// wrapped in <system-reminder> tags (so it treats the content as injected
// system context rather than user speech), while the web UI hides it from
// the transcript via the metadata.nadiKind marker below. This module is a
// pure primitive — building the message and recognizing it later — with no
// I/O or storage access; wiring it into agents/services happens elsewhere.

export const NADI_SYSTEM_REMINDER_KIND = "system-reminder";

// A watcher-completion is a system-reminder VARIANT: the model still sees the
// `<system-reminder>` body (so a proactive delivery drives a turn where it
// reacts to the process exit), but it carries a distinct kind + structured
// `watcher` metadata so the web transcript renders it as a visible completion
// card (like a subagent result) instead of hiding it. See
// web/src/lib/watcher-runs.ts for the client counterpart.
export const NADI_WATCHER_COMPLETION_KIND = "watcher-completion";

export type SystemReminderMetadata = {
  nadiKind: typeof NADI_SYSTEM_REMINDER_KIND;
};

/** Structured completion facts the client card renders from (metadata, not text). */
export type WatcherCompletionInfo = {
  /** Human title — the watcher label, falling back to the command. */
  title: string;
  command: string;
  /** Watcher process id — used to build a stable per-completion dedupe key. */
  processId: string;
  /**
   * The ledger terminal's outcome — one vocabulary, not a parallel one, so the
   * card can never disagree with the row (see `WorkOutcome`). `fault` is the
   * reaper's: the process is gone without a real exit.
   */
  outcome: WorkOutcome;
  /**
   * The terminal's reason. The outcome alone cannot tell a sandbox reset (files
   * gone) from a no-liveness tear-down (process gone) — both are `fault`, and
   * the human reading the card deserves the same distinction the model's
   * message body already makes.
   */
  reason?: WorkReason;
  /** Process exit code; null when the process is gone/unknown or did not exit. */
  exitCode: number | null;
  /** Recent output tail (exited case only). */
  outputTail?: string;
};

export type WatcherCompletionMetadata = {
  nadiKind: typeof NADI_WATCHER_COMPLETION_KIND;
  watcher: WatcherCompletionInfo;
};

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

export function buildSystemReminderMessage(body: string): UIMessage {
  return {
    id: `sysrem_${crypto.randomUUID()}`,
    role: "user",
    parts: [{ type: "text", text: `<system-reminder>\n${body}\n</system-reminder>` }],
    metadata: { nadiKind: NADI_SYSTEM_REMINDER_KIND },
  };
}

export function buildWatcherCompletionMessage(
  body: string,
  watcher: WatcherCompletionInfo,
): UIMessage {
  return {
    id: `sysrem_${crypto.randomUUID()}`,
    role: "user",
    parts: [{ type: "text", text: `<system-reminder>\n${body}\n</system-reminder>` }],
    metadata: { nadiKind: NADI_WATCHER_COMPLETION_KIND, watcher },
  };
}

export function isSystemReminderMessage(message: UIMessage): boolean {
  const metadata = message.metadata;
  return isObject(metadata) && metadata.nadiKind === NADI_SYSTEM_REMINDER_KIND;
}

export function isWatcherCompletionMessage(message: UIMessage): boolean {
  const metadata = message.metadata;
  return isObject(metadata) && metadata.nadiKind === NADI_WATCHER_COMPLETION_KIND;
}
