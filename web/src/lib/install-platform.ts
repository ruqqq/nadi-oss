import { isStandaloneDisplay } from "./browser-notifications";

export type InstallPlatform =
  | "installed"
  | "ios-safari"
  | "ios-other"
  | "android-chromium"
  | "desktop-chromium"
  | "unsupported";

/**
 * Pure so it is genuinely testable — a classifier that read `window` directly
 * could only ever be exercised against the one browser the test runs in.
 *
 * iOS is split because there is no install API there at all, only instructions,
 * and the instructions differ: Safari's Add to Home Screen lives behind the
 * Share button, Chrome's and Firefox's behind their own menus. Every iOS
 * browser is WebKit, so the platform check is the UA family, not the engine.
 */
export function classifyInstallPlatform(input: {
  userAgent: string;
  standalone: boolean;
}): InstallPlatform {
  if (input.standalone) return "installed";
  const ua = input.userAgent;

  if (/iPad|iPhone|iPod/.test(ua)) {
    // CriOS = Chrome, FxiOS = Firefox, EdgiOS = Edge. Anything else on iOS is
    // Safari or close enough to share its Share-button flow.
    return /CriOS|FxiOS|EdgiOS|OPT\//.test(ua) ? "ios-other" : "ios-safari";
  }

  // Firefox and desktop Safari have no install prompt; Chromium forks do.
  const chromium = /Chrome\/|Chromium\/|Edg\//.test(ua) && !/OPR\//.test(ua);
  if (!chromium) return "unsupported";
  return /Android/.test(ua) ? "android-chromium" : "desktop-chromium";
}

export function detectInstallPlatform(): InstallPlatform {
  if (typeof window === "undefined" || typeof navigator === "undefined") return "unsupported";
  return classifyInstallPlatform({
    userAgent: navigator.userAgent,
    standalone: typeof window.matchMedia === "function" && isStandaloneDisplay(),
  });
}
