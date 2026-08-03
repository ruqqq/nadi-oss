import { useCallback, useEffect, useState } from "react";
import { Button } from "../ui/button";
import { Card } from "../ui/card";
import { Check, DeviceMobile } from "../../icons";
import { detectInstallPlatform, type InstallPlatform } from "../../lib/install-platform";
import {
  consumeInstallPrompt,
  getInstallPrompt,
  subscribeInstallPrompt,
  wasInstalledThisSession,
} from "../../lib/install-prompt";

/** One path per platform. Showing every browser's steps at once is exactly what
 *  makes these screens unreadable. */
const IOS_SAFARI_STEPS = [
  "Tap the Share button in the bottom bar.",
  "Scroll down and choose Add to Home Screen.",
  "Tap Add.",
];
const IOS_OTHER_STEPS = [
  "Tap the ⋯ menu in the top right.",
  "Choose Add to Home Screen.",
  "Tap Add.",
];
const CHROMIUM_MENU_STEPS = [
  "Open your browser's menu.",
  "Choose Install Nadi (or Add to Home screen).",
  "Confirm.",
];

export function InstallStep({ onDone }: { onDone: () => void }) {
  const [platform] = useState<InstallPlatform>(detectInstallPlatform);
  const [installed, setInstalled] = useState(wasInstalledThisSession);
  const [prompt, setPrompt] = useState(getInstallPrompt);

  // The event can arrive after this screen mounts, so subscribe rather than
  // reading once — otherwise the button would stay hidden on a slow Chromium.
  useEffect(
    () =>
      subscribeInstallPrompt(() => {
        setPrompt(getInstallPrompt());
        setInstalled(wasInstalledThisSession());
      }),
    [],
  );

  const install = useCallback(() => {
    const event = getInstallPrompt();
    if (!event) return;
    void event.prompt().finally(consumeInstallPrompt);
  }, []);

  const chromium = platform === "android-chromium" || platform === "desktop-chromium";

  return (
    <Card className="mt-4 gap-4 p-4">
      <div className="space-y-1">
        <h2 className="font-display font-semibold text-lg">Install Nadi</h2>
        <p className="text-muted-foreground text-sm">
          Nadi works best installed — it opens like an app, works offline, and can send you
          notifications.
        </p>
      </div>

      {installed ? (
        <p className="flex items-center gap-2 text-approve text-sm">
          <Check aria-hidden />
          Installed. Open Nadi from your home screen next time.
        </p>
      ) : chromium && prompt ? (
        <Button type="button" onClick={install} className="w-full">
          <DeviceMobile aria-hidden />
          Install Nadi
        </Button>
      ) : platform === "unsupported" ? (
        <p className="text-muted-foreground text-sm">
          This browser can’t install web apps. Open Nadi in Chrome, Edge, or Safari on your phone to
          add it to your home screen.
        </p>
      ) : (
        // No stashed prompt event (unsupported, or it fired before capture) —
        // give instructions rather than leaving a dead button on the screen.
        <ol className="list-decimal space-y-1.5 pl-5 text-sm">
          {(platform === "ios-safari"
            ? IOS_SAFARI_STEPS
            : platform === "ios-other"
              ? IOS_OTHER_STEPS
              : CHROMIUM_MENU_STEPS
          ).map((line) => (
            <li key={line}>{line}</li>
          ))}
        </ol>
      )}

      {/* Completion is only observable where `appinstalled` fires — i.e. a
          Chromium we still hold a prompt event for. iOS never fires it, so a
          user who has just added Nadi to their home screen would otherwise find
          the wizard's last control is a ghost button telling them they are
          skipping the thing they just did. Everywhere we cannot detect it, the
          step gets a real primary action that finishes without claiming an
          install happened. */}
      <div className="flex justify-end gap-2">
        {installed || !(chromium && prompt) ? (
          <Button type="button" onClick={onDone}>
            Done
          </Button>
        ) : (
          <Button type="button" variant="ghost" onClick={onDone}>
            Skip for now
          </Button>
        )}
      </div>
    </Card>
  );
}
