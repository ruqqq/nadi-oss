import { useCallback, useEffect, useState } from "react";
import { toast } from "sonner";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Sheet, SheetContent, SheetHeader, SheetTitle } from "@/components/ui/sheet";
import { Button } from "@/components/ui/button";
import { Spinner } from "@/components/ui/spinner";
import { ArrowSquareOut, Browser } from "@/icons";
import { cn } from "@/lib/utils";
import {
  formatArtifactExpiryHint,
  mintArtifactViewUrl,
  type MessageArtifactPart,
} from "@/lib/message-artifact-parts";
import { useMediaQuery } from "@/lib/use-media-query";
import { useVisualViewportInset } from "@/lib/use-visual-viewport-inset";

export function ArtifactChip({ artifact, nowMs }: { artifact: MessageArtifactPart; nowMs: number }) {
  const isMobile = useMediaQuery("(max-width: 640px)");
  const expired = nowMs >= artifact.expiresAt;
  const expiryHint = formatArtifactExpiryHint(artifact.expiresAt, nowMs);

  const [previewOpen, setPreviewOpen] = useState(false);
  const [viewUrl, setViewUrl] = useState<string | null>(null);
  const [previewLoading, setPreviewLoading] = useState(false);
  const [previewExpired, setPreviewExpired] = useState(false);
  const [openBusy, setOpenBusy] = useState(false);
  const viewport = useVisualViewportInset(previewOpen && isMobile);

  const resetPreview = useCallback(() => {
    setViewUrl(null);
    setPreviewLoading(false);
    setPreviewExpired(false);
  }, []);

  useEffect(() => {
    if (!previewOpen) {
      resetPreview();
      return;
    }
    if (expired) {
      setPreviewExpired(true);
      return;
    }

    let cancelled = false;
    setPreviewLoading(true);
    setPreviewExpired(false);
    void mintArtifactViewUrl(artifact.url)
      .then((url) => {
        if (!cancelled) setViewUrl(url);
      })
      .catch((error: unknown) => {
        if (cancelled) return;
        const message = error instanceof Error ? error.message : "Couldn't open this preview.";
        if (message.toLowerCase().includes("expired")) {
          setPreviewExpired(true);
          return;
        }
        toast.error(message);
        setPreviewOpen(false);
      })
      .finally(() => {
        if (!cancelled) setPreviewLoading(false);
      });

    return () => {
      cancelled = true;
    };
  }, [artifact.url, expired, previewOpen, resetPreview]);

  async function openInTab() {
    if (expired || openBusy) return;
    setOpenBusy(true);
    try {
      const url = await mintArtifactViewUrl(artifact.url);
      window.open(url, "_blank", "noopener,noreferrer");
    } catch (error: unknown) {
      const message = error instanceof Error ? error.message : "Couldn't open this preview.";
      toast.error(message);
    } finally {
      setOpenBusy(false);
    }
  }

  const previewBody = (
    <div className="flex min-h-0 flex-1 flex-col">
      {previewLoading && (
        <div className="flex flex-1 items-center justify-center p-8">
          <Spinner className="size-6 text-muted-foreground" label="Loading preview" />
        </div>
      )}
      {!previewLoading && previewExpired && (
        <div className="flex flex-1 items-center justify-center p-8 text-sm text-muted-foreground">
          This artifact has expired.
        </div>
      )}
      {!previewLoading && viewUrl && (
        <iframe
          title={artifact.title}
          src={viewUrl}
          className="min-h-[50vh] w-full flex-1 border-0 bg-background"
        />
      )}
    </div>
  );

  const previewHeader = (
    <span className="flex min-w-0 items-center gap-2">
      <Browser className="size-4 shrink-0 text-muted-foreground" />
      <span className="truncate font-display">{artifact.title}</span>
    </span>
  );

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
            <span
              className={cn(
                "font-mono text-[11px] uppercase tracking-wider",
                expired ? "text-muted-foreground" : "text-muted-foreground",
              )}
            >
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

      {isMobile ? (
        <Sheet open={previewOpen} onOpenChange={setPreviewOpen}>
          <SheetContent
            side="bottom"
            className="flex max-h-[85vh] flex-col gap-0 p-0 pb-[env(safe-area-inset-bottom)]"
            style={
              viewport
                ? { maxHeight: `${viewport.height}px`, paddingBottom: viewport.keyboard }
                : undefined
            }
          >
            <SheetHeader className="shrink-0 border-b py-4 pr-12 pl-5">
              <SheetTitle className="text-base">{previewHeader}</SheetTitle>
            </SheetHeader>
            {previewBody}
          </SheetContent>
        </Sheet>
      ) : (
        <Dialog open={previewOpen} onOpenChange={setPreviewOpen}>
          <DialogContent className="flex max-h-[82vh] flex-col gap-0 p-0 sm:max-w-3xl">
            <DialogHeader className="shrink-0 border-b py-4 pr-12 pl-5">
              <DialogTitle className="text-base">{previewHeader}</DialogTitle>
            </DialogHeader>
            {previewBody}
          </DialogContent>
        </Dialog>
      )}
    </>
  );
}
