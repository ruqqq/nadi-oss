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
  maxTouchPoints: number;
}): InstallPlatform {
  if (input.standalone) return "installed";
  const ua = input.userAgent;

  if (/iPad|iPhone|iPod/.test(ua)) {
    // CriOS = Chrome, FxiOS = Firefox, EdgiOS = Edge, OPiOS = Opera. Anything
    // else on iOS is Safari or close enough to share its Share-button flow.
    return /CriOS|FxiOS|EdgiOS|OPiOS/.test(ua) ? "ios-other" : "ios-safari";
  }

  // Firefox and desktop Safari have no install prompt; Chromium forks do.
  const chromium = /Chrome\/|Chromium\/|Edg\//.test(ua) && !/OPR\//.test(ua);
  if (chromium) return /Android/.test(ua) ? "android-chromium" : "desktop-chromium";

  // Stock iPadOS 13+ Safari sends a desktop Mac UA by default (no iPad token).
  // Chromium is excluded above, so this only needs to separate Safari from
  // desktop Firefox (no `Safari/` token) and anything else non-Chromium; a
  // real desktop Mac (any browser) reports 0 touch points, so touch support
  // is what marks this as the touchscreen iPad, not the desktop machine.
  if (/Macintosh/.test(ua) && /Safari\//.test(ua) && input.maxTouchPoints > 0) return "ios-safari";

  return "unsupported";
}

export function detectInstallPlatform(): InstallPlatform {
  if (typeof window === "undefined" || typeof navigator === "undefined") return "unsupported";
  return classifyInstallPlatform({
    userAgent: navigator.userAgent,
    standalone: typeof window.matchMedia === "function" && isStandaloneDisplay(),
    maxTouchPoints: navigator.maxTouchPoints,
  });
}
