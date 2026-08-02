import { Parser } from "htmlparser2";

const SKIP_TAGS = new Set(["script", "style", "noscript", "iframe", "object", "embed"]);

export function htmlToText(html: string): string {
  let output = "";
  let skipDepth = 0;
  let inVoidSkip = false;

  const parser = new Parser({
    onopentag(name) {
      inVoidSkip = false;
      if (skipDepth > 0 || SKIP_TAGS.has(name)) {
        skipDepth++;
      }
    },
    ontext(text) {
      if (skipDepth === 0 && !inVoidSkip) {
        output += text;
      }
    },
    onclosetag(_name, isImplied) {
      if (isImplied && skipDepth > 0) {
        skipDepth--;
        inVoidSkip = true;
      } else if (!isImplied && skipDepth > 0) {
        skipDepth--;
      }
    },
  });

  parser.write(html);
  parser.end();
  return output.trim();
}
