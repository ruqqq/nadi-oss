import { useMemo } from "react";
import { cn } from "@/lib/utils";
import { formatReference, parseQuranVerse, toArabicIndic } from "@/lib/quran-verse";

// A verse is a band, not a card. The transcript is already a stack of rounded
// bordered cards (tools, approvals, artifacts) and one more would read as UI
// chrome; a tinted band with no border reads as a page, which is what a mushaf
// is. The one flourish is the ayah medallion — the circular marker that closes
// every āyah in a printed Qur'an — and everything else stays quiet so it lands.

// The medallion sits inline at the end of the verse, where a printed mushaf
// puts it. The gap that keeps it off the last word is measured, not guessed:
// Arabic final forms paint outside their advance box, and the browser places
// the next inline box by advance width alone, so layout reports no collision
// while the ink runs through the marker. Pixel-scanning Amiri Quran across the
// verse-final forms puts the worst overhang at 0.11em (ر in ٱلْقَدْرِ); every
// other final letter's ink stays inside its box.
//
// Every dimension here is em against the VERSE's font size, which is why this
// span sets no font-size of its own and the digit is shrunk on an inner span.
// Two versions of this got the unit wrong: first a flat `mx-1` (4px against a
// 3.1px overhang at the top of the size clamp — touching on a phone, clean on
// the preview fixture), then an `ms-[0.5em]` that silently resolved against the
// medallion's own 0.7rem and stayed 5.6px at every verse size. The overhang
// scales with the type, so the gap has to as well.
function AyahMedallion({ ayah }: { ayah: number }) {
  return (
    <span
      aria-hidden="true"
      className="ms-[0.45em] inline-flex size-[1.15em] shrink-0 items-center justify-center rounded-full bg-primary/5 align-middle font-arabic text-primary/70 leading-none ring-1 ring-primary/25"
    >
      <span className="text-[0.42em]">{toArabicIndic(ayah)}</span>
    </span>
  );
}

export type QuranBlockProps = {
  /** Raw body of the ```quran fence. Arrives incomplete while streaming. */
  source?: string;
  className?: string;
};

export function QuranBlock({ source, className }: QuranBlockProps) {
  const verse = useMemo(() => parseQuranVerse(source ?? ""), [source]);
  const { reference, arabic, translation } = verse;

  if (arabic === "" && translation === "" && reference === null) return null;

  // A range has no single marker to draw, so the medallion sits it out and the
  // header carries the numbers on its own.
  const medallionAyah = reference && reference.endAyah === undefined ? reference.ayah : null;

  return (
    <figure
      className={cn("my-4 rounded-md bg-quran-bg px-5 py-6 text-foreground sm:px-7", className)}
    >
      {reference && (
        <figcaption className="mb-5 text-muted-foreground text-xs">
          {reference.label === undefined
            ? formatReference(reference)
            : `${reference.label} · ${formatReference(reference)}`}
        </figcaption>
      )}

      {arabic !== "" && (
        <p
          className="text-center font-quran text-[clamp(1.35rem,1.05rem+1.3vw,1.8rem)] leading-[2.1]"
          dir="rtl"
          lang="ar"
        >
          {arabic}
          {medallionAyah !== null && <AyahMedallion ayah={medallionAyah} />}
        </p>
      )}

      {translation !== "" && (
        <p className={cn("text-pretty text-sm leading-relaxed", arabic !== "" && "mt-5")}>
          {translation}
        </p>
      )}
    </figure>
  );
}
