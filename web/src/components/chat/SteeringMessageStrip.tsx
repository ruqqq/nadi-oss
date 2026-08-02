import { Button } from "@/components/ui/button";
import { Spinner } from "@/components/ui/spinner";
import { ArrowBendDownRight, CheckCircle, X } from "@/icons";
import { isCancellableSteerState, type SteeringChip } from "@/lib/steering-messages";

// The steering counterpart to QueuedMessageStrip: a steer the user injected into
// the running turn, shown as a chip until it settles into the transcript. The
// chip is distinct from a queued chip (amber steer accent) and walks
// Steering → Cancelling → Sent (see steering-messages.ts). Cancel is offered
// only while Steering; the server confirms it (see App wiring).

function labelFor(chip: SteeringChip): string {
  if (chip.state === "cancelling") return "Cancelling";
  if (chip.state === "sent") return "Sent";
  return "Steering";
}

export function SteeringMessageStrip({
  items,
  onCancel,
}: {
  items: SteeringChip[];
  onCancel: (chip: SteeringChip) => void;
}) {
  if (items.length === 0) return null;

  return (
    <div className="border-border border-t bg-background/95 px-3 py-2">
      <div className="flex flex-col gap-2">
        {items.map((chip) => {
          const cancellable = isCancellableSteerState(chip.state);
          const sent = chip.state === "sent";
          return (
            <div
              key={chip.clientMessageId}
              className={`flex min-w-0 items-center gap-2 rounded-md border px-2 py-1.5 text-sm ${
                sent ? "border-border bg-muted/30" : "border-steer/30 bg-steer-bg"
              }`}
            >
              <span
                className={`flex shrink-0 items-center gap-1 text-xs ${
                  sent ? "text-approve" : "text-steer"
                }`}
              >
                {chip.state === "cancelling" ? (
                  <Spinner className="size-3" />
                ) : sent ? (
                  <CheckCircle aria-hidden className="size-3.5" weight="fill" />
                ) : (
                  <ArrowBendDownRight aria-hidden className="size-3.5" weight="bold" />
                )}
                {labelFor(chip)}
              </span>
              <span className="min-w-0 flex-1 truncate">{chip.text}</span>
              {cancellable && (
                <Button
                  aria-label="Cancel steering message"
                  onClick={() => onCancel(chip)}
                  size="icon-xs"
                  title="Cancel steering message"
                  type="button"
                  variant="ghost"
                >
                  <X aria-hidden className="size-3" />
                </Button>
              )}
            </div>
          );
        })}
      </div>
    </div>
  );
}
