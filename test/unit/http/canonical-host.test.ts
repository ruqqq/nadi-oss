import { describe, expect, it } from "vitest";
import { canonicalRedirectUrl } from "../../../src/http/canonical-host";

const CONFIGURED = { CANONICAL_HOST: "app.example.com", LEGACY_HOSTS: "legacy.example.com" };

describe("canonicalRedirectUrl", () => {
  it("redirects a legacy host, preserving path and query", () => {
    expect(
      canonicalRedirectUrl(
        new URL("https://legacy.example.com/threads/t1?tab=activity"),
        CONFIGURED,
      ),
    ).toBe("https://app.example.com/threads/t1?tab=activity");
  });

  it("serves the canonical host normally", () => {
    expect(
      canonicalRedirectUrl(new URL("https://app.example.com/threads/t1"), CONFIGURED),
    ).toBeNull();
  });

  it("ignores a host that is neither canonical nor legacy", () => {
    expect(canonicalRedirectUrl(new URL("https://other.example.com/"), CONFIGURED)).toBeNull();
  });

  it("does not redirect the artifact preview host when it is not listed as legacy", () => {
    expect(
      canonicalRedirectUrl(new URL("https://artifacts.example.com/v/t/art_1/"), CONFIGURED),
    ).toBeNull();
  });

  // The self-hosted default: no custom domain, so nothing to redirect to.
  it("is disabled when the canonical host is unset", () => {
    expect(canonicalRedirectUrl(new URL("https://legacy.example.com/"), {})).toBeNull();
    expect(
      canonicalRedirectUrl(new URL("https://legacy.example.com/"), {
        LEGACY_HOSTS: "legacy.example.com",
      }),
    ).toBeNull();
  });

  it("is disabled when no legacy hosts are listed", () => {
    expect(
      canonicalRedirectUrl(new URL("https://legacy.example.com/"), {
        CANONICAL_HOST: "app.example.com",
      }),
    ).toBeNull();
  });

  it("accepts a comma-separated list, tolerating whitespace and case", () => {
    const env = {
      CANONICAL_HOST: "app.example.com",
      LEGACY_HOSTS: " OLD.example.com , legacy.example.com ",
    };
    expect(canonicalRedirectUrl(new URL("https://old.example.com/x"), env)).toBe(
      "https://app.example.com/x",
    );
  });

  // URL.hostname silently ignores a value carrying a scheme or port, which used
  // to leave the request's own URL in place — a 308 to itself, i.e. an infinite
  // redirect for the whole legacy origin. Both are plausible operator typos.
  it.each([
    "https://app.example.com",
    "app.example.com:443",
    "app.example.com/",
    "//app.example.com",
  ])("refuses to redirect when the canonical host is malformed (%s)", (canonical) => {
    expect(
      canonicalRedirectUrl(new URL("https://legacy.example.com/x"), {
        CANONICAL_HOST: canonical,
        LEGACY_HOSTS: "legacy.example.com",
      }),
    ).toBeNull();
  });

  // A stale port from the legacy origin would otherwise ride along and point at
  // a port the custom domain doesn't serve.
  it("drops a port from the legacy origin", () => {
    expect(canonicalRedirectUrl(new URL("http://legacy.example.com:8787/x"), CONFIGURED)).toBe(
      "https://app.example.com/x",
    );
  });
});
