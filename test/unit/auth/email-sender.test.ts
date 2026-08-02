import { describe, expect, it, vi } from "vitest";
import { sendOtpEmail } from "../../../src/auth/email-sender";

describe("sendOtpEmail", () => {
  it("requires Cloudflare Email Service configuration before sending", async () => {
    await expect(
      sendOtpEmail({
        env: {},
        to: "user@example.com",
        subject: "Your Nadi sign-in code",
        text: "Use 123456 to sign in to Nadi.",
      }),
    ).rejects.toThrow("missing_email_config");
  });

  it("sends the OTP email through the Cloudflare Email Service binding", async () => {
    const send = vi.fn(async () => ({ messageId: "email_123" }));

    await sendOtpEmail({
      env: {
        EMAIL: { send },
        AUTH_EMAIL_FROM: "signin@nadiai.app",
      },
      to: "user@example.com",
      subject: "Your Nadi sign-in code",
      text: "Use 123456 to sign in to Nadi.",
    });

    expect(send).toHaveBeenCalledWith({
      from: { name: "Nadi", email: "signin@nadiai.app" },
      to: "user@example.com",
      subject: "Your Nadi sign-in code",
      text: "Use 123456 to sign in to Nadi.",
    });
  });

  it("skips binding delivery when email delivery is disabled", async () => {
    const send = vi.fn(async () => ({ messageId: "email_123" }));

    await sendOtpEmail({
      env: {
        EMAIL: { send },
        AUTH_EMAIL_FROM: "signin@nadiai.app",
        EMAIL_DELIVERY_DISABLED: "true",
      },
      to: "user@example.com",
      subject: "Your Nadi sign-in code",
      text: "Use 123456 to sign in to Nadi.",
    });

    expect(send).not.toHaveBeenCalled();
  });

  it("reports Cloudflare Email Service send failures", async () => {
    const send = vi.fn(async () => {
      throw new Error("binding rejected");
    });

    await expect(
      sendOtpEmail({
        env: {
          EMAIL: { send },
          AUTH_EMAIL_FROM: "signin@nadiai.app",
        },
        to: "user@example.com",
        subject: "Your Nadi sign-in code",
        text: "Use 123456 to sign in to Nadi.",
      }),
    ).rejects.toThrow("email_send_failed");
  });
});
