import { describe, expect, it } from "vitest";
import { FakeComputeBackend } from "../../../src/compute/backends/fake";
import { createFakeSpritesBackend } from "./helpers/fake-sprites-client";
import { deriveCompletionSecret, verifyCompletionToken } from "../../../src/compute/completion-token";
import { DEFAULT_COMPUTE_LIMITS } from "../../../src/compute/config";
import { log } from "../../../src/log";
import { MAX_WATCH_TIMEOUT_MS, ThreadComputeService } from "../../../src/compute/thread-service";
import type { EffectiveComputeConfig } from "../../../src/compute/types";
import { createMemoryComputeStore } from "./helpers/memory-store";

const CONFIG: EffectiveComputeConfig = {
  provider: "fake",
  providerConfig: { kind: "cloudflare" },
  resourceProfile: "small",
  idleTimeoutMs: 1_000,
  recoveryTtlMs: 5_000,
  maxProcessRuntimeMs: 10_000,
  monitorPollIntervalMs: 100,
  limits: DEFAULT_COMPUTE_LIMITS,
  allowedHosts: null,
  editableEnv: {},
  agentEditableEnv: {},
  secretEnvNames: [],
  environmentEditableEnv: {},
  environmentSecretEnvNames: [],
};

const SECRET = "test-better-auth-secret";

/** Pulls the bearer token out of a curl fragment built by `buildCompletionCallback`. */
function extractToken(fragment: string): string {
  const match = fragment.match(/Authorization: Bearer ([^']+)'/);
  if (!match?.[1]) throw new Error(`no bearer token in fragment: ${fragment}`);
  return match[1];
}

describe("ThreadComputeService completion callback", () => {
  it("attaches a callback carrying exactly (threadId, processId, exp) and the widened curl timeout", async () => {
    const backend = new FakeComputeBackend();
    const store = createMemoryComputeStore();
    const now = { value: 1_000 };
    const service = new ThreadComputeService({
      backend,
      store,
      config: CONFIG,
      environmentId: "thread_test",
      threadId: "thread_abc",
      env: {},
      appBaseUrl: "https://nadi.example.com/",
      betterAuthSecret: SECRET,
      setAlarm: async () => {},
      now: () => now.value,
    });

    await service.exec({ command: "true" });

    expect(backend.startProcessCalls).toHaveLength(1);
    const fragment = backend.startProcessCalls[0]?.completionCallback;
    expect(fragment).toBeDefined();
    // The wrapper's own curl timeout must be widened past the completion
    // route's own ~10s teardown budget (Task 4's review finding) — regressing
    // this back to a tight timeout is exactly the kind of "tidy-up" the
    // source comment warns against.
    expect(fragment).toContain("curl -sf -m 25 -X POST https://nadi.example.com/api/compute/completion");
    // Origin is normalised (trailing slash stripped) rather than doubled.
    expect(fragment).not.toContain("com//api");

    const secret = await deriveCompletionSecret(SECRET);
    const token = extractToken(fragment!);
    const payload = await verifyCompletionToken(secret, token, now.value);
    expect(payload).not.toBeNull();
    // The token payload must carry EXACTLY these three fields — nothing more
    // (see completion-token.ts's doc: the worst forgery available must stay
    // "lie about this process's own exit code", not widen to another thread
    // or process).
    expect(Object.keys(payload!).sort()).toEqual(["exp", "processId", "threadId"]);
    expect(payload!.threadId).toBe("thread_abc");
    expect(payload!.processId).toMatch(/^proc_/);
    // exp covers the CONFIG's maxProcessRuntimeMs (10_000ms here), which is
    // far smaller than MAX_WATCH_TIMEOUT_MS, so the watch window dominates —
    // see the next test for the case where the process budget dominates.
    expect(payload!.exp).toBe(now.value + MAX_WATCH_TIMEOUT_MS + 300_000);
  });

  it("derives exp from the PROCESS timeout when it exceeds the watch window", async () => {
    const backend = new FakeComputeBackend();
    const store = createMemoryComputeStore();
    const now = { value: 5_000 };
    // A workspace can configure up to 24h; use something well past
    // MAX_WATCH_TIMEOUT_MS (1h) to prove the process budget, not the watch
    // window, drives `exp` here.
    const longRunConfig: EffectiveComputeConfig = {
      ...CONFIG,
      maxProcessRuntimeMs: 24 * 60 * 60 * 1000,
    };
    const service = new ThreadComputeService({
      backend,
      store,
      config: longRunConfig,
      environmentId: "thread_test",
      threadId: "thread_abc",
      env: {},
      appBaseUrl: "https://nadi.example.com",
      betterAuthSecret: SECRET,
      setAlarm: async () => {},
      now: () => now.value,
    });

    await service.exec({ command: "true" });

    const fragment = backend.startProcessCalls[0]?.completionCallback;
    expect(fragment).toBeDefined();
    const secret = await deriveCompletionSecret(SECRET);
    const payload = await verifyCompletionToken(secret, extractToken(fragment!), now.value);
    expect(payload!.exp).toBe(now.value + longRunConfig.maxProcessRuntimeMs + 300_000);
  });

  it("omits the callback when appBaseUrl is not configured", async () => {
    const backend = new FakeComputeBackend();
    const store = createMemoryComputeStore();
    const service = new ThreadComputeService({
      backend,
      store,
      config: CONFIG,
      environmentId: "thread_test",
      threadId: "thread_abc",
      env: {},
      betterAuthSecret: SECRET,
      setAlarm: async () => {},
      now: () => 1_000,
    });

    await service.exec({ command: "true" });
    expect(backend.startProcessCalls[0]?.completionCallback).toBeUndefined();
  });

  it("omits the callback when betterAuthSecret is not configured", async () => {
    const backend = new FakeComputeBackend();
    const store = createMemoryComputeStore();
    const service = new ThreadComputeService({
      backend,
      store,
      config: CONFIG,
      environmentId: "thread_test",
      threadId: "thread_abc",
      env: {},
      appBaseUrl: "https://nadi.example.com",
      setAlarm: async () => {},
      now: () => 1_000,
    });

    await service.exec({ command: "true" });
    expect(backend.startProcessCalls[0]?.completionCallback).toBeUndefined();
  });

  it("omits the callback when the service has no threadId", async () => {
    const backend = new FakeComputeBackend();
    const store = createMemoryComputeStore();
    const service = new ThreadComputeService({
      backend,
      store,
      config: CONFIG,
      environmentId: "thread_test",
      // threadId omitted entirely.
      env: {},
      appBaseUrl: "https://nadi.example.com",
      betterAuthSecret: SECRET,
      setAlarm: async () => {},
      now: () => 1_000,
    });

    await service.exec({ command: "true" });
    expect(backend.startProcessCalls[0]?.completionCallback).toBeUndefined();
  });

  it("does NOT refuse to background a mock/fake backend even with no callback available", async () => {
    // `FakeComputeBackend.id === "fake"`, exempt from the refusal rule: it
    // never curls anywhere, so the pre-existing background/watcher behavior
    // must be unaffected by this whole mechanism.
    const backend = new FakeComputeBackend();
    const store = createMemoryComputeStore();
    const now = { value: 1_000 };
    const result = await new ThreadComputeService({
      backend,
      store,
      config: CONFIG,
      environmentId: "thread_test",
      threadId: "thread_abc",
      env: {},
      // No appBaseUrl/betterAuthSecret at all — the common case for every
      // pre-existing test in this suite.
      setAlarm: async () => {},
      now: () => now.value,
      execForegroundTimeoutMs: 1,
      execForegroundPollIntervalMs: 1,
      sleep: async (ms) => void (now.value += ms),
    }).exec({ command: "sleep 5" });

    expect(result.status).toBe("backgrounded");
  });

  it("refuses to background a REMOTE provider with no reachable callback, running synchronously instead", async () => {
    const { backend } = createFakeSpritesBackend();
    const store = createMemoryComputeStore();
    const warnings: Array<[string, Record<string, unknown> | undefined]> = [];
    const originalWarn = log.warn;
    log.warn = (event, fields) => {
      warnings.push([event, fields]);
    };
    try {
      const service = new ThreadComputeService({
        backend,
        store,
        config: CONFIG,
        environmentId: "thread_test",
        threadId: "thread_abc",
        env: {},
        // No appBaseUrl configured — sprites IS a remote provider, so this
        // must refuse to background rather than silently rely on polling.
        setAlarm: async () => {},
        now: () => 1_000,
      });

      const result = await service.exec({ command: "true" });
      // Ran to completion synchronously rather than "backgrounded" — the
      // command is trivial so it would have completed either way; the
      // load-bearing assertion is the warning below plus the equivalent
      // real-suspension case in the sibling loopback test.
      expect(result.status).not.toBe("backgrounded");
      expect(warnings).toContainEqual([
        "compute.background_refused_no_callback",
        { threadId: "thread_abc", provider: "sprites", reason: "no_base_url" },
      ]);
    } finally {
      log.warn = originalWarn;
    }
  });

  it("treats a loopback APP_BASE_URL as unreachable for a remote provider and refuses to background", async () => {
    const { backend } = createFakeSpritesBackend();
    const store = createMemoryComputeStore();
    const warnings: Array<[string, Record<string, unknown> | undefined]> = [];
    const originalWarn = log.warn;
    log.warn = (event, fields) => {
      warnings.push([event, fields]);
    };
    try {
      const service = new ThreadComputeService({
        backend,
        store,
        config: CONFIG,
        environmentId: "thread_test",
        threadId: "thread_abc",
        env: {},
        // The local-dev default — non-empty, but unreachable from inside a
        // real sandbox.
        appBaseUrl: "http://localhost:8787",
        betterAuthSecret: SECRET,
        setAlarm: async () => {},
        now: () => 1_000,
      });

      const result = await service.exec({ command: "true" });
      expect(result.status).not.toBe("backgrounded");
      expect(warnings).toContainEqual([
        "compute.background_refused_no_callback",
        { threadId: "thread_abc", provider: "sprites", reason: "unreachable_base_url" },
      ]);
    } finally {
      log.warn = originalWarn;
    }
  });

  it("does NOT treat a loopback APP_BASE_URL as unreachable for the in-process fake backend", async () => {
    const backend = new FakeComputeBackend();
    const store = createMemoryComputeStore();
    const now = { value: 1_000 };
    const service = new ThreadComputeService({
      backend,
      store,
      config: CONFIG,
      environmentId: "thread_test",
      threadId: "thread_abc",
      env: {},
      appBaseUrl: "http://localhost:8787",
      betterAuthSecret: SECRET,
      setAlarm: async () => {},
      now: () => now.value,
      execForegroundTimeoutMs: 1,
      execForegroundPollIntervalMs: 1,
      sleep: async (ms) => void (now.value += ms),
    });

    const result = await service.exec({ command: "sleep 5" });
    expect(result.status).toBe("backgrounded");
    // Not refused, so a callback IS attached (fake ignores it, harmlessly).
    expect(backend.startProcessCalls[0]?.completionCallback).toBeDefined();
  });

  it("runs the completion callback through a REAL sprites wrapper, exercising FakeSpritesClient's cbRc guard", async () => {
    const { backend, client } = createFakeSpritesBackend();
    const store = createMemoryComputeStore();
    const service = new ThreadComputeService({
      backend,
      store,
      config: CONFIG,
      environmentId: "thread_test",
      threadId: "thread_abc",
      env: {},
      appBaseUrl: "https://nadi.example.com",
      betterAuthSecret: SECRET,
      setAlarm: async () => {},
      now: () => 1_000,
    });

    // A completed-synchronously command still runs through the FULL wrapper
    // (the callback is unconditional in the wrapper shape, not gated on how
    // long the command took) — so `WRAPPER_RE`, including the cbRc guard
    // added for this task, is exercised even for a trivial `true`.
    const result = await service.exec({ command: "true" });
    expect(result.status).toBe("exited");
    if (result.status === "exited") expect(result.exitCode).toBe(0);

    const wrapperCall = client.execDetachedOptions[0];
    expect(wrapperCall).toBeDefined();
    const script = wrapperCall!.argv[2];
    expect(script).toContain("/api/compute/completion");
    expect(script).toContain("NADI_EXIT_CODE=");
    // Ordering, from the real assembled wrapper: rc write, then callback,
    // then release.
    const rcAt = script!.indexOf("mv -f");
    const callbackAt = script!.indexOf("/api/compute/completion");
    const releaseAt = script!.lastIndexOf("-X DELETE");
    expect(rcAt).toBeLessThan(callbackAt);
    expect(callbackAt).toBeLessThan(releaseAt);
  });
});
