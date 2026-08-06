import { afterEach, describe, expect, it, vi } from "vitest";
import {
  CloudflareEmailSender,
  resolveEmailSender,
  ResendEmailSender,
  sendOtpEmail,
} from "../../../src/auth/email-sender";

function captureLogs() {
  const spy = vi.spyOn(console, "log");
  return {
    entries: () =>
      spy.mock.calls.map((call) => JSON.parse(String(call[0]))) as Array<
        Record<string, unknown> & { event: string; level: string }
      >,
  };
}

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe("sendOtpEmail", () => {
  it("sends nothing and logs a warning naming the missing config when no provider is configured", async () => {
    const logs = captureLogs();

    await expect(
      sendOtpEmail({
        env: {},
        to: "user@example.com",
        subject: "Your Nadi sign-in code",
        text: "Use 123456 to sign in to Nadi.",
      }),
    ).resolves.toBe(false);

    const warning = logs
      .entries()
      .find((entry) => entry.event === "auth.email.no_sender_configured");
    expect(warning).toBeDefined();
    expect(warning?.level).toBe("warn");
    // The warning names exactly what is missing so an operator sees why no
    // code is delivered — a silent swallow would be indistinguishable from a
    // broken deployment.
    expect(warning?.missing).toEqual(["EMAIL binding", "RESEND_API_KEY", "AUTH_EMAIL_FROM"]);
    expect(warning?.to).toBe("user@example.com");
  });

  it("names the still-missing piece when only the Resend key is configured", async () => {
    const logs = captureLogs();

    await expect(
      sendOtpEmail({
        env: { RESEND_API_KEY: "re_123" },
        to: "user@example.com",
        subject: "Your Nadi sign-in code",
        text: "Use 123456 to sign in to Nadi.",
      }),
    ).resolves.toBe(false);

    const warning = logs
      .entries()
      .find((entry) => entry.event === "auth.email.no_sender_configured");
    expect(warning?.missing).toEqual(["EMAIL binding", "AUTH_EMAIL_FROM"]);
  });

  it("prefers the Cloudflare Email binding over Resend when both are configured", async () => {
    const send = vi.fn(async () => ({ messageId: "email_123" }));

    await sendOtpEmail({
      env: {
        EMAIL: { send },
        AUTH_EMAIL_FROM: "signin@nadiai.app",
        RESEND_API_KEY: "re_123",
      },
      to: "user@example.com",
      subject: "Your Nadi sign-in code",
      text: "Use 123456 to sign in to Nadi.",
    });

    expect(send).toHaveBeenCalledTimes(1);
  });

  it("resolves false and skips the send when email delivery is disabled", async () => {
    const send = vi.fn(async () => ({ messageId: "email_123" }));

    await expect(
      sendOtpEmail({
        env: {
          EMAIL: { send },
          AUTH_EMAIL_FROM: "signin@nadiai.app",
          EMAIL_DELIVERY_DISABLED: "true",
        },
        to: "user@example.com",
        subject: "Your Nadi sign-in code",
        text: "Use 123456 to sign in to Nadi.",
      }),
    ).resolves.toBe(false);
    expect(send).not.toHaveBeenCalled();
  });

  it("resolves true once a sender has run, so callers only claim delivery then", async () => {
    const send = vi.fn(async () => ({ messageId: "email_123" }));

    await expect(
      sendOtpEmail({
        env: { EMAIL: { send }, AUTH_EMAIL_FROM: "signin@nadiai.app" },
        to: "user@example.com",
        subject: "Your Nadi sign-in code",
        text: "Use 123456 to sign in to Nadi.",
      }),
    ).resolves.toBe(true);
  });

  it("uses the Resend sender when the EMAIL binding is absent", async () => {
    const logs = captureLogs();
    const fetchMock = vi.fn(
      async () => new Response(JSON.stringify({ id: "email_123" }), { status: 200 }),
    );
    vi.stubGlobal("fetch", fetchMock);

    await expect(
      sendOtpEmail({
        env: { RESEND_API_KEY: "re_123", AUTH_EMAIL_FROM: "signin@nadiai.app" },
        to: "user@example.com",
        subject: "Your Nadi sign-in code",
        text: "Use 123456 to sign in to Nadi.",
      }),
    ).resolves.toBe(true);

    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(logs.entries()).toHaveLength(0);
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

  it("logs the code instead of sending when the local fallback is on", async () => {
    const send = vi.fn(async () => ({ messageId: "email_123" }));

    // The fallback counts as delivery (the code reached the log), so callers
    // may claim "sent".
    await expect(
      sendOtpEmail({
        env: {
          AUTH_OTP_LOG_FALLBACK: "true",
          EMAIL: { send },
          AUTH_EMAIL_FROM: "signin@nadiai.app",
        },
        to: "user@example.com",
        subject: "Your Nadi sign-in code",
        text: "Use 123456 to sign in to Nadi.",
      }),
    ).resolves.toBe(true);

    // The fallback short-circuits before any sender runs.
    expect(send).not.toHaveBeenCalled();
  });

  it("refuses the log fallback on the cloud edition even when the var is set", async () => {
    const send = vi.fn(async () => ({ messageId: "email_123" }));

    await sendOtpEmail({
      env: {
        AUTH_OTP_LOG_FALLBACK: "true",
        NADI_EDITION: "cloud",
        EMAIL: { send },
        AUTH_EMAIL_FROM: "signin@nadiai.app",
      },
      to: "user@example.com",
      subject: "Your Nadi sign-in code",
      text: "Use 123456 to sign in to Nadi.",
    });

    // Cloud must still deliver by email — never leak a credential to the log.
    expect(send).toHaveBeenCalledTimes(1);
  });

  it("does not log the code when the fallback is unset", async () => {
    const send = vi.fn(async () => ({ messageId: "email_123" }));

    await sendOtpEmail({
      env: { EMAIL: { send }, AUTH_EMAIL_FROM: "signin@nadiai.app" },
      to: "user@example.com",
      subject: "Your Nadi sign-in code",
      text: "Use 123456 to sign in to Nadi.",
    });

    expect(send).toHaveBeenCalledTimes(1);
  });
});

describe("resolveEmailSender", () => {
  it("returns null when neither provider is configured", () => {
    expect(resolveEmailSender({})).toBeNull();
    expect(resolveEmailSender({ AUTH_EMAIL_FROM: "signin@nadiai.app" })).toBeNull();
  });

  it("returns a Cloudflare sender when the EMAIL binding and from are configured", () => {
    const sender = resolveEmailSender({
      EMAIL: { send: vi.fn() },
      AUTH_EMAIL_FROM: "signin@nadiai.app",
      RESEND_API_KEY: "re_123",
    });
    expect(sender).toBeInstanceOf(CloudflareEmailSender);
  });

  it("returns a Resend sender when only the Resend key and from are configured", () => {
    const sender = resolveEmailSender({
      RESEND_API_KEY: "re_123",
      AUTH_EMAIL_FROM: "signin@nadiai.app",
    });
    expect(sender).toBeInstanceOf(ResendEmailSender);
  });
});

describe("ResendEmailSender", () => {
  it("posts the OTP email to the Resend API with the right body and auth header", async () => {
    const fetchMock = vi.fn(
      async () => new Response(JSON.stringify({ id: "email_123" }), { status: 200 }),
    );
    vi.stubGlobal("fetch", fetchMock);

    await new ResendEmailSender("re_123", "signin@nadiai.app").send({
      to: "user@example.com",
      subject: "Your Nadi sign-in code",
      text: "Use 123456 to sign in to Nadi.",
    });

    expect(fetchMock).toHaveBeenCalledWith("https://api.resend.com/emails", {
      method: "POST",
      headers: {
        Authorization: "Bearer re_123",
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        from: "signin@nadiai.app",
        to: ["user@example.com"],
        subject: "Your Nadi sign-in code",
        text: "Use 123456 to sign in to Nadi.",
      }),
    });
  });

  it("surfaces a non-2xx response as a failure, not a silent success", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(
        async () => new Response(JSON.stringify({ message: "invalid api key" }), { status: 401 }),
      ),
    );

    await expect(
      new ResendEmailSender("re_bad", "signin@nadiai.app").send({
        to: "user@example.com",
        subject: "Your Nadi sign-in code",
        text: "Use 123456 to sign in to Nadi.",
      }),
    ).rejects.toThrow("email_send_failed");
  });

  it("surfaces a transport failure as a failure, not a silent success", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => {
        throw new Error("network down");
      }),
    );

    await expect(
      new ResendEmailSender("re_123", "signin@nadiai.app").send({
        to: "user@example.com",
        subject: "Your Nadi sign-in code",
        text: "Use 123456 to sign in to Nadi.",
      }),
    ).rejects.toThrow("email_send_failed");
  });
});
