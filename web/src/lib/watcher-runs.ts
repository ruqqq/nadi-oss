import type { UIMessage } from "ai";

// --- Watcher completion (transcript card) -----------------------------------
// Mirrors src/agent/system-reminder.ts: a watched process that exits (or times
// out) is delivered as a `watcher-completion` message — a system-reminder
// variant that stays VISIBLE in the transcript (not hidden) and carries
// structured `watcher` metadata. We render it from that metadata, not from the
// message text, so there is no brittle regex (unlike the subagent path, whose
// SDK strips its metadata — see subagent-runs.ts).

export const NADI_WATCHER_COMPLETION_KIND = "watcher-completion";

// Mirrors `WorkOutcome` in src/agent/work-ledger.ts — the ledger terminal is
// what the card renders, so the vocabularies must not diverge. `fault` is the
// reaper's: the work is gone without a real exit. `stopped` is a deliberate
// kill, which is NOT an exit.
export type WatcherCompletionOutcome = "exited" | "stopped" | "timeout" | "fault";

const WATCHER_COMPLETION_OUTCOMES: readonly WatcherCompletionOutcome[] = [
  "exited",
  "stopped",
  "timeout",
  "fault",
];

// Mirrors `WorkReason` in src/agent/work-ledger.ts. The outcome cannot tell a
// sandbox reset (the FILES are gone) from a no-liveness tear-down (the PROCESS
// is gone) — both are `fault` — so the card reads the reason to say which.
export type WatcherCompletionReason =
  | "process_exit"
  | "process_stopped"
  | "watch_timeout"
  | "no_liveness"
  | "sandbox_reset";

const WATCHER_COMPLETION_REASONS: readonly WatcherCompletionReason[] = [
  "process_exit",
  "process_stopped",
  "watch_timeout",
  "no_liveness",
  "sandbox_reset",
];

export type WatcherCompletionInfo = {
  title: string;
  command: string;
  outcome: WatcherCompletionOutcome;
  /** Absent on older/foreign payloads; the card degrades to generic fault copy. */
  reason?: WatcherCompletionReason;
  exitCode: number | null;
  outputTail?: string;
};

export type WatcherResultTone = "success" | "error" | "stopped" | "fault";

export type WatcherResultModel = {
  title: string;
  statusLabel: string;
  tone: WatcherResultTone;
  body: string;
};

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

/** Extract the structured watcher-completion facts from a message's metadata. */
export function parseWatcherCompletion(message: UIMessage): WatcherCompletionInfo | null {
  const metadata = message.metadata;
  if (!isObject(metadata) || metadata.nadiKind !== NADI_WATCHER_COMPLETION_KIND) return null;
  const w = metadata.watcher;
  if (!isObject(w)) return null;
  // Keep every known outcome; anything unrecognized degrades to `exited`, the
  // only outcome whose card copy makes no claim beyond the exit code it shows.
  const outcome = WATCHER_COMPLETION_OUTCOMES.includes(w.outcome as WatcherCompletionOutcome)
    ? (w.outcome as WatcherCompletionOutcome)
    : "exited";
  const exitCode = typeof w.exitCode === "number" ? w.exitCode : null;
  const info: WatcherCompletionInfo = {
    title: typeof w.title === "string" && w.title.length > 0 ? w.title : "Background process",
    command: typeof w.command === "string" ? w.command : "",
    outcome,
    exitCode,
  };
  if (WATCHER_COMPLETION_REASONS.includes(w.reason as WatcherCompletionReason)) {
    info.reason = w.reason as WatcherCompletionReason;
  }
  if (typeof w.outputTail === "string") info.outputTail = w.outputTail;
  return info;
}

// Marker-only (mirrors the server predicate in src/agent/system-reminder.ts):
// recognition MUST NOT depend on the payload parsing. A watcher-completion is
// NOT hidden by `visibleChatMessages`, so if ChatLog routed to the card branch
// only on a successful parse, a message with the kind marker but a
// missing/malformed `watcher` payload would fall through to a normal message
// row and leak its raw `<system-reminder>` text. Keying on the marker keeps
// every such message on the card branch; `WatcherResultNotice` degrades a bad
// payload to nothing rather than to raw text.
export function isWatcherCompletionMessage(message: UIMessage): boolean {
  const metadata = message.metadata;
  return isObject(metadata) && metadata.nadiKind === NADI_WATCHER_COMPLETION_KIND;
}

/** Display model for the transcript completion card. */
export function watcherResultModel(info: WatcherCompletionInfo): WatcherResultModel {
  if (info.outcome === "timeout") {
    return {
      title: info.title,
      statusLabel: "timed out",
      tone: "stopped",
      body: "Still running after the watch timeout; no longer watching it.",
    };
  }
  if (info.outcome === "fault") {
    // A reset and a tear-down are both `fault`, but they cost the human
    // different things: a reset takes the whole filesystem with it, a
    // tear-down only this process. Say which.
    if (info.reason === "sandbox_reset") {
      return {
        title: info.title,
        statusLabel: "sandbox reset",
        tone: "fault",
        body: "The sandbox was reset — every file this process wrote and all of its output are gone, and the filesystem is now empty.",
      };
    }
    return {
      title: info.title,
      statusLabel: "faulted",
      tone: "fault",
      body: "This process never reached a terminal — it is gone, and its output is lost or incomplete.",
    };
  }
  if (info.outcome === "stopped") {
    return {
      title: info.title,
      statusLabel: "stopped",
      tone: "stopped",
      body: "Stopped before it finished; any output above is partial.",
    };
  }
  const code = info.exitCode;
  const tone: WatcherResultTone = code === 0 ? "success" : "error";
  const statusLabel = code === null ? "exited" : `exited · code ${code}`;
  const tail = info.outputTail;
  const hasOutput = tail !== undefined && tail.trim().length > 0;
  return {
    title: info.title,
    statusLabel,
    tone,
    body: hasOutput ? tail : "(no output)",
  };
}
