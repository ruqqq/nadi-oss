import { log } from "../log";
import { resolveEdition } from "../edition";

export interface AuthEmailMessage {
  to: string;
  subject: string;
  text: string;
}

export interface EmailSender {
  send(message: AuthEmailMessage): Promise<void>;
}

export class CloudflareEmailSender implements EmailSender {
  constructor(
    private readonly email: SendEmail,
    private readonly from: string,
  ) {}

  async send(message: AuthEmailMessage): Promise<void> {
    try {
      await this.email.send({
        from: { name: "Nadi", email: this.from },
        to: message.to,
        subject: message.subject,
        text: message.text,
      });
    } catch {
      throw new Error("email_send_failed");
    }
  }
}

/**
 * Resend HTTP sender for platforms without the Cloudflare `EMAIL` binding
 * (celld — SMTP is impossible there because `cloudflare:sockets` is a silent
 * stub, so everything goes over fetch). Only the wire call lives here; which
 * provider gets picked is `resolveEmailSender`'s job.
 */
export class ResendEmailSender implements EmailSender {
  constructor(
    private readonly apiKey: string,
    private readonly from: string,
  ) {}

  async send(message: AuthEmailMessage): Promise<void> {
    let response: Response;
    try {
      response = await fetch("https://api.resend.com/emails", {
        method: "POST",
        headers: {
          Authorization: `Bearer ${this.apiKey}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          from: this.from,
          to: [message.to],
          subject: message.subject,
          text: message.text,
        }),
      });
    } catch {
      throw new Error("email_send_failed");
    }
    if (!response.ok) {
      throw new Error("email_send_failed");
    }
  }
}

/**
 * Pick the OTP sender for a deployment, first match wins:
 * 1. Cloudflare Email binding + AUTH_EMAIL_FROM (unchanged, still first).
 * 2. Resend, when RESEND_API_KEY and the shared from-address are configured.
 * 3. Nothing configured — `null`, and sendOtpEmail no-ops with a warning.
 * A provider is only considered complete when BOTH its key and the from
 * address are present; a half-configured one loses to a complete one.
 */
export function resolveEmailSender(env: {
  EMAIL?: SendEmail;
  AUTH_EMAIL_FROM?: string;
  RESEND_API_KEY?: string;
}): EmailSender | null {
  if (env.EMAIL && env.AUTH_EMAIL_FROM) {
    return new CloudflareEmailSender(env.EMAIL, env.AUTH_EMAIL_FROM);
  }
  if (env.RESEND_API_KEY && env.AUTH_EMAIL_FROM) {
    return new ResendEmailSender(env.RESEND_API_KEY, env.AUTH_EMAIL_FROM);
  }
  return null;
}

/** Which pieces of the sender config are absent, for the no-op warning. */
function missingEmailConfig(env: {
  EMAIL?: SendEmail;
  AUTH_EMAIL_FROM?: string;
  RESEND_API_KEY?: string;
}): string[] {
  const missing: string[] = [];
  if (!env.EMAIL) missing.push("EMAIL binding");
  if (!env.RESEND_API_KEY) missing.push("RESEND_API_KEY");
  if (!env.AUTH_EMAIL_FROM) missing.push("AUTH_EMAIL_FROM");
  return missing;
}

/**
 * Local development fallback: write the sign-in email to the log instead of
 * sending it. A self-hoster with no SMTP (and celld, which has no email binding
 * at all) otherwise cannot complete an OTP sign-in on their own machine.
 *
 * This prints a working credential to the log — anyone who can read the log can
 * sign in as anyone. So it is off unless explicitly switched on, it refuses to
 * engage on the cloud edition no matter what the var says, and it announces
 * itself loudly every time it fires.
 */
function logOtpFallback(
  env: { AUTH_OTP_LOG_FALLBACK?: string; NADI_EDITION?: string },
  message: AuthEmailMessage,
): boolean {
  if (env.AUTH_OTP_LOG_FALLBACK !== "true") return false;
  if (resolveEdition(env) === "cloud") {
    log.error("auth.otp_log_fallback_refused", {
      reason: "AUTH_OTP_LOG_FALLBACK is set on the cloud edition; refusing to log credentials",
      to: message.to,
    });
    return false;
  }
  log.warn("auth.otp_log_fallback", {
    insecure: "sign-in credential written to the log — local development only",
    to: message.to,
    subject: message.subject,
    text: message.text,
  });
  return true;
}

export async function sendOtpEmail(input: {
  env: {
    EMAIL?: SendEmail;
    AUTH_EMAIL_FROM?: string;
    RESEND_API_KEY?: string;
    EMAIL_DELIVERY_DISABLED?: string;
    AUTH_OTP_LOG_FALLBACK?: string;
    NADI_EDITION?: string;
  };
  to: string;
  subject: string;
  text: string;
  sender?: EmailSender;
}): Promise<boolean> {
  if (input.env.EMAIL_DELIVERY_DISABLED === "true") {
    return false;
  }

  const message = { to: input.to, subject: input.subject, text: input.text };
  if (logOtpFallback(input.env, message)) {
    return true;
  }

  const sender = input.sender ?? resolveEmailSender(input.env);

  if (!sender) {
    // Unconfigured mail delivery must be a loud no-op, not a throw: a
    // deployment without Resend (or the EMAIL binding) can otherwise never
    // send sign-in codes, and failing the request would brick sign-in for
    // good. A silent swallow is indistinguishable from a broken deployment,
    // so name exactly what is missing.
    log.warn("auth.email.no_sender_configured", {
      missing: missingEmailConfig(input.env),
      hint: "configure the EMAIL binding + AUTH_EMAIL_FROM (Cloudflare) or RESEND_API_KEY + AUTH_EMAIL_FROM (Resend)",
      to: message.to,
    });
    return false;
  }

  await sender.send({
    to: input.to,
    subject: input.subject,
    text: input.text,
  });
  return true;
}
