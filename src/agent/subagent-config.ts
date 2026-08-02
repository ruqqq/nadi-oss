/**
 * Detached-run options for a shared-sandbox subagent dispatch.
 *
 * `noProgressBudgetMs: Infinity` DISABLES the SDK reconcile backbone's
 * "give up on a silent run" timer. A subagent reports a progress signal only
 * at the start of each turn, and real work (a build, a long model turn, a
 * watcher wait) is silent for minutes — so any finite budget here
 * abandons healthy runs. The absolute `maxBudgetMs` ceiling remains the sole
 * bound (plus the child's own chatRecovery content-runaway limits and explicit
 * cancel). See agents/docs/agent-tools.md.
 */
export const SUBAGENT_DETACHED = {
  notify: { source: "subagent" as const },
  maxBudgetMs: 45 * 60_000, // 45 min: fits real coding subagents; still finite.
  noProgressBudgetMs: Infinity,
};
