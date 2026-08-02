import { describe, expect, it } from "vitest";
import { buildEmailOtpCopy } from "../../../src/auth/email-copy";

describe("buildEmailOtpCopy", () => {
  it("renders concise sign-in copy with the OTP", () => {
    expect(buildEmailOtpCopy({ otp: "123456" })).toEqual({
      subject: "Your Nadi sign-in code",
      text: "Use 123456 to sign in to Nadi. This code expires soon. If you did not request it, you can ignore this email.",
    });
  });
});
