import type { ToolSet } from "ai";
import { truncateOlderMessages } from "agents/experimental/memory/utils";

/**
 * Fallback cap, used only when no budget is available.
 *
 * The real cap is `ContextBudget.maxToolOutputCapChars`, scaled to the model's
 * window. It is NOT cosmetic: tool results in the protected tail are replayed at
 * full fidelity, so an unbounded one keeps the post-compaction floor above the
 * trigger and compaction can never converge — the tool-heavy runaway.
 */
export const DEFAULT_TOOL_OUTPUT_CAP_CHARS = 128_000;

type ProbeMessages = Parameters<typeof truncateOlderMessages>[0];

/**
 * Cap a single tool-result value to `maxChars`, reusing the SDK's exact
 * shape-preserving truncation (strings gain a `[truncated N chars]` suffix,
 * objects keep their container with a truncation note) so the model reads a
 * clearly-truncated result rather than a missing one. Returns the value
 * unchanged when it already fits.
 *
 * `truncateToolOutput` isn't publicly exported, so we route the value through
 * `truncateOlderMessages` on a one-message probe (which calls it internally).
 */
export function capToolOutput(output: unknown, maxChars: number): unknown {
  const probe = [
    {
      id: "cap-probe",
      role: "assistant",
      parts: [
        {
          type: "tool-cap",
          toolCallId: "cap-probe",
          state: "output-available",
          input: {},
          output,
        },
      ],
    },
  ] as unknown as ProbeMessages;
  const [capped] = truncateOlderMessages(probe, {
    keepRecent: 0,
    maxToolOutputChars: maxChars,
    maxTextChars: Number.POSITIVE_INFINITY,
  });
  const part = capped?.parts[0] as { output?: unknown } | undefined;
  return part && "output" in part ? part.output : output;
}

/**
 * Wrap a tool set so every tool's `execute` result is capped at `maxChars`
 * before it becomes a message — the write-time bound that stops a single
 * pathological output from ever pinning the compaction trigger. Tools without
 * an `execute` (client-resolved) are returned untouched.
 */
export function wrapToolsWithOutputCap<T extends ToolSet>(
  tools: T,
  maxChars: number = DEFAULT_TOOL_OUTPUT_CAP_CHARS,
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
      execute: async (input: unknown, options: unknown) =>
        capToolOutput(await execute(input, options), maxChars),
    } as ToolSet[string];
  }
  return result as T;
}
