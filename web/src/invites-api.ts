import { appFetch } from "./lib/app-fetch";
import { errorFromResponse } from "./lib/http-error";

export type InviteStatus = "pending" | "claimed" | "accepted";

export interface Invite {
  id: string;
  token: string | null;
  email: string | null;
  status: InviteStatus;
  createdAt: number;
  claimedAt: number | null;
  acceptedAt: number | null;
}

export interface WaitingListEntry {
  email: string;
  attempts: number;
  createdAt: number;
  updatedAt: number;
}

/** `limit: null` means unlimited (superuser). */
export interface InviteQuota {
  used: number;
  limit: number | null;
}

export interface InvitesResponse {
  invites: Invite[];
  quota: InviteQuota;
  isSuperuser: boolean;
  waitingList: WaitingListEntry[];
}

export interface InvitePreview {
  valid: boolean;
  inviterEmail?: string | null;
}

type FetchLike = typeof fetch;
const JSON_HEADERS = { "Content-Type": "application/json" } as const;

/** The URL an inviter shares. Resolved against the current origin. */
export function inviteUrl(token: string): string {
  const browser = globalThis as unknown as { window: { location: { origin: string } } };
  return `${browser.window.location.origin}/invite/${token}`;
}

export async function listInvites(fetchImpl: FetchLike = appFetch): Promise<InvitesResponse> {
  const res = await fetchImpl("/api/invites", { credentials: "include" });
  if (!res.ok) throw await errorFromResponse(res, "load your invites");
  return (await res.json()) as InvitesResponse;
}

export async function createInviteLink(fetchImpl: FetchLike = appFetch): Promise<Invite> {
  const res = await fetchImpl("/api/invites", {
    method: "POST",
    credentials: "include",
    headers: JSON_HEADERS,
    body: JSON.stringify({}),
  });
  if (!res.ok) throw await errorFromResponse(res, "create an invite link");
  return ((await res.json()) as { invite: Invite }).invite;
}

/** Superuser-only: invite a specific email straight off the waiting list. */
export async function inviteEmail(email: string, fetchImpl: FetchLike = appFetch): Promise<Invite> {
  const res = await fetchImpl("/api/invites", {
    method: "POST",
    credentials: "include",
    headers: JSON_HEADERS,
    body: JSON.stringify({ email }),
  });
  if (!res.ok) throw await errorFromResponse(res, `invite ${email}`);
  return ((await res.json()) as { invite: Invite }).invite;
}

export async function revokeInvite(id: string, fetchImpl: FetchLike = appFetch): Promise<void> {
  const res = await fetchImpl(`/api/invites/${encodeURIComponent(id)}`, {
    method: "DELETE",
    credentials: "include",
  });
  if (!res.ok) throw await errorFromResponse(res, "revoke the invite");
}

/** Public — the invitee has no account yet. */
export async function previewInvite(
  token: string,
  fetchImpl: FetchLike = appFetch,
): Promise<InvitePreview> {
  const res = await fetchImpl(`/api/invites/claim?token=${encodeURIComponent(token)}`);
  if (!res.ok) throw await errorFromResponse(res, "check the invite link");
  return (await res.json()) as InvitePreview;
}

/** Public — binds the invite link to this email so the OTP gate lets them in. */
export async function claimInvite(
  token: string,
  email: string,
  fetchImpl: FetchLike = appFetch,
): Promise<void> {
  const res = await fetchImpl("/api/invites/claim", {
    method: "POST",
    headers: JSON_HEADERS,
    body: JSON.stringify({ token, email }),
  });
  if (!res.ok) throw await errorFromResponse(res, "accept the invite");
}
