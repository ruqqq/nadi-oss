import { XIcon } from "@/components/icons/lucide-shim";
import { Button } from "@/components/ui/button";
import { Spinner } from "@/components/ui/spinner";
import { isCancellableQueuedStatus, type QueuedMessage } from "@/lib/queued-messages";
import type { FileUIPart } from "ai";

import { AttachmentPreviewChip } from "./AttachmentPreviewChip";

function labelFor(item: QueuedMessage): string {
  if (item.cancelling) return "Cancelling";
  if (item.status === "pending") return "Queued";
  if (item.status === "running") return "Queued";
  if (item.status === "error") return "Failed";
  if (item.status === "aborted" || item.status === "skipped") return "Cancelled";
  return "Done";
}

function previewFor(item: QueuedMessage): string {
  if (item.textPreview) return item.textPreview;
  if (item.attachmentCount > 0) return "Attachment";
  return "Queued message";
}

export function QueuedMessageStrip({
  items,
  onCancel,
}: {
  items: QueuedMessage[];
  onCancel: (item: QueuedMessage) => void;
}) {
  if (items.length === 0) return null;

  return (
    <div className="border-t border-border bg-background/95 px-3 py-2">
      <div className="flex flex-col gap-2">
        {items.map((item) => {
          const cancellable = isCancellableQueuedStatus(item.status) && !item.cancelling;

          return (
            <div
              // Batch rebuilds change submissionId; clientMessageId is the
              // stable per-message identity.
              key={item.clientMessageId}
              className="flex min-w-0 items-center gap-2 rounded-md border border-border bg-muted/30 px-2 py-1.5 text-sm"
            >
              <span className="flex shrink-0 items-center gap-1 text-muted-foreground text-xs">
                {item.cancelling && <Spinner className="size-3" />}
                {labelFor(item)}
              </span>
              <span className="min-w-0 flex-1 truncate">{previewFor(item)}</span>
              {item.attachments.length > 0 && (
                <div className="hidden min-w-0 shrink items-center gap-1 sm:flex">
                  {item.attachments.slice(0, 2).map((file: FileUIPart, index: number) => (
                    <AttachmentPreviewChip key={`${item.submissionId}-${index}`} data={file} />
                  ))}
                </div>
              )}
              <Button
                aria-label="Cancel queued message"
                disabled={!cancellable}
                onClick={() => onCancel(item)}
                size="icon-xs"
                title="Cancel queued message"
                type="button"
                variant="ghost"
              >
                <XIcon aria-hidden className="size-3" />
              </Button>
            </div>
          );
        })}
      </div>
    </div>
  );
}
