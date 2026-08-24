// Arabic faces are loaded the first time Arabic actually appears, not at boot.
//
// The obvious approach — import @fontsource/amiri/arabic-400.css from fonts.ts
// and let `unicode-range` keep the download idle — does not work: fontsource's
// per-subset CSS declares no unicode-range, so an eager import fetches 106KB
// (Amiri) + 46KB (Amiri Quran) for every user whether or not they ever see an
// Arabic character. fonts.ts is explicitly tuned for a light mobile payload, so
// the faces come in behind a dynamic import instead, triggered by the renderer
// the moment it marks its first Arabic run.
//
// Idempotent and safe to call on every render.
let pending: Promise<unknown> | null = null;

export function ensureArabicFonts(): Promise<unknown> {
  if (pending) return pending;
  // No document (tests, any non-browser context) means no stylesheet to add.
  if (typeof document === "undefined") return Promise.resolve();

  pending = Promise.all([
    import("@fontsource/amiri/arabic-400.css"),
    import("@fontsource/amiri-quran/arabic-400.css"),
  ]).catch(() => {
    // A failed font fetch is not worth breaking a message over — the fallback
    // stack in --font-arabic still renders readable Arabic.
    pending = null;
  });
  return pending;
}
