import { useCallback, useEffect, useState } from "react";

export type Theme = "light" | "dark" | "system";

const STORAGE_KEY = "nadi-theme";

// Follow the OS until the user says otherwise. A visitor who keeps their machine
// dark should not be handed a light page; an explicit choice in Settings wins.
const DEFAULT_THEME: Theme = "system";

// theme-color values match --background in index.css (light / dark).
const THEME_COLOR = { light: "#f4efe6", dark: "#15120d" } as const;

function prefersDark(): boolean {
  return typeof window !== "undefined" && window.matchMedia("(prefers-color-scheme: dark)").matches;
}

export function getStoredTheme(): Theme {
  try {
    const v = localStorage.getItem(STORAGE_KEY);
    if (v === "light" || v === "dark" || v === "system") return v;
  } catch {
    // ignore
  }
  return DEFAULT_THEME;
}

export function resolveDark(theme: Theme): boolean {
  return theme === "dark" || (theme === "system" && prefersDark());
}

/** Apply a theme to <html> and the theme-color meta. Does not persist. */
export function applyTheme(theme: Theme): void {
  const dark = resolveDark(theme);
  document.documentElement.classList.toggle("dark", dark);
  const meta = document.querySelector('meta[name="theme-color"]');
  if (meta) meta.setAttribute("content", dark ? THEME_COLOR.dark : THEME_COLOR.light);
}

/**
 * React hook owning theme state + persistence. The initial `.dark` class is set
 * by the inline script in index.html (no flash); this keeps it in sync after
 * hydration and on changes from Settings.
 */
export function useTheme() {
  const [theme, setThemeState] = useState<Theme>(getStoredTheme);

  const setTheme = useCallback((next: Theme) => {
    setThemeState(next);
    try {
      localStorage.setItem(STORAGE_KEY, next);
    } catch {
      // ignore
    }
    applyTheme(next);
  }, []);

  // Re-apply, and follow OS changes while in "system" mode.
  useEffect(() => {
    applyTheme(theme);
    if (theme !== "system") return;
    const mq = window.matchMedia("(prefers-color-scheme: dark)");
    const onChange = () => applyTheme("system");
    mq.addEventListener("change", onChange);
    return () => mq.removeEventListener("change", onChange);
  }, [theme]);

  return { theme, setTheme, resolvedDark: resolveDark(theme) };
}
