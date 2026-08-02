import { ComputeError } from "../errors";

/**
 * Decodes file bytes as UTF-8 text for the file-editing tools, which only
 * operate on text files. Rejects invalid UTF-8 and NUL-containing content as
 * binary.
 */
export function decodeTextFile(bytes: ArrayBuffer): string {
  const view = new Uint8Array(bytes);
  if (view.includes(0)) {
    throw new ComputeError("compute_binary_file");
  }

  try {
    return new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch {
    throw new ComputeError("compute_binary_file");
  }
}
