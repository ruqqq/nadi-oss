import { describe, expect, it } from "vitest";
import { BINARY_DOCUMENT_MIME_BY_EXT, TEXT_MIME_BY_EXT } from "../../src/http/attachment-routes";
import { BINARY_DOCUMENT_EXTENSIONS, TEXT_EXTENSIONS } from "../../web/src/lib/attachment-accept";

// Guards against the front/back allowlist drifting: the composer picker's
// accepted text/code + binary-document extensions must exactly match the
// extensions the upload endpoint knows how to canonicalise. A one-sided edit
// fails here.
describe("attachment allowlist sync", () => {
  it("frontend TEXT_EXTENSIONS matches backend TEXT_MIME_BY_EXT keys", () => {
    expect([...TEXT_EXTENSIONS].sort()).toEqual(Object.keys(TEXT_MIME_BY_EXT).sort());
  });

  it("frontend BINARY_DOCUMENT_EXTENSIONS matches backend BINARY_DOCUMENT_MIME_BY_EXT keys", () => {
    expect([...BINARY_DOCUMENT_EXTENSIONS].sort()).toEqual(
      Object.keys(BINARY_DOCUMENT_MIME_BY_EXT).sort(),
    );
  });

  it("binary document extensions do not overlap the text allowlist", () => {
    const overlap = BINARY_DOCUMENT_EXTENSIONS.filter((ext) => ext in TEXT_MIME_BY_EXT);
    expect(overlap).toEqual([]);
  });

  it("includes epub and the other known document formats", () => {
    for (const ext of [
      "epub",
      "odt",
      "ods",
      "xls",
      "xlsm",
      "xlsb",
      "numbers",
      "docx",
      "xlsx",
      "pptx",
    ]) {
      expect(BINARY_DOCUMENT_EXTENSIONS).toContain(ext);
      expect(BINARY_DOCUMENT_MIME_BY_EXT[ext]).toEqual(expect.any(String));
    }
  });
});
