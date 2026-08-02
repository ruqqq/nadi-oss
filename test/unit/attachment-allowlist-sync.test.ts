import { describe, expect, it } from "vitest";
import { OFFICE_MIME_BY_EXT, TEXT_MIME_BY_EXT } from "../../src/http/attachment-routes";
import { OFFICE_EXTENSIONS, TEXT_EXTENSIONS } from "../../web/src/lib/attachment-accept";

// Guards against the front/back allowlist drifting: the composer picker's
// accepted text/code extensions must exactly match the extensions the upload
// endpoint knows how to canonicalise. A one-sided edit fails here.
describe("attachment allowlist sync", () => {
  it("frontend TEXT_EXTENSIONS matches backend TEXT_MIME_BY_EXT keys", () => {
    expect([...TEXT_EXTENSIONS].sort()).toEqual(Object.keys(TEXT_MIME_BY_EXT).sort());
  });

  it("frontend OFFICE_EXTENSIONS matches backend OFFICE_MIME_BY_EXT keys", () => {
    expect([...OFFICE_EXTENSIONS].sort()).toEqual(Object.keys(OFFICE_MIME_BY_EXT).sort());
  });

  it("office extensions do not overlap the text allowlist", () => {
    const overlap = OFFICE_EXTENSIONS.filter((ext) => ext in TEXT_MIME_BY_EXT);
    expect(overlap).toEqual([]);
  });
});
