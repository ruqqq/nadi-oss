import type { FeedbackDiagnostics } from "../feedback-api";

interface FeedbackBrowserGlobal {
  document: { documentElement: { classList: { contains(className: string): boolean } } };
  navigator: { onLine: boolean; userAgent: string };
  window: {
    innerHeight: number;
    innerWidth: number;
    location: { pathname: string };
  };
}

export function collectFeedbackDiagnostics(): FeedbackDiagnostics {
  const browser = globalThis as unknown as FeedbackBrowserGlobal;
  const env = (import.meta as unknown as { env?: { VITE_APP_BUILD?: string } }).env;
  return {
    schemaVersion: 1,
    route: browser.window.location.pathname.slice(0, 500),
    build: String(env?.VITE_APP_BUILD ?? "unknown").slice(0, 200),
    browser: browserFamily(browser.navigator.userAgent).slice(0, 200),
    os: osFamily(browser.navigator.userAgent).slice(0, 200),
    viewport: { width: browser.window.innerWidth, height: browser.window.innerHeight },
    theme: browser.document.documentElement.classList.contains("dark") ? "dark" : "light",
    online: browser.navigator.onLine,
  };
}

function browserFamily(userAgent: string): string {
  if (/firefox|fxios/i.test(userAgent)) return "Firefox";
  if (/edg\//i.test(userAgent)) return "Edge";
  if (/chrome|chromium|crios/i.test(userAgent)) return "Chromium";
  if (/safari/i.test(userAgent)) return "Safari";
  return "Unknown";
}

function osFamily(userAgent: string): string {
  if (/iphone|ipad|ipod/i.test(userAgent)) return "iOS";
  if (/android/i.test(userAgent)) return "Android";
  if (/mac os x|macintosh/i.test(userAgent)) return "macOS";
  if (/windows/i.test(userAgent)) return "Windows";
  if (/linux/i.test(userAgent)) return "Linux";
  return "Unknown";
}
