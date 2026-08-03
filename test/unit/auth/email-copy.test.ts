import { describe, expect, it } from "vitest";
import { buildEmailOtpCopy, buildWaitlistAcceptedCopy } from "../../../src/auth/email-copy";

describe("buildEmailOtpCopy", () => {
  it("renders concise sign-in copy with the OTP", () => {
    expect(buildEmailOtpCopy({ otp: "123456" })).toEqual({
      subject: "Your Nadi sign-in code",
      text: "Use 123456 to sign in to Nadi. This code expires soon. If you did not request it, you can ignore this email.",
    });
  });
});

describe("buildWaitlistAcceptedCopy", () => {
  it("tells the recipient they can sign in and includes the app URL", () => {
    expect(buildWaitlistAcceptedCopy({ signInUrl: "https://nadi.test" })).toEqual({
      subject: "You're in — sign in to Nadi",
      text: "There's room for you on Nadi. Sign in at https://nadi.test with this email address.",
    });
  });
});
