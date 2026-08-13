import type { UIMessage } from "ai";
import {
  parseSubagentCompletion,
  subagentResultModel,
  type SubagentRunView,
} from "./subagent-runs";
import {
  isWatcherCompletionMessage,
  parseWatcherCompletion,
  watcherResultModel,
} from "./watcher-runs";
import type { LineSegment } from "./tool-summary";

/**
 * The one model behind a completion's two surfaces: the recessed
 * `ActivityLine` it renders as in the transcript, and the result panel that
 * line opens.
 *
 * Both come from one function so they cannot disagree — the line's leading
 * phrase and the panel's status chip are derived from the same tone, rather
 * than each component reaching for the underlying model and phrasing the
 * outcome its own way.
 *
 * The line follows the run log's grammar (see `getRunToolLine` in
 * tool-summary.ts): a verb-led phrase first, the thing it happened to second
 * and faint. That is the whole point of routing completions through
 * `ActivityLine` — a finished background task is the same kind of event as a
 * finished tool call, and the transcript should have one voice for it, not two.
 */

/** Drives the panel's status chip. `pending` is a completion still in flight —
 *  rare, but `subagentResultModel` can report it when the live run stream says
 *  the run is running while its completion message is already in history. */
export type CompletionTone = "ok" | "bad" | "pending";

export interface CompletionLineModel {
  /** `ActivityLine` segments: verb phrase, then the faint name. */
  segments: LineSegment[];
  /** `ActivityLine` state. Success is silent; only a failure gets a marker. */
  state: "idle" | "active" | "error";
  /** Accessible name for the line, and the inspector's title attribute. */
  label: string;
  /** Panel heading — the task's own name. */
  title: string;
  /** Panel status chip text, from the underlying per-kind model. */
  statusLabel: string;
  tone: CompletionTone;
  /** Panel body. Markdown for a subagent, an output tail for a process. */
  body: string;
  kind: "subagent" | "process";
}

/**
 * Verb-led phrase for a subagent, from its SDK status.
 *
 * Deliberately says "Subagent" rather than showing an icon: the phrase names
 * the kind AND the outcome in the same breath, which is what lets the line drop
 * the glyph entirely on success. The old card said the outcome three ways at
 * once — border tint, filled glyph, and status text.
 */
function subagentPhrase(tone: string, statusLabel: string): string {
  switch (tone) {
    case "success":
      return "Subagent finished";
    case "error":
      return "Subagent failed";
    case "running":
      return "Subagent running";
    default:
      // `stopped` covers aborted and interrupted, which read very differently
      // to someone who cancelled a run vs one that ran out of budget — so take
      // the word from the per-kind model rather than flattening both to
      // "stopped". `statusLabel` is e.g. "Cancelled" or
      // "Interrupted (budget-exceeded)".
      return `Subagent ${statusLabel.toLowerCase()}`;
  }
}

/** Verb-led phrase for a watched process, from its ledger outcome. */
function processPhrase(statusLabel: string, exitCode: number | null): string {
  // `statusLabel` is already the vocabulary the ledger uses ("exited · code 7",
  // "timed out", "faulted", "sandbox reset"); the exit-code case is the only one
  // worth restating more tightly, since "Process exited · code 0" reads as
  // machinery where "Process finished" reads as an outcome.
  if (statusLabel.startsWith("exited")) {
    if (exitCode === 0) return "Process finished";
    return exitCode === null ? "Process exited" : `Process exited ${exitCode}`;
  }
  return `Process ${statusLabel}`;
}

export function completionLineModel(
  message: UIMessage,
  runsById: Record<string, SubagentRunView>,
): CompletionLineModel | null {
  if (isWatcherCompletionMessage(message)) {
    const info = parseWatcherCompletion(message);
    // A marker-only match with an unparseable payload: the old card rendered
    // nothing at all here, silently dropping the completion from the
    // transcript. A line with no name is still better than a hole.
    if (!info) {
      return {
        segments: [{ text: "Process finished" }],
        state: "idle",
        label: "Process finished",
        title: "Background process",
        statusLabel: "finished",
        tone: "ok",
        body: "(no output)",
        kind: "process",
      };
    }
    const model = watcherResultModel(info);
    const phrase = processPhrase(model.statusLabel, info.exitCode);
    const bad = model.tone !== "success";
    return {
      segments: [{ text: phrase }, { text: `· ${model.title}`, tone: "faint", mono: true }],
      state: bad ? "error" : "idle",
      label: `${phrase} — ${model.title}`,
      title: model.title,
      statusLabel: model.statusLabel,
      tone: bad ? "bad" : "ok",
      body: model.body,
      kind: "process",
    };
  }

  if (!parseSubagentCompletion(message)) return null;
  const model = subagentResultModel(message, runsById);
  const phrase = subagentPhrase(model.tone, model.statusLabel);
  const tone: CompletionTone =
    model.tone === "success" ? "ok" : model.tone === "running" ? "pending" : "bad";
  return {
    segments: [{ text: phrase }, { text: `· ${model.title}`, tone: "faint" }],
    state: tone === "bad" ? "error" : tone === "pending" ? "active" : "idle",
    label: `${phrase} — ${model.title}`,
    title: model.title,
    statusLabel: model.statusLabel,
    tone,
    body: model.body,
    kind: "subagent",
  };
}

/**
 * Every subagent completion in the transcript, keyed by run id — the source for
 * the background-tasks sheet's "Result" disclosure.
 *
 * The sheet reads the SAME model the transcript renders rather than a new RPC,
 * because the completion body is already in history: `parseSubagentCompletion`
 * recovers the run id from the message text (`[<runId>]`), which is exactly the
 * ledger row's id.
 *
 * A run whose completion has been compacted out of history simply has no entry,
 * and the sheet must render no disclosure at all in that case — an empty
 * "Result" panel would claim the run returned nothing, which is a different and
 * false statement.
 *
 * Process rows deliberately get nothing here: the sheet reads their output live
 * via `readBackgroundWorkOutput`, which serves head AND tail of both streams —
 * strictly better than the tail this metadata carries.
 */
export function subagentResultsByRunId(
  messages: UIMessage[],
  runsById: Record<string, SubagentRunView>,
): Record<string, CompletionLineModel> {
  const out: Record<string, CompletionLineModel> = {};
  for (const message of messages) {
    const parsed = parseSubagentCompletion(message);
    if (!parsed) continue;
    const model = completionLineModel(message, runsById);
    // Last write wins: a run id appears once, but if a completion were ever
    // re-delivered the later message is the newer truth.
    if (model) out[parsed.runId] = model;
  }
  return out;
}
