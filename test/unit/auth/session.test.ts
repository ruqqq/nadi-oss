import { describe, expect, it } from "vitest";
import { readSessionCookie } from "../../../src/auth/session";

describe("readSessionCookie", () => {
  it("extracts the Better Auth session cookie", () => {
    const req = new Request("https://nadi.test", {
      headers: { cookie: "other=x; better-auth.session_token=abc.def; theme=dark" },
    });

    expect(readSessionCookie(req)).toBe("abc.def");
  });

  it("returns null when no session cookie is present", () => {
    expect(readSessionCookie(new Request("https://nadi.test"))).toBeNull();
  });
});
