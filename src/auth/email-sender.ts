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

export async function sendOtpEmail(input: {
  env: {
    EMAIL?: SendEmail;
    AUTH_EMAIL_FROM?: string;
    EMAIL_DELIVERY_DISABLED?: string;
  };
  to: string;
  subject: string;
  text: string;
  sender?: EmailSender;
}): Promise<void> {
  if (input.env.EMAIL_DELIVERY_DISABLED === "true") {
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
