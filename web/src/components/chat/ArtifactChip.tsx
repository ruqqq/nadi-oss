import { Button } from "@/components/ui/button";
import { ArrowSquareOut, Browser } from "@/icons";
import { cn } from "@/lib/utils";
import {
  formatArtifactExpiryHint,
  type MessageArtifactPart,
} from "@/lib/message-artifact-parts";
import { ArtifactPreview, useArtifactPreview } from "./ArtifactPreview";

export function ArtifactChip({ artifact, nowMs }: { artifact: MessageArtifactPart; nowMs: number }) {
  const { expired, previewOpen, setPreviewOpen, openBusy, openInTab } = useArtifactPreview(
    artifact,
    nowMs,
  );
  const expiryHint = formatArtifactExpiryHint(artifact.expiresAt, nowMs);

  return (
    <>
      <div
        className={cn(
          "flex w-64 max-w-full flex-col gap-2 rounded-lg border border-border bg-card px-3 py-2.5",
          expired && "opacity-60",
        )}
      >
        <div className="flex items-center gap-3">
          <span className="flex size-9 shrink-0 items-center justify-center rounded-md bg-muted text-muted-foreground">
            <Browser className="size-5" />
          </span>
          <span className="flex min-w-0 flex-col">
            <span className="truncate text-sm font-medium text-foreground">{artifact.title}</span>
            <span className="font-mono text-[11px] uppercase tracking-wider text-muted-foreground">
              {expiryHint}
            </span>
          </span>
        </div>
        <div className="flex gap-2">
          <Button
            type="button"
            variant="outline"
            size="sm"
            className="h-8 flex-1"
            disabled={expired}
            onClick={() => setPreviewOpen(true)}
          >
            Preview
          </Button>
          <Button
            type="button"
            variant="outline"
            size="sm"
            className="h-8 flex-1"
            disabled={expired || openBusy}
            onClick={() => void openInTab()}
          >
            <ArrowSquareOut className="size-3.5" />
            Open
          </Button>
        </div>
      </div>

      <ArtifactPreview
        artifact={artifact}
        expired={expired}
        open={previewOpen}
        onOpenChange={setPreviewOpen}
      />
    </>
  );
}
