import type { WebFetchArgs, WebFetchProvider, WebFetchResponse } from "./types";

const JS_SHELL_TEXT_THRESHOLD = 500;
const JS_SHELL_MARKERS = [/<div\s+id=["']root["']/i, /<div\s+id=["']__next["']/i, /<app-root\b/i];

export class FallbackWebFetcher implements WebFetchProvider {
  constructor(
    private readonly providers: {
      direct: WebFetchProvider;
      browser: WebFetchProvider;
    },
  ) {}

  async fetch(args: WebFetchArgs): Promise<WebFetchResponse> {
    const result = await this.providers.direct.fetch(args);
    const trigger = shouldFallback(result);
    if (!trigger) {
      return result;
    }
    try {
      return await this.providers.browser.fetch(args);
    } catch {
      // Escalation failed, but the direct fetch produced a usable (if thin)
      // result — return that rather than discarding it.
      return result;
    }
  }
}

type FallbackReason = "empty_content" | "js_shell";

function shouldFallback(result: WebFetchResponse): FallbackReason | null {
  if (!isHtmlContentType(result.contentType)) {
    return null;
  }
  if (result.content.trim().length === 0) {
    return "empty_content";
  }
  if (
    looksLikeJsShell(result.content) &&
    stripMarkup(result.content).length < JS_SHELL_TEXT_THRESHOLD
  ) {
    return "js_shell";
  }
  return null;
}

function isHtmlContentType(contentType: string): boolean {
  const mime = contentType.split(";")[0]?.trim().toLowerCase() ?? "";
  return mime === "text/html" || mime === "application/xhtml+xml";
}

function looksLikeJsShell(html: string): boolean {
  return JS_SHELL_MARKERS.some((pattern) => pattern.test(html));
}

function stripMarkup(html: string): string {
  return html
    .replace(/<script[\s\S]*?<\/script>/gi, "")
    .replace(/<style[\s\S]*?<\/style>/gi, "")
    .replace(/<[^>]+>/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}
