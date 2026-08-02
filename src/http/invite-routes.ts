import { eq } from "drizzle-orm";
import type { Env } from "../env";
import { validateRequestSession } from "../auth/session";
import { isSuperuser } from "../auth/invite-gate";
import { registryDb } from "../db/client";
import {
  INVITE_LIMIT,
  InviteRepository,
  WaitingListRepository,
  normalizeEmail,
} from "../db/repositories/invites";
import { users, type Invite, type WaitingListEntry } from "../db/schema";

export async function routeInvites(req: Request, env: Env): Promise<Response | null> {
  const url = new URL(req.url);

  // The only unauthenticated pair — the invitee has no account yet.
  if (url.pathname === "/api/invites/claim") {
    if (req.method === "GET") return previewInvite(env, url);
    if (req.method === "POST") return claimInvite(req, env);
    return new Response("Method not allowed", { status: 405 });
  }

  if (url.pathname === "/api/invites") {
    if (req.method === "GET") return listInvites(req, env);
    if (req.method === "POST") return createInvite(req, env);
    return new Response("Method not allowed", { status: 405 });
  }

  const id = url.pathname.match(/^\/api\/invites\/([^/]+)$/)?.[1];
  if (id) {
    if (req.method === "DELETE") return revokeInvite(req, env, id);
    return new Response("Method not allowed", { status: 405 });
  }

  if (url.pathname.startsWith("/api/invites")) {
    return new Response("Not found", { status: 404 });
  }
  return null;
}

function serialize(invite: Invite) {
  return {
    id: invite.id,
    token: invite.token,
    email: invite.email,
    status: invite.status,
    createdAt: invite.createdAt,
    claimedAt: invite.claimedAt,
    acceptedAt: invite.acceptedAt,
  };
}

function serializeWaiting(entry: WaitingListEntry) {
  return {
    email: entry.email,
    attempts: entry.attempts,
    createdAt: entry.createdAt,
    updatedAt: entry.updatedAt,
  };
}

async function listInvites(req: Request, env: Env): Promise<Response> {
  const session = await validateRequestSession(env, req);
  if (!session) return new Response("Unauthorized", { status: 401 });

  const db = registryDb(env);
  const repo = new InviteRepository(db);
  const superuser = isSuperuser(session.user.email, env.SUPERUSER_EMAILS);

  const [invites, used] = await Promise.all([
    repo.listForInviter(session.user.id),
    repo.countAccepted(session.user.id),
  ]);

  return Response.json({
    invites: invites.map(serialize),
    quota: { used, limit: superuser ? null : INVITE_LIMIT },
    isSuperuser: superuser,
    // The waiting list is the superuser's queue to work through; ordinary users
    // never see other people's emails.
    waitingList: superuser
      ? (await new WaitingListRepository(db).list()).map(serializeWaiting)
      : [],
  });
}

async function createInvite(req: Request, env: Env): Promise<Response> {
  const session = await validateRequestSession(env, req);
  if (!session) return new Response("Unauthorized", { status: 401 });

  const body = (await req.json().catch(() => ({}))) as { email?: unknown };
  const db = registryDb(env);
  const repo = new InviteRepository(db);
  const superuser = isSuperuser(session.user.email, env.SUPERUSER_EMAILS);

  if (!superuser) {
    const used = await repo.countAccepted(session.user.id);
    if (used >= INVITE_LIMIT) {
      return new Response(`You've used all ${INVITE_LIMIT} of your invites.`, { status: 403 });
    }
  }

  // Direct email invite (superuser only) — used to clear the waiting list.
  if (typeof body.email === "string" && body.email.trim() !== "") {
    if (!superuser) {
      return new Response("Only an admin can invite a specific email. Share an invite link.", {
        status: 403,
      });
    }
    const email = normalizeEmail(body.email);
    const existing = await repo.findByEmail(email);
    if (existing && existing.status !== "pending") {
      await new WaitingListRepository(db).remove(email);
      return Response.json({ invite: serialize(existing) }, { status: 200 });
    }
    const invite = await repo.createForEmail(session.user.id, email);
    await new WaitingListRepository(db).remove(email);
    return Response.json({ invite: serialize(invite) }, { status: 201 });
  }

  const invite = await repo.createLink(session.user.id, crypto.randomUUID());
  return Response.json({ invite: serialize(invite) }, { status: 201 });
}

async function revokeInvite(req: Request, env: Env, id: string): Promise<Response> {
  const session = await validateRequestSession(env, req);
  if (!session) return new Response("Unauthorized", { status: 401 });

  const repo = new InviteRepository(registryDb(env));
  const invite = await repo.findById(id);
  if (!invite || invite.inviterUserId !== session.user.id) {
    return new Response("Invite not found", { status: 404 });
  }
  if (invite.status === "accepted") {
    return new Response("That person has already joined — their invite can't be revoked.", {
      status: 409,
    });
  }
  await repo.revoke(id, session.user.id);
  return new Response(null, { status: 204 });
}

async function previewInvite(env: Env, url: URL): Promise<Response> {
  const token = url.searchParams.get("token") ?? "";
  if (token === "") return Response.json({ valid: false });

  const db = registryDb(env);
  const invite = await new InviteRepository(db).findByToken(token);
  if (!invite || invite.status !== "pending") return Response.json({ valid: false });

  const inviter = await db
    .select({ email: users.email })
    .from(users)
    .where(eq(users.id, invite.inviterUserId))
    .get();
  return Response.json({ valid: true, inviterEmail: inviter?.email ?? null });
}

async function claimInvite(req: Request, env: Env): Promise<Response> {
  const body = (await req.json().catch(() => ({}))) as { token?: unknown; email?: unknown };
  const token = typeof body.token === "string" ? body.token : "";
  const rawEmail = typeof body.email === "string" ? body.email : "";
  if (token === "" || rawEmail.trim() === "") {
    return new Response("An invite token and email are required.", { status: 400 });
  }
  const email = normalizeEmail(rawEmail);

  const db = registryDb(env);
  const repo = new InviteRepository(db);
  const invite = await repo.findByToken(token);
  if (!invite) {
    return new Response("That invite link isn't valid.", { status: 404 });
  }
  // Re-opening your own link is fine; someone else's claimed link is not.
  if (invite.status !== "pending") {
    if (invite.email === email) return new Response(null, { status: 204 });
    return new Response("That invite link has already been used.", { status: 409 });
  }

  await repo.claim(invite.id, email);
  await new WaitingListRepository(db).remove(email);
  return new Response(null, { status: 204 });
}
