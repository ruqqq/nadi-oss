import { APICallError, type LanguageModel } from "ai";
import type { Env } from "../env";
import { log } from "../log";

type PostHogClient = {
  capture(input: unknown): void;
  flush(): Promise<void>;
};

type WithTracing = (
  model: unknown,
  client: PostHogClient,
  opts: Record<string, unknown>,
) => LanguageModel;

let cached: { key: string; client: PostHogClient; withTracing: WithTracing } | null = null;

/** Memoized posthog-node client, or null when PostHog is not configured. */
export async function getPostHogClient(env: Env): Promise<PostHogClient | null> {
  const key = env.POSTHOG_KEY;
  if (!key) return null;
  if (cached?.key === key) return cached.client;
  const [{ PostHog }, { withTracing }] = await Promise.all([
    import("posthog-node"),
    import("@posthog/ai"),
  ]);
  const client = new PostHog(key, {
    host: env.POSTHOG_HOST ?? "https://us.i.posthog.com",
    // The DO has no process-exit hook and no long-lived timer guarantee; we send
    // eagerly and additionally flush via ctx.waitUntil after each turn.
    flushAt: 1,
    flushInterval: 0,
  });
  cached = { key, client, withTracing: withTracing as unknown as WithTracing };
  return client;
}

export function getCachedPostHogClient(env: Env): PostHogClient | null {
  return cached?.key === env.POSTHOG_KEY ? cached.client : null;
}

export interface InstrumentOpts {
  client: PostHogClient | null;
  workspaceId: string;
  threadId: string;
  traceId: string;
  captureContent: boolean;
  runtime?: "legacy" | "think";
}

/** Wrap the model with PostHog AI tracing; returns the bare model when unconfigured. */
export function instrumentModel(model: LanguageModel, opts: InstrumentOpts): LanguageModel {
  if (!opts.client) return model;
  const withTracing = cached?.withTracing;
  if (!withTracing) return model;
  // Cast: ai's LanguageModel includes GlobalProviderModelId (string); withTracing
  // only accepts LanguageModelV2 | LanguageModelV3, so we cast to any here.
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  return withTracing(model as any, opts.client, {
    posthogDistinctId: opts.workspaceId,
    posthogGroups: { workspace: opts.workspaceId },
    posthogProperties: {
      thread_id: opts.threadId,
      ...(opts.runtime !== undefined ? { runtime: opts.runtime } : {}),
    },
    posthogTraceId: opts.traceId,
    posthogPrivacyMode: !opts.captureContent,
  }) as LanguageModel;
}

export interface RunErrorCtx {
  workspaceId: string;
  threadId: string;
  provider: string;
  model: string;
  traceId: string;
  runtime?: "legacy" | "think";
  error: unknown;
}

/**
 * Whether to capture prompt/output/tool content in PostHog AI traces.
 * Privacy-safe default: content is captured ONLY when POSTHOG_CAPTURE_CONTENT
 * is exactly "true". Any other value (including undefined) → metadata only.
 */
export function resolveCaptureContent(env: Env): boolean {
  return env.POSTHOG_CAPTURE_CONTENT === "true";
}

/** Capture a run-loop error as a $exception event on the trace. No-op when unconfigured. */
export function captureRunError(client: PostHogClient | null, ctx: RunErrorCtx): void {
  if (!client) return;
  try {
    const err = ctx.error;
    // Preserve the provider-side detail that `toUIMessageStreamResponse` and the
    // Think chat protocol otherwise collapse into a generic client message. The
    // response body is truncated because it can be large and may carry secrets.
    const api = APICallError.isInstance(err) ? err : undefined;
    client.capture({
      distinctId: ctx.workspaceId,
      event: "$exception",
      groups: { workspace: ctx.workspaceId },
      properties: {
        thread_id: ctx.threadId,
        provider: ctx.provider,
        model: ctx.model,
        ...(ctx.runtime !== undefined ? { runtime: ctx.runtime } : {}),
        $ai_trace_id: ctx.traceId,
        $exception_message: err instanceof Error ? err.message : String(err),
        $exception_type: err instanceof Error ? err.name : "Error",
        ...(err instanceof Error && err.cause !== undefined
          ? { exception_cause: String(err.cause) }
          : {}),
        ...(api?.statusCode !== undefined ? { status_code: api.statusCode } : {}),
        ...(api?.url !== undefined ? { request_url: api.url } : {}),
        ...(api?.responseBody !== undefined
          ? { response_body: api.responseBody.slice(0, 500) }
          : {}),
      },
    });
  } catch (e) {
    // Best-effort: telemetry must never break a chat turn.
    log.warn("posthog.capture_failed", { error: String(e) });
  }
}
