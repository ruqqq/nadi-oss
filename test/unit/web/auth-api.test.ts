import { describe, expect, it, vi } from "vitest";
import {
  getSession,
  requestEmailOtp,
  signInWithEmailOtp,
  SignInNotAllowedError,
} from "../../../web/src/auth-api";

describe("auth api helpers", () => {
  it("treats missing session user as unauthenticated", async () => {
    const fetch = vi.fn(async () => Response.json(null));

    await expect(getSession(fetch)).resolves.toEqual({ authenticated: false });

    expect(fetch).toHaveBeenCalledWith("/api/auth/get-session", {
      credentials: "include",
    });
  });

  it("includes the user id when authenticated", async () => {
    const fetchImpl = (async () =>
      new Response(JSON.stringify({ user: { id: "user-123", email: "a@b.c" } }), {
        status: 200,
        headers: { "content-type": "application/json" },
      })) as unknown as typeof fetch;
    const session = await getSession(fetchImpl);
    expect(session).toEqual({ authenticated: true, user: { id: "user-123", email: "a@b.c" } });
  });

  it("requests sign-in OTPs with the Better Auth endpoint", async () => {
    const fetch = vi.fn(async () => Response.json({ success: true }));

    await requestEmailOtp("user@example.com", fetch);

    expect(fetch).toHaveBeenCalledWith("/api/auth/email-otp/send-verification-otp", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ email: "user@example.com", type: "sign-in" }),
    });
  });

  // Both of these arrive as a 403 with no OTP sent, and only this flag tells them
  // apart. Lose it and the waiting list gets shown to strangers as a failure.
  it("marks a waiting-list 403 as the outcome it is", async () => {
    const fetch = vi.fn(async () =>
      Response.json(
        { message: "Nadi is invite-only. We've added you to the waiting list.", waitlisted: true },
        { status: 403 },
      ),
    );

    await expect(requestEmailOtp("stranger@example.com", fetch)).rejects.toMatchObject({
      waitlisted: true,
      message: "Nadi is invite-only. We've added you to the waiting list.",
    });
  });

  it("leaves a genuine refusal unflagged", async () => {
    const fetch = vi.fn(async () =>
      Response.json(
        { message: "That invite link can't be used.", waitlisted: false },
        { status: 403 },
      ),
    );

    const err = await requestEmailOtp("guest@example.com", fetch).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(SignInNotAllowedError);
    expect((err as SignInNotAllowedError).waitlisted).toBe(false);
  });

  it("signs in with email OTP and includes credentials for the session cookie", async () => {
    const fetch = vi.fn(async () =>
      Response.json({ token: "token", user: { email: "user@example.com" } }),
    );

    await signInWithEmailOtp({ email: "user@example.com", otp: "123456" }, fetch);

    expect(fetch).toHaveBeenCalledWith("/api/auth/sign-in/email-otp", {
      method: "POST",
      credentials: "include",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ email: "user@example.com", otp: "123456" }),
    });
  });
});
