import { describe, expect, it, vi } from "vitest";
import { FallbackWebFetcher } from "../../../src/web/fallback-fetcher";
import type { WebFetchProvider, WebFetchResponse } from "../../../src/web/types";

function provider(response: WebFetchResponse): WebFetchProvider {
  return { fetch: vi.fn().mockResolvedValue(response) };
}

const base = { url: "https://a.com", finalUrl: "https://a.com", truncated: false } as const;

describe("FallbackWebFetcher", () => {
  it("returns the direct result when content is substantial", async () => {
    const direct = provider({
      ...base,
      contentType: "text/html",
      content: "<p>lots of real text here and more and more</p>".repeat(50),
      via: "direct",
    });
    const browser = provider({
      ...base,
      contentType: "text/markdown",
      content: "browser",
      via: "browser",
    });
    const out = await new FallbackWebFetcher({ direct, browser }).fetch({ url: base.url });
    expect(out.via).toBe("direct");
    expect(browser.fetch).not.toHaveBeenCalled();
  });

  it("escalates to the browser on an empty html body", async () => {
    const direct = provider({ ...base, contentType: "text/html", content: "   ", via: "direct" });
    const browser = provider({
      ...base,
      contentType: "text/markdown",
      content: "rendered",
      via: "browser",
    });
    const out = await new FallbackWebFetcher({ direct, browser }).fetch({ url: base.url });
    expect(out.via).toBe("browser");
  });

  it("escalates to the browser on a JS-shell page", async () => {
    const direct = provider({
      ...base,
      contentType: "text/html",
      content: '<div id="root"></div>',
      via: "direct",
    });
    const browser = provider({
      ...base,
      contentType: "text/markdown",
      content: "rendered",
      via: "browser",
    });
    const out = await new FallbackWebFetcher({ direct, browser }).fetch({ url: base.url });
    expect(out.via).toBe("browser");
  });

  it("does not escalate for non-html content", async () => {
    const direct = provider({
      ...base,
      contentType: "application/json",
      content: "",
      via: "direct",
    });
    const browser = provider({
      ...base,
      contentType: "text/markdown",
      content: "rendered",
      via: "browser",
    });
    const out = await new FallbackWebFetcher({ direct, browser }).fetch({ url: base.url });
    expect(out.via).toBe("direct");
  });

  it("falls back to the direct result when the browser escalation throws", async () => {
    const direct = provider({
      ...base,
      contentType: "text/html",
      content: '<div id="root"></div>',
      via: "direct",
    });
    const browser: WebFetchProvider = {
      fetch: vi.fn().mockRejectedValue(new Error("browser boom")),
    };
    const out = await new FallbackWebFetcher({ direct, browser }).fetch({ url: base.url });
    expect(out.via).toBe("direct");
  });
});
