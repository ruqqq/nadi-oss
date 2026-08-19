import { describe, expect, it, vi } from "vitest";
import { openMintedUrlInNewTab } from "./open-minted-url";

function fakeTab() {
  return {
    opener: {} as unknown,
    closed: false,
    location: { replace: vi.fn() },
    close: vi.fn(function (this: { closed: boolean }) {
      this.closed = true;
    }),
  };
}

describe("openMintedUrlInNewTab", () => {
  it("claims the tab BEFORE awaiting the mint — the iOS Safari popup rule", async () => {
    const tab = fakeTab();
    const openFn = vi.fn(() => tab);
    let releaseMint!: (url: string) => void;
    const mint = vi.fn(() => new Promise<string>((resolve) => (releaseMint = resolve)));

    const pending = openMintedUrlInNewTab(mint, openFn as never);
    // The gesture is still on the stack here. Safari grants `window.open` only
    // to a call made in this task; anything after the await is blocked, which
    // is exactly the bug this pins.
    expect(openFn).toHaveBeenCalledTimes(1);
    expect(tab.location.replace).not.toHaveBeenCalled();

    releaseMint("https://example.test/view?token=abc");
    await pending;
    expect(tab.location.replace).toHaveBeenCalledWith("https://example.test/view?token=abc");
  });

  it("drops the opener link before navigating the claimed tab", async () => {
    const tab = fakeTab();
    await openMintedUrlInNewTab(async () => "https://example.test/v", (() => tab) as never);
    expect(tab.opener).toBeNull();
  });

  it("reports a refused tab with the url, so the caller can fall back", async () => {
    const result = await openMintedUrlInNewTab(
      async () => "https://example.test/v",
      (() => null) as never,
    );
    expect(result).toEqual({ status: "blocked", url: "https://example.test/v" });
  });

  it("closes the claimed tab and rethrows when minting fails", async () => {
    const tab = fakeTab();
    await expect(
      openMintedUrlInNewTab(async () => {
        throw new Error("This artifact has expired.");
      }, (() => tab) as never),
    ).rejects.toThrow("This artifact has expired.");
    // Otherwise the user is left staring at a blank tab with no explanation —
    // the toast lands in the tab they just left.
    expect(tab.close).toHaveBeenCalled();
  });

  it("reports success once the claimed tab is navigated", async () => {
    const tab = fakeTab();
    const result = await openMintedUrlInNewTab(
      async () => "https://example.test/v",
      (() => tab) as never,
    );
    expect(result).toEqual({ status: "opened" });
  });
});
