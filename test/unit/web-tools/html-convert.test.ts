import { describe, expect, it } from "vitest";
import { htmlToText } from "../../../src/web/html-to-text";
import { htmlToMarkdown } from "../../../src/web/html-to-markdown";

describe("htmlToText", () => {
  it("extracts text and skips script/style", () => {
    const html =
      "<html><head><style>.x{}</style></head><body><p>Hello</p><script>evil()</script></body></html>";
    const out = htmlToText(html);
    expect(out).toContain("Hello");
    expect(out).not.toContain("evil");
    expect(out).not.toContain(".x");
  });
});

describe("htmlToMarkdown", () => {
  it("degrades to text extraction when no DOM is present", () => {
    // vitest-pool-workers has no `document`, so this exercises the no-DOM guard.
    const out = htmlToMarkdown("<p>Hi <b>there</b></p><script>x()</script>");
    expect(out).toContain("Hi");
    expect(out).toContain("there");
    expect(out).not.toContain("x()");
  });
});
