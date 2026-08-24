import { describe, expect, it } from "vitest";
import { hasArabic, isPredominantlyArabic, splitArabicRuns } from "./arabic";

const AYAH = "ٱللَّهُ لَآ إِلَٰهَ إِلَّا هُوَ";
const HARAKA_ONLY = "َُّ"; // fatha, shadda, damma — Script=Inherited

describe("hasArabic", () => {
  it("finds Arabic letters", () => {
    expect(hasArabic("الحمد لله")).toBe(true);
  });

  it("finds bare harakat, which Script=Arabic alone would miss", () => {
    expect(hasArabic(HARAKA_ONLY)).toBe(true);
  });

  it("finds the end-of-ayah mark, which is Script=Common", () => {
    expect(hasArabic("۝")).toBe(true);
  });

  it("is false for Latin, digits and punctuation", () => {
    expect(hasArabic("Surah 2:255 — Al-Baqarah")).toBe(false);
  });
});

describe("isPredominantlyArabic", () => {
  it("is true for a whole ayah", () => {
    expect(isPredominantlyArabic(AYAH)).toBe(true);
  });

  it("stays true when a reference shares the line", () => {
    expect(isPredominantlyArabic(`${AYAH} 2:255`)).toBe(true);
  });

  it("is false for an English sentence containing one Arabic phrase", () => {
    expect(isPredominantlyArabic("The phrase الحمد لله means all praise is due to God.")).toBe(
      false,
    );
  });

  it("is false when neither script has more letters", () => {
    expect(isPredominantlyArabic("salam سلام")).toBe(false);
  });

  it("is false for text with no Arabic at all", () => {
    expect(isPredominantlyArabic("2:255")).toBe(false);
  });
});

describe("splitArabicRuns", () => {
  it("returns a single non-Arabic run when there is no Arabic", () => {
    expect(splitArabicRuns("hello world")).toEqual([{ text: "hello world", arabic: false }]);
  });

  it("keeps a multi-word Arabic phrase as one run", () => {
    const runs = splitArabicRuns("He said لا إله إلا الله quietly.");
    expect(runs).toEqual([
      { text: "He said ", arabic: false },
      { text: "لا إله إلا الله", arabic: true },
      { text: " quietly.", arabic: false },
    ]);
  });

  it("does not swallow the whitespace around a run", () => {
    const [, run] = splitArabicRuns("a سلام b");
    expect(run?.text).toBe("سلام");
  });

  it("splits two separate Arabic phrases", () => {
    const runs = splitArabicRuns("say سلام then reply وعليكم");
    expect(runs.filter((run) => run.arabic).map((run) => run.text)).toEqual(["سلام", "وعليكم"]);
  });

  it("round-trips the original text", () => {
    const text = "One الحمد لله two سلام three";
    expect(
      splitArabicRuns(text)
        .map((run) => run.text)
        .join(""),
    ).toBe(text);
  });
});
