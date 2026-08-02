// web/src/lib/attachment-upload.ts
import type { FileUIPart } from "ai";
import { appFetch } from "./app-fetch";
import { compressImage } from "./image-compress";

export const IMAGE_MIME = new Set(["image/png", "image/jpeg", "image/webp", "image/gif"]);

export async function uploadAttachment(threadId: string, part: FileUIPart): Promise<FileUIPart> {
  const sourceBlob = await (await fetch(part.url)).blob();

  let blob = sourceBlob;
  let width: number | null = null;
  let height: number | null = null;
  if (part.mediaType && IMAGE_MIME.has(part.mediaType)) {
    const file = new File([sourceBlob], part.filename ?? "image", { type: part.mediaType });
    const compressed = await compressImage(file);
    blob = compressed.blob;
    width = compressed.width;
    height = compressed.height;
  }

  const form = new FormData();
  form.set(
    "file",
    new File([blob], part.filename ?? "attachment", { type: blob.type || part.mediaType }),
  );
  if (width !== null) form.set("width", String(width));
  if (height !== null) form.set("height", String(height));

  const res = await appFetch(`/api/threads/${threadId}/attachments`, {
    method: "POST",
    body: form,
  });
  if (!res.ok) {
    const detail = await res.json().catch(() => ({}) as { error?: string });
    throw new Error((detail as { error?: string }).error ?? `upload_failed_${res.status}`);
  }
  const json = (await res.json()) as { id: string; url: string; mimeType: string };
  return {
    type: "file",
    url: json.url,
    mediaType: json.mimeType,
    filename: part.filename,
    attachmentId: json.id,
  } as FileUIPart & { attachmentId: string };
}

export function buildUploadAttachments(threadId: string) {
  return (files: FileUIPart[]): Promise<FileUIPart[]> =>
    Promise.all(files.map((f) => uploadAttachment(threadId, f)));
}

// Portable (browser + node) blob -> data URL, so the result survives PromptInput
// revoking its blob: URLs after submit. Avoids FileReader (absent in the node
// test env). Chunked base64 to stay safe on large (non-image) blobs.
async function blobToDataUrl(blob: Blob): Promise<string> {
  const bytes = new Uint8Array(await blob.arrayBuffer());
  let binary = "";
  const CHUNK = 0x8000;
  for (let i = 0; i < bytes.length; i += CHUNK) {
    binary += String.fromCharCode(...bytes.subarray(i, i + CHUNK));
  }
  return `data:${blob.type || "application/octet-stream"};base64,${btoa(binary)}`;
}

// Deferred uploader for the brand-new-chat composer: there is no threadId yet, so
// instead of POSTing we compress images and capture durable data URLs. The actual
// POST happens (via buildUploadAttachments) once the thread is created.
export async function compressToDataUrlAttachments(files: FileUIPart[]): Promise<FileUIPart[]> {
  return Promise.all(
    files.map(async (part) => {
      const sourceBlob = await (await fetch(part.url)).blob();
      let blob = sourceBlob;
      if (part.mediaType && IMAGE_MIME.has(part.mediaType)) {
        const file = new File([sourceBlob], part.filename ?? "image", { type: part.mediaType });
        blob = (await compressImage(file)).blob;
      }
      return {
        type: "file",
        url: await blobToDataUrl(blob),
        mediaType: part.mediaType,
        filename: part.filename,
      };
    }),
  );
}
