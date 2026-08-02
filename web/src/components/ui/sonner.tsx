"use client";

import {
  CircleCheckIcon,
  InfoIcon,
  Loader2Icon,
  OctagonXIcon,
  TriangleAlertIcon,
} from "@/components/icons/lucide-shim";
import { Toaster as Sonner, type ToasterProps } from "sonner";
import { useTheme } from "@/lib/theme";

const Toaster = ({ ...props }: ToasterProps) => {
  const { theme } = useTheme();

  return (
    <Sonner
      theme={theme}
      className="toaster group"
      icons={{
        success: <CircleCheckIcon className="size-4" />,
        info: <InfoIcon className="size-4" />,
        warning: <TriangleAlertIcon className="size-4" />,
        error: <OctagonXIcon className="size-4" />,
        loading: <Loader2Icon className="size-4 animate-spin" />,
      }}
      style={
        {
          "--normal-bg": "var(--popover)",
          "--normal-text": "var(--popover-foreground)",
          "--normal-border": "var(--border)",
          "--border-radius": "var(--radius)",
        } as React.CSSProperties
      }
      {...props}
    />
  );
};

/**
 * The app's toaster, hosting two docks that mean different things.
 *
 * BOTTOM (the default) is for consequences of something you just did — "Copied",
 * "Saved", "Updated to the latest version". It sits right above the composer,
 * where your attention already is: the composer publishes its clearance
 * (viewport bottom → its top) as --composer-clearance (see Composer.tsx), and
 * sonner passes string offsets straight into CSS, so screens without a composer
 * fall back to plain bottom-center.
 *
 * TOP is for news from elsewhere — a thread you are not looking at finished,
 * failed, or is waiting on you (lib/thread-activity-toast.tsx opts in per toast
 * with `position: "top-center"`). Nothing there needs acting on this second, so
 * it stays out of the way of what you are actually doing, and lands roughly
 * where the OS would have drawn its own banner. The top inset clears the notch:
 * installed on a phone, this dock is under the status bar.
 */
const TOASTER_OFFSET = {
  bottom: "calc(var(--composer-clearance, 8px) + 8px)",
  top: "calc(env(safe-area-inset-top, 0px) + 12px)",
};

const AppToaster = () => (
  <Toaster position="bottom-center" offset={TOASTER_OFFSET} mobileOffset={TOASTER_OFFSET} />
);

export { Toaster, AppToaster };
