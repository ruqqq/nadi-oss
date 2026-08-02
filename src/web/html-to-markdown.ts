import TurndownService from "turndown";
import { htmlToText } from "./html-to-text";

// Nadi's tsconfig uses the "WebWorker" lib (matching the Workers runtime),
// which does not declare `document`. This module-local ambient declaration
// lets us runtime-detect a DOM without pulling in the global "DOM" lib
// (which would conflict with WebWorker across the rest of the codebase).
declare const document: unknown;

export function htmlToMarkdown(html: string): string {
  if (typeof document === "undefined") {
    return htmlToText(html);
  }

  const turndown = new TurndownService({
    headingStyle: "atx",
    hr: "---",
    bulletListMarker: "-",
    codeBlockStyle: "fenced",
    emDelimiter: "*",
  });
  turndown.remove(["script", "style", "meta", "link"]);
  return turndown.turndown(html).replace(/^(-|\*|\d+\.) {2,}/gm, "$1 ");
}
