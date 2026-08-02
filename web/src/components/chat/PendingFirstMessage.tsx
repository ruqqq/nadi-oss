import type { FileUIPart } from "ai";

import { ArrowsClockwise } from "@/icons";
import { Button } from "@/components/ui/button";
import { Spinner } from "@/components/ui/spinner";
import { cn } from "@/lib/utils";

import { AttachmentPreviewChip } from "./AttachmentPreviewChip";

/**
 * A new thread's first message, shown optimistically while the thread is being
 * created or while the message itself is being uploaded and POSTed.
 *
 * Once bound to a real thread, the delivered message replaces this when it
 * arrives over the socket. A failed delivery stays with a Retry, so the message
 * is never lost.
 */
export function PendingFirstMessage({
  text,
  files,
  status,
  onRetry,
}: {
  text: string;
  files: FileUIPart[];
  status: "sending" | "sent" | "failed";
  onRetry?: () => void;
}) {
  const failed = status === "failed";

  return (
    <div className="flex justify-end px-3 py-2">
      <div className="relative flex max-w-[85%] min-w-0 flex-col items-end gap-1.5">
        <div
          className={cn(
            "min-w-0 rounded-lg px-3 py-2 text-sm whitespace-pre-wrap",
            failed
              ? "border border-destructive/40 bg-destructive/5 text-foreground"
              : "bg-primary text-primary-foreground",
            // Sending is a transient, non-interactive state — mute it so it reads
            // as "not yet real" without shifting the layout when it settles.
            status === "sending" && "opacity-70",
          )}
        >
          {text || <span className="text-muted-foreground italic">Attachment</span>}
        </div>

        {files.length > 0 && (
          <div className="flex min-w-0 flex-wrap justify-end gap-1">
            {files.map((file, index) => (
              <AttachmentPreviewChip key={index} data={file} />
            ))}
          </div>
        )}

        {/* Out of flow, deliberately. In flow this row sat BELOW the bubble in a
            bottom-anchored column, so the instant delivery landed and the row
            disappeared, the bubble dropped ~22px. Reserving its height instead
            only moves that jump to the hand-off into the live message, which
            has no such row — costing zero height is the only version with no
            jump anywhere. It rides in the gap above the typing dots without
            colliding: this caption is right-aligned, the dots are left. */}
        {status === "sending" && (
          <div className="absolute top-full right-0 mt-1 flex items-center gap-1.5 text-muted-foreground text-xs">
            <Spinner className="size-3" />
            Sending…
          </div>
        )}

        {/* Failure stays in flow: it is not transient, it carries an action, and
            here the layout shift is a signal rather than a glitch. */}
        {failed && (
          <div className="flex items-center gap-1.5 text-muted-foreground text-xs">
            <span className="text-destructive">Not sent</span>
            <Button onClick={onRetry} size="xs" type="button" variant="ghost">
              <ArrowsClockwise aria-hidden />
              Retry
            </Button>
          </div>
        )}
      </div>
    </div>
  );
}
