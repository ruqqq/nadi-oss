import { tool, type ToolSet } from "ai";
import { z } from "zod";

const SPAWN_DESCRIPTION = [
  "Delegate a self-contained task to a subagent that runs in the BACKGROUND on",
  "the SAME machine as you (shared filesystem, processes, environment). Returns",
  "immediately with a runId; the subagent's result arrives LATER as a message.",
  "",
  "Use this to parallelize INDEPENDENT work — a subtask whose result you do NOT",
  "need in order to keep making progress on something else. It is not a way to",
  "do the next thing on your own plan faster.",
  "",
  "Rules:",
  "- Do NOT perform the delegated task yourself as well. Spawning a subagent AND",
  "  doing the same work in this thread duplicates it and wastes tokens — the",
  "  whole point is to offload it. Hand it over completely.",
  "- If you NEED the subagent's result to continue (e.g. you delegated an",
  "  investigation whose findings you'll act on), do not press ahead on that",
  "  work. Stop and wait: end your turn (or start other INDEPENDENT work), and",
  "  continue when its completion message arrives. Use `check_subagents` to see",
  "  whether it has finished yet.",
  "- The subagent does NOT see this conversation — give a complete, standalone",
  "  `task`.",
  "",
  "Good: 'investigate X while I implement Y'; running several independent probes",
  "at once. Bad: spawning a subagent for a task and then doing that same task",
  "yourself in parallel.",
].join("\n");

const CHECK_DESCRIPTION = [
  "Check the subagents you've spawned in this thread: their status (running or a",
  "terminal state like completed/error/aborted) and, once finished, a short",
  "result summary. Use it to decide whether to keep waiting for a delegated",
  "result or to proceed — not as a busy-wait loop. A finished subagent's full",
  "result also arrives on its own as a message.",
].join(" ");

export interface SubagentRunStatus {
  runId: string;
  label?: string;
  status: string;
  summary?: string;
}

export function createSubagentTools(deps: {
  spawn: (input: {
    task: string;
    label?: string;
    /** The spawning tool call's id, forwarded as the run's parentToolCallId so
     *  useAgentToolEvents binds the run to this tool call (drives the run card). */
    toolCallId?: string;
  }) => Promise<{ runId: string } | { error: string }>;
  /** Lists this parent's subagent runs with their current status/summary. */
  list: () => Promise<SubagentRunStatus[]>;
}): ToolSet {
  return {
    spawn_subagent: tool({
      description: SPAWN_DESCRIPTION,
      inputSchema: z.object({
        task: z.string().min(1).describe("Self-contained instruction for the subagent."),
        label: z.string().optional().describe("Short human label for this run."),
      }),
      execute: async ({ task, label }, { toolCallId }) => {
        const result = await deps.spawn({ task, ...(label ? { label } : {}), toolCallId });
        if ("error" in result) return { status: "rejected", error: result.error };
        return { runId: result.runId, status: "started" };
      },
    }),
    check_subagents: tool({
      description: CHECK_DESCRIPTION,
      inputSchema: z.object({}),
      execute: async () => {
        const runs = await deps.list();
        if (runs.length === 0) return { runs: [], note: "No subagents have been spawned yet." };
        return { runs };
      },
    }),
  };
}

/** Formats a finished child's result for injection into the parent chat. */
/**
 * The SDK stores a run's `input_preview` column JSON-encoded (it does
 * `JSON.stringify(inputPreview)`), so reading the raw column yields a
 * quote-wrapped string. Parse it back to the clean label; otherwise re-wrapping
 * it in {@link formatSubagentCompletion} produces doubled quotes
 * (`Subagent ""task"" finished`) that break the client's completion-detection
 * regex, so the completion renders as a plain bubble instead of a result card.
 * Defensive: non-JSON or non-string input falls back to the raw value.
 */
export function unwrapStoredInputPreview(raw: string | undefined): string | undefined {
  if (typeof raw !== "string") return undefined;
  try {
    const parsed: unknown = JSON.parse(raw);
    return typeof parsed === "string" ? parsed : raw;
  } catch {
    return raw;
  }
}

export function formatSubagentCompletion(args: {
  runId: string;
  label?: string;
  status: string;
  summary?: string;
  error?: string;
}): string {
  const name = args.label ? `"${args.label}"` : "(unlabeled)";
  const head = `Subagent ${name} finished: ${args.status}. [${args.runId}]`;
  const MAX = 4000;
  const body = args.error ? `Error: ${args.error}` : (args.summary ?? "(no summary returned)");
  const clipped = body.length > MAX ? `${body.slice(0, MAX)}\n…[truncated]` : body;
  return `<system-reminder>\n${head}\n${clipped}\n</system-reminder>`;
}
