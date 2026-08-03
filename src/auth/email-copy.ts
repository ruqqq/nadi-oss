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

export function buildWaitlistAcceptedCopy(input: { signInUrl: string }): EmailOtpCopy {
  return {
    subject: "You're in — sign in to Nadi",
    text: `There's room for you on Nadi. Sign in at ${input.signInUrl} with this email address.`,
  };
}
