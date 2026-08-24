import { useMemo } from "react";
import { cn } from "@/lib/utils";
import { formatReference, parseQuranVerse, toArabicIndic } from "@/lib/quran-verse";

// A verse is a band, not a card. The transcript is already a stack of rounded
// bordered cards (tools, approvals, artifacts) and one more would read as UI
// chrome; a tinted band with no border reads as a page, which is what a mushaf
// is. The one flourish is the ayah medallion — the circular marker that closes
// every āyah in a printed Qur'an — and everything else stays quiet so it lands.

// The medallion closes the verse on its own line rather than sitting inline at
// the end of the text. Inline is where a printed mushaf puts it, but the web
// cannot place it safely there: Arabic final forms paint well outside their
// advance box — the tail of ر in ٱلْقَدْرِ sweeps left and below the baseline —
// and the browser positions the next inline box by advance width alone. Layout
// reports no collision while the ink runs straight through the medallion. No
// margin fixes it, because the overhang is per-letter: ر ى ن ج ح sweep, د ه ا
// do not, so any value tuned on one āyah breaks on the next.
function AyahMedallion({ ayah }: { ayah: number }) {
  return (
    <div
      aria-hidden="true"
      className="mt-4 flex size-7 items-center justify-center self-center rounded-full bg-primary/5 font-arabic text-[0.7rem] text-primary/70 leading-none ring-1 ring-primary/25"
    >
      {toArabicIndic(ayah)}
    </div>
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
      className={cn(
        "my-4 flex flex-col rounded-md bg-quran-bg px-5 py-6 text-foreground sm:px-7",
        className,
      )}
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
        </p>
      )}

      {medallionAyah !== null && arabic !== "" && <AyahMedallion ayah={medallionAyah} />}

      {translation !== "" && (
        <p className={cn("text-pretty text-sm leading-relaxed", arabic !== "" && "mt-5")}>
          {translation}
        </p>
      )}
    </figure>
  );
}
