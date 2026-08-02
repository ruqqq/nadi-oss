import { describe, expect, it } from "vitest";
import {
  ATTACHMENT_ACCEPT,
  canModelReadNatively,
  fileMatchesAccept,
} from "../../../web/src/lib/attachment-accept";

describe("ATTACHMENT_ACCEPT", () => {
  it("includes images, pdf, and text extensions", () => {
    expect(ATTACHMENT_ACCEPT).toContain("image/png");
    expect(ATTACHMENT_ACCEPT).toContain("application/pdf");
    expect(ATTACHMENT_ACCEPT).toContain(".ts");
    expect(ATTACHMENT_ACCEPT).toContain(".md");
  });
});

describe("fileMatchesAccept", () => {
  it("matches by MIME exact and wildcard", () => {
    expect(fileMatchesAccept({ type: "image/png", name: "a.png" }, "image/*")).toBe(true);
    expect(fileMatchesAccept({ type: "application/pdf", name: "a.pdf" }, "application/pdf")).toBe(true);
  });

  it("matches code files by extension when MIME is empty", () => {
    expect(fileMatchesAccept({ type: "", name: "mod.ts" }, ATTACHMENT_ACCEPT)).toBe(true);
    expect(fileMatchesAccept({ type: "", name: "README.md" }, ATTACHMENT_ACCEPT)).toBe(true);
  });

  it("rejects disallowed extensions", () => {
    expect(fileMatchesAccept({ type: "", name: "evil.exe" }, ATTACHMENT_ACCEPT)).toBe(false);
  });

  it("accepts everything when accept is empty", () => {
    expect(fileMatchesAccept({ type: "", name: "x" }, "")).toBe(true);
  });
});

describe("canModelReadNatively", () => {
  it("images need the image modality", () => {
    expect(canModelReadNatively({ type: "image/png", name: "a.png" }, ["text", "image"])).toBe(true);
    expect(canModelReadNatively({ type: "image/png", name: "a.png" }, ["text"])).toBe(false);
  });

  it("pdf needs the file modality", () => {
    expect(canModelReadNatively({ type: "application/pdf", name: "a.pdf" }, ["text", "file"])).toBe(true);
    expect(canModelReadNatively({ type: "application/pdf", name: "a.pdf" }, ["text", "image"])).toBe(false);
  });

  it("text/code files are never natively readable", () => {
    expect(canModelReadNatively({ type: "", name: "mod.ts" }, ["text", "image", "file"])).toBe(false);
  });
});
