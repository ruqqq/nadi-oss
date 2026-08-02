export interface EmailOtpCopy {
  subject: string;
  text: string;
}

export function buildEmailOtpCopy(input: { otp: string }): EmailOtpCopy {
  return {
    subject: "Your Nadi sign-in code",
    text: `Use ${input.otp} to sign in to Nadi. This code expires soon. If you did not request it, you can ignore this email.`,
  };
}
