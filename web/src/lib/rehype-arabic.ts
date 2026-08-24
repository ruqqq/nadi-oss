// Rehype plugins that give Arabic in the transcript the treatment it needs.
//
// Two separate jobs, deliberately:
//
//   `rehypeArabic`   — typography for ANY Arabic the model emits. It cannot be
//                      opted out of by a model that ignores the system prompt.
//   `rehypeQuran`    — turns a ```quran fence into a <quran-verse> element that
//                      the renderer maps to <QuranBlock>.
//
// Hand-rolled tree walks rather than unist-util-visit: the traversal is a
// dozen lines and the transcript's markdown pipeline lives inside streamdown,
// whose unist dependencies are not ours to resolve from web/.
import { isPredominantlyArabic, splitArabicRuns } from "./arabic";
import { ensureArabicFonts } from "./arabic-font";

type HastNode = {
  type: string;
  tagName?: string;
  value?: string;
  properties?: Record<string, unknown>;
  children?: HastNode[];
};

// Blocks that carry running prose, and so can meaningfully flip to RTL.
const BLOCK_TAGS = new Set([
  "p",
  "li",
  "blockquote",
  "td",
  "th",
  "dd",
  "dt",
  "figcaption",
  "h1",
  "h2",
  "h3",
  "h4",
  "h5",
  "h6",
]);

// Monospace is the one place Arabic must be left alone: shaping is already lost
// there, and a code sample is not prose.
const OPAQUE_TAGS = new Set(["code", "pre", "kbd", "samp", "quran-verse"]);

function textContent(node: HastNode): string {
  if (node.type === "text") return node.value ?? "";
  return (node.children ?? []).map(textContent).join("");
}

function addClass(node: HastNode, className: string): void {
  const properties = (node.properties ??= {});
  const existing = properties.className;
  if (Array.isArray(existing)) properties.className = [...existing, className];
  else if (typeof existing === "string") properties.className = `${existing} ${className}`;
  else properties.className = [className];
}

function wrapInlineRuns(parent: HastNode): void {
  const children = parent.children;
  if (!children) return;

  const next: HastNode[] = [];
  let changed = false;
  for (const child of children) {
    if (child.type !== "text") {
      next.push(child);
      continue;
    }
    const runs = splitArabicRuns(child.value ?? "");
    if (!runs.some((run) => run.arabic)) {
      next.push(child);
      continue;
    }
    changed = true;
    void ensureArabicFonts();
    for (const run of runs) {
      if (!run.arabic) {
        next.push({ type: "text", value: run.text });
        continue;
      }
      next.push({
        type: "element",
        tagName: "span",
        // No `dir` here on purpose. Inline direction is the bidi algorithm's
        // job and it already gets it right; forcing dir on an inline span is
        // what *causes* the reordered-punctuation bugs it looks like it fixes.
        properties: { className: ["arabic-inline"], lang: "ar" },
        children: [{ type: "text", value: run.text }],
      });
    }
  }
  if (changed) parent.children = next;
}

function isMarkedInline(node: HastNode): boolean {
  const className = node.properties?.className;
  return Array.isArray(className) && className.includes("arabic-inline");
}

function transformArabic(node: HastNode): void {
  if (node.tagName && OPAQUE_TAGS.has(node.tagName)) return;
  // A span this pass just created holds nothing but Arabic, so descending into
  // it would wrap that text again, and again — the recursion has no other floor.
  if (isMarkedInline(node)) return;

  if (node.tagName && BLOCK_TAGS.has(node.tagName) && isPredominantlyArabic(textContent(node))) {
    void ensureArabicFonts();
    node.properties = { ...node.properties, dir: "rtl", lang: "ar" };
    addClass(node, "arabic-block");
    return;
  }

  wrapInlineRuns(node);
  for (const child of node.children ?? []) transformArabic(child);
}

// `tree: unknown` keeps these assignable to unified's `PluggableList` without
// pulling @types/hast into web/ for a structure we only touch four fields of.
export function rehypeArabic() {
  return (tree: unknown) => {
    transformArabic(tree as HastNode);
  };
}

function isQuranCode(node: HastNode): boolean {
  if (node.tagName !== "code") return false;
  const className = node.properties?.className;
  const names = Array.isArray(className) ? className : String(className ?? "").split(/\s+/);
  return names.includes("language-quran");
}

function transformQuran(node: HastNode): void {
  const children = node.children;
  if (!children) return;

  for (let index = 0; index < children.length; index += 1) {
    const child = children[index];
    if (!child) continue;

    // A fence arrives as <pre><code class="language-quran">. Replace the <pre>
    // outright so no <pre> styling ever lands on the verse.
    const code =
      child.tagName === "pre" && child.children?.length === 1 && isQuranCode(child.children[0]!)
        ? child.children[0]!
        : isQuranCode(child)
          ? child
          : null;

    if (code) {
      void ensureArabicFonts();
      children[index] = {
        type: "element",
        tagName: "quran-verse",
        properties: { source: textContent(code) },
        children: [],
      };
      continue;
    }

    transformQuran(child);
  }
}

export function rehypeQuran() {
  return (tree: unknown) => {
    transformQuran(tree as HastNode);
  };
}
