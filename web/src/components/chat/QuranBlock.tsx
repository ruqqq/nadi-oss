import { useMemo } from "react";
import { cn } from "@/lib/utils";
import { formatReference, parseQuranVerse, toArabicIndic } from "@/lib/quran-verse";

// A verse is a band, not a card. The transcript is already a stack of rounded
// bordered cards (tools, approvals, artifacts) and one more would read as UI
// chrome; a tinted band with no border reads as a page, which is what a mushaf
// is. The one flourish is the ayah medallion — the circular marker that closes
// every āyah in a printed Qur'an — and everything else stays quiet so it lands.

function AyahMedallion({ ayah }: { ayah: number }) {
  return (
    <span
      aria-hidden="true"
      className="mx-1 inline-flex size-7 shrink-0 translate-y-1 items-center justify-center rounded-full bg-primary/5 font-arabic text-[0.7rem] text-primary/70 leading-none ring-1 ring-primary/25"
    >
      {toArabicIndic(ayah)}
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
