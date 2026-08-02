import { validateRequestSession } from "../auth/session";
import { registryDb } from "../db/client";
import { NotificationRepository } from "../db/repositories/notifications";
import type { Env } from "../env";

type SubscriptionBody = {
  endpoint: string;
  p256dh: string;
  auth: string;
};

export async function routeNotifications(req: Request, env: Env): Promise<Response | null> {
  const url = new URL(req.url);
  if (!url.pathname.startsWith("/api/notifications/")) return null;

  const session = await validateRequestSession(env, req);
  if (!session) return new Response("Unauthorized", { status: 401 });

  if (url.pathname === "/api/notifications/browser") {
    if (req.method === "GET") return getBrowserNotifications(env, session.user.id);
    return new Response("Method not allowed", { status: 405 });
  }

  if (url.pathname === "/api/notifications/browser/settings") {
    if (req.method === "PUT") return updateBrowserSettings(req, env, session.user.id);
    return new Response("Method not allowed", { status: 405 });
  }

  if (url.pathname === "/api/notifications/browser/subscriptions") {
    if (req.method === "POST") return upsertSubscription(req, env, session.user.id);
    if (req.method === "DELETE") return deleteSubscription(req, env, session.user.id);
    return new Response("Method not allowed", { status: 405 });
  }

  return new Response("Not found", { status: 404 });
}

async function browserSettingsResponse(
  repo: NotificationRepository,
  env: Env,
  userId: string,
): Promise<Response> {
  const settings = await repo.getBrowserSettings(userId);
  return Response.json({
    browserPushEnabled: settings?.browserPushEnabled ?? false,
    pushPreviewEnabled: settings?.pushPreviewEnabled ?? true,
    vapidPublicKey: env.VAPID_PUBLIC_KEY ?? null,
  });
}

async function getBrowserNotifications(env: Env, userId: string): Promise<Response> {
  const repo = new NotificationRepository(registryDb(env));
  return browserSettingsResponse(repo, env, userId);
}

async function updateBrowserSettings(req: Request, env: Env, userId: string): Promise<Response> {
  const body = (await req.json().catch(() => null)) as {
    browserPushEnabled?: unknown;
    pushPreviewEnabled?: unknown;
  } | null;

  // Both fields are optional so each switch can send only its own, but a field
  // that IS present must be a boolean, and a body with neither says nothing.
  for (const field of ["browserPushEnabled", "pushPreviewEnabled"] as const) {
    const value = body?.[field];
    if (value !== undefined && typeof value !== "boolean") {
      return new Response(`${field} must be boolean`, { status: 400 });
    }
  }
  if (body?.browserPushEnabled === undefined && body?.pushPreviewEnabled === undefined) {
    return new Response("no settings to update", { status: 400 });
  }

  const repo = new NotificationRepository(registryDb(env));
  await repo.updateBrowserSettings({
    userId,
    ...(typeof body.browserPushEnabled === "boolean"
      ? { browserPushEnabled: body.browserPushEnabled }
      : {}),
    ...(typeof body.pushPreviewEnabled === "boolean"
      ? { pushPreviewEnabled: body.pushPreviewEnabled }
      : {}),
    now: Date.now(),
  });

  // Read back rather than echo the request: a partial write must not leave the
  // client believing it knows the state of the field it did not send.
  return browserSettingsResponse(repo, env, userId);
}

async function upsertSubscription(req: Request, env: Env, userId: string): Promise<Response> {
  const body = readSubscription(await req.json().catch(() => null));
  if (!body) return new Response("Invalid subscription payload", { status: 400 });

  await new NotificationRepository(registryDb(env)).upsertSubscription({
    userId,
    endpoint: body.endpoint,
    p256dh: body.p256dh,
    auth: body.auth,
    userAgent: req.headers.get("user-agent"),
    now: Date.now(),
  });

  return new Response(null, { status: 204 });
}

async function deleteSubscription(req: Request, env: Env, userId: string): Promise<Response> {
  const body = (await req.json().catch(() => null)) as { endpoint?: unknown } | null;
  if (typeof body?.endpoint !== "string" || !body.endpoint.startsWith("https://")) {
    return new Response("endpoint must be an https URL", { status: 400 });
  }

  await new NotificationRepository(registryDb(env)).deleteSubscriptionByEndpoint({
    userId,
    endpoint: body.endpoint,
  });

  return new Response(null, { status: 204 });
}

function readSubscription(body: unknown): SubscriptionBody | null {
  if (!body || typeof body !== "object" || Array.isArray(body)) return null;

  const endpoint = (body as { endpoint?: unknown }).endpoint;
  const keys = (body as { keys?: unknown }).keys;
  if (typeof endpoint !== "string" || !endpoint.startsWith("https://")) return null;
  if (!keys || typeof keys !== "object" || Array.isArray(keys)) return null;

  const p256dh = (keys as { p256dh?: unknown }).p256dh;
  const auth = (keys as { auth?: unknown }).auth;
  if (typeof p256dh !== "string" || typeof auth !== "string") return null;

  return { endpoint, p256dh, auth };
}
