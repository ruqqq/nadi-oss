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
    EMAIL_DELIVERY_DISABLED?: string;
    AUTH_OTP_LOG_FALLBACK?: string;
    NADI_EDITION?: string;
  };
  to: string;
  subject: string;
  text: string;
  sender?: EmailSender;
}): Promise<void> {
  if (input.env.EMAIL_DELIVERY_DISABLED === "true") {
    return;
  }

  const message = { to: input.to, subject: input.subject, text: input.text };
  if (logOtpFallback(input.env, message)) {
    return;
  }

  const sender =
    input.sender ??
    (input.env.EMAIL && input.env.AUTH_EMAIL_FROM
      ? new CloudflareEmailSender(input.env.EMAIL, input.env.AUTH_EMAIL_FROM)
      : null);

  if (!sender) {
    throw new Error("missing_email_config");
  }

  await sender.send({
    to: input.to,
    subject: input.subject,
    text: input.text,
  });
}
