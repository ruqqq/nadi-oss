import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

const { init, identify, group, reset, capture, captureException, optIn, optOut, stopException, startException } =
  vi.hoisted(() => ({
  init: vi.fn(),
  identify: vi.fn(),
  group: vi.fn(),
  reset: vi.fn(),
  capture: vi.fn(),
  captureException: vi.fn(),
  optIn: vi.fn(),
  optOut: vi.fn(),
  stopException: vi.fn(),
  startException: vi.fn(),
}));
vi.mock("posthog-js", () => ({
  default: {
    init,
    identify,
    group,
    reset,
    capture,
    captureException,
    opt_in_capturing: optIn,
    opt_out_capturing: optOut,
    stopExceptionAutocapture: stopException,
    startExceptionAutocapture: startException,
  },
}));

import {
  initPostHog,
  identifyUser,
  bindWorkspace,
  resetPostHog,
  setPostHogConsent,
  track,
  captureException as reportException,
  onPostHogReady,
  __resetForTest,
} from "../../../web/src/lib/posthog";

/** Resolves once the deferred posthog load + init completes. MUST be called
 *  after initPostHog — onPostHogReady only registers when a key is configured. */
function whenReady(): Promise<void> {
  return new Promise((resolve) => onPostHogReady(() => resolve()));
}

beforeEach(() => {
  __resetForTest();
  init.mockClear();
  identify.mockClear();
  group.mockClear();
  reset.mockClear();
  capture.mockClear();
  captureException.mockClear();
  optIn.mockClear();
  optOut.mockClear();
  stopException.mockClear();
  startException.mockClear();
  // Run the deferred idle load synchronously so tests don't depend on timing.
  // (The import() it kicks off still settles on the microtask queue.)
  (globalThis as unknown as { requestIdleCallback: unknown }).requestIdleCallback = (
    cb: () => void,
  ) => {
    cb();
    return 0;
  };
});

afterEach(() => {
  delete (globalThis as unknown as { requestIdleCallback?: unknown }).requestIdleCallback;
});

describe("frontend posthog boundary", () => {
  it("does not init without a key", async () => {
    initPostHog({});
    await Promise.resolve();
    expect(init).not.toHaveBeenCalled();
  });

  it("inits once, deferred, with exception capture enabled", async () => {
    initPostHog({ key: "phc_x", host: "https://us.i.posthog.com" });
    setPostHogConsent(true);
    const ready = whenReady();
    await ready;
    // A second init is ignored (no re-import, no re-init).
    initPostHog({ key: "phc_x" });

    expect(init).toHaveBeenCalledTimes(1);
    expect(init).toHaveBeenCalledWith(
      "phc_x",
      expect.objectContaining({
        api_host: "https://us.i.posthog.com",
        person_profiles: "identified_only",
        disable_session_recording: true,
        capture_exceptions: true,
      }),
    );
  });

  it("guards identify/group/track/reset until a key is configured", async () => {
    identifyUser({ id: "u1" });
    bindWorkspace("ws1");
    track("e");
    resetPostHog();
    await Promise.resolve();
    expect(identify).not.toHaveBeenCalled();
    expect(group).not.toHaveBeenCalled();
    expect(capture).not.toHaveBeenCalled();
    expect(reset).not.toHaveBeenCalled();
  });

  it("does not load or queue before consent", async () => {
    initPostHog({ key: "phc_x" });
    identifyUser({ id: "u1" });
    bindWorkspace("ws1");
    track("e", { a: 1 });
    reportException(new Error("boom"));
    await Promise.resolve();

    expect(init).not.toHaveBeenCalled();
    expect(identify).not.toHaveBeenCalled();
    expect(group).not.toHaveBeenCalled();
    expect(capture).not.toHaveBeenCalled();
    expect(captureException).not.toHaveBeenCalled();
  });

  it("queues calls made after init but before load resolves, flushing FIFO", async () => {
    initPostHog({ key: "phc_x" });
    setPostHogConsent(true);
    // Run synchronously before the dynamic import's microtask settles.
    identifyUser({ id: "u1", email: "a@b.c" });
    bindWorkspace("ws1");
    track("e", { a: 1 });
    resetPostHog();
    const ready = whenReady();

    await ready;

    expect(identify).toHaveBeenCalledWith("u1", { email: "a@b.c" });
    expect(group).toHaveBeenCalledWith("workspace", "ws1");
    expect(capture).toHaveBeenCalledWith("e", { a: 1 });
    expect(reset).toHaveBeenCalledTimes(1);
    // identify was queued first, so it flushes before the capture.
    expect(identify.mock.invocationCallOrder[0]).toBeLessThan(capture.mock.invocationCallOrder[0]!);
  });

  it("loads and flushes calls after consent is granted", async () => {
    initPostHog({ key: "phc_x" });
    setPostHogConsent(true);
    identifyUser({ id: "u1", email: "a@b.c" });
    track("e", { a: 1 });
    const ready = whenReady();

    await ready;

    expect(init).toHaveBeenCalledTimes(1);
    expect(identify).toHaveBeenCalledWith("u1", { email: "a@b.c" });
    expect(capture).toHaveBeenCalledWith("e", { a: 1 });
  });

  it("queues captureException after consent and replays it after load", async () => {
    initPostHog({ key: "phc_x" });
    setPostHogConsent(true);
    const boom = new Error("boom");
    reportException(boom, { source: "window.onerror", early: true });
    const ready = whenReady();

    await ready;

    expect(captureException).toHaveBeenCalledWith(boom, {
      source: "window.onerror",
      early: true,
    });
  });

  it("drops queued calls when consent is revoked before load resolves", async () => {
    delete (globalThis as unknown as { requestIdleCallback?: unknown }).requestIdleCallback;
    initPostHog({ key: "phc_x" });
    setPostHogConsent(true);
    track("before-revoke");
    setPostHogConsent(false);

    await new Promise((resolve) => setTimeout(resolve, 5));

    expect(capture).not.toHaveBeenCalled();
  });

  it("opts the loaded SDK out and stops exception autocapture when consent is revoked", async () => {
    initPostHog({ key: "phc_x" });
    setPostHogConsent(true);

    await whenReady();

    setPostHogConsent(false);

    expect(optOut).toHaveBeenCalledTimes(1);
    expect(stopException).toHaveBeenCalledTimes(1);
    expect(reset).toHaveBeenCalledTimes(1);
  });

  it("opts the loaded SDK back in without sending an opt-in event", async () => {
    initPostHog({ key: "phc_x" });
    setPostHogConsent(true);

    await whenReady();

    setPostHogConsent(false);
    setPostHogConsent(true);

    expect(optIn).toHaveBeenCalledWith({ captureEventName: false });
    expect(startException).toHaveBeenCalledTimes(1);
  });

  it("never fires the ready callback when no key is configured", async () => {
    let readyFired = false;
    initPostHog({});
    onPostHogReady(() => {
      readyFired = true;
    });
    await Promise.resolve();
    expect(readyFired).toBe(false);
  });

  it("does not fire ready callbacks after consent is revoked", async () => {
    let readyFired = false;
    initPostHog({ key: "phc_x" });
    setPostHogConsent(true);

    await whenReady();

    setPostHogConsent(false);
    onPostHogReady(() => {
      readyFired = true;
    });

    expect(readyFired).toBe(false);
  });
});
