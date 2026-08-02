import type { UIMessage } from "ai";

// Mirrors src/agent/system-reminder.ts: the server persists and streams
// hidden system-reminder messages (role "user", metadata.nadiKind marker) so
// the model sees injected context, but the human transcript must not. This
// module is the web-side counterpart — a pure predicate plus a filter for the
// message list the chat log renders.

export const NADI_SYSTEM_REMINDER_KIND = "system-reminder";

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

export function isHiddenReminderMessage(message: UIMessage): boolean {
  const metadata = message.metadata;
  return isObject(metadata) && metadata.nadiKind === NADI_SYSTEM_REMINDER_KIND;
}

export function visibleChatMessages(messages: UIMessage[]): UIMessage[] {
  return messages.filter((message) => !isHiddenReminderMessage(message));
}
