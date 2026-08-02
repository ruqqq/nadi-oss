import type { ModelMessage } from "ai";

/**
 * `openai-oauth` forces Responses API `store:false`, so OpenAI does not persist
 * response item IDs such as `rs_*`. Legacy `@cloudflare/ai-chat` stripped this
 * ephemeral metadata before saving history; Think preserves more provider data,
 * so sanitize model input to keep later turns from replaying stale item IDs.
 */
export function sanitizeOpenAIOAuthMessages(messages: ModelMessage[]): ModelMessage[] {
  let changed = false;
  const sanitized = messages.map((message) => {
    const content = "content" in message ? message.content : undefined;
    const nextMessage = stripOpenAIItemMetadata(message);
    if (nextMessage !== message) changed = true;

    if (!Array.isArray(content)) return nextMessage as ModelMessage;

    const nextContent = content
      .filter((part) => {
        const keep = part.type !== "reasoning";
        if (!keep) changed = true;
        return keep;
      })
      .map((part) => {
        const nextPart = stripOpenAIItemMetadata(part);
        if (nextPart !== part) changed = true;
        return nextPart;
      });

    if (
      nextContent.length === content.length &&
      nextContent.every((part, index) => part === content[index])
    ) {
      return nextMessage as ModelMessage;
    }

    return { ...nextMessage, content: nextContent } as ModelMessage;
  });

  return changed ? sanitized : messages;
}

function stripOpenAIItemMetadata<T>(value: T): T {
  if (!isRecord(value)) return value;

  const nextProviderOptions = stripOpenAIEntry(value.providerOptions);
  const nextProviderMetadata = stripOpenAIEntry(value.providerMetadata);
  if (
    nextProviderOptions === value.providerOptions &&
    nextProviderMetadata === value.providerMetadata
  ) {
    return value;
  }

  const next: Record<string, unknown> = { ...value };
  assignOrDelete(next, "providerOptions", nextProviderOptions);
  assignOrDelete(next, "providerMetadata", nextProviderMetadata);
  return next as T;
}

function stripOpenAIEntry(value: unknown): unknown {
  if (!isRecord(value) || !("openai" in value)) return value;

  const next = { ...value };
  delete next.openai;
  return Object.keys(next).length === 0 ? undefined : next;
}

function assignOrDelete(target: Record<string, unknown>, key: string, value: unknown): void {
  if (value === undefined) {
    delete target[key];
    return;
  }
  target[key] = value;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}
