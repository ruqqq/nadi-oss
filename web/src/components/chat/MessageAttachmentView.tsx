import type { FileUIPart } from "ai";
import type { Icon } from "@phosphor-icons/react";
import { MessageAttachment } from "@/components/ai-elements/message";
import { File, FileCode, FilePdf, FileSvg, FileText } from "@/icons";
import { Dialog, DialogContent, DialogTitle, DialogTrigger } from "@/components/ui/dialog";

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

/**
 * Derives the glyph and a short uppercase type tag for a non-image file, from
 * its filename extension first and its media type as a fallback. The tag is
 * rendered in monospace to echo the operator-terminal identifiers (thr_…)
 * elsewhere in the UI.
 */
function fileMeta(data: FileUIPart): { Glyph: Icon; tag: string } {
  const name = data.filename || "";
  const dot = name.lastIndexOf(".");
  const ext = dot > 0 ? name.slice(dot + 1).toLowerCase() : "";
  const mediaType = data.mediaType || "";

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
 * Renders one attachment in the chat timeline. Images show as a thumbnail that
 * opens a full-size lightbox on click; other file types show as a compact file
 * card — a type glyph plus the filename and a monospace extension tag — that
 * opens the file in a new tab.
 */
export function MessageAttachmentView({ data }: { data: FileUIPart }) {
  const isImage = Boolean(data.mediaType?.startsWith("image/") && data.url);

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
          <img
            alt={data.filename || "attachment"}
            className="max-h-[85vh] w-full rounded-lg object-contain"
            src={data.url}
          />
        </DialogContent>
      </Dialog>
    );
  }

  const filename = data.filename || "Attachment";
  const { Glyph, tag } = fileMeta(data);

  return (
    <a
      aria-label={`Open ${filename}`}
      href={data.url}
      rel="noreferrer"
      target="_blank"
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
