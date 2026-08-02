import type { ToolSet } from "ai";

/**
 * Wall-clock timing for every tool call the model makes, including MCP.
 *
 * Two consumers, deliberately separate:
 *
 * - {@link ToolCallTimingSink} (the DO SQLite store) gets a row at call START,
 *   so a call that never returns still leaves evidence.
 * - {@link stampToolCallDurations} writes `durationMs` onto the persisted
 *   message part, which is what the UI reads. It rides the message through the
 *   live, archived and paginated read paths with no join, because the part is
 *   already persisted and already snapshotted verbatim.
 */

export interface ToolCallTimingSink {
  start(input: { toolCallId: string; toolName: string; startedAt: number }): void;
  finish(input: { toolCallId: string; finishedAt: number; ok: boolean }): void;
}

/** The field stamped onto a tool part. Read by the web transcript. */
export const TOOL_DURATION_FIELD = "durationMs";

interface ExecuteOptions {
  toolCallId?: string;
}

/**
 * Wrap a tool set so every call is timed.
 *
 * Applied to the MERGED tool set (MCP + sandbox + web + subagent + outcome), not
 * just the compute tools. That breadth is the point: in thr_23d415d9 an `exec`
 * and a Markdump MCP call went unresolved together, and with neither timed there
 * was no way to tell which one stalled.
 *
 * This must not change what a tool returns. The model's view of a tool result is
 * identical with and without timing — the duration travels on the message part,
 * never in the output. Tools without an `execute` (client-resolved) pass through
 * untouched, matching `wrapToolsWithOutputCap`.
 */
export function wrapToolsWithTiming<T extends ToolSet>(
  tools: T,
  sink: ToolCallTimingSink,
  now: () => number = Date.now,
): T {
  const result: ToolSet = {};
  for (const [name, tool] of Object.entries(tools)) {
    const execute = tool.execute as
      | ((input: unknown, options: unknown) => unknown | Promise<unknown>)
      | undefined;
    if (typeof execute !== "function") {
      result[name] = tool;
      continue;
    }
    result[name] = {
      ...tool,
      execute: async (input: unknown, options: unknown) => {
        const toolCallId = (options as ExecuteOptions | undefined)?.toolCallId;
        // No id means nothing to key a row or a stamp on. Run the tool
        // untimed rather than inventing an id that can never be joined back.
        if (typeof toolCallId !== "string" || !toolCallId) return execute(input, options);
        sink.start({ toolCallId, toolName: name, startedAt: now() });
        let ok = false;
        try {
          const output = await execute(input, options);
          ok = true;
          return output;
        } finally {
          // `finally`, so a throwing tool is still recorded — a tool that fails
          // slowly is exactly as interesting as one that succeeds slowly.
          sink.finish({ toolCallId, finishedAt: now(), ok });
        }
      },
    } as ToolSet[string];
  }
  return result as T;
}

interface MaybeToolPart {
  toolCallId?: unknown;
  [TOOL_DURATION_FIELD]?: unknown;
}

interface MaybeMessage {
  parts?: unknown;
}

/** Tool call ids carried by a message's parts, in order. */
export function toolCallIdsIn(message: unknown): string[] {
  const parts = (message as MaybeMessage | undefined)?.parts;
  if (!Array.isArray(parts)) return [];
  const ids: string[] = [];
  for (const part of parts) {
    const id = (part as MaybeToolPart | undefined)?.toolCallId;
    if (typeof id === "string" && id) ids.push(id);
  }
  return ids;
}

/**
 * Stamp `durationMs` onto every tool part with a known duration.
 *
 * Mutates the parts in place and returns the same message. In place because the
 * caller is an override of Think's `appendMessageToHistory` /
 * `updateMessageInHistory`, which hands us the very object about to be
 * persisted and cached — cloning would stamp a copy the transcript never sees.
 *
 * A part with no recorded duration is left exactly as it was. Threads that
 * predate this feature therefore render as they always did; absence is normal,
 * not an error.
 */
export function stampToolCallDurations(message: unknown, durations: Map<string, number>): unknown {
  if (durations.size === 0) return message;
  const parts = (message as MaybeMessage | undefined)?.parts;
  if (!Array.isArray(parts)) return message;
  for (const part of parts) {
    const candidate = part as MaybeToolPart | undefined;
    const id = candidate?.toolCallId;
    if (typeof id !== "string" || !id) continue;
    const durationMs = durations.get(id);
    if (durationMs === undefined) continue;
    candidate![TOOL_DURATION_FIELD] = durationMs;
  }
  return message;
}
