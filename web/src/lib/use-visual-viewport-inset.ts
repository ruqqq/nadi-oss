import { useEffect, useState } from "react";

export type VisualViewportInset = {
  /** On-screen keyboard height in px (0 when no keyboard is shown). */
  keyboard: number;
  /** Height of the visible viewport above the keyboard, in px. */
  height: number;
};

/**
 * Track the on-screen keyboard via the VisualViewport API so a bottom-anchored
 * surface can lift above it. Only listens while `enabled` (e.g. a sheet is open)
 * to avoid standing listeners on an always-mounted component. Returns null when
 * disabled or when VisualViewport is unavailable (desktop / older browsers).
 */
export function useVisualViewportInset(enabled: boolean): VisualViewportInset | null {
  const [inset, setInset] = useState<VisualViewportInset | null>(null);

  useEffect(() => {
    if (!enabled || typeof window === "undefined") {
      setInset(null);
      return;
    }
    const vv = window.visualViewport;
    if (!vv) {
      setInset(null);
      return;
    }
    const update = () => {
      const keyboard = Math.max(0, window.innerHeight - vv.height - vv.offsetTop);
      setInset({ keyboard, height: vv.height });
    };
    update();
    vv.addEventListener("resize", update);
    vv.addEventListener("scroll", update);
    return () => {
      vv.removeEventListener("resize", update);
      vv.removeEventListener("scroll", update);
    };
  }, [enabled]);

  return inset;
}
