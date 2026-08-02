import { htmlToMarkdown } from "./html-to-markdown";
import { htmlToText } from "./html-to-text";
import { assertSafeUrl, UrlGuardError } from "./url-guard";
import {
  WebToolError,
  type WebFetchArgs,
  type WebFetchProvider,
  type WebFetchResponse,
} from "./types";

const DEFAULT_MAX_BYTES = 1_000_000;
const HARD_MAX_BYTES = 1_000_000;
const DEFAULT_TIMEOUT_MS = 30_000;
const HARD_TIMEOUT_MS = 60_000;

const CHROME_UA =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/143.0.0.0 Safari/537.36";

export class DirectWebFetcher implements WebFetchProvider {
  async fetch(args: WebFetchArgs): Promise<WebFetchResponse> {
    let safeUrl: URL;
    try {
      safeUrl = assertSafeUrl(args.url);
    } catch (caught) {
      if (caught instanceof UrlGuardError) {
        throw new WebToolError("invalid_url", caught.message, { reason: caught.reason });
      }
      throw caught;
    }

    const format = args.format ?? "markdown";
    const maxBytes = Math.max(1_000, Math.min(args.maxBytes ?? DEFAULT_MAX_BYTES, HARD_MAX_BYTES));
    const timeoutMs = Math.max(
      1_000,
      Math.min(args.timeoutMs ?? DEFAULT_TIMEOUT_MS, HARD_TIMEOUT_MS),
    );

    const accept = acceptFor(format);
    const baseHeaders = (userAgent: string): Record<string, string> => ({
      "User-Agent": userAgent,
      Accept: accept,
      "Accept-Language": "en-US,en;q=0.9",
    });
    const doFetch = (userAgent: string): Promise<Response> =>
      fetch(safeUrl.toString(), {
        method: "GET",
        headers: baseHeaders(userAgent),
        redirect: "follow",
        signal: AbortSignal.timeout(timeoutMs),
      });

    let response: Response;
    try {
      response = await doFetch(CHROME_UA);
    } catch (caught) {
      const message = caught instanceof Error ? caught.message : String(caught);
      if (message.toLowerCase().includes("timeout") || message.toLowerCase().includes("aborted")) {
        throw new WebToolError("timeout", "request timed out");
      }
      throw new WebToolError("request_failed", message);
    }

    if (response.status === 403 && response.headers.get("cf-mitigated") === "challenge") {
      response = await doFetch("nadi");
    }

    if (!response.ok) {
      throw new WebToolError("http_error", `http ${response.status}`, { status: response.status });
    }

    const declared = response.headers.get("content-length");
    if (declared && Number(declared) > maxBytes) {
      throw new WebToolError("too_large", "content-length exceeds maxBytes", {
        declared: Number(declared),
        maxBytes,
      });
    }

    const contentType = response.headers.get("content-type") ?? "";
    const mime = contentType.split(";")[0]?.trim().toLowerCase() ?? "";
    const buffer = await response.arrayBuffer();

    let truncated = false;
    let view: ArrayBuffer = buffer;
    if (buffer.byteLength > maxBytes) {
      view = buffer.slice(0, maxBytes);
      truncated = true;
    }

    const isHtml = mime === "text/html" || mime === "application/xhtml+xml";
    const isText =
      isHtml ||
      mime.startsWith("text/") ||
      mime === "application/json" ||
      mime === "application/xml";

    if (!isText && !mime.startsWith("image/")) {
      throw new WebToolError("unsupported_media", `unsupported content type: ${mime}`, { mime });
    }
    if (mime.startsWith("image/") && mime !== "image/svg+xml") {
      throw new WebToolError("unsupported_media", "images are not yet supported", { mime });
    }

    const raw = new TextDecoder("utf-8", { fatal: false, ignoreBOM: false }).decode(view);
    const title = isHtml ? extractTitle(raw) : undefined;

    let content: string;
    if (isHtml && format === "markdown") {
      content = htmlToMarkdown(raw);
    } else if (isHtml && format === "text") {
      content = htmlToText(raw);
    } else {
      content = raw;
    }

    return {
      url: args.url,
      finalUrl: response.url || args.url,
      contentType,
      ...(title === undefined ? {} : { title }),
      content,
      truncated,
      via: "direct",
    };
  }
}

function acceptFor(format: "markdown" | "text" | "html"): string {
  switch (format) {
    case "markdown":
      return "text/markdown;q=1.0, text/x-markdown;q=0.9, text/plain;q=0.8, text/html;q=0.7, */*;q=0.1";
    case "text":
      return "text/plain;q=1.0, text/markdown;q=0.9, text/html;q=0.8, */*;q=0.1";
    case "html":
      return "text/html;q=1.0, application/xhtml+xml;q=0.9, text/plain;q=0.8, */*;q=0.1";
  }
}

function extractTitle(html: string): string | undefined {
  const match = /<title[^>]*>([\s\S]*?)<\/title>/i.exec(html);
  return match?.[1]?.trim() || undefined;
}
