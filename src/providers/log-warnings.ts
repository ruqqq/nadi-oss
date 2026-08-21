// src/providers/log-warnings.ts
//
// Every provider adapter reports what it could not send — an unsupported
// parameter, a dropped message part — in the `warnings` the AI SDK returns.
// Nothing read them, and that is the only reason `@ai-sdk/deepseek` silently
// discarding every image part went unnoticed: the drop was reported on every
// turn as `unsupported: user message part type: file` and thrown away.
//
// One wrapper around every model we build, so the next adapter that quietly
// stops sending part of the request says so in the logs instead.
import { wrapLanguageModel, type LanguageModel, type LanguageModelMiddleware } from "ai";
import { log } from "../log";

type Warning = { type?: unknown; feature?: unknown; setting?: unknown; details?: unknown };

export function withProviderWarningLogging(
  model: LanguageModel,
  context: { provider: string; model: string },
): LanguageModel {
  // The mock providers return `MockLanguageModelV3` through a double cast; the
  // union also admits a bare model-id string, which has nothing to wrap.
  if (typeof model === "string") return model;

  const middleware: LanguageModelMiddleware = {
    specificationVersion: "v3",
    wrapGenerate: async ({ doGenerate }) => {
      const result = await doGenerate();
      report(result.warnings, context);
      return result;
    },
    wrapStream: async ({ doStream }) => {
      const result = await doStream();
      return {
        ...result,
        stream: result.stream.pipeThrough(
          new TransformStream({
            transform(chunk, controller) {
              // v3 carries a stream's warnings on its opening chunk, not on the
              // doStream result.
              if (chunk.type === "stream-start") report(chunk.warnings, context);
              controller.enqueue(chunk);
            },
          }),
        ),
      };
    },
  };

  // A provider package pinned to an older spec still satisfies the union `ai`
  // accepts here; the wrapper only reads `warnings`, which every spec carries.
  return wrapLanguageModel({
    model: model as Parameters<typeof wrapLanguageModel>[0]["model"],
    middleware,
  });
}

function report(warnings: unknown, context: { provider: string; model: string }): void {
  if (!Array.isArray(warnings) || warnings.length === 0) return;
  log.warn("provider.warnings", {
    ...context,
    warnings: warnings.map(describe).join("; "),
  });
}

function describe(warning: unknown): string {
  const { type, feature, setting, details } = (warning ?? {}) as Warning;
  const subject = feature ?? setting;
  return [type, subject, details].filter((part) => typeof part === "string" && part).join(": ");
}
