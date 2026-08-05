import { posix } from "node:path";

/** Normalize a relative path inside an artifact R2 prefix; reject traversal and escapes. */
export function normalizeArtifactRelPath(raw: string): string | null {
  if (typeof raw !== "string" || raw.length === 0) return null;
  if (raw.includes("\\")) return null;
  if (posix.isAbsolute(raw)) return null;

  const normalized = posix.normalize(raw);
  if (normalized === "." || normalized === "..") return null;
  if (normalized.startsWith("../") || normalized.includes("/../")) return null;
  if (posix.isAbsolute(normalized)) return null;

  const trimmed = normalized.length > 1 ? normalized.replace(/\/+$/, "") : normalized;
  if (trimmed === "" || trimmed === ".") return null;

  return trimmed;
}
