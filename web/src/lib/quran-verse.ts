// Parser for the ```quran fence.
//
//   ```quran
//   2:255 Al-Baqarah
//   ٱللَّهُ لَآ إِلَٰهَ إِلَّا هُوَ ٱلْحَىُّ ٱلْقَيُّومُ
//
//   Allah — there is no deity except Him, the Ever-Living...
//   ```
//
// The reference is a line of body text rather than fence metadata (```quran
// 2:255) because mdast→hast keeps the fence *language* and drops the *meta*,
// so metadata would not survive the pipeline the transcript actually runs.
//
// Every field is optional in practice: this parses partial fences too, since
// the block renders while the model is still streaming into it.
export type AyahReference = {
  surah: number;
  ayah: number;
  endAyah?: number;
  /**
   * Optional sūrah name, supplied by whoever wrote the fence. Deliberately not
   * looked up from a table here: a 114-row name list would be one more piece of
   * hand-authored scripture-adjacent data to keep correct, guarding a header
   * label while the verse text beside it — the part that actually matters — is
   * already supplied by the model.
   */
  label?: string;
};

export type QuranVerse = {
  reference: AyahReference | null;
  arabic: string;
  translation: string;
};

const REFERENCE = /^\s*(\d{1,3}):(\d{1,3})(?:\s*[-–]\s*(\d{1,3}))?(?:\s+(\S.*?))?\s*$/;

// A name, not a sentence. Anything longer is a line of text that happens to
// start with digits, and treating it as a label would swallow it.
const MAX_LABEL_LENGTH = 48;

function parseReference(line: string): AyahReference | null {
  const match = REFERENCE.exec(line);
  if (!match) return null;

  const surah = Number(match[1]);
  const ayah = Number(match[2]);
  if (surah < 1 || surah > 114 || ayah < 1) return null;

  const label = match[4];
  if (label !== undefined && label.length > MAX_LABEL_LENGTH) return null;

  // `exactOptionalPropertyTypes` is on: an explicit `endAyah: undefined` is not
  // assignable to `endAyah?: number`, so absent keys have to be truly absent.
  const endAyah = match[3] === undefined ? undefined : Number(match[3]);
  return {
    surah,
    ayah,
    ...(endAyah !== undefined && endAyah > ayah ? { endAyah } : {}),
    ...(label === undefined ? {} : { label }),
  };
}

export function parseQuranVerse(source: string): QuranVerse {
  const lines = source.replace(/\r\n/g, "\n").split("\n");

  // Leading blank lines are noise from the fence itself.
  while (lines.length > 0 && lines[0]?.trim() === "") lines.shift();

  const reference = parseReference(lines[0] ?? "");
  if (reference) {
    lines.shift();
    while (lines.length > 0 && lines[0]?.trim() === "") lines.shift();
  }

  const arabicLines: string[] = [];
  while (lines.length > 0 && lines[0]?.trim() !== "") arabicLines.push(lines.shift()!);

  return {
    reference,
    arabic: arabicLines.join("\n").trim(),
    translation: lines.join("\n").trim(),
  };
}

const ARABIC_INDIC = "٠١٢٣٤٥٦٧٨٩";

/** 255 → ٢٥٥. The medallion is Arabic typography; Latin digits break the spell. */
export function toArabicIndic(value: number): string {
  return String(value).replace(/\d/g, (digit) => ARABIC_INDIC[Number(digit)] ?? digit);
}

/** "2:255" / "2:255–257" — the searchable, copyable form of the reference. */
export function formatReference(reference: AyahReference): string {
  const ayah =
    reference.endAyah === undefined
      ? String(reference.ayah)
      : `${reference.ayah}–${reference.endAyah}`;
  return `${reference.surah}:${ayah}`;
}
