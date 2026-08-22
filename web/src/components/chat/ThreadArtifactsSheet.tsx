import { useEffect, useState } from "react";
import type { FileUIPart } from "ai";
import {
  listThreadArtifacts,
  type ThreadArtifactItem,
  type ThreadDownloadItem,
} from "../../artifacts-api";
import type { MessageArtifactPart } from "../../lib/message-artifact-parts";
import { useMediaQuery } from "../../lib/use-media-query";
import { useVisualViewportInset } from "../../lib/use-visual-viewport-inset";
import { ScrollArea } from "../ui/scroll-area";
import { Sheet, SheetContent, SheetHeader, SheetTitle } from "../ui/sheet";
import { Spinner } from "../ui/spinner";
import { ArtifactChip } from "./ArtifactChip";
import { MessageAttachmentView } from "./MessageAttachmentView";

function toArtifactPart(item: ThreadArtifactItem): MessageArtifactPart {
  return {
    artifactId: item.id,
    title: item.title,
    expiresAt: item.expiresAt,
    url: item.url,
  };
}

function toFilePart(item: ThreadDownloadItem): FileUIPart {
  return {
    type: "file",
    url: item.url,
    mediaType: item.mimeType,
    ...(item.filename ? { filename: item.filename } : {}),
  };
}

export function ThreadArtifactsSheet({
  open,
  onOpenChange,
  threadId,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  threadId: string;
}) {
  const isMobile = useMediaQuery("(max-width: 640px)");
  const viewport = useVisualViewportInset(open && isMobile);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [artifacts, setArtifacts] = useState<ThreadArtifactItem[]>([]);
  const [downloads, setDownloads] = useState<ThreadDownloadItem[]>([]);
  const [nowMs, setNowMs] = useState(() => Date.now());

  useEffect(() => {
    if (!open) return;
    let cancelled = false;
    setLoading(true);
    setError(null);
    void listThreadArtifacts(threadId)
      .then((data) => {
        if (cancelled) return;
        setArtifacts(data.artifacts);
        setDownloads(data.downloads);
        setNowMs(Date.now());
      })
      .catch((err: unknown) => {
        if (cancelled) return;
        setError(err instanceof Error ? err.message : "Couldn't load this chat's artifacts.");
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [open, threadId]);

  const empty = !loading && !error && artifacts.length === 0 && downloads.length === 0;

  const body = (
    <ScrollArea className="min-h-0 flex-auto">
      <div className="flex flex-col gap-5 px-5 py-4">
        {loading && (
          <div className="flex justify-center py-8">
            <Spinner className="size-5 text-muted-foreground" label="Loading artifacts" />
          </div>
        )}
        {error && <p className="text-sm text-muted-foreground">{error}</p>}
        {empty && (
          <p className="text-sm text-muted-foreground">Nothing published in this chat yet.</p>
        )}
        {!loading && !error && artifacts.length > 0 && (
          <section className="space-y-3">
            <h3 className="text-[11px] font-medium uppercase tracking-wider text-muted-foreground">
              Artifacts
            </h3>
            <div className="flex flex-col gap-3">
              {artifacts.map((item) => (
                <ArtifactChip key={item.id} artifact={toArtifactPart(item)} nowMs={nowMs} />
              ))}
            </div>
          </section>
        )}
        {!loading && !error && downloads.length > 0 && (
          <section className="space-y-3">
            <h3 className="text-[11px] font-medium uppercase tracking-wider text-muted-foreground">
              Downloads
            </h3>
            <div className="flex flex-col gap-3">
              {downloads.map((item) => (
                <MessageAttachmentView key={item.id} data={toFilePart(item)} />
              ))}
            </div>
          </section>
        )}
      </div>
    </ScrollArea>
  );

  const sheetStyle =
    isMobile && viewport && viewport.keyboard > 0
      ? { bottom: `${viewport.keyboard}px`, maxHeight: `${viewport.height}px` }
      : undefined;

  return (
    <Sheet open={open} onOpenChange={onOpenChange}>
      <SheetContent
        side={isMobile ? "bottom" : "right"}
        style={sheetStyle}
        className={
          isMobile
            ? "flex max-h-[85vh] flex-col gap-0 overflow-hidden p-0 pb-[env(safe-area-inset-bottom)]"
            : "flex w-full flex-col gap-0 p-0 sm:max-w-md"
        }
      >
        <SheetHeader className="shrink-0 border-b py-4 pr-12 pl-5 text-left">
          <SheetTitle className="text-base">Artifacts & downloads</SheetTitle>
        </SheetHeader>
        {body}
      </SheetContent>
    </Sheet>
  );
}
