export interface ThreadThinkingPart {
  key: string;
  text: string;
  state?: string;
}

type MessageWithParts<P extends { type: string; text?: string; state?: string }> = {
  id: string;
  parts: P[];
};

export function latestThreadThinking<P extends { type: string; text?: string; state?: string }>(
  messages: MessageWithParts<P>[],
): ThreadThinkingPart | null {
  for (let messageIndex = messages.length - 1; messageIndex >= 0; messageIndex--) {
    const message = messages[messageIndex];
    if (!message) continue;
    for (let partIndex = message.parts.length - 1; partIndex >= 0; partIndex--) {
      const part = message.parts[partIndex];
      if (part?.type !== "reasoning") continue;
      return {
        key: `${message.id}-reasoning-${partIndex}`,
        text: part.text ?? "",
        state: part.state,
      };
    }
  }
  return null;
}
