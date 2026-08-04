import type { FileUIPart, UIMessage } from "ai";

type Part = UIMessage["parts"][number];

type DownloadToolOutput = {
  attachmentId?: unknown;
  filename?: unknown;
  mimeType?: unknown;
  url?: unknown;
  byteSize?: unknown;
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function attachmentUrlFromId(id: string): string {
  return `/api/attachments/${id}`;
}

/**
 * Build the FileUIParts to render under a message: explicit `file` parts plus
 * successful `exec_download_file` tool results (sandbox → Nadi attachment).
 * Dedupes by URL so a future persisted file part does not double-render.
 */
export function collectMessageFileParts(parts: readonly Part[]): FileUIPart[] {
  const byUrl = new Map<string, FileUIPart>();

  for (const part of parts) {
    if (part.type === "file" && typeof part.url === "string" && part.url.length > 0) {
      byUrl.set(part.url, part);
    }
  }

  for (const part of parts) {
    if (part.type !== "tool-exec_download_file") continue;
    if (!("state" in part) || part.state !== "output-available") continue;
    if (!("output" in part) || !isRecord(part.output)) continue;
    const output = part.output as DownloadToolOutput;
    // Error envelope from toErrorResult: { ok: false, ... }
    if ("ok" in output && output.ok === false) continue;

    const attachmentId =
      typeof output.attachmentId === "string" && output.attachmentId.length > 0
        ? output.attachmentId
        : null;
    if (!attachmentId) continue;

    const url =
      typeof output.url === "string" && output.url.length > 0
        ? output.url
        : attachmentUrlFromId(attachmentId);
    if (byUrl.has(url)) continue;

    const filename = typeof output.filename === "string" ? output.filename : undefined;
    const mimeType =
      typeof output.mimeType === "string" && output.mimeType.length > 0
        ? output.mimeType
        : "application/octet-stream";

    byUrl.set(url, {
      type: "file",
      url,
      mediaType: mimeType,
      ...(filename !== undefined ? { filename } : {}),
    });
  }

  return Array.from(byUrl.values());
}

/** Stable app URL → force-download variant (`?download=1`). */
export function attachmentDownloadUrl(url: string): string {
  try {
    // Absolute URLs (mock / external)
    if (/^https?:\/\//i.test(url)) {
      const parsed = new URL(url);
      parsed.searchParams.set("download", "1");
      return parsed.toString();
    }
  } catch {
    // fall through to relative handling
  }
  const q = url.indexOf("?");
  if (q < 0) return `${url}?download=1`;
  const base = url.slice(0, q);
  const params = new URLSearchParams(url.slice(q + 1));
  params.set("download", "1");
  const qs = params.toString();
  return qs ? `${base}?${qs}` : `${base}?download=1`;
}
