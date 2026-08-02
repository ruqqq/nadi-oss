import { describe, expect, it } from "vitest";
import { assertSafeUrl, UrlGuardError } from "../../../src/web/url-guard";

describe("assertSafeUrl", () => {
  it("accepts a normal https url", () => {
    expect(assertSafeUrl("https://example.com/page").hostname).toBe("example.com");
  });

  it("rejects a malformed url", () => {
    expect(() => assertSafeUrl("not a url")).toThrow(UrlGuardError);
  });

  it("rejects non-http(s) schemes", () => {
    expect(() => assertSafeUrl("file:///etc/passwd")).toThrow(/scheme/);
  });

  it("rejects localhost and loopback", () => {
    expect(() => assertSafeUrl("http://localhost/x")).toThrow(/local_hostname/);
    expect(() => assertSafeUrl("http://127.0.0.1/x")).toThrow(/loopback/);
  });

  it("rejects private and link-local ranges", () => {
    expect(() => assertSafeUrl("http://10.0.0.5/x")).toThrow(/private/);
    expect(() => assertSafeUrl("http://192.168.1.1/x")).toThrow(/private/);
    expect(() => assertSafeUrl("http://169.254.1.1/x")).toThrow(/link_local/);
  });

  it("rejects 0.0.0.0", () => {
    expect(() => assertSafeUrl("http://0.0.0.0/")).toThrow(/loopback/);
  });

  it("rejects IPv4-mapped IPv6 loopback/private addresses", () => {
    expect(() => assertSafeUrl("http://[::ffff:127.0.0.1]/")).toThrow(/private/);
  });
});
