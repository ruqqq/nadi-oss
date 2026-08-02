/**
 * PostHog façade — keeps `posthog-js` (~40–55 KB gzip) out of the first-paint
 * critical path. The library is dynamically imported after first paint after
 * workspace consent is granted; calls made before consent are intentionally
 * dropped, while calls made after consent but before load completes are queued
 * and flushed in FIFO order once it's ready.
 */
import type posthogJs from "posthog-js";

type PostHog = typeof posthogJs;

/** Resolved instance, non-null only after the dynamic import + init complete. */
let instance: PostHog | null = null;
/** In-flight (or settled) load, so we import + init at most once. */
let loadPromise: Promise<PostHog | null> | null = null;
/** Set by `initPostHog` when a key is configured; gates every public call.
 *  `host` is kept required-but-nullable so assigning an absent env var (which is
 *  `string | undefined`) type-checks under exactOptionalPropertyTypes. */
let identity: { key: string; host: string | undefined } | null = null;
/** Workspace privacy gate; PostHog stays inert until consent is granted. */
let consent = false;
/** Calls issued after consent but before the instance is ready, replayed on load. */
const pending: Array<(p: PostHog) => void> = [];
/** One-shot callbacks fired once the instance is ready (e.g. error-shim handoff). */
const readyCallbacks: Array<(p: PostHog) => void> = [];

function run(fn: (p: PostHog) => void): void {
  if (!identity || !consent) return;
  if (instance) fn(instance);
  else {
    pending.push(fn);
    void load();
  }
}

function scheduleLoad(): void {
  const start = () => {
    void load();
  };
  // requestIdleCallback is a Window API; type it locally so this file compiles
  // under both the DOM lib (web) and the WebWorker lib (root repo typecheck).
  const ric = (
    globalThis as {
      requestIdleCallback?: (cb: () => void, opts?: { timeout: number }) => number;
    }
  ).requestIdleCallback;
  if (typeof ric === "function") {
    ric(start, { timeout: 2000 });
  } else {
    setTimeout(start, 1);
  }
}

/**
 * Record the config and schedule the deferred load. No-op without a key, or if
 * already called. Does NOT block first paint — the actual import runs on idle.
 */
export function initPostHog(config: { key?: string; host?: string }): void {
  if (identity || !config.key) return;
  identity = { key: config.key, host: config.host };
  if (consent) scheduleLoad();
}

async function load(): Promise<PostHog | null> {
  if (loadPromise) return loadPromise;
  if (!identity) return null;
  const cfg = identity;
  loadPromise = import("posthog-js").then(({ default: posthog }) => {
    if (!consent) {
      loadPromise = null;
      return null;
    }
    posthog.init(cfg.key, {
      api_host: cfg.host ?? "https://us.i.posthog.com",
      person_profiles: "identified_only",
      capture_pageview: true,
      disable_session_recording: true,
      capture_exceptions: true,
    });
    instance = posthog;
    for (const fn of pending) fn(posthog);
    pending.length = 0;
    for (const cb of readyCallbacks) cb(posthog);
    readyCallbacks.length = 0;
    return posthog;
  });
  return loadPromise;
}

export function identifyUser(user: { id: string; email?: string }): void {
  if (!identity) return;
  run((p) => p.identify(user.id, user.email ? { email: user.email } : undefined));
}

export function bindWorkspace(workspaceId: string): void {
  if (!identity) return;
  run((p) => p.group("workspace", workspaceId));
}

export function resetPostHog(): void {
  if (!identity) return;
  run((p) => p.reset());
}

export function setPostHogConsent(enabled: boolean): void {
  consent = enabled;
  if (!enabled) {
    pending.length = 0;
    readyCallbacks.length = 0;
    if (instance) {
      instance.opt_out_capturing();
      instance.stopExceptionAutocapture?.();
      instance.reset();
    }
    return;
  }
  if (instance) {
    instance.opt_in_capturing({ captureEventName: false });
    instance.startExceptionAutocapture?.();
    return;
  }
  if (identity) scheduleLoad();
}

/** Capture a named event. Metadata only — never pass message text. */
export function track(event: string, props?: Record<string, unknown>): void {
  if (!identity) return;
  run((p) => p.capture(event, props));
}

/** Report an exception. Used by the early-error shim's replay and ad-hoc catches. */
export function captureException(error: unknown, extra?: Record<string, unknown>): void {
  if (!identity) return;
  run((p) => p.captureException(error, extra));
}

/**
 * Run `cb` once PostHog is loaded and initialised (immediately if already ready).
 * No-op when no key is configured — the callback never fires, so callers that own
 * resources (e.g. the error shim's listeners) must not rely on it for cleanup in
 * the keyless case.
 */
export function onPostHogReady(cb: (p: PostHog) => void): void {
  if (!identity || !consent) return;
  if (instance) {
    cb(instance);
    return;
  }
  readyCallbacks.push(cb);
}

/** @internal test-only: reset module state between cases. */
export function __resetForTest(): void {
  instance = null;
  loadPromise = null;
  identity = null;
  consent = false;
  pending.length = 0;
  readyCallbacks.length = 0;
}
