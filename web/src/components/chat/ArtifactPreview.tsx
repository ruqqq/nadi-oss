import { useCallback, useEffect, useState } from "react";
import { toast } from "sonner";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Sheet, SheetContent, SheetHeader, SheetTitle } from "@/components/ui/sheet";
import { Spinner } from "@/components/ui/spinner";
import { Browser } from "@/icons";
import {
  mintArtifactViewUrl,
  type MessageArtifactPart,
} from "@/lib/message-artifact-parts";
import { openMintedUrlInNewTab } from "@/lib/open-minted-url";
import { useMediaQuery } from "@/lib/use-media-query";
import { useVisualViewportInset } from "@/lib/use-visual-viewport-inset";

export function useArtifactPreview(artifact: MessageArtifactPart, nowMs: number) {
  const expired = nowMs >= artifact.expiresAt;
  const [previewOpen, setPreviewOpen] = useState(false);
  const [openBusy, setOpenBusy] = useState(false);

  async function openInTab() {
    if (expired || openBusy) return;
    setOpenBusy(true);
    try {
      // The tab is claimed inside this click (see openMintedUrlInNewTab) —
      // minting first and opening after the await is what made this button do
      // nothing at all on iOS Safari while working on desktop Chrome.
      const result = await openMintedUrlInNewTab(() => mintArtifactViewUrl(artifact.url));
      // A browser that refuses the tab anyway (iOS "Block Pop-ups", a locked
      // down PWA) still has somewhere to go: the in-app preview renders the
      // same artifact without leaving the conversation.
      if (result.status === "blocked") setPreviewOpen(true);
    } catch (error: unknown) {
      const message = error instanceof Error ? error.message : "Couldn't open this preview.";
      toast.error(message);
    } finally {
      setOpenBusy(false);
    }
  }

  return { expired, previewOpen, setPreviewOpen, openBusy, openInTab };
}

export function ArtifactPreview({
  artifact,
  expired,
  open,
  onOpenChange,
}: {
  artifact: MessageArtifactPart;
  expired: boolean;
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  const isMobile = useMediaQuery("(max-width: 640px)");
  const viewport = useVisualViewportInset(open && isMobile);
  const [viewUrl, setViewUrl] = useState<string | null>(null);
  const [previewLoading, setPreviewLoading] = useState(false);
  const [previewExpired, setPreviewExpired] = useState(false);

  const resetPreview = useCallback(() => {
    setViewUrl(null);
    setPreviewLoading(false);
    setPreviewExpired(false);
  }, []);

  useEffect(() => {
    if (!open) {
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
        onOpenChange(false);
      })
      .finally(() => {
        if (!cancelled) setPreviewLoading(false);
      });

    return () => {
      cancelled = true;
    };
  }, [artifact.url, expired, open, onOpenChange, resetPreview]);

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
          className="min-h-0 w-full flex-1 border-0 bg-background"
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

  if (isMobile) {
    return (
      <Sheet open={open} onOpenChange={onOpenChange}>
        <SheetContent
          side="bottom"
          className="flex h-dvh max-h-dvh flex-col gap-0 rounded-none p-0 pb-[env(safe-area-inset-bottom)]"
          style={
            viewport
              ? {
                  height: `${viewport.height}px`,
                  maxHeight: `${viewport.height}px`,
                  paddingBottom: viewport.keyboard,
                }
              : undefined
          }
        >
          <SheetHeader className="shrink-0 border-b py-4 pr-12 pl-5">
            <SheetTitle className="text-base">{previewHeader}</SheetTitle>
          </SheetHeader>
          {previewBody}
        </SheetContent>
      </Sheet>
    );
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="fixed inset-0 flex h-dvh max-h-dvh w-screen max-w-none translate-x-0 translate-y-0 flex-col gap-0 rounded-none border-0 p-0 sm:max-w-none">
        <DialogHeader className="shrink-0 border-b py-4 pr-12 pl-5">
          <DialogTitle className="text-base">{previewHeader}</DialogTitle>
        </DialogHeader>
        {previewBody}
      </DialogContent>
    </Dialog>
  );
}
