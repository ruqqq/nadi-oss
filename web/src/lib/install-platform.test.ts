import { describe, expect, it } from "vitest";
import { classifyInstallPlatform } from "./install-platform";

const IOS_SAFARI =
  "Mozilla/5.0 (iPhone; CPU iPhone OS 17_5 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.5 Mobile/15E148 Safari/604.1";
const IOS_CHROME =
  "Mozilla/5.0 (iPhone; CPU iPhone OS 17_5 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) CriOS/126.0 Mobile/15E148 Safari/604.1";
const ANDROID_CHROME =
  "Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Mobile Safari/537.36";
const DESKTOP_CHROME =
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36";
const DESKTOP_SAFARI =
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.5 Safari/605.1.15";
const DESKTOP_FIREFOX =
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10.15; rv:127.0) Gecko/20100101 Firefox/127.0";

describe("classifyInstallPlatform", () => {
  it("reports installed regardless of browser when standalone", () => {
    expect(classifyInstallPlatform({ userAgent: IOS_SAFARI, standalone: true })).toBe("installed");
    expect(classifyInstallPlatform({ userAgent: ANDROID_CHROME, standalone: true })).toBe(
      "installed",
    );
  });

  it("separates iOS Safari from other iOS browsers", () => {
    // Both can Add to Home Screen, but the menu differs, so the instructions do.
    expect(classifyInstallPlatform({ userAgent: IOS_SAFARI, standalone: false })).toBe("ios-safari");
    expect(classifyInstallPlatform({ userAgent: IOS_CHROME, standalone: false })).toBe("ios-other");
  });

  it("classifies Chromium by form factor", () => {
    expect(classifyInstallPlatform({ userAgent: ANDROID_CHROME, standalone: false })).toBe(
      "android-chromium",
    );
    expect(classifyInstallPlatform({ userAgent: DESKTOP_CHROME, standalone: false })).toBe(
      "desktop-chromium",
    );
  });

  it("reports unsupported where there is nothing to offer", () => {
    expect(classifyInstallPlatform({ userAgent: DESKTOP_SAFARI, standalone: false })).toBe(
      "unsupported",
    );
    expect(classifyInstallPlatform({ userAgent: DESKTOP_FIREFOX, standalone: false })).toBe(
      "unsupported",
    );
  });
});
