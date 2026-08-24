import { describe, expect, it } from "vitest";
import { formatReference, parseQuranVerse, toArabicIndic } from "./quran-verse";
import { SURAH_COUNT, surahByNumber } from "./surahs";

const AYAH = "ٱللَّهُ لَآ إِلَٰهَ إِلَّا هُوَ ٱلْحَىُّ ٱلْقَيُّومُ";

describe("parseQuranVerse", () => {
  it("splits reference, Arabic and translation", () => {
    const verse = parseQuranVerse(`2:255\n${AYAH}\n\nAllah — there is no deity except Him.`);
    expect(verse.reference).toEqual({ surah: 2, ayah: 255 });
    expect(verse.arabic).toBe(AYAH);
    expect(verse.translation).toBe("Allah — there is no deity except Him.");
  });

  it("reads a range", () => {
    expect(parseQuranVerse(`2:255-257\n${AYAH}`).reference).toEqual({
      surah: 2,
      ayah: 255,
      endAyah: 257,
    });
  });

  it("keeps multi-line Arabic together", () => {
    const verse = parseQuranVerse(`112:1\nقُلْ هُوَ\nٱللَّهُ أَحَدٌ\n\nSay: He is God, One.`);
    expect(verse.arabic).toBe("قُلْ هُوَ\nٱللَّهُ أَحَدٌ");
    expect(verse.translation).toBe("Say: He is God, One.");
  });

  it("keeps a multi-paragraph translation", () => {
    const verse = parseQuranVerse(`2:255\n${AYAH}\n\nFirst line.\n\nSecond line.`);
    expect(verse.translation).toBe("First line.\n\nSecond line.");
  });

  it("treats an unparseable first line as Arabic rather than dropping it", () => {
    const verse = parseQuranVerse(`Ayat al-Kursi\n${AYAH}`);
    expect(verse.reference).toBeNull();
    expect(verse.arabic).toBe(`Ayat al-Kursi\n${AYAH}`);
  });

  it("rejects a surah number outside 1–114", () => {
    expect(parseQuranVerse("115:1\ntext").reference).toBeNull();
  });

  it("omits endAyah entirely when the range is degenerate", () => {
    const reference = parseQuranVerse("2:255-255\ntext").reference;
    expect(reference).toEqual({ surah: 2, ayah: 255 });
    expect(reference && "endAyah" in reference).toBe(false);
  });

  it("handles a fence that is still streaming in", () => {
    // Reference line complete, nothing after it yet: header renders, body waits.
    const referenceOnly = parseQuranVerse("2:255\n");
    expect(referenceOnly.reference).toEqual({ surah: 2, ayah: 255 });
    expect(referenceOnly.arabic).toBe("");
    expect(referenceOnly.translation).toBe("");

    // Arabic arriving, translation not yet.
    expect(parseQuranVerse(`2:255\n${AYAH}`).translation).toBe("");

    const empty = parseQuranVerse("");
    expect(empty.reference).toBeNull();
    expect(empty.arabic).toBe("");
  });
});

describe("toArabicIndic", () => {
  it("converts Latin digits", () => {
    expect(toArabicIndic(255)).toBe("٢٥٥");
    expect(toArabicIndic(1)).toBe("١");
  });
});

describe("formatReference", () => {
  it("formats a single ayah and a range", () => {
    expect(formatReference({ surah: 2, ayah: 255 })).toBe("2:255");
    expect(formatReference({ surah: 2, ayah: 255, endAyah: 257 })).toBe("2:255–257");
  });
});

describe("surahByNumber", () => {
  it("covers all 114 surahs", () => {
    expect(SURAH_COUNT).toBe(114);
    for (let number = 1; number <= 114; number += 1) {
      const surah = surahByNumber(number);
      expect(surah?.arabic, `surah ${number}`).toBeTruthy();
      expect(surah?.latin, `surah ${number}`).toBeTruthy();
    }
  });

  it("names the familiar ones correctly", () => {
    expect(surahByNumber(1)?.arabic).toBe("الفاتحة");
    expect(surahByNumber(2)?.latin).toBe("Al-Baqarah");
    expect(surahByNumber(114)?.arabic).toBe("الناس");
  });

  it("returns null outside the range", () => {
    expect(surahByNumber(0)).toBeNull();
    expect(surahByNumber(115)).toBeNull();
  });
});
