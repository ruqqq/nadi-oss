import { describe, expect, it } from "vitest";
import { isFeedbackAdmin } from "../../../src/feedback/admin-auth";

describe("isFeedbackAdmin", () => {
  it("matches only exact comma-separated emails case-insensitively", () => {
    const env = {
      FEEDBACK_ADMIN_EMAILS: " Admin@Example.com, example.org, second@example.com ",
    };

    expect(isFeedbackAdmin(env, "admin@example.com")).toBe(true);
    expect(isFeedbackAdmin(env, " second@example.com ")).toBe(true);
    expect(isFeedbackAdmin(env, "person@example.org")).toBe(false);
    expect(isFeedbackAdmin(env, "not-admin@example.com")).toBe(false);
  });

  it("rejects missing and malformed admin input", () => {
    expect(isFeedbackAdmin({ FEEDBACK_ADMIN_EMAILS: "admin@example.com" }, null)).toBe(false);
    expect(isFeedbackAdmin({ FEEDBACK_ADMIN_EMAILS: "admin@example.com" }, undefined)).toBe(false);
    expect(isFeedbackAdmin({ FEEDBACK_ADMIN_EMAILS: "" }, "admin@example.com")).toBe(false);
    expect(isFeedbackAdmin({ FEEDBACK_ADMIN_EMAILS: "example.com" }, "admin@example.com")).toBe(
      false,
    );
  });
});
