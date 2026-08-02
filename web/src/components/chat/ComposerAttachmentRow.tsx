import type { FileUIPart } from "ai";
import { useCallback, useEffect, useRef, useState } from "react";
import {
  PromptInputAttachment,
  usePromptInputAttachments,
} from "@/components/ai-elements/prompt-input";
import { AttachmentPreviewChip } from "@/components/chat/AttachmentPreviewChip";

const FADE = "16px";

/** Mask that fades whichever edge has content scrolled past it. */
function edgeMask(left: boolean, right: boolean): string | undefined {
  if (!(left || right)) return undefined;
  const stops = [
    left ? `transparent 0, black ${FADE}` : "black 0",
    right ? `black calc(100% - ${FADE}), transparent 100%` : "black 100%",
  ];
  return `linear-gradient(to right, ${stops.join(", ")})`;
}

/**
 * Attachment chips on their own row above the composer toolbar, scrolling
 * horizontally. They used to sit inline beside the + button, where enough of
 * them overflowed the row and painted over the model picker.
 *
 * Renders nothing when there is nothing to show, so the composer keeps its
 * original height until the first attachment lands.
 */
export function ComposerAttachmentRow({
  uploadAttachments,
  previewFiles,
}: {
  uploadAttachments: boolean;
  previewFiles?: FileUIPart[] | undefined;
}) {
  const attachments = usePromptInputAttachments();
  const scrollerRef = useRef<HTMLDivElement>(null);
  const contentRef = useRef<HTMLDivElement>(null);
  const [fade, setFade] = useState<{ left: boolean; right: boolean }>({
    left: false,
    right: false,
  });

  const syncFade = useCallback(() => {
    const el = scrollerRef.current;
    if (!el) return;
    const max = el.scrollWidth - el.clientWidth;
    setFade((prev) => {
      const next = { left: el.scrollLeft > 1, right: el.scrollLeft < max - 1 };
      return prev.left === next.left && prev.right === next.right ? prev : next;
    });
  }, []);

  // Watch both boxes: the scroller's width sets the viewport, the content's
  // width changes as chips are added or removed.
  useEffect(() => {
    const scroller = scrollerRef.current;
    const content = contentRef.current;
    if (!(scroller && content)) return;
    syncFade();
    const observer = new ResizeObserver(syncFade);
    observer.observe(scroller);
    observer.observe(content);
    return () => observer.disconnect();
  }, [syncFade]);

  const liveFiles = uploadAttachments ? attachments.files : [];
  const previews = previewFiles ?? [];
  if (liveFiles.length === 0 && previews.length === 0) return null;

  return (
    <div
      ref={scrollerRef}
      onScroll={syncFade}
      className="fade-in slide-in-from-bottom-1 w-full animate-in overflow-x-auto px-3 pb-2 duration-200 [-ms-overflow-style:none] [scrollbar-width:none] [&::-webkit-scrollbar]:hidden"
      style={{
        maskImage: edgeMask(fade.left, fade.right),
        WebkitMaskImage: edgeMask(fade.left, fade.right),
      }}
    >
      <div ref={contentRef} className="flex w-max flex-nowrap items-center gap-2">
        {liveFiles.map((attachment) => (
          <PromptInputAttachment
            key={attachment.id}
            data={attachment}
            className="fade-in zoom-in-95 animate-in duration-150"
          />
        ))}
        {previews.map((file, i) => (
          <AttachmentPreviewChip key={`preview-${i}`} data={file} />
        ))}
      </div>
    </div>
  );
}
