import { useEffect } from "react";

/**
 * Set `document.title` for as long as the caller is mounted, restoring whatever
 * was there before on the way out.
 *
 * Pass `null` to leave the title alone — that is the landing page, which keeps
 * the tagline baked into `index.html` ("Nadi: The agent isn't the model.").
 * Inside the app the title is just the deployment's name, because a tagline is
 * a pitch and a person who is already signed in has bought it; what they want
 * from a browser tab is to find this one among nine others.
 *
 * Restoring on cleanup is what makes app → /about work: the landing page passes
 * null, so without a restore it would inherit the app's title instead of its
 * own.
 */
export function useDocumentTitle(title: string | null): void {
  useEffect(() => {
    if (!title) return;
    const previous = document.title;
    document.title = title;
    return () => {
      document.title = previous;
    };
  }, [title]);
}
