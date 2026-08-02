import type { FileUIPart } from "ai";
import { PaperclipIcon } from "@/components/icons/lucide-shim";

/**
 * Read-only attachment chip matching the compact PromptInputAttachment look,
 * without the remove button or attachments context. Used to mirror staged
 * attachments in the composer's attachment row while the disabled new-chat
 * composer waits for the thread to be created.
 */
export function AttachmentPreviewChip({ data }: { data: FileUIPart }) {
  const filename = data.filename || "";
  const isImage = Boolean(data.mediaType?.startsWith("image/") && data.url);

  return (
    <div className="flex h-8 min-w-0 max-w-48 shrink-0 items-center gap-1.5 rounded-md border border-border px-1.5 font-medium text-sm">
      <div className="flex size-5 shrink-0 items-center justify-center overflow-hidden rounded bg-background">
        {isImage ? (
          <img
            alt={filename || "attachment"}
            className="size-5 object-cover"
            height={20}
            src={data.url}
            width={20}
          />
        ) : (
          <span className="text-muted-foreground">
            <PaperclipIcon className="size-3" />
          </span>
        )}
      </div>
      {filename && <span className="min-w-0 flex-1 truncate">{filename}</span>}
    </div>
  );
}
