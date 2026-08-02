import { describe, expect, it } from "vitest";
import { isEmailAllowed } from "../../../src/auth/email-whitelist";

describe("isEmailAllowed", () => {
  it("allows all emails when the allowlist is unset", () => {
    expect(isEmailAllowed("anyone@example.com", undefined)).toBe(true);
  });

  it("allows all emails when the allowlist is empty or whitespace", () => {
    expect(isEmailAllowed("anyone@example.com", "")).toBe(true);
    expect(isEmailAllowed("anyone@example.com", "   ,  ")).toBe(true);
  });

  it("allows an exact email match", () => {
    expect(isEmailAllowed("you@example.com", "you@example.com")).toBe(true);
  });

  it("rejects an email not in the allowlist", () => {
    expect(isEmailAllowed("stranger@example.com", "you@example.com")).toBe(false);
  });

  it("allows any address at a whitelisted bare domain", () => {
    expect(isEmailAllowed("someone@exe.dev", "exe.dev")).toBe(true);
    expect(isEmailAllowed("other@exe.dev", "exe.dev")).toBe(true);
  });

  it("does not match a domain entry against a different domain", () => {
    expect(isEmailAllowed("someone@notexe.dev", "exe.dev")).toBe(false);
  });

  it("does not treat a domain entry as a subdomain wildcard", () => {
    expect(isEmailAllowed("someone@sub.exe.dev", "exe.dev")).toBe(false);
  });

  it("matches case-insensitively for both exact and domain rules", () => {
    expect(isEmailAllowed("You@Example.Com", "you@example.com")).toBe(true);
    expect(isEmailAllowed("SOMEONE@EXE.DEV", "exe.dev")).toBe(true);
  });

  it("trims whitespace around comma-separated entries", () => {
    expect(isEmailAllowed("someone@exe.dev", "you@example.com,  exe.dev ")).toBe(true);
  });

  it("supports a mixed list of exact emails and domains", () => {
    const rules = "you@example.com, exe.dev, ruqqq.com";
    expect(isEmailAllowed("you@example.com", rules)).toBe(true);
    expect(isEmailAllowed("anyone@exe.dev", rules)).toBe(true);
    expect(isEmailAllowed("anyone@ruqqq.com", rules)).toBe(true);
    expect(isEmailAllowed("nope@elsewhere.com", rules)).toBe(false);
  });

  it("rejects a malformed candidate email with no domain", () => {
    expect(isEmailAllowed("notanemail", "exe.dev")).toBe(false);
  });
});
