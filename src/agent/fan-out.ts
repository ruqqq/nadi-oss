import type { UserEvent } from "./user-events";

interface PublishStub {
  publish(event: UserEvent): Promise<void>;
}

interface HubNamespace {
  idFromName(name: string): DurableObjectId;
  get(id: DurableObjectId): PublishStub;
}

/**
 * Publish one event to each user's UserHub. Best-effort: a failed publish for
 * one user never rejects the whole fan-out.
 */
export async function fanOutToUsers(
  hub: HubNamespace,
  userIds: string[],
  event: UserEvent,
): Promise<void> {
  await Promise.allSettled(userIds.map((uid) => hub.get(hub.idFromName(uid)).publish(event)));
}
