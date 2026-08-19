import type { ModelTuple } from "@/lib/model-switch";

/**
 * The transcript's only feedback that a mid-conversation model switch took
 * effect (see the composer picker's "no pending affordance" doc — there is
 * nothing shown before this point). Styling matches `ChatLog`'s
 * `CompactionDivider` (no-summary branch) so the transcript reads as one
 * family of "something changed here" rules rather than a bespoke visual.
 *
 * `title` carries the full `provider/model` for both ends of the switch;
 * the label itself only names the model switched *to* — the `from` side
 * is available on hover/inspection, not the headline.
 */
export function ModelSwitchDivider({ from, to }: { from: ModelTuple; to: ModelTuple }) {
  return (
    <div
      className="flex items-center gap-3 py-3 text-xs text-muted-foreground"
      role="separator"
      aria-label={`Switched to ${to.model}`}
      title={`${from.provider}/${from.model} → ${to.provider}/${to.model}`}
    >
      <span className="h-px min-w-6 flex-1 bg-border" />
      <span className="shrink-0 font-mono">Switched to {to.model}</span>
      <span className="h-px min-w-6 flex-1 bg-border" />
    </div>
  );
}
