import { describe, expect, it } from "vitest";
import { formatReference, parseQuranVerse, toArabicIndic } from "./quran-verse";

const AYAH = "ٱللَّهُ لَآ إِلَٰهَ إِلَّا هُوَ ٱلْحَىُّ ٱلْقَيُّومُ";

describe("parseQuranVerse", () => {
  it("splits reference, Arabic and translation", () => {
    const verse = parseQuranVerse(`2:255\n${AYAH}\n\nAllah — there is no deity except Him.`);
    expect(verse.reference).toEqual({ surah: 2, ayah: 255 });
    expect(verse.arabic).toBe(AYAH);
    expect(verse.translation).toBe("Allah — there is no deity except Him.");
  });

  it("reads an optional surah label after the numbers", () => {
    const verse = parseQuranVerse(`2:255 Al-Baqarah\n${AYAH}`);
    expect(verse.reference).toEqual({ surah: 2, ayah: 255, label: "Al-Baqarah" });
    expect(verse.arabic).toBe(AYAH);
  });

  it("reads a label on a range", () => {
    expect(parseQuranVerse(`2:255-257 Al-Baqarah\n${AYAH}`).reference).toEqual({
      surah: 2,
      ayah: 255,
      endAyah: 257,
      label: "Al-Baqarah",
    });
  });

  it("takes an Arabic label as readily as a Latin one", () => {
    expect(parseQuranVerse("112:1 الإخلاص\ntext").reference?.label).toBe("الإخلاص");
  });

  it("omits label entirely when there is none", () => {
    const reference = parseQuranVerse(`2:255\n${AYAH}`).reference;
    expect(reference && "label" in reference).toBe(false);
  });

  it("treats a long trailing sentence as text, not a label", () => {
    // Otherwise a line that merely starts with digits gets eaten by the header.
    const verse = parseQuranVerse(
      "2:255 is the verse people call Ayat al-Kursi, the greatest verse\ntext",
    );
    expect(verse.reference).toBeNull();
    expect(verse.arabic).toContain("Ayat al-Kursi");
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
