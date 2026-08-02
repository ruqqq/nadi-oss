import type { BrowserRunBinding } from "../env";
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
const DEFAULT_TIMEOUT_MS = 45_000;
const HARD_TIMEOUT_MS = 90_000;

export class BrowserWebFetcher implements WebFetchProvider {
  constructor(private readonly browser: BrowserRunBinding) {}

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
    const action = format === "markdown" ? "markdown" : "content";

    let response: Response;
    try {
      const options = {
        url: safeUrl.toString(),
        rejectResourceTypes: ["image", "font", "media"] satisfies BrowserRunResourceType[],
        timeout: timeoutMs,
      };
      response =
        action === "markdown"
          ? await this.browser.quickAction("markdown", options)
          : await this.browser.quickAction("content", options);
    } catch (caught) {
      const message = caught instanceof Error ? caught.message : String(caught);
      const lower = message.toLowerCase();
      const aborted =
        (caught instanceof DOMException && caught.name === "AbortError") ||
        lower.includes("timeout") ||
        lower.includes("aborted");
      if (aborted) {
        throw new WebToolError("timeout", "browser render timed out");
      }
      throw new WebToolError("request_failed", message);
    }

    if (response.status >= 500) {
      throw new WebToolError("request_failed", `browser render http ${response.status}`, {
        status: response.status,
      });
    }
    if (!response.ok) {
      throw new WebToolError("http_error", `browser render http ${response.status}`, {
        status: response.status,
      });
    }

    let body: string;
    try {
      body = await response.text();
    } catch (caught) {
      const message = caught instanceof Error ? caught.message : String(caught);
      throw new WebToolError("request_failed", message);
    }

    let truncated = false;
    if (body.length > maxBytes) {
      body = body.slice(0, maxBytes);
      truncated = true;
    }

    const title = action === "content" ? extractTitle(body) : undefined;
    const content = format === "text" ? htmlToText(body) : body;

    return {
      url: args.url,
      finalUrl: args.url,
      contentType: action === "markdown" ? "text/markdown" : "text/html",
      ...(title === undefined ? {} : { title }),
      content,
      truncated,
      via: "browser",
    };
  }
}

function extractTitle(html: string): string | undefined {
  const match = /<title[^>]*>([\s\S]*?)<\/title>/i.exec(html);
  return match?.[1]?.trim() || undefined;
}
