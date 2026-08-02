import { betterAuth } from "better-auth";
import { APIError, createAuthMiddleware } from "better-auth/api";
import { emailOTP } from "better-auth/plugins";
import { drizzleAdapter } from "better-auth/adapters/drizzle";
import type { Env } from "../env";
import { buildEmailOtpCopy } from "./email-copy";
import { canSignIn } from "./invite-gate";
import { sendOtpEmail } from "./email-sender";
import { registryDb } from "../db/client";
import { InviteRepository, WaitingListRepository } from "../db/repositories/invites";
import { WorkspaceRepository } from "../db/repositories/workspaces";
import { DEFAULT_SYSTEM_PROMPT } from "../agent/model-config";
import { defaultProviderConfig, resolveDefaultSandboxProvider } from "../compute/config";
import { users, sessions, accounts, verifications } from "../db/schema";

export function buildAuth(env: Env) {
  return betterAuth({
    secret: env.BETTER_AUTH_SECRET,
    baseURL: env.APP_BASE_URL,
    database: drizzleAdapter(registryDb(env), {
      provider: "sqlite",
      usePlural: true,
      camelCase: true,
      schema: { users, sessions, accounts, verifications },
    }),
    emailAndPassword: { enabled: false },
    // Stated here rather than inherited: Better Auth's defaults (7 days /
    // 1 day) are invisible in this file, and a 7-day session shipped for
    // months because nobody had chosen it.
    //
    // expiresIn is an inactivity timeout, not a deadline — it only bites
    // someone who ignores Nadi for a month, because `maybeRenewSession`
    // (web/src/lib/session-renewal.ts) rolls it forward from the client.
    // Sign-in is an emailed OTP, so a forced re-auth is expensive enough to
    // be worth avoiding for anyone still using the app.
    session: {
      expiresIn: 60 * 60 * 24 * 30,
      updateAge: 60 * 60 * 24,
    },
    databaseHooks: {
      user: {
        create: {
          // Provision a private workspace, owner membership, and default agent
          // for every new user on first sign-in. Idempotent; without it a fresh
          // user has no workspace and every settings/provider route 404s.
          after: async (user) => {
            const db = registryDb(env);
            const defaultSandboxProvider = resolveDefaultSandboxProvider(env);

            // Consume the inviter's slot: the quota counts accepted invites, and
            // an invite is only "accepted" once the invitee has a real account.
            // No-op for superusers, whitelisted, and pre-existing emails.
            await new InviteRepository(db).markAccepted(user.email, user.id);
            await new WaitingListRepository(db).remove(user.email);

            const repo = new WorkspaceRepository(db);
            await repo.provisionForOwner({
              userId: user.id,
              now: Date.now(),
              defaultAgent: {
                name: "Assistant",
                systemPrompt: DEFAULT_SYSTEM_PROMPT,
                provider: env.DEFAULT_MODEL_PROVIDER,
                model: env.DEFAULT_MODEL,
              },
              // New accounts get compute on by default. In production this is
              // Cloudflare (configured at the deployment level, so it works out
              // of the box); `buildComputeBackend` still fails closed if the
              // deployment lacks the bindings, degrading to "compute
              // unavailable" rather than a broken-but-enabled provider. Local
              // dev sets DEFAULT_SANDBOX_PROVIDER=mock so the in-memory backend
              // stands in with no credentials, containers, or R2.
              defaultSandbox: {
                provider: defaultSandboxProvider,
                enabled: true,
                providerConfigJson: JSON.stringify(defaultProviderConfig(defaultSandboxProvider)),
              },
            });
          },
        },
      },
    },
    hooks: {
      // Reject uninvited emails before any OTP is created or sent. Runs ahead of
      // the send-verification-otp endpoint, so no verification row is written
      // and no email is delivered to a non-allowed address. Uninvited emails are
      // recorded on the waiting list instead.
      before: createAuthMiddleware(async (ctx) => {
        if (ctx.path !== "/email-otp/send-verification-otp") {
          return;
        }
        const email = typeof ctx.body?.email === "string" ? ctx.body.email : "";
        const decision = await canSignIn(env, registryDb(env), email);
        if (!decision.allowed) {
          console.log(
            JSON.stringify({
              ts: new Date().toISOString(),
              level: "warn",
              event: "auth.email-otp.blocked",
              email,
              reason: decision.reason,
              waitlisted: decision.waitlisted,
            }),
          );
          throw new APIError("FORBIDDEN", {
            message:
              decision.reason === "inviter-out-of-invites"
                ? "That invite link can't be used: whoever invited you has no invites left."
                : "Nadi is invite-only. We've added you to the waiting list.",
            // Landing on the waiting list is the outcome we intend for a
            // stranger, not a failure. The status has to be 403 to stop the OTP,
            // so say which kind of block this is and let the client tell the
            // truth about it.
            waitlisted: decision.waitlisted,
          });
        }
      }),
    },
    plugins: [
      emailOTP({
        resendStrategy: "reuse",
        async sendVerificationOTP({ email, otp }: { email: string; otp: string }) {
          const copy = buildEmailOtpCopy({ otp });
          await sendOtpEmail({
            env,
            to: email,
            subject: copy.subject,
            text: copy.text,
          });
          console.log(
            JSON.stringify({
              ts: new Date().toISOString(),
              level: "info",
              event: "auth.email-otp.sent",
              email,
              subject: copy.subject,
              otpLength: otp.length,
            }),
          );
        },
      }),
    ],
  });
}
