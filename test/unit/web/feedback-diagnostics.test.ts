/// <reference lib="dom" />
// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import { collectFeedbackDiagnostics } from "../../../web/src/lib/feedback-diagnostics";

function setUserAgent(userAgent: string) {
  vi.stubGlobal("navigator", {
    ...navigator,
    userAgent,
    onLine: true,
  });
}

afterEach(() => {
  vi.unstubAllGlobals();
  document.documentElement.className = "";
  window.history.replaceState(null, "", "/");
});

describe("collectFeedbackDiagnostics", () => {
  it("returns a bounded snapshot without raw browser or page-private data", () => {
    setUserAgent(
      "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 Safari/605.1.15",
    );
    window.history.replaceState(null, "", "/threads/t1?secret=value");
    document.documentElement.classList.add("dark");

    const diagnostics = collectFeedbackDiagnostics();

    expect(diagnostics).toMatchObject({
      schemaVersion: 1,
      route: "/threads/t1",
      browser: "Safari",
      os: "macOS",
      theme: "dark",
      online: true,
    });
    expect(diagnostics.viewport.width).toBe(window.innerWidth);
    expect(diagnostics.viewport.height).toBe(window.innerHeight);
    expect(JSON.stringify(diagnostics)).not.toContain("Mozilla");
    expect(JSON.stringify(diagnostics)).not.toContain("secret=value");
    expect(JSON.stringify(diagnostics)).not.toContain("referrer");
    expect(JSON.stringify(diagnostics)).not.toContain("localStorage");
    expect(JSON.stringify(diagnostics)).not.toContain("sessionStorage");
    expect(JSON.stringify(diagnostics)).not.toContain("console");
    expect(JSON.stringify(diagnostics)).not.toContain("network");
  });

  it.each([
    [
      "Mozilla/5.0 AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36",
      "Chromium",
      "Unknown",
    ],
    [
      "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Firefox/128.0",
      "Firefox",
      "Linux",
    ],
    [
      "Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 Version/18.0 Mobile/15E148 Safari/604.1",
      "Safari",
      "iOS",
    ],
  ])("reduces user agents to %s", (userAgent, browser, os) => {
    setUserAgent(userAgent);
    const diagnostics = collectFeedbackDiagnostics();
    expect(diagnostics.browser).toBe(browser);
    expect(diagnostics.os).toBe(os);
  });
});
