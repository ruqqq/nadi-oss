import type { FileUIPart } from "ai";
import type { Icon } from "@phosphor-icons/react";
import { MessageAttachment } from "@/components/ai-elements/message";
import { DownloadSimple, File, FileCode, FilePdf, FileSvg, FileText } from "@/icons";
import { Dialog, DialogContent, DialogTitle, DialogTrigger } from "@/components/ui/dialog";
import { attachmentDownloadUrl } from "@/lib/message-file-parts";

/** Extensions we treat as source/markup so they get the code glyph. */
const CODE_EXTS = new Set([
  "ts",
  "tsx",
  "js",
  "jsx",
  "mjs",
  "cjs",
  "json",
  "html",
  "css",
  "scss",
  "py",
  "go",
  "rs",
  "rb",
  "java",
  "c",
  "h",
  "cpp",
  "cc",
  "cs",
  "php",
  "swift",
  "kt",
  "sh",
  "bash",
  "zsh",
  "sql",
  "yml",
  "yaml",
  "toml",
  "xml",
]);

export function fileKind(filename: string, mediaType: string): { Glyph: Icon; tag: string } {
  const name = filename || "";
  const dot = name.lastIndexOf(".");
  const ext = dot > 0 ? name.slice(dot + 1).toLowerCase() : "";

  if (ext === "pdf" || mediaType === "application/pdf") {
    return { Glyph: FilePdf, tag: "PDF" };
  }
  if (ext === "svg" || mediaType.includes("svg")) {
    return { Glyph: FileSvg, tag: "SVG" };
  }
  if (CODE_EXTS.has(ext)) {
    return { Glyph: FileCode, tag: ext.toUpperCase() };
  }
  if (ext) {
    return { Glyph: FileText, tag: ext.toUpperCase() };
  }
  if (mediaType.startsWith("text/")) {
    return { Glyph: FileText, tag: "TEXT" };
  }
  return { Glyph: File, tag: "FILE" };
}

/**
 * Derives the glyph and a short uppercase type tag for a non-image file, from
 * its filename extension first and its media type as a fallback. The tag is
 * rendered in monospace to echo the operator-terminal identifiers (thr_…)
 * elsewhere in the UI.
 */
function fileMeta(data: FileUIPart): { Glyph: Icon; tag: string } {
  return fileKind(data.filename || "", data.mediaType || "");
}

/**
 * Renders one attachment in the chat timeline. Images show as a thumbnail that
 * opens a full-size lightbox on click (with download); other file types show as
 * a compact file card that downloads via the serve route's disposition flag.
 */
export function MessageAttachmentView({ data }: { data: FileUIPart }) {
  const isImage = Boolean(data.mediaType?.startsWith("image/") && data.url);
  const downloadHref = data.url ? attachmentDownloadUrl(data.url) : undefined;
  const filename = data.filename || "Attachment";

  if (isImage) {
    return (
      <Dialog>
        <DialogTrigger asChild>
          <button
            type="button"
            className="cursor-zoom-in rounded-lg outline-none focus-visible:ring-2 focus-visible:ring-ring"
            aria-label={`View ${data.filename || "image"}`}
          >
            <MessageAttachment data={data} />
          </button>
        </DialogTrigger>
        <DialogContent
          className="max-w-3xl border-0 bg-transparent p-0 shadow-none"
          showCloseButton
        >
          <DialogTitle className="sr-only">{data.filename || "Image attachment"}</DialogTitle>
          <div className="flex flex-col gap-3">
            <img
              alt={data.filename || "attachment"}
              className="max-h-[85vh] w-full rounded-lg object-contain"
              src={data.url}
            />
            {downloadHref && (
              <a
                href={downloadHref}
                download={data.filename || undefined}
                className="mx-auto inline-flex items-center gap-1.5 rounded-md border border-border bg-card px-3 py-1.5 text-sm font-medium text-foreground outline-none transition-colors hover:bg-accent/40 focus-visible:ring-2 focus-visible:ring-ring"
              >
                <DownloadSimple className="size-4" />
                Download{data.filename ? ` ${data.filename}` : ""}
              </a>
            )}
          </div>
        </DialogContent>
      </Dialog>
    );
  }

  const { Glyph, tag } = fileMeta(data);

  return (
    <a
      aria-label={`Download ${filename}`}
      href={downloadHref ?? data.url}
      rel="noreferrer"
      className="group flex w-56 max-w-full items-center gap-3 rounded-lg border border-border bg-card px-3 py-2.5 outline-none transition-colors hover:border-ring/50 hover:bg-accent/40 focus-visible:ring-2 focus-visible:ring-ring"
    >
      <span className="flex size-9 shrink-0 items-center justify-center rounded-md bg-muted text-muted-foreground transition-colors group-hover:text-foreground">
        <Glyph className="size-5" />
      </span>
      <span className="flex min-w-0 flex-col">
        <span className="truncate text-sm font-medium text-foreground">{filename}</span>
        <span className="font-mono text-[11px] uppercase tracking-wider text-muted-foreground">
          {tag}
        </span>
      </span>
    </a>
  );
}
