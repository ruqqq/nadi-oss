import type { StreamTextTransform, TextStreamPart, ToolSet } from "ai";

/**
 * AI SDK's UI stream requires every reasoning delta/end to be preceded by a
 * reasoning-start in the same active step. Resumed OpenAI Responses streams can
 * begin at a later summary delta, so synthesize the missing start locally.
 */
export function repairOrphanReasoningStream<TOOLS extends ToolSet>(): StreamTextTransform<TOOLS> {
  return () => {
    const activeReasoning = new Set<string>();

    return new TransformStream<TextStreamPart<TOOLS>, TextStreamPart<TOOLS>>({
      transform(part, controller) {
        switch (part.type) {
          case "reasoning-start":
            activeReasoning.add(part.id);
            controller.enqueue(part);
            break;
          case "reasoning-delta":
            if (!activeReasoning.has(part.id)) {
              activeReasoning.add(part.id);
              controller.enqueue({
                type: "reasoning-start",
                id: part.id,
                ...(part.providerMetadata !== undefined
                  ? { providerMetadata: part.providerMetadata }
                  : {}),
              } as TextStreamPart<TOOLS>);
            }
            controller.enqueue(part);
            break;
          case "reasoning-end":
            if (!activeReasoning.has(part.id)) {
              controller.enqueue({
                type: "reasoning-start",
                id: part.id,
                ...(part.providerMetadata !== undefined
                  ? { providerMetadata: part.providerMetadata }
                  : {}),
              } as TextStreamPart<TOOLS>);
            }
            activeReasoning.delete(part.id);
            controller.enqueue(part);
            break;
          case "finish-step":
            activeReasoning.clear();
            controller.enqueue(part);
            break;
          default:
            controller.enqueue(part);
        }
      },
    });
  };
}
