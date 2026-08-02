import { computeDerivativeSize, MAX_IMAGE_EDGE } from "./image-dimensions";

/** Resize an image File to <= maxEdge on the long side and re-encode. */
export async function compressImage(
  file: File,
  maxEdge: number = MAX_IMAGE_EDGE,
): Promise<{ blob: Blob; width: number; height: number }> {
  const bitmap = await createImageBitmap(file);
  const { width, height } = computeDerivativeSize(bitmap.width, bitmap.height, maxEdge);
  const canvas = document.createElement("canvas");
  canvas.width = width;
  canvas.height = height;
  const ctx = canvas.getContext("2d");
  if (!ctx) throw new Error("canvas 2d context unavailable");
  ctx.drawImage(bitmap, 0, 0, width, height);
  bitmap.close();
  const outType = file.type === "image/png" ? "image/png" : "image/jpeg";
  const blob = await new Promise<Blob>((resolve, reject) =>
    canvas.toBlob((b) => (b ? resolve(b) : reject(new Error("toBlob failed"))), outType, 0.85),
  );
  return { blob, width, height };
}
