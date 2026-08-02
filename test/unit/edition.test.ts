import { describe, expect, it } from "vitest";
import { editionCapabilities, resolveEdition } from "../../src/edition";

describe("resolveEdition", () => {
  it("falls to self-hosted when NADI_EDITION is unset", () => {
    expect(resolveEdition({})).toBe("self-hosted");
    expect(resolveEdition({ NADI_EDITION: undefined })).toBe("self-hosted");
  });

  it("reads cloud case- and whitespace-insensitively", () => {
    expect(resolveEdition({ NADI_EDITION: "cloud" })).toBe("cloud");
    expect(resolveEdition({ NADI_EDITION: "Cloud" })).toBe("cloud");
    expect(resolveEdition({ NADI_EDITION: "  CLOUD  " })).toBe("cloud");
  });

  it("treats an unrecognized or empty value as self-hosted, not cloud", () => {
    // The fall must stay toward showing operator config: a typo'd var must never
    // silently hide deployment settings from the self-hoster who has to fix it.
    for (const value of ["", "   ", "saas", "hosted", "1", "true", "self-hosted"]) {
      expect(resolveEdition({ NADI_EDITION: value })).toBe("self-hosted");
    }
  });
});

describe("editionCapabilities", () => {
  it("grants operatorManagedCompute only on cloud", () => {
    expect(editionCapabilities({ NADI_EDITION: "cloud" })).toEqual({
      operatorManagedCompute: true,
    });
    expect(editionCapabilities({})).toEqual({ operatorManagedCompute: false });
  });
});
