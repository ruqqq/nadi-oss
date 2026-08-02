import { describe, expect, it } from "vitest";
import { isSuperuser } from "../../../src/auth/invite-gate";

describe("isSuperuser", () => {
  it("matches an exact email, case- and whitespace-insensitively", () => {
    expect(isSuperuser("you@example.com", "you@example.com")).toBe(true);
    expect(isSuperuser("  YOU@Example.COM ", "you@example.com")).toBe(true);
    expect(isSuperuser("you@example.com", " you@example.com , other@x.com ")).toBe(true);
    expect(isSuperuser("other@x.com", "you@example.com, other@x.com")).toBe(true);
  });

  it("does not match non-superusers", () => {
    expect(isSuperuser("someone@else.com", "you@example.com")).toBe(false);
  });

  it("does not treat a bare domain as a wildcard (unlike the env allowlist)", () => {
    expect(isSuperuser("anyone@partner.example", "partner.example")).toBe(false);
  });

  it("is closed when unset or empty", () => {
    expect(isSuperuser("you@example.com", undefined)).toBe(false);
    expect(isSuperuser("you@example.com", "")).toBe(false);
    expect(isSuperuser("", "you@example.com")).toBe(false);
  });
});
