/**
 * Drives the in-app activity toast in the mocked app (`?scenario=thread-activity`).
 *
 * This one genuinely cannot be seeded. The toast fires on a *transition* seen
 * over the live socket — a thread the app already knows about changing to
 * attention / failed / completed — so any amount of seeded state produces
 * nothing. The scenario has to actually push events, which is why this schedules
 * them rather than living in `scenarios/index.ts`.
 *
 * Threads are reused from the store, so the payloads keep whatever shape
 * `ThreadSummary` currently has instead of drifting into a hand-written
 * fixture.
 */
import { dispatchMockThreadUpdated } from "./live";
import type { MockStore } from "./store";

const SCENARIO = "thread-activity";

/**
 * Staggered so each toast is legible on its own before the next arrives. The
 * previews mirror what `extractPushPreview` produces server-side — the last
 * assistant message's prose, collapsed and clipped — so the mocked toast is the
 * same shape as the real one. The failure carries none, exercising the fallback
 * to generic copy.
 */
const SCRIPT = [
  {
    delayMs: 2_000,
    patch: { activityStatus: "attention_required", attentionRequiredAt: 0 },
    preview: "Ready to merge #118. Approve running `gh pr merge 118 --squash`?",
  },
  {
    delayMs: 5_500,
    patch: { activityStatus: "failed", unreadOutcome: "failed" },
    preview: undefined,
  },
  {
    delayMs: 9_000,
    patch: { activityStatus: "idle", unreadOutcome: "completed" },
    preview:
      "Traced it to the cold-start path: the bootstrap probe was blocking first paint. Moved it behind the shell render and the p95 dropped from 2.9s to 1.1s.",
  },
] as const;

export function scheduleThreadActivityDemo(scenario: string | null, store: MockStore): void {
  if (scenario !== SCENARIO) return;

  const targets = store.threads.filter((thread) => thread.archivedAt == null).slice(0, SCRIPT.length);

  SCRIPT.forEach((step, index) => {
    const thread = targets[index];
    if (!thread) return;
    setTimeout(() => {
      dispatchMockThreadUpdated(
        {
          ...thread,
          ...step.patch,
          ...("attentionRequiredAt" in step.patch ? { attentionRequiredAt: Date.now() } : {}),
          updatedAt: Date.now(),
        },
        step.preview,
      );
    }, step.delayMs);
  });
}
