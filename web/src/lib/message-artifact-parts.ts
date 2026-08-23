import type { UIMessage } from "ai";
import { errorFromResponse } from "@/lib/http-error";

type Part = UIMessage["parts"][number];

export type MessageArtifactPart = {
  artifactId: string;
  title: string;
  expiresAt: number;
  url: string;
};

type PublishToolOutput = {
  artifactId?: unknown;
  title?: unknown;
  expiresAt?: unknown;
  url?: unknown;
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function artifactUrlFromId(id: string): string {
  return `/api/artifacts/${id}`;
}

/**
 * Build artifact chips to render under assistant messages: successful
 * `exec_publish_artifact` tool results. Dedupes by artifact id.
 */
export function collectMessageArtifactParts(parts: readonly Part[]): MessageArtifactPart[] {
  const byId = new Map<string, MessageArtifactPart>();

  for (const part of parts) {
    if (part.type !== "tool-exec_publish_artifact") continue;
    if (!("state" in part) || part.state !== "output-available") continue;
    if (!("output" in part) || !isRecord(part.output)) continue;
    const output = part.output as PublishToolOutput;
    if ("ok" in output && output.ok === false) continue;

    const artifactId =
      typeof output.artifactId === "string" && output.artifactId.length > 0
        ? output.artifactId
        : null;
    if (!artifactId || byId.has(artifactId)) continue;

    const expiresAt = typeof output.expiresAt === "number" ? output.expiresAt : null;
    if (expiresAt === null || !Number.isFinite(expiresAt)) continue;

    const url =
      typeof output.url === "string" && output.url.length > 0
        ? output.url
        : artifactUrlFromId(artifactId);
    const title =
      typeof output.title === "string" && output.title.length > 0 ? output.title : artifactId;

    byId.set(artifactId, { artifactId, title, expiresAt, url });
  }

  return Array.from(byId.values());
}

/** Short label for the artifact chip's expiry row. */
export function formatArtifactExpiryHint(expiresAt: number, nowMs: number): string {
  if (nowMs >= expiresAt) return "Expired";
  const msLeft = expiresAt - nowMs;
  const hours = Math.floor(msLeft / (60 * 60 * 1000));
  if (hours >= 24) {
    const days = Math.floor(hours / 24);
    return `${days}d left`;
  }
  if (hours >= 1) return `${hours}h left`;
  const mins = Math.max(1, Math.floor(msLeft / (60 * 1000)));
  return `${mins}m left`;
}

/** Mint a short-lived view URL for an artifact preview iframe or new tab. */
export async function mintArtifactViewUrl(
  artifactUrl: string,
  fetchFn: typeof fetch = fetch,
): Promise<string> {
  const res = await fetchFn(`${artifactUrl}/view`, {
    method: "POST",
    credentials: "include",
  });
  if (!res.ok) {
    throw await errorFromResponse(res, "open this preview");
  }
  const json = (await res.json()) as { viewUrl?: unknown };
  if (typeof json.viewUrl !== "string" || json.viewUrl.length === 0) {
    throw new Error("Preview link was missing from the server response.");
  }
  return json.viewUrl;
}

/** Extend an expired artifact's TTL when its files are still stored. */
export async function republishArtifact(
  artifactUrl: string,
  fetchFn: typeof fetch = fetch,
): Promise<{ expiresAt: number }> {
  const res = await fetchFn(`${artifactUrl}/republish`, {
    method: "POST",
    credentials: "include",
  });
  if (!res.ok) {
    throw await errorFromResponse(res, "republish this artifact");
  }
  const json = (await res.json()) as { expiresAt?: unknown };
  if (typeof json.expiresAt !== "number" || !Number.isFinite(json.expiresAt)) {
    throw new Error("Republish response was missing a new expiry.");
  }
  return { expiresAt: json.expiresAt };
}
