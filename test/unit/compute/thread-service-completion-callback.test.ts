import { describe, expect, it } from "vitest";
import { FakeComputeBackend } from "../../../src/compute/backends/fake";
import { createFakeSpritesBackend } from "./helpers/fake-sprites-client";
import {
  deriveCompletionSecret,
  verifyCompletionToken,
} from "../../../src/compute/completion-token";
import { DEFAULT_COMPUTE_LIMITS } from "../../../src/compute/config";
import { ComputeError } from "../../../src/compute/errors";
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
    expect(fragment).toContain(
      "curl -sf -m 25 -X POST https://nadi.example.com/api/compute/completion",
    );
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

  it("omits the callback entirely when background work is not admitted, leaving the wrapper byte-identical", async () => {
    // C1: `supportsProcessMonitor: false` is how `sandboxHostDeps()` reports
    // `BACKGROUND_WORK_ENABLED` off (and SubAgent's own opt-out). With the flag
    // off nothing registers a watcher, so a callback would report a completion
    // `reportProcessCompletion` rejects — and on a backend whose completion
    // signal IS the wrapper's exit it would re-time every command. The flag-off
    // command must therefore match the pre-push one EXACTLY, not just closely.
    const normalize = (script: string) =>
      script.replace(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/g, "UUID");

    const build = async (admitted: boolean) => {
      const { backend, client } = createFakeSpritesBackend();
      const service = new ThreadComputeService({
        backend,
        store: createMemoryComputeStore(),
        config: CONFIG,
        environmentId: "thread_test",
        threadId: "thread_abc",
        env: {},
        appBaseUrl: "https://nadi.example.com",
        betterAuthSecret: SECRET,
        setAlarm: async () => {},
        now: () => 1_000,
        ...(admitted ? {} : { supportsProcessMonitor: false }),
      });
      await service.exec({ command: "true" });
      return { script: client.execDetachedOptions[0]!.argv[2]! };
    };

    const off = await build(false);
    const on = await build(true);

    expect(off.script).not.toContain("/api/compute/completion");
    expect(off.script).not.toContain("NADI_EXIT_CODE");
    // ANTI-VACUITY: the admitted run through the same wrapper DOES carry it,
    // so the assertions above are about the gate and not about the fixture.
    expect(on.script).toContain("/api/compute/completion");
    // And the difference is EXACTLY the callback: strip it from the admitted
    // script and the two scripts are the same bytes.
    const withoutCallback = normalize(on.script).replace(
      /; NADI_EXIT_CODE="\$\(cat [^)]+\)"; \{ curl .+? ; \} >\/dev\/null 2>&1/,
      "",
    );
    expect(withoutCallback).toBe(normalize(off.script));
  });

  it("bounds the curl tightly when the callback DELAYS the only completion signal", async () => {
    // Cloudflare's ordering: the callback sits inside the wrapper, before the
    // `exit` that closes the log stream `waitForProcessExit` is waiting on — so
    // its latency lands inside `exec()`'s 10s foreground window. 25s there makes
    // a sub-second command report as "backgrounded".
    const backend = new FakeComputeBackend() as FakeComputeBackend & {
      completionCallbackDelaysCompletion?: boolean;
    };
    backend.completionCallbackDelaysCompletion = true;
    const service = new ThreadComputeService({
      backend,
      store: createMemoryComputeStore(),
      config: CONFIG,
      environmentId: "thread_test",
      threadId: "thread_abc",
      env: {},
      appBaseUrl: "https://nadi.example.com",
      betterAuthSecret: SECRET,
      setAlarm: async () => {},
      now: () => 1_000,
    });

    await service.exec({ command: "true" });
    const fragment = backend.startProcessCalls[0]?.completionCallback;
    expect(fragment).toContain(
      "curl -sf --connect-timeout 3 -m 5 -X POST https://nadi.example.com/api/compute/completion",
    );
    // The generous bound belongs to the OTHER ordering only.
    expect(fragment).not.toContain("-m 25");
  });

  it("carries stdin through the refusal path instead of silently dropping it", async () => {
    // I7. Sprites has no `waitForProcessExit`, so `exec()`'s
    // refusal-to-background falls to `runExecToCompletion` -> `execRun` ->
    // `runCommand`, whose input carried no `stdin`. Reachable on any
    // sprites deployment whose APP_BASE_URL is loopback or unset — which is
    // what wrangler.jsonc ships — and a dropped stdin changes what the
    // command READS, so it is a wrong answer rather than a missing feature.
    const backend = new FakeComputeBackend();
    const service = new ThreadComputeService({
      backend,
      store: createMemoryComputeStore(),
      config: CONFIG,
      environmentId: "thread_test",
      threadId: "thread_abc",
      env: {},
      setAlarm: async () => {},
      now: () => 1_000,
      // The other door into the same synchronous path (an attached subagent, or
      // background work switched off) — no provider misconfiguration needed.
      backgroundLongRunningExec: false,
    });

    await service.exec({ command: "cat", stdin: "payload-from-the-model\n" });

    expect(backend.runCommandCalls).toHaveLength(1);
    expect(backend.runCommandCalls[0]?.stdin).toBe("payload-from-the-model\n");
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

  // Was "when the service has no threadId". `threadId` became a REQUIRED dep in
  // P3 (it routes every back-call), so "omitted entirely" is now a compile
  // error and cannot be tested. The empty string is what survives of that
  // scenario, and it still matters: the token is scoped to
  // `(threadId, processId)`, so one minted for `""` would aim the sandbox's
  // push at a thread DO named `""`.
  it("omits the callback when the service's threadId is empty", async () => {
    const backend = new FakeComputeBackend();
    const store = createMemoryComputeStore();
    const service = new ThreadComputeService({
      backend,
      store,
      config: CONFIG,
      environmentId: "thread_test",
      threadId: "",
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
      // `true` completes so fast it would resolve to "exited" via the
      // NORMAL background-eligible path too (sprites' own settle-quickly
      // poll never even observes "running") — so this assertion alone would
      // pass with the guard removed. It stays as a cheap smoke check; the
      // guard's actual teeth are the warning below and, for a command that
      // genuinely WOULD have backgrounded, the dedicated test further down
      // ("...carries a REAL exit code and output").
      expect(result.status).not.toBe("backgrounded");
      expect(warnings).toContainEqual([
        "compute.background_refused_no_callback",
        { threadId: "thread_abc", provider: "sprites", reason: "no_base_url", entryPoint: "exec" },
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
      // See the sibling "no reachable callback" test's comment: `true` alone
      // would not catch a removed guard. The "genuinely WOULD have
      // backgrounded" case further down covers both reasons through the
      // same code path (`shouldRefuseBackgrounding`), so it is not repeated
      // here per-reason.
      expect(result.status).not.toBe("backgrounded");
      expect(warnings).toContainEqual([
        "compute.background_refused_no_callback",
        {
          threadId: "thread_abc",
          provider: "sprites",
          reason: "unreachable_base_url",
          entryPoint: "exec",
        },
      ]);
    } finally {
      log.warn = originalWarn;
    }
  });

  it("refuses a command that genuinely would have backgrounded, and the synchronous fallback carries a REAL exit code and output", async () => {
    const { backend } = createFakeSpritesBackend();
    const store = createMemoryComputeStore();
    const now = { value: 1_000 };
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
        // No appBaseUrl — refusal active.
        setAlarm: async () => {},
        now: () => now.value,
        execForegroundTimeoutMs: 1,
        execForegroundPollIntervalMs: 1,
        sleep: async (ms) => void (now.value += ms),
      });

      // `sleep` only ever "backgrounds" through the WRAPPER path
      // (`SpritesComputeBackend.startProcess` / `FakeSpritesClient.runWrapper`,
      // which special-cases it as a session with no rc file — see the "does
      // NOT refuse..." test above, which proves exactly that for the
      // mock/fake backend). WITHOUT the refusal this command would come back
      // `running` and then `backgrounded`, exactly like that sibling test.
      // WITH the refusal, `exec()` takes the synchronous `runCommand` path
      // instead, which never builds a wrapper at all — and `FakeSpritesClient`'s
      // plain-script interpreter, like the Cloudflare fake's equivalent
      // `exec`, does not model `sleep` outside the wrapper. So the REAL,
      // distinguishing proof that this genuinely ran through the synchronous
      // fallback (not a stub returning a fabricated success) is exit 127
      // with a "command not found" stderr — a broken guard would instead
      // return `status: "backgrounded"` with no such output at all.
      const result = await service.exec({ command: "sleep 5 && echo done" });

      expect(result.status).toBe("exited");
      if (result.status === "exited") {
        expect(result.exitCode).toBe(127);
        expect(result.stderrPreview).toContain("sleep");
      }
      expect(warnings).toContainEqual([
        "compute.background_refused_no_callback",
        { threadId: "thread_abc", provider: "sprites", reason: "no_base_url", entryPoint: "exec" },
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

  it("execStart refuses (throws) rather than silently backgrounding a remote provider with no callback", async () => {
    // `execStart`'s whole contract is "start it and do not wait" — it has no
    // synchronous fallback to offer, so unlike `exec()` it must make the
    // refusal OBSERVABLE (a thrown error a caller can catch and act on)
    // rather than silently starting a process nothing will ever hear back
    // from.
    const { backend } = createFakeSpritesBackend();
    const store = createMemoryComputeStore();
    const service = new ThreadComputeService({
      backend,
      store,
      config: CONFIG,
      environmentId: "thread_test",
      threadId: "thread_abc",
      env: {},
      // No appBaseUrl — sprites is a remote provider, so execStart must
      // refuse rather than start an unwatchable background process.
      setAlarm: async () => {},
      now: () => 1_000,
    });

    await expect(service.execStart({ command: "sleep 60" })).rejects.toThrow(ComputeError);
    await expect(service.execStart({ command: "sleep 60" })).rejects.toMatchObject({
      code: "compute_unavailable",
      message: expect.stringContaining("background_unavailable_no_callback"),
    });
  });

  it("execStart still backgrounds normally once a real callback is available", async () => {
    const { backend } = createFakeSpritesBackend();
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

    const started = await service.execStart({ command: "sleep 60" });
    expect(started.status).toBe("running");
  });

  it("execStart never refuses on the in-process mock/fake backend", async () => {
    const backend = new FakeComputeBackend();
    const store = createMemoryComputeStore();
    const service = new ThreadComputeService({
      backend,
      store,
      config: CONFIG,
      environmentId: "thread_test",
      threadId: "thread_abc",
      env: {},
      setAlarm: async () => {},
      now: () => 1_000,
    });

    const started = await service.execStart({ command: "sleep 60" });
    expect(started.status).toBe("running");
  });
});
