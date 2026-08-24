// Arabic-script detection for the transcript.
//
// `\p{Script=Arabic}` is NOT enough: the harakat that make Qur'anic text
// readable (fatha U+064E, shadda U+0651, damma U+064F, ...) are Script=Inherited
// combining marks, so a Script=Arabic test skips exactly the characters this
// whole feature exists to render well. `Script_Extensions` includes marks that
// are used with Arabic, which is what we want.
//
// U+06DD (END OF AYAH) and U+06DE (START OF RUB EL HIZB) are Script=Common
// despite being Qur'anic-only, so they are named explicitly.
const ARABIC_CHAR = /[\p{Script_Extensions=Arabic}۝۞]/u;

const ARABIC_LETTER = /\p{L}/u;

// Characters allowed *inside* an Arabic run without ending it: spaces, marks,
// punctuation, symbols, digits. A run only extends across these when Arabic
// resumes afterwards, so trailing spaces never get pulled into the run.
const RUN_INTERIOR = /[\s\p{M}\p{P}\p{S}\p{N}]/u;

export function hasArabic(text: string): boolean {
  return ARABIC_CHAR.test(text);
}

/**
 * True when Arabic letters outnumber every other script's letters — the test
 * for whether a whole block should flip to RTL. Digits, punctuation and
 * combining marks are ignored: they are script-neutral and would otherwise let
 * a reference like "2:255" outvote a short āyah.
 *
 * Ties lose. A block that is half English keeps LTR flow, where the Unicode
 * bidi algorithm already does the right thing for the Arabic inside it.
 */
export function isPredominantlyArabic(text: string): boolean {
  let arabic = 0;
  let other = 0;
  for (const char of text) {
    if (!ARABIC_LETTER.test(char)) continue;
    if (ARABIC_CHAR.test(char)) arabic += 1;
    else other += 1;
  }
  return arabic > 0 && arabic > other;
}

export type TextRun = { text: string; arabic: boolean };

/**
 * Split text into alternating Arabic and non-Arabic runs, so inline Arabic can
 * be given the Arabic face without disturbing the Latin around it.
 *
 * A run spans from its first Arabic character to its last, absorbing interior
 * spaces and punctuation — "لا إله إلا الله" is one run, not five — but never
 * the whitespace that merely sits next to it.
 */
export function splitArabicRuns(text: string): TextRun[] {
  const runs: TextRun[] = [];
  let plainStart = 0;
  let index = 0;

  while (index < text.length) {
    if (!ARABIC_CHAR.test(text[index] ?? "")) {
      index += 1;
      continue;
    }

    const start = index;
    let end = index;
    let scan = index;
    while (scan < text.length) {
      const char = text[scan] ?? "";
      if (ARABIC_CHAR.test(char)) end = scan;
      else if (!RUN_INTERIOR.test(char)) break;
      scan += 1;
    }

    if (start > plainStart) runs.push({ text: text.slice(plainStart, start), arabic: false });
    runs.push({ text: text.slice(start, end + 1), arabic: true });
    plainStart = end + 1;
    index = end + 1;
  }

  if (plainStart < text.length) runs.push({ text: text.slice(plainStart), arabic: false });
  return runs;
}
