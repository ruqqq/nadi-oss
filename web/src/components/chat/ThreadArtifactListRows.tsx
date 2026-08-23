import type { ThreadArtifactItem, ThreadDownloadItem } from "../../artifacts-api";
import { Button } from "../ui/button";
import { Spinner } from "../ui/spinner";
import { ArrowSquareOut, ArrowsClockwise, Browser, DownloadSimple, Image } from "../../icons";
import { cn } from "../../lib/utils";
import { formatArtifactExpiryHint, type MessageArtifactPart } from "../../lib/message-artifact-parts";
import { attachmentDownloadUrl } from "../../lib/message-file-parts";
import { ArtifactPreview, useArtifactPreview } from "./ArtifactPreview";
import { fileKind } from "./MessageAttachmentView";

function toArtifactPart(item: ThreadArtifactItem): MessageArtifactPart {
  return {
    artifactId: item.id,
    title: item.title,
    expiresAt: item.expiresAt,
    url: item.url,
  };
}

export function formatByteSize(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes < 0) return "—";
  if (bytes < 1024) return `${Math.round(bytes)} B`;
  if (bytes < 1024 * 1024) return `${Math.round(bytes / 1024)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(bytes >= 10 * 1024 * 1024 ? 0 : 1)} MB`;
}

function downloadKind(item: ThreadDownloadItem) {
  const mediaType = item.mimeType || "";
  if (mediaType.startsWith("image/") && !mediaType.includes("svg")) {
    const name = item.filename || "";
    const dot = name.lastIndexOf(".");
    const ext = dot > 0 ? name.slice(dot + 1).toUpperCase() : "IMAGE";
    return { Glyph: Image, tag: ext };
  }
  return fileKind(item.filename || "", mediaType);
}

const rowClass =
  "flex w-full min-w-0 items-center gap-2 rounded-lg border border-border bg-card py-1.5 pr-1.5 pl-3 transition-colors hover:bg-accent/60";

export function ArtifactListRow({
  item,
  nowMs,
}: {
  item: ThreadArtifactItem;
  nowMs: number;
}) {
  const artifact = toArtifactPart(item);
  const {
    expired,
    expiresAt,
    previewOpen,
    setPreviewOpen,
    openBusy,
    openInTab,
    republishBusy,
    republish,
  } = useArtifactPreview(artifact, nowMs);
  const expiryHint = formatArtifactExpiryHint(expiresAt, nowMs);
  const filesLabel =
    item.fileCount === 1 ? "1 file" : `${item.fileCount.toLocaleString("en-US")} files`;

  const identity = (
    <>
      <span className="flex size-8 shrink-0 items-center justify-center rounded-md bg-muted text-muted-foreground">
        <Browser aria-hidden className="size-4" />
      </span>
      <span className="flex min-w-0 flex-1 flex-col">
        <span className="truncate font-medium text-sm text-foreground">{item.title}</span>
        <span className="truncate font-mono text-[11px] uppercase tracking-wider text-muted-foreground">
          {expiryHint} · {filesLabel}
        </span>
      </span>
    </>
  );

  return (
    <>
      <div className={rowClass}>
        {expired ? (
          <div className="flex min-w-0 flex-1 items-center gap-3 py-1">{identity}</div>
        ) : (
          <button
            type="button"
            className="flex min-w-0 flex-1 items-center gap-3 py-1 text-left outline-none focus-visible:ring-2 focus-visible:ring-ring"
            onClick={() => setPreviewOpen(true)}
            aria-label={`Preview ${item.title}`}
          >
            {identity}
          </button>
        )}
        {expired ? (
          <Button
            type="button"
            variant="outline"
            size="sm"
            className="h-8 shrink-0"
            disabled={republishBusy}
            aria-label={`Republish ${item.title}`}
            onClick={() => void republish()}
          >
            {republishBusy ? (
              <Spinner className="size-3.5" label="Republishing" />
            ) : (
              <ArrowsClockwise aria-hidden className="size-3.5" />
            )}
            Republish
          </Button>
        ) : (
          <Button
            type="button"
            variant="ghost"
            size="icon-sm"
            disabled={openBusy}
            aria-label={`Open ${item.title} in a new tab`}
            title="Open in a new tab"
            onClick={() => void openInTab()}
          >
            <ArrowSquareOut aria-hidden className="size-4" />
          </Button>
        )}
      </div>
      <ArtifactPreview
        artifact={artifact}
        expired={expired}
        open={previewOpen}
        onOpenChange={setPreviewOpen}
        onRepublish={() => void republish()}
        republishBusy={republishBusy}
      />
    </>
  );
}

export function DownloadListRow({ item }: { item: ThreadDownloadItem }) {
  const filename = item.filename || "Attachment";
  const downloadHref = attachmentDownloadUrl(item.url);
  const { Glyph, tag } = downloadKind(item);

  return (
    <a
      href={downloadHref}
      download={item.filename || undefined}
      rel="noreferrer"
      aria-label={`Download ${filename}`}
      className={cn(rowClass, "outline-none focus-visible:ring-2 focus-visible:ring-ring")}
    >
      <span className="flex size-8 shrink-0 items-center justify-center rounded-md bg-muted text-muted-foreground">
        <Glyph aria-hidden className="size-4" />
      </span>
      <span className="flex min-w-0 flex-1 flex-col py-1">
        <span className="truncate font-medium text-sm text-foreground">{filename}</span>
        <span className="truncate font-mono text-[11px] uppercase tracking-wider text-muted-foreground">
          {tag} · {formatByteSize(item.byteSize)}
        </span>
      </span>
      <span className="flex size-8 shrink-0 items-center justify-center text-muted-foreground">
        <DownloadSimple aria-hidden className="size-4" />
      </span>
    </a>
  );
}
