import type { ModelInputModality } from "../settings-api";

const IMAGE_MIME = new Set(["image/png", "image/jpeg", "image/webp", "image/gif"]);
const IMAGE_EXT = new Set(["png", "jpg", "jpeg", "webp", "gif"]);

// Curated text/code extensions (kept in sync with the backend allowlist).
export const TEXT_EXTENSIONS = [
  "txt",
  "log",
  "md",
  "markdown",
  "csv",
  "json",
  "yaml",
  "yml",
  "xml",
  "html",
  "htm",
  "svg",
  "css",
  "sql",
  "js",
  "jsx",
  "ts",
  "tsx",
  "py",
  "go",
  "rs",
  "java",
  "c",
  "h",
  "cpp",
  "hpp",
  "sh",
  "rb",
  "php",
];

// Office formats (kept in sync with the backend OFFICE_MIME_BY_EXT allowlist).
export const OFFICE_EXTENSIONS = ["docx", "xlsx", "pptx"];

// The composer file-picker `accept` attribute: images + PDF (by MIME) plus
// text/code by extension (browsers report empty/odd MIME for code files, so
// extensions filter the OS picker more reliably). Decoupled from model
// modalities — capability is surfaced via a toast instead.
export const ATTACHMENT_ACCEPT = [
  "image/png",
  "image/jpeg",
  "image/webp",
  "image/gif",
  "application/pdf",
  ...TEXT_EXTENSIONS.map((ext) => `.${ext}`),
  ...OFFICE_EXTENSIONS.map((ext) => `.${ext}`),
].join(",");

function extensionOf(name: string): string {
  const dot = name.lastIndexOf(".");
  return dot >= 0 && dot < name.length - 1 ? name.slice(dot + 1).toLowerCase() : "";
}

export function fileMatchesAccept(file: { type: string; name: string }, accept: string): boolean {
  if (!accept || accept.trim() === "") return true;
  const patterns = accept
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
  return patterns.some((pattern) => {
    if (pattern.startsWith(".")) {
      return file.name.toLowerCase().endsWith(pattern.toLowerCase());
    }
    if (pattern.endsWith("/*")) {
      return file.type.startsWith(pattern.slice(0, -1));
    }
    return file.type === pattern;
  });
}

function isImage(file: { type: string; name: string }): boolean {
  return IMAGE_MIME.has(file.type) || IMAGE_EXT.has(extensionOf(file.name));
}

function isPdf(file: { type: string; name: string }): boolean {
  return file.type === "application/pdf" || extensionOf(file.name) === "pdf";
}

// Whether the selected model can read this file inline as native content.
// Everything else (text/code, or a PDF on an image-only model) is surfaced to
// the agent via getAttachmentUrl instead.
export function canModelReadNatively(
  file: { type: string; name: string },
  modalities: ModelInputModality[],
): boolean {
  if (isImage(file)) return modalities.includes("image");
  if (isPdf(file)) return modalities.includes("file");
  return false;
}
