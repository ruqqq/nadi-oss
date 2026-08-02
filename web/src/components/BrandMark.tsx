/**
 * Nadi brandmark — the app icon, shown in topbar chrome in place of the "nadi"
 * wordmark. Sources the same SVG that generates the PWA / installed-app icons
 * (web/public/nadi-logo.svg, served at /nadi-logo.svg).
 */
export function BrandMark({ className }: { className?: string }) {
  return (
    <img
      src="/nadi-logo.svg"
      alt="Nadi"
      width={28}
      height={28}
      draggable={false}
      className={className ?? "size-7 shrink-0 rounded-[6px]"}
    />
  );
}
