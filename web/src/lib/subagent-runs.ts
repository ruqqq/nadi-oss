import type { UIMessage } from "ai";

/**
 * The web-side counterpart to the subagent run-visibility layer. Pure helpers
 * that project the SDK's `AgentToolRunState` (streamed via `useAgentToolEvents`)
 * and the injected completion message onto small view models the thin `.tsx`
 * cards render. Kept dependency-light so it unit-tests in the node env.
 */

/** MUST equal the parent's `detached.notify.source` (src/agent/think-thread-agent.ts). */
export const SUBAGENT_NOTIFY_SOURCE = "subagent";

/** The subset of the SDK's `AgentToolRunState` the UI reads. */
export interface SubagentRunView {
  runId: string;
  status: "running" | "completed" | "error" | "aborted" | "interrupted";
  display?: { name?: string };
  inputPreview?: unknown;
  progress?: { message?: string; phase?: string };
  summary?: string;
  error?: string;
  /** Present only when `status === "interrupted"` — machine-readable cause,
   *  mirrored from the SDK's `AgentToolRunState.reason` (e.g. "budget-exceeded"). */
  reason?: string;
  /** Present only when `status === "interrupted"` — true while a soft
   *  interrupt's child facet is still live on the shared sandbox. */
  childStillRunning?: boolean;
}

export type SubagentTone = "running" | "success" | "error" | "stopped";

export function subagentTone(status: SubagentRunView["status"]): SubagentTone {
  switch (status) {
    case "running":
      return "running";
    case "completed":
      return "success";
    case "error":
      return "error";
    default:
      return "stopped"; // aborted | interrupted
  }
}

const STATUS_LABEL: Record<SubagentRunView["status"], string> = {
  running: "Running",
  completed: "Completed",
  error: "Error",
  aborted: "Cancelled",
  interrupted: "Interrupted",
};

const KNOWN_STATUSES: readonly SubagentRunView["status"][] = [
  "running",
  "completed",
  "error",
  "aborted",
  "interrupted",
];
function isKnownStatus(value: unknown): value is SubagentRunView["status"] {
  return typeof value === "string" && (KNOWN_STATUSES as readonly string[]).includes(value);
}

/**
 * Status label for a run's card/result chip. An `interrupted` run gets the
 * SDK-mirrored `reason` (and, while the child facet is still live on the
 * shared sandbox, "still running") folded in — so it reads as distinct from
 * a clean `completed` run and from a plain, reasonless interruption, instead
 * of the single generic "Interrupted" for every soft/hard interrupt cause.
 */
function statusLabelFor(
  run: Pick<SubagentRunView, "status" | "reason" | "childStillRunning">,
): string {
  const base = STATUS_LABEL[run.status];
  if (run.status !== "interrupted") return base;
  const details = [run.reason, run.childStillRunning ? "still running" : undefined].filter(
    (part): part is string => Boolean(part),
  );
  return details.length > 0 ? `${base} (${details.join(", ")})` : base;
}

/**
 * The subagent completion arrives as a role:"user" message whose text is the
 * `formatSubagentCompletion` string:
 *   <system-reminder>\nSubagent "<label>" finished: <status>. [<runId>]\n<body>\n</system-reminder>
 * (or `Subagent (unlabeled)` when no label). We MUST discriminate on this text
 * shape, not on message.metadata: @cloudflare/think attaches the detached-notify
 * metadata to the *submission* row, never to the message applied to history, so
 * `message.metadata.source` is absent on the client.
 *
 * The label group is a LAZY `[\s\S]*?` up to the literal `" finished: `
 * marker, not `[^"]*` — this regex has broken twice on the same shape:
 * `formatSubagentCompletion` now strips `"` from the label server-side, but a
 * run registered before that fix (or a future caller that skips it) can still
 * carry an embedded `"`, and a strict "no quotes allowed" capture cannot match
 * that case at all — the whole message then falls back to a raw text bubble
 * instead of a result card. The marker string is specific enough that a label
 * containing it verbatim is the only case the laziness could mis-split on.
 */
const SUBAGENT_COMPLETION_RE =
  /^<system-reminder>\s*Subagent (?:"([\s\S]*?)"(?= finished: )|\(unlabeled\)) finished: (\w+)\.\s*\[([^\]]+)\]\s*([\s\S]*?)\s*<\/system-reminder>\s*$/;

export interface SubagentCompletionParse {
  label?: string;
  status?: string;
  runId: string;
  body: string;
}

export function parseSubagentCompletion(message: UIMessage): SubagentCompletionParse | null {
  if (message.role !== "user") return null;
  const match = SUBAGENT_COMPLETION_RE.exec(firstText(message).trim());
  if (!match) return null;
  const label = match[1];
  const status = match[2];
  const runId = match[3] ?? "";
  const body = (match[4] ?? "").trim();
  return {
    ...(label ? { label } : {}),
    ...(status ? { status } : {}),
    runId,
    body,
  };
}

export function isSubagentCompletionMessage(message: UIMessage): boolean {
  return parseSubagentCompletion(message) !== null;
}

export function subagentCardTitle(run: SubagentRunView): string {
  const name = run.display?.name;
  if (name && name.trim()) return name;
  if (typeof run.inputPreview === "string" && run.inputPreview.trim()) {
    return run.inputPreview.length > 80 ? `${run.inputPreview.slice(0, 80)}…` : run.inputPreview;
  }
  return "Subagent";
}

export interface SubagentResultModel {
  title: string;
  statusLabel: string;
  tone: SubagentTone;
  body: string;
}

function firstText(message: UIMessage): string {
  const part = message.parts.find((p) => p.type === "text");
  return part && "text" in part ? String((part as { text: unknown }).text) : "";
}

export function subagentResultModel(
  message: UIMessage,
  runsById: Record<string, SubagentRunView>,
): SubagentResultModel {
  const parsed = parseSubagentCompletion(message);
  const run = parsed ? runsById[parsed.runId] : undefined;
  const parsedStatus = parsed?.status;
  const status: SubagentRunView["status"] =
    run?.status ?? (isKnownStatus(parsedStatus) ? parsedStatus : "completed");
  const parsedLabel = parsed?.label;
  const title = run
    ? subagentCardTitle(run)
    : parsedLabel && parsedLabel.trim()
      ? parsedLabel
      : "Subagent";
  const body = run?.error ?? run?.summary ?? parsed?.body ?? "";
  return {
    title,
    statusLabel: statusLabelFor({
      status,
      reason: run?.reason,
      childStillRunning: run?.childStillRunning,
    }),
    tone: subagentTone(status),
    body: body || "(no summary)",
  };
}
