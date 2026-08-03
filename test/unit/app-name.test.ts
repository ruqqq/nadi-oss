import { describe, expect, it } from "vitest";
import { DEFAULT_APP_NAME, resolveAppName } from "../../src/app-name";

describe("resolveAppName", () => {
  it("returns APP_NAME when set", () => {
    expect(resolveAppName({ APP_NAME: "Acme" })).toBe("Acme");
  });

  it("trims whitespace", () => {
    expect(resolveAppName({ APP_NAME: "  Acme  " })).toBe("Acme");
  });

  it("falls back to Nadi when unset or blank", () => {
    expect(resolveAppName({})).toBe(DEFAULT_APP_NAME);
    expect(resolveAppName({ APP_NAME: undefined })).toBe(DEFAULT_APP_NAME);
    expect(resolveAppName({ APP_NAME: "" })).toBe(DEFAULT_APP_NAME);
    expect(resolveAppName({ APP_NAME: "   " })).toBe(DEFAULT_APP_NAME);
  });
});
