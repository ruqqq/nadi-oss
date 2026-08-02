import { and, eq } from "drizzle-orm";
import {
  applyThreadLifecycleState,
  isCompletionPushEligible,
} from "../agent/thread-lifecycle-events";
import { notifyWorkspaceMembers } from "../agent/notify-user";
import { applyAutomatonRunLifecycleEvent } from "../automata/run-lifecycle";
import { registryDb } from "../db/client";
import { NotificationRepository } from "../db/repositories/notifications";
import { ThreadRepository } from "../db/repositories/threads";
import { automata, threadIndex, workspaceMembers } from "../db/schema";
import type { Env } from "../env";
import { serializeThread } from "../http/thread-serialize";
import { sendWebPush } from "./web-push";

interface UserHubPresenceStub {
  hasVisibleThread(threadId: string): boolean | Promise<boolean>;
  hasVisibleClient(): boolean | Promise<boolean>;
}

export type ThreadPushEvent =
  | {
      type: "thread.completed";
      threadId: string;
      workspaceId: string;
      startedAt: number;
      occurredAt: number;
      hadWatchedWork: boolean;
      preview?: string;
    }
  | {
      type: "thread.attention_required";
      threadId: string;
      workspaceId: string;
      occurredAt: number;
      reason?: string;
      preview?: string;
    }
  | {
      type: "thread.failed";
      threadId: string;
      workspaceId: string;
      startedAt: number | null;
      occurredAt: number;
      reason?: string;
      preview?: string;
    };

export type ThreadPushDecisionEvent =
  | {
      type: "thread.completed";
      startedAt: number;
      occurredAt: number;
      hadWatchedWork: boolean;
    }
  | {
      type: "thread.attention_required";
      occurredAt: number;
    }
  | {
      type: "thread.failed";
      startedAt: number | null;
      occurredAt: number;
    };

type ThreadLifecycleInputEvent =
  | { type: "thread.started"; threadId: string; workspaceId: string; startedAt: number }
  | ThreadPushEvent;

export function shouldSendThreadPush(
  event: ThreadPushDecisionEvent & {
    isAutomatonRun: boolean;
    notifyMode?: "all" | "failures_only" | null;
  },
): boolean {
  // Failure and attention-required always push — they are the point.
  if (event.type !== "thread.completed") {
    return true;
  }

  if (event.isAutomatonRun) {
    // failures_only means: no ping on a run that finished cleanly.
    if (event.notifyMode === "failures_only") {
      return false;
    }
    // The duration threshold presumes a present user; an automaton is unattended.
    return true;
  }

  return isCompletionPushEligible({
    startedAt: event.startedAt,
    completedAt: event.occurredAt,
    hadWatchedWork: event.hadWatchedWork,
  });
}

export function buildThreadPushPayload(event: {
  type: ThreadPushEvent["type"];
  threadId: string;
  automatonName?: string | null;
  /** The thread's own name, once it has one (see auto-name-thread.ts). */
  threadTitle?: string | null;
  /**
   * The excerpt to show as the body: the assistant's reply for a completion or
   * an attention gate, the declared reason for a failure. Absent when the
   * recipient turned previews off, or when the turn produced no prose — both
   * fall back to the generic copy below.
   *
   * Body only. The title names the thread in either mode.
   */
  preview?: string | null | undefined;
}): { title: string; body: string; url: string } {
  const url = `/threads/${encodeURIComponent(event.threadId)}`;
  const name = event.automatonName;
  const preview = event.preview?.trim() || null;
  if (event.type === "thread.attention_required") {
    return {
      title: name ? `${name} needs you` : "Action needed",
      body: preview ?? "Open the thread to continue.",
      url,
    };
  }
  if (event.type === "thread.failed") {
    return {
      title: name ? `${name} failed` : "Run failed",
      body: preview ?? "Open the thread to check what happened.",
      url,
    };
  }
  // A completion only pushes when the turn was long-running AND the user is away
  // (shouldSendThreadPush), so it lands on someone who has walked off and may
  // have several threads going. Name the thread that finished; "Thread ready"
  // told them nothing about which one.
  const threadTitle = event.threadTitle?.trim();
  return {
    title: name ? `${name} is ready` : (threadTitle ?? "") || "Thread ready",
    body: preview ?? (name ? "Nadi finished this run." : "Nadi finished — tap to read the reply."),
    url,
  };
}

/**
 * What one recipient gets for this event, or null if they get nothing.
 *
 * Previews are a per-user setting, so two members of the same workspace can
 * legitimately receive different bodies for the same event. Taking `settings`
 * is what makes that structural: this cannot be lifted out of the member loop
 * and reused, which is exactly the bug it exists to prevent.
 */
export function pushPayloadForRecipient(input: {
  type: ThreadPushEvent["type"];
  threadId: string;
  automatonName?: string | null;
  threadTitle?: string | null;
  preview?: string | null | undefined;
  settings: { browserPushEnabled: boolean; pushPreviewEnabled: boolean } | undefined;
}): { title: string; body: string; url: string } | null {
  if (!input.settings?.browserPushEnabled) {
    return null;
  }
  return buildThreadPushPayload({
    ...input,
    preview: input.settings.pushPreviewEnabled ? input.preview : null,
  });
}

/**
 * The title a push may name. A thread keeps its placeholder ("New thread") until
 * it is named, and the placeholder is worse than the generic fallback copy.
 */
export function pushableThreadTitle(thread: { title: string; titleSet: boolean }): string | null {
  return thread.titleSet ? thread.title : null;
}

function presenceStub(env: Env, userId: string): UserHubPresenceStub {
  return env.USER_HUB.get(env.USER_HUB.idFromName(userId)) as UserHubPresenceStub;
}

/** Is this user reading the thread right now? Feeds `isAway` → unread state. */
async function userHasVisibleThread(env: Env, userId: string, threadId: string): Promise<boolean> {
  try {
    return await presenceStub(env, userId).hasVisibleThread(threadId);
  } catch {
    return false;
  }
}

/**
 * Is this user in the app right now, on any thread and on any device? Gates
 * push only — someone already looking at Nadi does not need an OS banner for it,
 * and on an installed iOS PWA that banner is actively broken: WebKit does not
 * fire `notificationclick` while the app is running and was launched from the
 * home screen, so tapping it does nothing at all.
 *
 * Suppression is per user rather than per device on purpose. Nothing links a
 * live socket to a push subscription, and "I am using Nadi on my phone, so also
 * banner my laptop" is a notification worth losing.
 *
 * Fails OPEN, like the check above: a cold or throwing hub sends the push. The
 * cost of a stray notification is an annoyance; the cost of a wrongly withheld
 * one is silence.
 */
async function userIsInTheApp(env: Env, userId: string): Promise<boolean> {
  try {
    return await presenceStub(env, userId).hasVisibleClient();
  } catch {
    return false;
  }
}

async function selectWorkspaceMemberIds(env: Env, workspaceId: string): Promise<string[]> {
  const db = registryDb(env);
  const rows = await db
    .select({ userId: workspaceMembers.userId })
    .from(workspaceMembers)
    .where(eq(workspaceMembers.workspaceId, workspaceId))
    .all();
  return rows.map((row) => row.userId);
}

/**
 * The transport, injectable so a test can observe what was actually sent. The
 * default is the real one; nothing in production passes this.
 */
export type PushSender = typeof sendWebPush;

async function sendPushToWorkspaceMembers(
  env: Env,
  event: ThreadPushEvent,
  memberIds: string[],
  automatonName: string | null,
  threadTitle: string | null,
  send: PushSender,
): Promise<void> {
  const db = registryDb(env);
  const notifications = new NotificationRepository(db);

  await Promise.all(
    memberIds.map(async (userId) => {
      try {
        // Deliberately broader than the `isAway` check in the caller: that one
        // asks about THIS thread and must stay that way, or a thread the user
        // was not reading would stop being marked unread.
        if (await userIsInTheApp(env, userId)) {
          return;
        }

        // Per recipient, never hoisted: previews are a per-user setting.
        const payload = pushPayloadForRecipient({
          ...event,
          automatonName,
          threadTitle,
          settings: await notifications.getBrowserSettings(userId),
        });
        if (!payload) {
          return;
        }

        const subscriptions = await notifications.listSubscriptionsForUser(userId);
        await Promise.all(
          subscriptions.map(async (subscription) => {
            const result = await send({ env, subscription, payload });
            if (result === "gone") {
              await notifications.deleteSubscriptionId(subscription.id);
            }
          }),
        );
      } catch {
        // Best-effort: notification delivery must not fail lifecycle persistence.
      }
    }),
  );
}

export async function recordThreadLifecycleEvent(input: {
  env: Env;
  event: ThreadLifecycleInputEvent;
  /** Test seam: observe delivery without a VAPID keypair. Production omits it. */
  sendPush?: PushSender;
}): Promise<void> {
  const db = registryDb(input.env);
  const threads = new ThreadRepository(db);
  const thread = await threads.getById(input.event.threadId);
  if (!thread) {
    return;
  }

  const automatonRow = thread.automatonId
    ? ((await db
        .select({ name: automata.name, notifyMode: automata.notifyMode })
        .from(automata)
        .where(eq(automata.id, thread.automatonId))
        .get()) ?? null)
    : null;
  const automatonName = automatonRow?.name ?? null;

  const memberIds = await selectWorkspaceMemberIds(input.env, input.event.workspaceId);
  const visibleChecks = await Promise.all(
    memberIds.map((userId) => userHasVisibleThread(input.env, userId, input.event.threadId)),
  );
  const isAway = !visibleChecks.some(Boolean);

  const patch = applyThreadLifecycleState({
    current: {
      activityStatus: thread.activityStatus,
      unreadOutcome: thread.unreadOutcome,
      attentionRequiredAt: thread.attentionRequiredAt,
    },
    event:
      input.event.type === "thread.started"
        ? { type: "thread.started", startedAt: input.event.startedAt }
        : input.event.type === "thread.completed"
          ? {
              type: "thread.completed",
              startedAt: input.event.startedAt,
              completedAt: input.event.occurredAt,
            }
          : input.event.type === "thread.attention_required"
            ? { type: "thread.attention_required", occurredAt: input.event.occurredAt }
            : {
                type: "thread.failed",
                startedAt: input.event.startedAt,
                failedAt: input.event.occurredAt,
              },
    isAway,
  });

  await db
    .update(threadIndex)
    .set({ ...patch, updatedAt: Date.now() })
    .where(eq(threadIndex.id, input.event.threadId));

  if (thread.automatonRunId) {
    await applyAutomatonRunLifecycleEvent({
      db,
      runId: thread.automatonRunId,
      event:
        input.event.type === "thread.started"
          ? { type: "thread.started", startedAt: input.event.startedAt }
          : input.event.type === "thread.completed"
            ? { type: "thread.completed", occurredAt: input.event.occurredAt }
            : input.event.type === "thread.attention_required"
              ? {
                  type: "thread.attention_required",
                  occurredAt: input.event.occurredAt,
                  ...(input.event.reason ? { reason: input.event.reason } : {}),
                }
              : {
                  type: "thread.failed",
                  occurredAt: input.event.occurredAt,
                  ...(input.event.reason ? { reason: input.event.reason } : {}),
                },
    }).catch(() => {
      // Best-effort, exactly like push delivery: run bookkeeping must never
      // fail thread lifecycle persistence.
    });
  }

  const updated = await threads.getSummaryRowById(input.event.threadId);
  if (updated) {
    // The excerpt the push would have carried, handed to the in-app notice on
    // the same event that raised the outcome. `thread.started` has none — there
    // is no reply yet — and neither does a rename, which is why this rides on
    // the event rather than the thread row. See agent/user-events.ts.
    const preview = input.event.type === "thread.started" ? null : (input.event.preview ?? null);
    await notifyWorkspaceMembers(input.env, updated.workspaceId, {
      type: "thread.updated",
      thread: serializeThread(updated),
      ...(preview ? { preview } : {}),
    });
  }

  if (input.event.type === "thread.started") {
    return;
  }

  if (
    !shouldSendThreadPush({
      ...input.event,
      isAutomatonRun: thread.automatonId !== null,
      notifyMode: automatonRow?.notifyMode ?? null,
    })
  ) {
    return;
  }

  await sendPushToWorkspaceMembers(
    input.env,
    input.event,
    memberIds,
    automatonName,
    pushableThreadTitle(thread),
    input.sendPush ?? sendWebPush,
  );
}

export async function clearThreadAttentionIfResolved(input: {
  env: Env;
  threadId: string;
  userId: string;
  seenAt?: number;
}): Promise<void> {
  const db = registryDb(input.env);
  const threads = new ThreadRepository(db);
  const thread = await threads.getById(input.threadId);
  if (!thread) {
    return;
  }

  const membership = await db
    .select({ userId: workspaceMembers.userId })
    .from(workspaceMembers)
    .where(
      and(
        eq(workspaceMembers.workspaceId, thread.workspaceId),
        eq(workspaceMembers.userId, input.userId),
      ),
    )
    .get();
  if (!membership) {
    return;
  }

  const seenAt = input.seenAt ?? Date.now();
  await db
    .update(threadIndex)
    .set({
      unreadOutcome: null,
      unreadOutcomeAt: null,
      lastSeenAt: seenAt,
      updatedAt: seenAt,
    })
    .where(eq(threadIndex.id, input.threadId));

  const updated = await threads.getSummaryRowById(input.threadId);
  if (!updated) {
    return;
  }

  await notifyWorkspaceMembers(input.env, updated.workspaceId, {
    type: "thread.updated",
    thread: serializeThread(updated),
  });
}
