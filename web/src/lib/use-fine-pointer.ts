import { useMediaQuery } from "./use-media-query";

/**
 * True when the primary input can hover and click precisely — mouse, trackpad,
 * stylus on a precision surface. False for touch-primary phones (even in
 * landscape, where width alone would clear the wide layout breakpoint).
 *
 * Thread rows use this separately from `useWideLayout`: a narrow desktop
 * window or PWA is still pointer-driven and needs the ⋮ trigger, not long press.
 */
export const FINE_POINTER_QUERY = "(hover: hover) and (pointer: fine)";

export function useFinePointer(): boolean {
  return useMediaQuery(FINE_POINTER_QUERY);
}
