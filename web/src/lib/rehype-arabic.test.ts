import { describe, expect, it } from "vitest";
import { rehypeArabic, rehypeQuran } from "./rehype-arabic";

type Node = {
  type: string;
  tagName?: string;
  value?: string;
  properties?: Record<string, unknown>;
  children?: Node[];
};

const text = (value: string): Node => ({ type: "text", value });
const element = (tagName: string, children: Node[], properties?: Record<string, unknown>): Node => ({
  type: "element",
  tagName,
  ...(properties ? { properties } : {}),
  children,
});
const root = (children: Node[]): Node => ({ type: "root", children });

const AYAH = "ٱللَّهُ لَآ إِلَٰهَ إِلَّا هُوَ";

function runArabic(tree: Node): Node {
  rehypeArabic()(tree);
  return tree;
}

describe("rehypeArabic", () => {
  it("flips a predominantly Arabic paragraph to RTL", () => {
    const tree = runArabic(root([element("p", [text(AYAH)])]));
    const paragraph = tree.children?.[0];
    expect(paragraph?.properties?.dir).toBe("rtl");
    expect(paragraph?.properties?.lang).toBe("ar");
    expect(paragraph?.properties?.className).toEqual(["arabic-block"]);
  });

  it("leaves an English paragraph untouched", () => {
    const tree = runArabic(root([element("p", [text("Plain English, no Arabic here.")])]));
    const paragraph = tree.children?.[0];
    expect(paragraph?.properties?.dir).toBeUndefined();
    expect(paragraph?.children).toEqual([text("Plain English, no Arabic here.")]);
  });

  it("wraps an inline Arabic phrase without flipping the paragraph", () => {
    const tree = runArabic(
      root([element("p", [text("The phrase الحمد لله means all praise is due to God.")])]),
    );
    const paragraph = tree.children?.[0];
    expect(paragraph?.properties?.dir).toBeUndefined();

    const spans = (paragraph?.children ?? []).filter((child) => child.tagName === "span");
    expect(spans).toHaveLength(1);
    expect(spans[0]?.properties?.className).toEqual(["arabic-inline"]);
    expect(spans[0]?.properties?.lang).toBe("ar");
    // Inline runs must NOT carry dir — the bidi algorithm owns inline order.
    expect(spans[0]?.properties?.dir).toBeUndefined();
    expect(spans[0]?.children?.[0]?.value).toBe("الحمد لله");
  });

  it("preserves an existing className when marking a block", () => {
    const tree = runArabic(root([element("p", [text(AYAH)], { className: ["intro"] })]));
    expect(tree.children?.[0]?.properties?.className).toEqual(["intro", "arabic-block"]);
  });

  it("marks Arabic inside list items and headings", () => {
    const tree = runArabic(
      root([element("ul", [element("li", [text(AYAH)])]), element("h2", [text(AYAH)])]),
    );
    expect(tree.children?.[0]?.children?.[0]?.properties?.dir).toBe("rtl");
    expect(tree.children?.[1]?.properties?.dir).toBe("rtl");
  });

  it("leaves Arabic inside code alone", () => {
    const tree = runArabic(root([element("pre", [element("code", [text(AYAH)])])]));
    const code = tree.children?.[0]?.children?.[0];
    expect(code?.properties).toBeUndefined();
    expect(code?.children).toEqual([text(AYAH)]);
  });
});

describe("rehypeQuran", () => {
  const fence = (body: string, language = "language-quran"): Node =>
    root([element("pre", [element("code", [text(body)], { className: [language] })])]);

  it("replaces a quran fence with a quran-verse element", () => {
    const tree = fence(`2:255\n${AYAH}`);
    rehypeQuran()(tree);
    const node = tree.children?.[0];
    expect(node?.tagName).toBe("quran-verse");
    expect(node?.properties?.source).toBe(`2:255\n${AYAH}`);
  });

  it("leaves other fences alone", () => {
    const tree = fence("const x = 1;", "language-ts");
    rehypeQuran()(tree);
    expect(tree.children?.[0]?.tagName).toBe("pre");
  });

  it("finds a fence nested inside a list item", () => {
    const tree = root([
      element("ul", [
        element("li", [element("pre", [element("code", [text("1:1")], { className: ["language-quran"] })])]),
      ]),
    ]);
    rehypeQuran()(tree);
    expect(tree.children?.[0]?.children?.[0]?.children?.[0]?.tagName).toBe("quran-verse");
  });

  it("leaves the verse for rehypeArabic to skip", () => {
    const tree = fence(`2:255\n${AYAH}`);
    rehypeQuran()(tree);
    rehypeArabic()(tree);
    expect(tree.children?.[0]?.properties?.dir).toBeUndefined();
    expect(tree.children?.[0]?.properties?.source).toBe(`2:255\n${AYAH}`);
  });
});
