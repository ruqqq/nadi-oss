import { sendNotification, type PushSubscription } from "web-push-neo";

type PushEnv = {
  VAPID_PUBLIC_KEY?: string;
  VAPID_PRIVATE_KEY?: string;
  VAPID_SUBJECT?: string;
};

export interface PushSubscriptionLike {
  endpoint: string;
  p256dh: string;
  auth: string;
}

export interface PushPayload {
  title: string;
  body: string;
  url: string;
}

export function isWebPushConfigured(env: PushEnv): boolean {
  return Boolean(env.VAPID_PUBLIC_KEY && env.VAPID_PRIVATE_KEY && env.VAPID_SUBJECT);
}

export async function sendWebPush(input: {
  env: PushEnv;
  subscription: PushSubscriptionLike;
  payload: PushPayload;
}): Promise<"sent" | "gone" | "failed" | "disabled"> {
  if (!isWebPushConfigured(input.env)) {
    return "disabled";
  }

  const subscription: PushSubscription = {
    endpoint: input.subscription.endpoint,
    keys: {
      p256dh: input.subscription.p256dh,
      auth: input.subscription.auth,
    },
  };

  try {
    await sendNotification(subscription, JSON.stringify(input.payload), {
      vapidDetails: {
        subject: input.env.VAPID_SUBJECT!,
        publicKey: input.env.VAPID_PUBLIC_KEY!,
        privateKey: input.env.VAPID_PRIVATE_KEY!,
      },
      TTL: 300,
      urgency: "normal",
    });

    return "sent";
  } catch (error) {
    const statusCode =
      typeof error === "object" && error !== null
        ? (error as { statusCode?: unknown }).statusCode
        : undefined;

    if (statusCode === 404 || statusCode === 410) {
      return "gone";
    }

    return "failed";
  }
}
