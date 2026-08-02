import { appFetch } from "./lib/app-fetch";

export type AuthSession =
  | { authenticated: false }
  | {
      authenticated: true;
      user: {
        id: string;
        email?: string;
        name?: string | null;
      };
    };

type FetchLike = typeof fetch;

async function readJson(res: Response): Promise<unknown> {
  if (!res.ok) {
    throw new Error(`auth_request_failed_${res.status}`);
  }
  return res.json();
}

export async function getSession(fetchImpl: FetchLike = appFetch): Promise<AuthSession> {
  const data = await readJson(
    await fetchImpl("/api/auth/get-session", {
      credentials: "include",
    }),
  );
  if (
    data !== null &&
    typeof data === "object" &&
    "user" in data &&
    data.user !== null &&
    typeof data.user === "object"
  ) {
    const user = data.user as { id: string; email?: string; name?: string | null };
    return { authenticated: true, user };
  }
  return { authenticated: false };
}

/**
 * A 403 from the OTP endpoint means the invite gate turned this email away.
 * `message` is the server's explanation (waiting-listed, or the inviter is out
 * of invites) — it is written to be shown to the user as-is.
 */
export class SignInNotAllowedError extends Error {
  /**
   * True when being turned away *is* the outcome: this email is now on the
   * waiting list. It travels as a 403 only because there is no OTP to send, so
   * callers must not present it as a failure.
   */
  readonly waitlisted: boolean;

  constructor(message: string, waitlisted = false) {
    super(message);
    this.waitlisted = waitlisted;
  }
}

export async function requestEmailOtp(email: string, fetchImpl: FetchLike = appFetch): Promise<void> {
  const res = await fetchImpl("/api/auth/email-otp/send-verification-otp", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ email, type: "sign-in" }),
  });
  if (res.status === 403) {
    // Better Auth serializes APIError as { message, code }, plus whatever else
    // the body carried.
    const body = (await res.json().catch(() => null)) as {
      message?: unknown;
      waitlisted?: unknown;
    } | null;
    const message = typeof body?.message === "string" ? body.message.trim() : "";
    throw new SignInNotAllowedError(
      message || "Nadi is invite-only.",
      body?.waitlisted === true,
    );
  }
  await readJson(res);
}

export async function signInWithEmailOtp(
  input: { email: string; otp: string },
  fetchImpl: FetchLike = appFetch,
): Promise<void> {
  await readJson(
    await fetchImpl("/api/auth/sign-in/email-otp", {
      method: "POST",
      credentials: "include",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(input),
    }),
  );
}

export async function signOut(fetchImpl: FetchLike = appFetch): Promise<void> {
  // Better Auth clears the session cookie on the server. Best-effort: even if it
  // fails, the caller drops the client session and returns to the sign-in gate.
  await fetchImpl("/api/auth/sign-out", {
    method: "POST",
    credentials: "include",
  });
}
