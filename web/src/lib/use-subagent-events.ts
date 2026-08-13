import type { UIMessage } from "ai";
import { useAgent, useAgentToolEvents } from "agents/react";
import type { SubagentRunView } from "./subagent-runs";

// Bind the State type param so this resolves to useAgent's untyped overload —
// the same one App.tsx's `useAgent({...})` call resolves to, and the same
// binding use-background-work.ts uses for its own (call-shaped) socket cast.
// `useAgentToolEvents` only needs the event-target half of this
// (`addEventListener`/`removeEventListener`), which the plain return type
// already provides.
type AgentSocket = ReturnType<typeof useAgent<unknown>>;

/**
 * Live subagent tool-call state for the CURRENT session, keyed by run id.
 *
 * This is deliberately narrow: it used to be bundled into `useSubagentRuns`
 * alongside the (now-removed) subagent dock's own concerns — run list/sort,
 * server-persisted timings, cancel/clear-finished actions. Those moved to
 * `useBackgroundWork` (ledger-backed, survives a refresh); this hook keeps
 * only what a page refresh CANNOT recover — the in-flight SDK event stream —
 * because `ChatLog`'s `CompletionGroup` (via `SubagentResultNotice`) needs
 * `run.summary`/`run.error`/`run.display` to enrich an already-rendered
 * completion message, and the ledger row (`WorkRow`) carries none of that.
 */
export function useSubagentEvents(agent: AgentSocket): {
  runsById: Record<string, SubagentRunView>;
} {
  const events = useAgentToolEvents<UIMessage["parts"][number]>({ agent });
  return { runsById: events.runsById as unknown as Record<string, SubagentRunView> };
}
