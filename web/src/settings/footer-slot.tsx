import { createContext, useContext, type ReactNode } from "react";
import { createPortal } from "react-dom";

/**
 * The Settings footer slot: a `shrink-0` region the shell renders *below* the
 * scrolling `<main>`. Tabs portal their primary actions here so a long form's
 * Save/Archive stays visible without a `sticky` bar fighting the scroll
 * container's reserved safe-area (which, in an installed PWA, otherwise floats
 * the bar above the home indicator).
 *
 * The context value is the slot's DOM node, or null before it mounts.
 */
export const SettingsFooterContext = createContext<HTMLElement | null>(null);

/**
 * Renders its children into the Settings footer slot. A no-op until the slot
 * mounts. Children stay in the React tree where this is used — so they keep
 * their state, handlers, and context intact; only their DOM position moves —
 * which is what keeps this immune to the stale-closure traps of passing a
 * pre-rendered node up through context.
 */
export function SettingsFooterPortal({ children }: { children: ReactNode }) {
  const el = useContext(SettingsFooterContext);
  return el ? createPortal(children, el) : null;
}
