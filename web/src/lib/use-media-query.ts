import { useEffect, useState } from "react";

/**
 * Subscribe to a CSS media query. SPA-only (no SSR), so we can read
 * matchMedia synchronously on mount. Used to pick the inspector surface:
 * a bottom Sheet on narrow viewports, a centered Dialog otherwise.
 */
export function useMediaQuery(query: string): boolean {
  const [matches, setMatches] = useState(() =>
    typeof window === "undefined" ? false : window.matchMedia(query).matches,
  );

  useEffect(() => {
    const mql = window.matchMedia(query);
    const onChange = () => setMatches(mql.matches);
    onChange();
    mql.addEventListener("change", onChange);
    return () => mql.removeEventListener("change", onChange);
  }, [query]);

  return matches;
}
