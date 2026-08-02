export const THREAD_RUNTIMES = ["legacy", "think"] as const;

export type ThreadRuntime = (typeof THREAD_RUNTIMES)[number];

export function normalizeThreadRuntime(value: unknown): ThreadRuntime {
  return value === "think" || value === "legacy" ? value : "legacy";
}

export function parseThreadRuntimeDefault(_env?: unknown): ThreadRuntime {
  return "think";
}

export function agentNameForThreadRuntime(
  runtime: ThreadRuntime,
): "thread-agent" | "think-thread-agent" {
  return runtime === "think" ? "think-thread-agent" : "thread-agent";
}

export function agentRoutePrefixForThreadRuntime(
  runtime: ThreadRuntime,
): "/agents/thread-agent" | "/think-agents/think-thread-agent" {
  return runtime === "think" ? "/think-agents/think-thread-agent" : "/agents/thread-agent";
}
