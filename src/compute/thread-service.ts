import type {
  BackendProcessReference,
  BackendReference,
  ComputeBackend,
  ComputeSpec,
  ProcessStatus,
  StopMode,
} from "./backend";
import type { ComputeResourceProfile, EffectiveComputeConfig } from "./types";
import type { ComputeProcessRecord, ThreadComputeStore } from "./thread-store";
import { RECLAIM_MIN_IDLE_MS, type ComputeQuotaGate } from "./container-quota";
import { ComputeError } from "./errors";
import { log } from "../log";
import {
  grepOutputChunks,
  readOutputChunks,
  tailOutputChunks,
  type OutputChunkView,
} from "./output";
import { canAddWatcher, classifyWatcher, nextWakeAt, type WatcherRow } from "./watchers";
import { recordComputeEvent, type ComputeEvent } from "./observability";
import { deriveCompletionSecret, signCompletionToken } from "./completion-token";
import { ComputeFileService } from "./file-service";
import { readGeneration, writeGeneration } from "./generation";
import type { WorkLedgerSink } from "../agent/work-ledger-store";
import type { WorkspaceCleanliness } from "./workspace-cleanliness";
import {
  PROCESS_STALE_AFTER_MS,
  UNKNOWN_GENERATION,
  type CurrentGeneration,
  type WorkOutcome,
  type WorkRow,
} from "../agent/work-ledger";
import { mimeFromFilename } from "../artifacts/mime";

// The root every runtime is provisioned with; a relative-path exec must resolve
// here (same root the file tools guard), not the sandbox's boot dir (/root).
export const WORKSPACE_ROOT = "/workspace" as const;

export const DEFAULT_WATCH_TIMEOUT_MS = 300_000;
export const EXEC_FOREGROUND_TIMEOUT_MS = 10_000;
const EXEC_FOREGROUND_POLL_INTERVAL_MS = 500;
export const MIN_STEP_WATCH_AGE_MS = 10_000;
export const MAX_WATCH_TIMEOUT_MS = 3_600_000;
const REMINDER_TAIL_MAX_LINES = 20;
const REMINDER_TAIL_MAX_BYTES = 2_048;

/**
 * How long one caller waits on an acquisition before giving up on ITS call.
 *
 * Each backend call is already individually bounded (30s per sprites request,
 * 120s for a create); it is their SUM that is not, which is how a single `exec`
 * once ran 154s. An unbounded tool call is the worst shape for that: the model
 * blocks with nothing to report and the user sees a dead thread.
 *
 * NOT a cancellation, and this is the point: the acquisition keeps running
 * (nothing here can cancel a backend call) and stays in `acquisitionInFlight`,
 * so the retry the model makes attaches to the SAME provisioning instead of
 * asking an already-slow backend for a second sandbox.
 *
 * Historically this also had to beat the ~30s `blockConcurrencyWhile` budget,
 * because overrunning it CANCELLED the callback and reset the whole Durable
 * Object. Acquisition no longer runs inside that gate (see `ensureRuntime`), so
 * that constraint is gone — the value stays 25s only because bounding the tool
 * call is worth doing on its own.
 */
const ACQUIRE_DEADLINE_MS = 25_000;

/**
 * The wrapper's OWN curl timeout (`-m`) on its completion callback — NOT the
 * budget for the process it just ran. `/api/compute/completion`'s teardown
 * (`reapProcess` -> `releaseWorkHold` -> a `runCommand` with a 10s timeout)
 * is awaited before the HTTP response returns, so the server side can
 * legitimately take up to ~10s to answer. 10s here would then race the
 * server's own budget and lose intermittently; 25s leaves real margin. Do not
 * "tidy" this back down without re-reading that teardown path.
 *
 * Applies only to a backend whose completion is observable INDEPENDENTLY of
 * the callback — sprites, which writes its rc sentinel before the callback
 * runs. See {@link COMPLETION_CALLBACK_BLOCKING_CURL_BOUNDS} for the other
 * ordering, and `ComputeBackend.completionCallbackDelaysCompletion` for why
 * the two cannot share one number.
 */
const COMPLETION_CALLBACK_CURL_TIMEOUT_SECS = 25;

/**
 * The `curl` bounds used instead when the callback runs BEFORE completion is
 * observable at all (`ComputeBackend.completionCallbackDelaysCompletion` —
 * today Cloudflare, whose completion signal IS the wrapper's exit).
 *
 * Tight, and deliberately so: every second the callback spends here is added
 * to the command's observed runtime, inside `exec()`'s 10s foreground window
 * ({@link EXEC_FOREGROUND_TIMEOUT_MS}) polled every 500ms. At 25s a
 * sub-second command would report as `"backgrounded"` whenever the origin is
 * slow to answer from inside a container. The generous 25s above exists to
 * cover the server's hold-release teardown, and that teardown does not exist
 * on this side: a backend with no `workHold` makes `releaseWorkHold` return
 * immediately.
 *
 * `--connect-timeout` separately, not just `-m`: a black-holed origin
 * otherwise burns the whole `-m` budget on the TCP handshake alone.
 */
const COMPLETION_CALLBACK_BLOCKING_CURL_BOUNDS = {
  connectTimeoutSecs: 3,
  maxTimeSecs: 5,
} as const;

/**
 * Extra margin added on top of whatever budget actually bounds a process's
 * completion callback's `exp`, covering the time between the wrapper's rc
 * write and the callback's own delivery (queueing, a slow `curl`, clock
 * skew). Not itself a timeout on anything.
 */
const COMPLETION_TOKEN_MARGIN_MS = 300_000;

/**
 * Hostnames a completion callback fired from INSIDE a remote sandbox can
 * never reach, even though `APP_BASE_URL` is non-empty for local dev
 * (`http://localhost:8787`) — a curl from inside a sprite container never
 * routes back to the developer's own laptop.
 *
 * FAILS OPEN on an unparsable origin: `APP_BASE_URL` is also better-auth's
 * `baseURL` (`src/auth/options.ts`), so a genuinely malformed value already
 * breaks the deployment elsewhere, louder, and treating "could not tell" as
 * "unreachable" would silently disable backgrounding for a typo that has
 * nothing to do with sandboxes at all. The caller logs the parse failure
 * separately so it is not silent either way.
 *
 * Checks BOTH the bracketed and bare spellings of the IPv6 loopback:
 * `new URL("http://[::1]:8787").hostname` is `"[::1]"`, brackets included —
 * a bare `"::1"` comparison alone never matches a real URL's hostname.
 */
function isUnreachableFromASandbox(origin: string): boolean {
  let hostname: string;
  try {
    hostname = new URL(origin).hostname;
  } catch {
    return false;
  }
  return (
    hostname === "localhost" ||
    hostname === "127.0.0.1" ||
    hostname === "::1" ||
    hostname === "[::1]" ||
    hostname === "0.0.0.0"
  );
}

/** Whether `value` parses as a URL at all — see `isUnreachableFromASandbox`'s fail-open doc. */
function isParseableUrl(value: string): boolean {
  try {
    new URL(value);
    return true;
  } catch {
    return false;
  }
}

/**
 * Rejects with `onTimeout()` if `promise` has not settled within `ms`.
 *
 * The timer is cleared on both settle paths: a pending timer keeps the isolate's
 * timer queue non-empty for no reason, and on Workers that is not free.
 */
function withDeadline<T>(promise: Promise<T>, ms: number, onTimeout: () => Error): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(onTimeout()), ms);
    promise.then(
      (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      (error: unknown) => {
        clearTimeout(timer);
        reject(error instanceof Error ? error : new Error(String(error)));
      },
    );
  });
}

const LOST_COMPUTE_REMINDER =
  "The previous thread compute environment was missing from its backend, so stale local state was cleared. Future commands will run in a fresh environment. Files and running processes from the missing environment are gone, but previous command output remains available in this conversation.";
const EXPIRED_RECOVERY_REMINDER =
  "The previous repository-work compute environment reached the end of its recovery window and was destroyed. The next command will run in a fresh sandbox.";
const RESTORED_COMPUTE_REMINDER =
  "The previous repository-work compute environment was restored. Continue from the retained checkout if relevant.";

export type ExecCompletedResult = {
  ok: true;
  status: "exited" | "failed" | "stopped";
  processId: string;
  command: string;
  label: string | null;
  exitCode?: number;
  timedOut?: boolean;
  timeoutMs?: number;
  message?: string;
  stdoutPreview: string;
  stderrPreview: string;
  stdoutTruncated: boolean;
  stderrTruncated: boolean;
};

export type ExecBackgroundedResult = {
  ok: true;
  status: "backgrounded";
  processId: string;
  command: string;
  label: string | null;
  watching: boolean;
  watcherDeadlineAt?: number;
  backgroundedAfterMs: number;
  stdoutPreview: string;
  stderrPreview: string;
  stdoutTruncated: boolean;
  stderrTruncated: boolean;
  message: string;
  nextActions: string[];
};

export type ExecResult = ExecCompletedResult | ExecBackgroundedResult;

type StoreLifecycle = Pick<
  ThreadComputeStore,
  | "getComputeState"
  | "markAcquiring"
  | "markActive"
  | "markReleasing"
  | "markRecoverable"
  | "markDiscarding"
  | "markAbsent"
  | "touchLastUsed"
  | "markError"
  | "setResourceProfile"
  | "setGeneration"
>;

export interface ThreadComputeStoreLike extends StoreLifecycle {
  createProcess(process: ComputeProcessRecord): void;
  updateProcess(id: string, patch: Partial<ComputeProcessRecord>): void;
  listProcesses(limit: number): ComputeProcessRecord[];
  getProcess(id: string): ComputeProcessRecord | null;
  appendOutput(input: {
    processId: string;
    stream: "stdout" | "stderr";
    text: string;
    now: number;
  }): void;
  listOutputChunks(processId: string, stream?: "stdout" | "stderr"): OutputChunkView[];
  upsertWatcher(row: WatcherRow): void;
  deleteWatcher(processId: string): void;
  listWatchers(): WatcherRow[];
  countWatchers(): number;
  markProcessAutoWatched(processId: string, now: number): void;
  wasProcessAutoWatched(processId: string): boolean;
}

interface ThreadComputeServiceDeps {
  backend: ComputeBackend;
  store: ThreadComputeStoreLike;
  config: EffectiveComputeConfig;
  environmentId: string;
  /** The owning thread's id, for retention-decision logging only — never used
   *  for compute addressing (that's `environmentId`, a workbench identifier). */
  threadId?: string;
  env: Record<string, string>;
  /**
   * The origin the sandbox wrapper's own completion callback posts back to
   * (Worker `Env.APP_BASE_URL`) and the Worker secret that callback's token
   * is HMAC-signed with (`Env.BETTER_AUTH_SECRET`, via
   * `deriveCompletionSecret`). Deliberately NOT part of `env` above — that is
   * the SANDBOX's own exec environment (workbench vars, the minted
   * `GH_TOKEN`), a completely different scope despite the similarly-named
   * field.
   *
   * Absent `appBaseUrl` means "mint no completion callback for this
   * process": see `buildCompletionCallback`. A callback aimed at nowhere is
   * silent loss, so the safe default is no callback at all — the process
   * still runs and is still tracked by the existing poll/watcher path, it
   * just never gets the PUSH half of completion delivery.
   */
  appBaseUrl?: string;
  betterAuthSecret?: string;
  setAlarm: (timestamp: number) => Promise<void>;
  clearAlarm?: () => Promise<void>;
  now: () => number;
  deliverSystemReminder?: (
    body: string,
    mode: "deferred" | "proactive",
    options?: {
      watcher?: {
        title: string;
        command: string;
        processId: string;
        /** The ledger terminal's outcome — `fault` once the reaper delivers. */
        outcome: WorkOutcome;
        exitCode: number | null;
        outputTail?: string;
      };
    },
  ) => Promise<void>;
  /** Test seam; defaults to {@link ACQUIRE_DEADLINE_MS}. */
  acquireDeadlineMs?: number;
  attachedRuntime?: BackendReference;
  hasBlockingWork?: () => Promise<boolean>;
  supportsProcessMonitor?: boolean;
  backgroundLongRunningExec?: boolean;
  execForegroundTimeoutMs?: number;
  execForegroundPollIntervalMs?: number;
  sleep?: (ms: number) => Promise<void>;
  recordEvent?: (event: ComputeEvent) => void;
  /**
   * Cloudflare-only per-workspace container cap. Undefined for every other
   * provider (see resolveComputeService) — never gate Daytona on the ledger.
   */
  quota?: ComputeQuotaGate;
  /**
   * Liveness reporting for the background work ledger. Optional: the compute
   * service works without it (older tests construct no ledger), but without it
   * the reaper has nothing to enforce against.
   */
  workLedger?: WorkLedgerSink;
  /**
   * The background work ledger's next sweep horizon (`nextSweepAt` over the
   * open rows), or null when no work is open. Folded into this service's
   * single `armAlarm` min-fold so the reaper PIGGYBACKS the thread's one
   * alarm. It must never arm its own: the scheduler is cancel-then-set on a
   * single id, so a second arm point overwrites this one.
   */
  getWorkHorizon?: () => number | null;
  /**
   * Clears the "workspace verified clean" bit. Called from EVERY entry point
   * that can mutate the sandbox filesystem. Err broad: a command passed to
   * exec can always write, so all exec paths call it. Missing a path leaves a
   * stale clean bit and destroys work; a spurious call only preserves a
   * sandbox that did not need preserving.
   */
  markSandboxDirty?: () => Promise<void>;
  /**
   * True only when `confirm_work_saved` verified the workspace clean and
   * nothing has written to the sandbox since (see `markSandboxDirty`). Read
   * by `resolveIdleDisposition` to skip the git probe entirely.
   */
  isSandboxDeclaredClean?: () => Promise<boolean>;
  /**
   * Runs the git-based cleanliness probe (Task 2) against the live sandbox.
   * Absent — as in tests that construct a service without it — defaults to
   * `probe_failed` in `resolveIdleDisposition`, which preserves. Never treat
   * an absent probe as `clean`.
   */
  probeWorkspaceCleanliness?: () => Promise<WorkspaceCleanliness>;
  /**
   * Fired once, after a genuinely FRESH acquire (`recovery === null` — the
   * same condition that gates `markAcquiring`) — never on a recovery restore,
   * where `/workspace` comes back populated from backup and re-cloning would
   * clobber it. A failure here must not fail the acquisition: caught and
   * logged, the sandbox is still usable and the model can prepare it itself.
   */
  onFreshRuntimeAcquired?: () => Promise<void>;
}

export class ThreadComputeService {
  private acquisitionInFlight: Promise<BackendReference> | undefined;
  private workspaceRootEnsured = false;
  private fileServiceInstance: ComputeFileService | undefined;
  private armCount = 0;
  /**
   * Cached per instance: `deriveCompletionSecret` is a SHA-256 over the
   * Worker secret, and every process start would otherwise pay it again.
   */
  private completionSecretPromise: Promise<string> | undefined;
  /** Guards `compute.app_base_url_unparsable` to at most once per instance. */
  private loggedUnparsableAppBaseUrl = false;

  constructor(private readonly deps: ThreadComputeServiceDeps) {}

  /**
   * How many alarms this service instance has actually armed (i.e. how many
   * times `armAlarm` reached `setAlarm`). The alarm callback samples this
   * around its tick to learn the FACT "something armed" rather than inferring
   * it from "the tick returned without throwing" — a tick can throw after
   * arming, and can return without arming at all. That fact is what gates the
   * callback's fallback re-arm: the scheduler is cancel-then-set on one id, so
   * a fallback that fires while the tick already armed does not add an alarm,
   * it REPLACES a nearer one.
   */
  alarmArmCount(): number {
    return this.armCount;
  }

  /**
   * The sandbox generation nonce for the current container, or null when
   * unknown. Persisted in the compute store (see `ThreadComputeStore.setGeneration`)
   * — NOT an instance field — because `ThreadComputeService` is constructed
   * fresh on every `resolveComputeService(...)` call; an in-memory field would
   * always read back null for any instance other than the one that wrote it,
   * making the reaper permanently blind (Task 5 review finding #1) and every
   * new instance's first touch would overwrite a healthy container's nonce
   * (finding #2).
   */
  getGeneration(): string | null {
    return this.deps.store.getComputeState()?.generation ?? null;
  }

  /**
   * The same state as `getGeneration`, but with "the container answered and its
   * nonce is gone" kept DISTINCT from "unknown". This is what the reaper
   * classifies on: a live container missing its nonce IS a reset, and it is the
   * only evidence a real Cloudflare reset leaves — after a destroy/OOM the SDK
   * silently hands back a working container on the same sandbox id, so nothing
   * throws `SandboxNotFound`, the DO never re-provisions, and the nonce never
   * diverges (verified live, 2026-07-16).
   *
   * A store read only. The PROBE that produces `absent` runs on the poll path
   * (`pollDueWatchers`) and on the registration path (`refreshGeneration`),
   * never here — the reaper must never make a call that can block or throw on a
   * dead sandbox. Pinned by "the sweep's generation source never touches the
   * backend" in `watcher-fault.test.ts`.
   */
  getGenerationView(): CurrentGeneration {
    const state = this.deps.store.getComputeState();
    if (state?.generation != null) return { kind: "known", nonce: state.generation };
    if (state?.generationAbsentAt != null)
      return { kind: "absent", observedAt: state.generationAbsentAt };
    return { kind: "unknown" };
  }

  /**
   * Probe the LIVE container's nonce and record what it says, so a caller about
   * to register work stamps its row against what the container actually carries
   * rather than a possibly-stale advertisement.
   *
   * Why registration is the right place. The only other probe fires on a poll
   * FAILURE, so a wipe that happens while no watcher is armed used to be
   * witnessed by nothing: the store kept advertising the stale nonce, work
   * registered afterwards inherited it, and its polls SUCCEEDED against the
   * healthy (wiped) container. At the first later `absent` probe — possibly hours
   * later — the restore writes a fresh nonce and every row still carrying the
   * stale one faults `sandbox_reset` although its work is intact. Registration is
   * the moment the row's generation is DECIDED, so it is the one moment that can
   * tell "registered before the wipe" from "registered after it but before anyone
   * noticed".
   *
   * CONSTRAINT — this must never be reached from the reaper's CLASSIFICATION
   * path: `runWorkLedgerSweep`, `getCurrentGeneration`, `hasBlockingWork`, and
   * everything they await (including `backfillLegacySubagentRuns`). That path
   * stays backend-free by design — a call that can block on a dead sandbox there
   * stalls the alarm and wedges the whole Durable Object, which is the production
   * incident this design exists to fix. Its generation source is
   * `getGenerationView`, a pure store read, and must stay one.
   *
   * NOT "the alarm tick is backend-free" — that claim is false and was never
   * true: `runComputeTick` -> `pollDueWatchers` calls `getProcessStatus` and, on
   * failure, `probeAndRecordGeneration`. The tick's backend calls are each
   * individually guarded; classification is not, and must never need to be.
   * Registration is safe for the same reason as the tick — it runs inside a model
   * turn that is already calling the backend.
   *
   * Pinned by "the sweep's generation source never touches the backend"
   * (`watcher-fault.test.ts`) and, end to end over a real DO, by "the sweep makes
   * no backend call" (`work-ledger.integration.test.ts`).
   *
   * Never provisions: with no live container there is no nonce to question, and
   * a fresh provision writes a known one anyway. Non-throwing by construction —
   * `readGeneration` answers-or-degrades and the restore swallows its own write
   * failure — so a registration path can await it without a guard.
   */
  async refreshGeneration(): Promise<void> {
    const state = this.deps.store.getComputeState();
    if (state?.status !== "active" || !state.runtimeRef) return;
    await this.probeAndRecordGeneration(state.runtimeRef, this.deps.now());
  }

  /**
   * One probe, and the only writer of the store's generation outside a
   * provision. Shared verbatim by the poll-failure path and the registration
   * path so the two can never drift into disagreeing about what a probe means.
   *
   * `found` and `unreadable` only ever RECORD. In particular an unreadable probe
   * learns nothing and must never license a write: it is the case where the
   * container may be perfectly healthy and merely unreachable, and writing on it
   * is what would overwrite a live nonce and mass-fault every open row. It
   * records `unknown` rather than leaving the stale nonce standing — the
   * registering row then carries `UNKNOWN_GENERATION`, which `classifyWork`
   * never reads as a mismatch, so an ambiguous probe degrades to `no_liveness`
   * instead of inventing a reset.
   */
  private async probeAndRecordGeneration(runtime: BackendReference, now: number): Promise<void> {
    const probe = await readGeneration(this.deps.backend, runtime);
    if (probe.kind === "absent") {
      await this.restoreGenerationAfterWipe(runtime, now);
      return;
    }
    this.deps.store.setGeneration(
      probe.kind === "found" ? { kind: "known", nonce: probe.nonce } : { kind: "unknown" },
      now,
    );
  }

  /**
   * The ledger row a watched process registers. One helper because both process
   * registration sites (`backgroundResult`, `execWatch`) owe the ledger the
   * IDENTICAL row, and two copies of it drift — the generation stamp especially,
   * which is the whole reset signal.
   *
   * Callers must `await refreshGeneration()` first: `getGeneration()` below is a
   * store read, and stamping it against an unprobed advertisement is the stale
   * window this design closes.
   */
  private buildProcessWorkRow(processId: string, now: number): WorkRow {
    return {
      id: processId,
      kind: "process",
      startedAt: now,
      lastAliveAt: now,
      staleAfterMs: PROCESS_STALE_AFTER_MS,
      deadlineAt: now + MAX_WATCH_TIMEOUT_MS,
      generation: this.getGeneration() ?? UNKNOWN_GENERATION,
      terminal: null,
      deliveredAt: null,
    };
  }

  /**
   * Re-fold the alarm for a ledger row registered by a caller OUTSIDE this
   * service. Both process registrations (`execStart`, `execWatch`) already
   * arm immediately after registering, so the new row's horizon is honored on
   * the spot; a subagent row is registered by the agent (`spawnSubagent`),
   * which has no other way to reach the fold. Without this the parent's alarm
   * stays at the idle-release time and a wedged child's first classification is
   * delayed by up to `idleTimeoutMs` instead of the intended 3 minutes.
   *
   * This is NOT a second arm site — it is a way to REACH the one that exists.
   * `armAlarm` min-folds `getWorkHorizon` and remains the sole caller of
   * `setAlarm`; adding an independent `scheduleEviction` here would cancel the
   * fold's alarm rather than add to it.
   */
  async refreshWorkAlarm(): Promise<void> {
    await this.armAlarm(this.computeReleaseAt());
  }

  /**
   * Optimistic file operations sharing this thread's runtime resolution and
   * lease. Every call acquires/restores compute and refreshes the lease the
   * same way exec does.
   */
  get files(): ComputeFileService {
    if (!this.fileServiceInstance) {
      this.fileServiceInstance = new ComputeFileService({
        backend: this.deps.backend,
        readMaxBytes: this.deps.config.limits.readMaxBytes,
        readMaxLines: this.deps.config.limits.readMaxLines,
        maxDownloadBytes: this.deps.config.limits.maxDownloadBytes,
        maxUploadBytes: this.deps.config.limits.maxUploadBytes,
        provider: this.deps.backend.id,
        profile: this.deps.config.resourceProfile,
        resolveRuntime: () => this.ensureRuntime(),
        refreshLease: async () => {
          this.deps.store.touchLastUsed(this.deps.now());
          await this.refreshRelease(this.deps.config.idleTimeoutMs);
        },
        markDirty: async () => {
          await this.deps.markSandboxDirty?.();
        },
        now: this.deps.now,
        ...(this.deps.recordEvent ? { recordEvent: this.deps.recordEvent } : {}),
      });
    }
    return this.fileServiceInstance;
  }

  /**
   * Start a process and return immediately without waiting — the explicit
   * "background it, do not wait" entry point (today reached only from
   * debug/diagnostic RPCs; see `exec()` for the model-facing implicit
   * foreground-then-maybe-background flow, which has its OWN refusal check
   * because it can fall back to running synchronously instead).
   *
   * `execStart` has no synchronous fallback to offer — the caller explicitly
   * asked not to wait, so silently blocking here would violate the contract
   * just as badly as silently losing the completion would. So when no
   * completion callback can be delivered for a REMOTE provider
   * (`shouldRefuseBackgrounding()`), this THROWS instead of starting a process
   * nothing will ever hear back from — the same "answer or throw" convention
   * every other failure path on this method already uses (a backend error
   * from `startAndStoreProcess` propagates the same way). A caller wrapped in
   * `compute-tools.ts`'s per-tool `try { ... } catch { return toErrorResult(error) }`
   * surfaces this as `{ ok: false, error: "compute_unavailable", detail: "..." }`
   * — the existing shape, not a new one — with a `detail` message the model
   * can act on by running the command in the foreground itself instead.
   */
  async execStart(input: {
    command: string;
    cwd?: string | undefined;
    env?: Record<string, string> | undefined;
    stdin?: string | undefined;
    timeoutMs?: number | undefined;
    label?: string | undefined;
  }) {
    await this.deps.markSandboxDirty?.();
    if (this.shouldRefuseBackgrounding()) {
      log.warn("compute.background_refused_no_callback", {
        threadId: this.deps.threadId,
        provider: this.deps.backend.id,
        reason: this.completionCallbackUnavailableReason(),
        entryPoint: "execStart",
      });
      throw new ComputeError(
        "compute_unavailable",
        "background_unavailable_no_callback: background work is unavailable in this deployment; run the command in the foreground instead.",
      );
    }
    return this.startAndStoreProcess(input);
  }

  async exec(input: {
    command: string;
    cwd?: string | undefined;
    env?: Record<string, string> | undefined;
    stdin?: string | undefined;
    timeoutMs?: number | undefined;
    label?: string | undefined;
  }): Promise<ExecResult> {
    await this.deps.markSandboxDirty?.();
    const refuseReason = this.shouldRefuseBackgrounding()
      ? this.completionCallbackUnavailableReason()
      : null;
    if (this.deps.backgroundLongRunningExec === false || refuseReason !== null) {
      if (refuseReason !== null) {
        // A callback to nowhere is silent loss, and for a remote provider the
        // poll/watcher path is not a substitute (see `shouldRefuseBackgrounding`).
        // Logged exactly HERE, once per exec call that this actually changes
        // the behavior of — never in `buildCompletionCallback`, which runs for
        // every process start including ones (mock/fake, execStart) this rule
        // never applies to.
        log.warn("compute.background_refused_no_callback", {
          threadId: this.deps.threadId,
          provider: this.deps.backend.id,
          reason: refuseReason,
          entryPoint: "exec",
        });
      }
      if (this.deps.backend.waitForProcessExit) {
        return this.runCancellableExecToCompletion(input);
      }
      return this.runExecToCompletion(input);
    }
    const started = await this.startAndStoreProcess(input);
    if (started.status !== "running") {
      return this.buildCompletedExecResult(started.processId, input.command, input.label ?? null);
    }
    return this.waitForForegroundOrBackground(
      started.processId,
      input.command,
      input.label ?? null,
      started.timeoutMs,
    );
  }

  /**
   * Run a command to completion, letting the provider report the exit.
   *
   * Use this over `execStart` + `execStatus` polling for any command you cannot
   * bound to a few seconds. On Cloudflare a long-lived poll loop over getProcess
   * wedges (~10 minutes, then throws) at every cadence tried; `execRun` asks for
   * no status at all. `exec()`'s bounded 10s foreground poll is fine and stays
   * as it is. Backends without `runCommand` fall back to start-and-poll.
   */
  async execRun(input: {
    command: string;
    cwd?: string | undefined;
    env?: Record<string, string> | undefined;
    stdin?: string | undefined;
    timeoutMs?: number | undefined;
    label?: string | undefined;
  }): Promise<{
    processId: string;
    status: ExecCompletedResult["status"];
    exitCode: number;
    stdout: string;
    stderr: string;
    /**
     * True when `stdout` is a TAIL, not the whole thing. The start-and-poll
     * fallback below returns `buildPreview`'s tail (200 lines / 32KB), and a
     * cut that lands on a line boundary is INDISTINGUISHABLE from complete
     * output — every surviving line can parse cleanly while the dropped head
     * held the only evidence of a problem. Callers that make a decision from
     * stdout must treat this as "I did not see the output".
     */
    stdoutTruncated: boolean;
  }> {
    await this.deps.markSandboxDirty?.();
    const backend = this.deps.backend;
    if (!backend.runCommand) {
      // Unreachable today: every real remote provider (sprites, cloudflare,
      // daytona) implements `runCommand`, so this branch only ever runs for
      // the in-process mock/fake backends, which `execStart`'s refusal check
      // never applies to. Left un-special-cased deliberately — if a future
      // backend without `runCommand` lands here, `execStart` already refuses
      // correctly on its own; do not duplicate that check.
      const started = await this.execStart(input);
      await this.waitForForegroundOrBackground(
        started.processId,
        input.command,
        input.label ?? null,
        started.timeoutMs,
        true,
      );
      const process = this.requireProcess(started.processId);
      const preview = this.buildPreview(started.processId);
      if (process.status === "running")
        throw new ComputeError("provider_transient", "exec_run_did_not_complete");
      return {
        processId: started.processId,
        status: process.status as ExecCompletedResult["status"],
        exitCode: process.exitCode ?? -1,
        stdout: preview.stdoutPreview,
        stderr: preview.stderrPreview,
        // `preview.stdoutTruncated` is NOT enough on its own: `tailOutputChunks`
        // deliberately leaves `limited` false when it merely clips to
        // `tailMaxLines`, because for a preview a line window is the thing the
        // caller asked for. That clip is exactly the cut that lands on a line
        // boundary — the one a parser cannot detect — so the line count has to
        // be compared explicitly here.
        stdoutTruncated:
          preview.stdoutTruncated || process.stdoutLines > this.deps.config.limits.tailMaxLines,
      };
    }

    const runtime = await this.ensureRuntime();
    const cwd = input.cwd ?? WORKSPACE_ROOT;
    const timeoutMs = Math.min(
      input.timeoutMs ?? this.deps.config.maxProcessRuntimeMs,
      this.deps.config.maxProcessRuntimeMs,
    );
    const result = await backend.runCommand(runtime, {
      command: input.command,
      cwd,
      ...(input.env === undefined ? {} : { env: input.env }),
      // Carried, never dropped: this is the path `exec()` falls to when it
      // refuses to background (a sprites deployment whose `APP_BASE_URL` is
      // loopback or unset — what `wrangler.jsonc` ships — reaches it for every
      // exec), and a silently dropped stdin changes what the command READS.
      ...(input.stdin === undefined ? {} : { stdin: input.stdin }),
      timeoutMs,
    });

    // Record it like any other process so the thread's process list, output
    // retention, and the UI see a completed run rather than nothing at all.
    const processId = `proc_${crypto.randomUUID()}`;
    const now = this.deps.now();
    this.deps.store.createProcess({
      id: processId,
      backendProcessRef: null,
      command: input.command,
      cwd,
      status: result.status,
      exitCode: result.exitCode,
      startedAt: now,
      finishedAt: now,
      stdoutBytes: 0,
      stderrBytes: 0,
      stdoutLines: 0,
      stderrLines: 0,
      // Carries the backend's own verdict, so the stored row (and the UI that
      // reads it) shows the cut too, not just the value returned here.
      outputTruncated: result.stdoutTruncated === true,
      label: input.label ?? null,
    });
    if (result.stdout) this.appendOutput(processId, "stdout", result.stdout);
    if (result.stderr) this.appendOutput(processId, "stderr", result.stderr);
    this.deps.store.touchLastUsed(now);
    await this.refreshRelease(this.deps.config.idleTimeoutMs);
    this.emitCommandEvent("command_completion", processId, "success");
    return {
      processId,
      status: result.status,
      exitCode: result.exitCode,
      stdout: result.stdout,
      stderr: result.stderr,
      // `runCommand` returns the command's complete stdout, and the tail limits
      // apply to what gets STORED for the UI rather than to what is returned
      // here — UNLESS the backend positively reports a cut it can see. The
      // sprites provider does, from the server's 64KiB fast-path replay cap;
      // every other backend leaves this absent and reads as complete.
      stdoutTruncated: result.stdoutTruncated === true,
    };
  }

  private async runExecToCompletion(input: {
    command: string;
    cwd?: string | undefined;
    env?: Record<string, string> | undefined;
    stdin?: string | undefined;
    timeoutMs?: number | undefined;
    label?: string | undefined;
  }): Promise<ExecCompletedResult> {
    const run = await this.execRun(input);
    return {
      ok: true,
      status: run.status,
      processId: run.processId,
      command: input.command,
      label: input.label ?? null,
      exitCode: run.exitCode,
      stdoutPreview: run.stdout,
      stderrPreview: run.stderr,
      stdoutTruncated: run.stdoutTruncated,
      stderrTruncated: false,
    };
  }

  /**
   * Synchronous exec for providers that can wait on a process stream instead
   * of polling status. Unlike `runCommand`, this creates a process record
   * immediately, so turn cancellation can terminate it while it is running.
   */
  private async runCancellableExecToCompletion(input: {
    command: string;
    cwd?: string | undefined;
    env?: Record<string, string> | undefined;
    stdin?: string | undefined;
    timeoutMs?: number | undefined;
    label?: string | undefined;
  }): Promise<ExecCompletedResult> {
    const started = await this.startAndStoreProcess(input);
    if (started.status !== "running") {
      return this.buildCompletedExecResult(started.processId, input.command, input.label ?? null);
    }

    const process = this.requireProcessReference(started.processId);
    const runtime = await this.ensureRuntime();
    const status = await this.deps.backend.waitForProcessExit!(runtime, process.backendProcessRef, {
      stdout: async (chunk) => this.appendOutput(started.processId, "stdout", chunk),
      stderr: async (chunk) => this.appendOutput(started.processId, "stderr", chunk),
    });
    this.updateTerminalProcess(started.processId, status);
    this.emitCommandEvent("command_completion", started.processId, "success");
    return this.buildCompletedExecResult(started.processId, input.command, input.label ?? null);
  }

  async ensureRuntimeReference(): Promise<BackendReference> {
    return this.ensureRuntime();
  }

  /**
   * Whether this service's backend actually reads
   * `StartProcessInput.completionCallback` into what it runs. Derived from
   * the backend's OWN declared `consumesCompletionCallback` capability
   * (`ComputeBackend`'s doc) rather than a provider-id allow-list: an id list
   * drifts the moment a provider gains or loses the wrapper (today sprites
   * and Cloudflare both have one; Daytona does not and is being phased out
   * over its network-allowlist behavior), and self-corrects nothing when that
   * happens. A list did exactly that once already in review — see this
   * file's git history.
   */
  private consumesCompletionCallback(): boolean {
    return this.deps.backend.consumesCompletionCallback === true;
  }

  /**
   * Whether background work is ADMITTED for this thread at all — the
   * `BACKGROUND_WORK_ENABLED` deployment flag and its workspace override,
   * threaded in by `sandboxHostDeps()` as `supportsProcessMonitor` (SubAgent
   * turns the same dep off for its own reasons; both mean "no watcher will
   * ever be registered here").
   *
   * `buildCompletionCallback` is gated on this so that with background work
   * OFF the emitted command is BYTE-IDENTICAL to the pre-push one. That is
   * not cosmetic: with the flag off nothing registers a ledger row or a
   * watcher, so a callback that did fire would be reporting a completion
   * `reportProcessCompletion` rejects anyway (`background_work_disabled`) —
   * and there is no watcher left to correct a mis-report. On a backend where
   * the callback also DELAYS the only completion signal
   * (`completionCallbackDelaysCompletion`, i.e. the production default
   * provider) an ungated callback re-times every command in a deployment that
   * asked for none of this.
   *
   * Defaults to admitted when the dep is absent, exactly as
   * {@link supportsProcessMonitor} does: direct-construction tests wire
   * neither, and flipping their default would silently drop the callback from
   * every one of them.
   */
  private backgroundWorkAdmitted(): boolean {
    return this.supportsProcessMonitor();
  }

  /**
   * Why `buildCompletionCallback` cannot produce a fragment right now, or
   * `null` when it can. Synchronous — every input is already known without
   * minting a token — so `exec()` can consult it to decide whether a process
   * may background at all, without paying for a signature it would throw
   * away. The one side effect (a log line) fires at most once per instance;
   * see `loggedUnparsableAppBaseUrl`.
   *
   * The loopback check is scoped to `consumesCompletionCallback()`
   * deliberately: local dev sets `APP_BASE_URL` to `http://localhost:8787`,
   * which is non-empty but unreachable from inside a real sandbox — and
   * irrelevant for a backend that never reads the callback at all (today:
   * `"mock"`/`"fake"`, and `"daytona"`, which is not expected to grow one).
   * For `"cloudflare"` and `"sprites"` (both consume it) this loopback check
   * is exactly what makes local dev against a REAL Cloudflare or sprites
   * container refuse to background — see the ACCEPTED CONSEQUENCE note on
   * `ComputeBackend.consumesCompletionCallback`.
   */
  private completionCallbackUnavailableReason():
    | "no_base_url"
    | "no_secret"
    | "no_thread_id"
    | "unreachable_base_url"
    | null {
    if (!this.deps.appBaseUrl) return "no_base_url";
    if (!this.deps.betterAuthSecret) return "no_secret";
    if (!this.deps.threadId) return "no_thread_id";
    if (!this.consumesCompletionCallback()) return null;
    if (!isParseableUrl(this.deps.appBaseUrl)) {
      // Fails OPEN, not closed: `APP_BASE_URL` is also better-auth's own
      // `baseURL` (`src/auth/options.ts`), so a genuinely malformed value
      // already breaks the deployment elsewhere, louder — treating "could
      // not tell" as "unreachable" here would just silently disable
      // backgrounding on top of that, for a typo unrelated to sandboxes.
      if (!this.loggedUnparsableAppBaseUrl) {
        this.loggedUnparsableAppBaseUrl = true;
        log.warn("compute.app_base_url_unparsable", {
          threadId: this.deps.threadId,
          appBaseUrl: this.deps.appBaseUrl,
        });
      }
      return null;
    }
    if (isUnreachableFromASandbox(this.deps.appBaseUrl)) return "unreachable_base_url";
    return null;
  }

  /**
   * A callback to nowhere is silent loss, and for a backend that actually
   * consumes the callback the poll/watcher path is not a substitute for it
   * (see the module's design doc) — so a process that cannot carry a
   * completion callback must not be allowed to background at all; it runs to
   * completion synchronously instead. Never true for a backend that never
   * reads `completionCallback` in the first place (`consumesCompletionCallback()`
   * false): forcing THAT backend synchronous would change test/dev/Cloudflare
   * behavior that has nothing to do with this mechanism.
   */
  private shouldRefuseBackgrounding(): boolean {
    return this.consumesCompletionCallback() && this.completionCallbackUnavailableReason() !== null;
  }

  /**
   * A complete shell fragment a backend's wrapper can run to report this
   * process's exit code back to `/api/compute/completion` — see
   * `StartProcessInput.completionCallback`. Returns `undefined` (never
   * throws) when there is nowhere to call back to or nothing to sign with, so
   * the caller degrades to "no callback" rather than failing the process
   * start. Logging is `exec()`'s job (`shouldRefuseBackgrounding`'s caller) —
   * this method fires for EVERY process start, including `execStart`/`execRun`
   * and every direct-construction test, so logging here would be pure noise
   * for the common "no `appBaseUrl` configured at all" case that changes
   * nothing for `"mock"`/`"fake"`.
   *
   * Returns `undefined` unconditionally when background work is not admitted
   * for this thread ({@link backgroundWorkAdmitted}) — the flag-off command
   * must be byte-identical to the pre-push one. Checked FIRST, before any
   * origin/secret reasoning, because none of that is relevant to a deployment
   * that asked for no background work.
   *
   * The fragment references `$NADI_EXIT_CODE` rather than embedding a value:
   * this method runs BEFORE the process exists, let alone finishes, so only
   * the backend — reading back whatever it uses to track completion (sprites'
   * rc sentinel) — can supply the actual recorded value. See
   * `buildSpritesWrapper`'s doc for the consuming side of that contract.
   *
   * `exp` covers whichever is larger of the watch window or this PROCESS's
   * own timeout: `maxProcessRuntimeMs` is configurable up to 24h, and a
   * token that only covered the (1h05) watch window would expire out from
   * under a long-running build, turning its eventual completion into a 401 —
   * the exact silent-loss failure this mechanism exists to remove, just
   * relocated to the token instead of the callback.
   */
  private async buildCompletionCallback(
    processId: string,
    timeoutMs: number,
  ): Promise<string | undefined> {
    if (!this.backgroundWorkAdmitted()) return undefined;
    if (this.completionCallbackUnavailableReason() !== null) return undefined;
    const appBaseUrl = this.deps.appBaseUrl!;
    const betterAuthSecret = this.deps.betterAuthSecret!;
    const threadId = this.deps.threadId!;
    if (!this.completionSecretPromise) {
      this.completionSecretPromise = deriveCompletionSecret(betterAuthSecret);
    }
    const secret = await this.completionSecretPromise;
    const token = await signCompletionToken(secret, {
      threadId,
      processId,
      exp: this.deps.now() + Math.max(timeoutMs, MAX_WATCH_TIMEOUT_MS) + COMPLETION_TOKEN_MARGIN_MS,
    });
    const origin = appBaseUrl.replace(/\/$/, "");
    // Two orderings, two budgets — see both constants' docs. Never one number.
    const bounds = this.deps.backend.completionCallbackDelaysCompletion
      ? `--connect-timeout ${COMPLETION_CALLBACK_BLOCKING_CURL_BOUNDS.connectTimeoutSecs} ` +
        `-m ${COMPLETION_CALLBACK_BLOCKING_CURL_BOUNDS.maxTimeSecs}`
      : `-m ${COMPLETION_CALLBACK_CURL_TIMEOUT_SECS}`;
    return (
      `curl -sf ${bounds} -X POST ${origin}/api/compute/completion ` +
      `-H 'Authorization: Bearer ${token}' -H 'Content-Type: application/json' ` +
      `-d "{\\"processId\\":\\"${processId}\\",\\"exitCode\\":$NADI_EXIT_CODE}"`
    );
  }

  private async startAndStoreProcess(input: {
    command: string;
    cwd?: string | undefined;
    env?: Record<string, string> | undefined;
    stdin?: string | undefined;
    timeoutMs?: number | undefined;
    label?: string | undefined;
  }) {
    let runtime = await this.ensureRuntime();
    const processId = `proc_${crypto.randomUUID()}`;
    // Default to the workspace root so a relative path means the same thing to
    // exec and to read_file; an explicitly-passed cwd is never overridden.
    const cwd = input.cwd ?? WORKSPACE_ROOT;
    const timeoutMs = Math.min(
      input.timeoutMs ?? this.deps.config.maxProcessRuntimeMs,
      this.deps.config.maxProcessRuntimeMs,
    );
    const completionCallback = await this.buildCompletionCallback(processId, timeoutMs);
    const startInput = {
      command: input.command,
      cwd,
      ...(input.env === undefined ? {} : { env: input.env }),
      ...(input.stdin === undefined ? {} : { stdin: input.stdin }),
      ...(completionCallback === undefined ? {} : { completionCallback }),
      timeoutMs,
    };
    let result;
    try {
      result = await this.deps.backend.startProcess(runtime, startInput);
    } catch (error) {
      if (!this.isRuntimeMissing(error) || this.deps.attachedRuntime) throw error;
      await this.markRuntimeMissing();
      runtime = await this.ensureRuntime();
      result = await this.deps.backend.startProcess(runtime, startInput);
    }
    const now = this.deps.now();
    this.deps.store.createProcess({
      id: processId,
      backendProcessRef: result.process,
      command: input.command,
      cwd,
      status: result.status,
      exitCode: result.exitCode ?? null,
      startedAt: now,
      finishedAt: result.status === "running" ? null : now,
      stdoutBytes: 0,
      stderrBytes: 0,
      stdoutLines: 0,
      stderrLines: 0,
      outputTruncated: false,
      label: input.label ?? null,
    });
    if (result.stdout) this.appendOutput(processId, "stdout", result.stdout);
    if (result.stderr) this.appendOutput(processId, "stderr", result.stderr);
    this.deps.store.touchLastUsed(now);
    await this.refreshRelease(this.deps.config.idleTimeoutMs);
    if (result.status !== "running") {
      this.emitCommandEvent("command_completion", processId, "success");
    }
    return {
      processId,
      label: input.label ?? null,
      command: input.command,
      status: result.status,
      exitCode: result.exitCode,
      stdoutPreview: result.stdout ?? "",
      stderrPreview: result.stderr ?? "",
      timeoutMs: startInput.timeoutMs,
    };
  }

  private appendOutput(processId: string, stream: "stdout" | "stderr", text: string): void {
    this.deps.store.appendOutput({ processId, stream, text, now: this.deps.now() });
    const process = this.deps.store.getProcess(processId);
    if (!process) return;
    const bytes = new TextEncoder().encode(text).byteLength;
    const lines = text.split(/(?<=\n)/g).filter(Boolean).length;
    this.deps.store.updateProcess(processId, {
      [stream === "stdout" ? "stdoutBytes" : "stderrBytes"]:
        (stream === "stdout" ? process.stdoutBytes : process.stderrBytes) + bytes,
      [stream === "stdout" ? "stdoutLines" : "stderrLines"]:
        (stream === "stdout" ? process.stdoutLines : process.stderrLines) + lines,
    });
  }

  private buildPreview(processId: string) {
    const stdout = tailOutputChunks(this.deps.store.listOutputChunks(processId, "stdout"), {
      stream: "stdout",
      maxLines: this.deps.config.limits.tailMaxLines,
      maxBytes: this.deps.config.limits.tailMaxBytes,
    });
    const stderr = tailOutputChunks(this.deps.store.listOutputChunks(processId, "stderr"), {
      stream: "stderr",
      maxLines: this.deps.config.limits.tailMaxLines,
      maxBytes: this.deps.config.limits.tailMaxBytes,
    });
    const process = this.deps.store.getProcess(processId);
    return {
      stdoutPreview: stdout.text,
      stderrPreview: stderr.text,
      stdoutTruncated: stdout.limited || process?.outputTruncated === true,
      stderrTruncated: stderr.limited || process?.outputTruncated === true,
    };
  }

  private buildCompletedExecResult(
    processId: string,
    command: string,
    label: string | null,
  ): ExecCompletedResult {
    const process = this.requireProcess(processId);
    if (process.status === "running") throw new Error("compute_process_still_running");
    return {
      ok: true,
      status: process.status,
      processId,
      command,
      label,
      ...(process.exitCode === null ? {} : { exitCode: process.exitCode }),
      ...this.buildPreview(processId),
    };
  }

  private async waitForForegroundOrBackground(
    processId: string,
    command: string,
    label: string | null,
    processTimeoutMs: number,
    waitToCompletion = false,
  ): Promise<ExecResult> {
    const foregroundTimeoutMs = Math.min(
      waitToCompletion
        ? processTimeoutMs
        : (this.deps.execForegroundTimeoutMs ?? EXEC_FOREGROUND_TIMEOUT_MS),
      processTimeoutMs,
    );
    const intervalMs = Math.max(
      1,
      this.deps.execForegroundPollIntervalMs ?? EXEC_FOREGROUND_POLL_INTERVAL_MS,
    );
    const startedAt = this.deps.now();
    while (this.deps.now() - startedAt < foregroundTimeoutMs) {
      await (this.deps.sleep ?? defaultSleep)(
        Math.min(intervalMs, foregroundTimeoutMs - (this.deps.now() - startedAt)),
      );
      await this.refreshProcessStatus(processId);
      if (this.requireProcess(processId).status !== "running") {
        return this.buildCompletedExecResult(processId, command, label);
      }
    }
    if (foregroundTimeoutMs >= processTimeoutMs) {
      await this.stopTimedOutProcess(processId, processTimeoutMs);
      return {
        ...this.buildCompletedExecResult(processId, command, label),
        timedOut: true,
        timeoutMs: processTimeoutMs,
        message: `Command timed out after ${processTimeoutMs}ms and was stopped.`,
      };
    }
    return this.backgroundResult(processId, command, label, foregroundTimeoutMs);
  }

  private async stopTimedOutProcess(processId: string, timeoutMs: number): Promise<void> {
    const process = this.requireProcessReference(processId);
    const runtime = await this.ensureRuntime();
    const result = await this.deps.backend.stopProcess(runtime, process.backendProcessRef, "kill");
    this.updateTerminalProcess(processId, result);
    this.emitCommandEvent("command_timeout", processId, "success", timeoutMs);
  }

  private async backgroundResult(
    processId: string,
    command: string,
    label: string | null,
    timeoutMs: number,
  ): Promise<ExecBackgroundedResult> {
    const preview = this.buildPreview(processId);
    if (this.deps.backgroundLongRunningExec === false || !this.supportsProcessMonitor()) {
      return this.backgroundWithoutWatcher(processId, command, label, timeoutMs, preview);
    }
    if (!canAddWatcher(this.deps.store.countWatchers())) {
      return this.backgroundWithoutWatcher(processId, command, label, timeoutMs, preview);
    }
    // Before `now`, so the row's window opens no earlier than what the probe
    // observed — a restore's `observedAt` must not land after this row started.
    await this.refreshGeneration();
    const now = this.deps.now();
    const deadlineAt = now + DEFAULT_WATCH_TIMEOUT_MS;
    this.deps.store.upsertWatcher({
      processId,
      deadlineAt,
      pollIntervalMs: this.deps.config.monitorPollIntervalMs,
      nextPollAt: now + this.deps.config.monitorPollIntervalMs,
      label,
      createdAt: now,
    });
    this.deps.store.markProcessAutoWatched(processId, now);
    this.deps.workLedger?.register(this.buildProcessWorkRow(processId, now));
    await this.armAlarm(this.computeReleaseAt());
    return {
      ok: true,
      status: "backgrounded",
      processId,
      command,
      label,
      watching: true,
      watcherDeadlineAt: deadlineAt,
      backgroundedAfterMs: timeoutMs,
      ...preview,
      message:
        "Command is running in the background. A message will be delivered to this thread when it finishes. If you have nothing else to do, end your turn now — do not poll for completion.",
      nextActions: ["Use exec_stop to cancel."],
    };
  }

  private backgroundWithoutWatcher(
    processId: string,
    command: string,
    label: string | null,
    timeoutMs: number,
    preview: ReturnType<ThreadComputeService["buildPreview"]>,
  ): ExecBackgroundedResult {
    return {
      ok: true,
      status: "backgrounded",
      processId,
      command,
      label,
      watching: false,
      backgroundedAfterMs: timeoutMs,
      ...preview,
      message: "Command is still running in the background without a watcher.",
      nextActions: ["Use exec_output to inspect it.", "Use exec_stop to cancel."],
    };
  }

  async execOutput(input: {
    processId: string;
    // `"both"` is intentionally unsupported here: stdout and stderr are stored
    // as independently-indexed chunk streams with no reliable global ordering,
    // so a combined tail cannot be assembled correctly. Callers wanting both
    // use `exec_output_grep` (which merges by line number) instead.
    stream?: "stdout" | "stderr" | undefined;
    maxLines?: number | undefined;
    maxBytes?: number | undefined;
  }) {
    const process = this.deps.store.getProcess(input.processId);
    if (!process) throw new Error("sandbox_process_not_found");
    // Ask the provider, don't trust the store. The stored status only advances
    // when a watcher poll runs, so a process that has already exited reads
    // "running" here until one happens to fire — and a caller polling this for
    // completion would wait forever. (This is ONE call, not a loop: a long
    // in-invocation poll loop over the provider's status is what wedged
    // run_skill_script — see ComputeBackend.runCommand.)
    await this.refreshProcessStatusBestEffort(input.processId);
    // execStatus refreshes output as part of a terminal transition; a process
    // still running has no such moment, so pull its incremental output here.
    if ((this.deps.store.getProcess(input.processId) ?? process).status === "running") {
      await this.refreshProcessOutput(input.processId);
    }
    const fresh = this.deps.store.getProcess(input.processId) ?? process;
    const stream = input.stream === "stderr" ? "stderr" : "stdout";
    const chunks = this.deps.store.listOutputChunks(input.processId, stream);
    const tail = tailOutputChunks(chunks, {
      stream,
      maxLines: Math.min(
        input.maxLines ?? this.deps.config.limits.tailMaxLines,
        this.deps.config.limits.tailMaxLines,
      ),
      maxBytes: Math.min(
        input.maxBytes ?? this.deps.config.limits.tailMaxBytes,
        this.deps.config.limits.tailMaxBytes,
      ),
    });
    return {
      processId: input.processId,
      label: fresh.label,
      command: fresh.command,
      status: fresh.status,
      exitCode: fresh.exitCode ?? undefined,
      stream,
      ...(fresh.status === "running"
        ? {
            guidance:
              "This process is running and watched — a completion message will be delivered to this thread automatically. Do not call exec_output in a loop; end your turn if you have nothing else to do.",
          }
        : {}),
      ...this.withRetention(tail, input.processId),
    };
  }

  /**
   * Refresh a process's status from the provider, tolerating failure: a status
   * read must never turn a successful output read into an error. A transient
   * provider hiccup just leaves the caller with the stored status.
   */
  private async refreshProcessStatusBestEffort(processId: string): Promise<void> {
    try {
      await this.execStatus({ processId });
    } catch (error) {
      log.warn("compute.status_refresh_failed", { processId, error: String(error) });
    }
  }

  /**
   * Backend-fresh process status. `execOutput`'s status comes from the store,
   * which only advances via watcher polls — a caller polling for completion
   * without a watcher (the skill-script runner) would wait forever. This asks
   * the provider directly while the stored status is still "running". It never
   * provisions: a missing or released runtime just reports the stored status,
   * so a poll loop drains fast instead of resurrecting a dead sandbox.
   */
  async execStatus(input: {
    processId: string;
  }): Promise<{ processId: string; status: string; exitCode?: number | undefined }> {
    const process = this.deps.store.getProcess(input.processId);
    if (!process) throw new Error("sandbox_process_not_found");
    const state = this.deps.store.getComputeState();
    if (
      process.status === "running" &&
      state?.status === "active" &&
      state.runtimeRef &&
      process.backendProcessRef
    ) {
      try {
        const status = await this.deps.backend.getProcessStatus(
          state.runtimeRef,
          process.backendProcessRef,
        );
        if (status.status !== process.status || status.exitCode !== undefined) {
          this.updateTerminalProcess(input.processId, status);
          if (status.status !== "running")
            this.emitCommandEvent("command_completion", input.processId, "success");
        }
        if (status.status !== "running") await this.refreshProcessOutput(input.processId);
      } catch (error) {
        if (!this.isRuntimeMissing(error)) throw error;
        await this.markRuntimeMissing();
      }
    }
    const fresh = this.deps.store.getProcess(input.processId) ?? process;
    return {
      processId: input.processId,
      status: fresh.status,
      exitCode: fresh.exitCode ?? undefined,
    };
  }

  /**
   * Surface `limitReason:"retention"` when a served slice is not otherwise
   * limited but the process's stored output was capped by the retention limits,
   * so the model knows earlier output was dropped, not just this window.
   */
  private withRetention<T extends { limited: boolean; limitReason?: string }>(
    result: T,
    processId: string,
  ): T {
    if (result.limited) return result;
    const process = this.deps.store.getProcess(processId);
    if (process?.outputTruncated) {
      return { ...result, limited: true, limitReason: "retention" } as T;
    }
    return result;
  }

  async execOutputGrep(input: {
    processId: string;
    pattern: string;
    stream?: "stdout" | "stderr" | "both" | undefined;
    caseSensitive?: boolean | undefined;
    contextLines?: number | undefined;
  }) {
    await this.refreshProcessOutput(input.processId);
    const result = grepOutputChunks(this.deps.store.listOutputChunks(input.processId), {
      pattern: input.pattern,
      stream: input.stream ?? "both",
      caseSensitive: input.caseSensitive ?? false,
      contextLines: Math.min(input.contextLines ?? 0, this.deps.config.limits.grepMaxContextLines),
      maxMatches: this.deps.config.limits.grepMaxMatches,
      maxReturnedLines: this.deps.config.limits.grepMaxReturnedLines,
      maxBytes: this.deps.config.limits.grepMaxBytes,
    });
    return this.withRetention(result, input.processId);
  }

  async execOutputRead(input: {
    processId: string;
    stream?: "stdout" | "stderr" | undefined;
    startLine?: number | undefined;
    endLine?: number | undefined;
    startByte?: number | undefined;
    maxLines?: number | undefined;
    maxBytes?: number | undefined;
  }) {
    await this.cleanupExpiredRecovery(this.deps.now());
    await this.refreshProcessOutput(input.processId);
    const stream = input.stream === "stderr" ? "stderr" : "stdout";
    const result = readOutputChunks(this.deps.store.listOutputChunks(input.processId, stream), {
      stream,
      ...(input.startLine === undefined ? {} : { startLine: input.startLine }),
      ...(input.endLine === undefined ? {} : { endLine: input.endLine }),
      ...(input.startByte === undefined ? {} : { startByte: input.startByte }),
      maxLines: Math.min(
        input.maxLines ?? this.deps.config.limits.readMaxLines,
        this.deps.config.limits.readMaxLines,
      ),
      maxBytes: this.deps.config.limits.readMaxBytes,
    });
    return this.withRetention(result, input.processId);
  }

  async execList(
    input: {
      status?: ComputeProcessRecord["status"] | "all" | undefined;
      limit?: number | undefined;
    } = {},
  ) {
    await this.cleanupExpiredRecovery(this.deps.now());
    // Preserve legacy Daytona behavior: default 20, hard cap 100.
    const limit = Math.min(input.limit ?? 20, 100);
    const processes = this.deps.store.listProcesses(1_000);
    const status = input.status;
    const filtered =
      status && status !== "all"
        ? processes.filter((process) => process.status === status)
        : processes;
    return { ok: true, processes: filtered.slice(0, limit) };
  }

  async execStop(input: { processId: string; mode?: StopMode | undefined }) {
    const process = this.requireProcessReference(input.processId);
    const runtime = await this.ensureRuntime();
    const result = await this.deps.backend.stopProcess(
      runtime,
      process.backendProcessRef,
      input.mode ?? "terminate",
    );
    this.updateTerminalProcess(input.processId, result);
    // Same funnel as the exit path: a stop settles the process and drops its
    // watcher, so the row must close here or the reaper faults settled work.
    // Covers THIS path only. `stopAllRunningProcesses` (turn cancel) does not
    // route through here — it goes straight to `stopProcessDirect` to stay out
    // of `ensureRuntime` entirely — and closes its rows itself.
    //
    // `stopped`, never `exited`: a kill is not a clean exit, and now that
    // terminals are delivered the outcome is what the model is TOLD. Reporting
    // a cancelled process as exited would have it read a truncated output tail
    // as the finished result.
    const stoppedAt = this.deps.now();
    const closed = this.deps.workLedger?.terminalize(input.processId, {
      outcome: "stopped",
      reason: "process_stopped",
      at: stoppedAt,
      detail: `process stopped (${input.mode ?? "terminate"})`,
    });
    // This path delivers NOTHING, deliberately: the person (or the model) who
    // asked for the stop does not need a card telling them it stopped. Stamping
    // the delivery gate is how that intent is DECLARED — an undelivered terminal
    // means "someone still owes the model a notification", and without this the
    // sweep would start injecting a "stopped" card that never existed before.
    //
    // Only when this call actually closed the row: a false return means the
    // reaper closed it first and may still genuinely owe its delivery.
    if (closed) this.deps.workLedger?.markDelivered(input.processId, stoppedAt);
    this.deps.store.deleteWatcher(input.processId);
    this.emitCommandEvent("command_stop", input.processId, "success");
    return { ok: true, processId: input.processId, ...result };
  }

  /**
   * Stop every still-running process in this thread's sandbox.
   *
   * Called when a turn is CANCELLED. Aborting the model loop only stops the
   * assistant talking — anything it launched keeps burning the container until
   * it exits or hits maxProcessRuntimeMs, which is not what "stop" means to the
   * person who pressed it.
   *
   * Never provisions: with no active runtime there is nothing to stop, and
   * resurrecting a released sandbox to kill processes that died with it would be
   * absurd. Best-effort per process — one failure must not strand the rest — and
   * a process we cannot stop still loses its watcher, so a dead process can't
   * keep the thread polling forever.
   *
   * Uses `stopProcessDirect`, not `execStop`, for the reason `reapProcess`
   * documents at length: `execStop` routes through `ensureRuntime`, which on a
   * freshly constructed service mkdirs the workspace root first and can provision
   * a whole sandbox. `status === "active"` is our bookkeeping, not evidence the
   * container answers. Stakes are lower here than in the sweep — a human is
   * present and the sandbox answered seconds ago — but the hazard is the same: a
   * teardown path must never block on the backend it exists to stop touching.
   */
  async stopAllRunningProcesses(
    mode: StopMode = "terminate",
  ): Promise<{ stopped: string[]; failed: string[] }> {
    const state = this.deps.store.getComputeState();
    if (state?.status !== "active" || !state.runtimeRef) return { stopped: [], failed: [] };
    const running = this.deps.store
      .listProcesses(1_000)
      .filter((process) => process.status === "running" && process.backendProcessRef);
    const stopped: string[] = [];
    const failed: string[] = [];
    for (const process of running) {
      const ok = await this.stopProcessDirect(process.id, mode);
      (ok ? stopped : failed).push(process.id);
      // Both branches close the row. The success branch inherits `execStop`'s
      // funnel: a stop settles the process and drops its watcher, so the row
      // must close here or the reaper faults settled work. The FAILURE branch
      // closes it too — an open row left behind gets faulted `no_liveness` one
      // `PROCESS_STALE_AFTER_MS` (3x the watcher poll, 180s today)
      // later, which tells the model a process the USER cancelled "showed no
      // liveness signal". `stopped` either way: the user asked for a stop, and
      // reporting it as `exited` would have the model read a truncated output
      // tail as the finished result.
      const stoppedAt = this.deps.now();
      const closed = this.deps.workLedger?.terminalize(process.id, {
        outcome: "stopped",
        reason: "process_stopped",
        at: stoppedAt,
        detail: ok ? `process stopped (${mode})` : `process stop failed (${mode})`,
      });
      // Delivers NOTHING, deliberately: whoever asked for the stop does not need
      // a card telling them it stopped. Stamping the gate DECLARES that intent —
      // an undelivered terminal means "someone still owes the model a card", and
      // without this the sweep would start injecting a "stopped" card that never
      // existed before (and a later prune could never remove the row).
      //
      // Only when this call actually closed the row: a false return means the
      // reaper closed it first and may still genuinely owe its delivery.
      if (closed) this.deps.workLedger?.markDelivered(process.id, stoppedAt);
      this.deps.store.deleteWatcher(process.id);
    }
    return { stopped, failed };
  }

  /**
   * Stop one process by talking to the backend DIRECTLY — no `ensureRuntime`, so
   * no provisioning and no workspace-root mkdir.
   * Local bookkeeping only beyond that; the LEDGER is the caller's business,
   * because the two callers owe opposite things (the reaper's caller already
   * closed and delivered the row; turn-cancel must close it itself).
   *
   * Returns whether the process was actually stopped. Never throws: every caller
   * is best-effort by contract, and a throw could only cost a LATER process its
   * teardown in the same loop.
   */
  private async stopProcessDirect(processId: string, mode: StopMode): Promise<boolean> {
    const state = this.deps.store.getComputeState();
    if (state?.status !== "active" || !state.runtimeRef) return false;
    const process = this.deps.store.getProcess(processId);
    if (process?.status !== "running" || !process.backendProcessRef) return false;
    try {
      const result = await this.deps.backend.stopProcess(
        state.runtimeRef,
        process.backendProcessRef,
        mode,
      );
      this.updateTerminalProcess(processId, result);
      this.emitCommandEvent("command_stop", processId, "success");
      return true;
    } catch (error) {
      log.warn("compute.direct_stop_failed", { processId, error: String(error) });
      return false;
    }
  }

  async execWatch(input: { processId: string; timeoutMs?: number }) {
    if (!this.supportsProcessMonitor()) throw new Error("compute_process_monitor_unavailable");
    await this.refreshProcessStatus(input.processId);
    const process = this.requireProcess(input.processId);
    if (process.status !== "running")
      return { ok: true as const, watching: false, status: process.status };
    if (!canAddWatcher(this.deps.store.countWatchers()))
      throw new Error("compute_watcher_limit_reached");
    // Before `now`, for the same reason as `backgroundResult`. This path already
    // awaits `refreshProcessStatus`, so one more listing is in keeping.
    await this.refreshGeneration();
    const now = this.deps.now();
    const timeoutMs = Math.min(input.timeoutMs ?? DEFAULT_WATCH_TIMEOUT_MS, MAX_WATCH_TIMEOUT_MS);
    const watcher = {
      processId: input.processId,
      deadlineAt: now + timeoutMs,
      pollIntervalMs: this.deps.config.monitorPollIntervalMs,
      nextPollAt: now + this.deps.config.monitorPollIntervalMs,
      label: process.label,
      createdAt: now,
    };
    this.deps.store.upsertWatcher(watcher);
    this.deps.workLedger?.register(this.buildProcessWorkRow(input.processId, now));
    await this.armAlarm(this.computeReleaseAt());
    return { ok: true as const, watching: true, ...watcher };
  }

  async execUnwatch(input: { processId: string }) {
    const existed = this.deps.store
      .listWatchers()
      .some((watcher) => watcher.processId === input.processId);
    this.deps.store.deleteWatcher(input.processId);
    // Delete, don't terminalize. Unwatching is "stop telling me about this" —
    // the process keeps running, so no terminal is true and there is nothing
    // honest to deliver. An open row here would go unstamped (nothing polls an
    // unwatched process) and the reaper would fault it `no_liveness` one
    // `PROCESS_STALE_AFTER_MS`
    // later, reporting a live process as torn down.
    this.deps.workLedger?.deleteRow(input.processId);
    return { ok: true as const, unwatched: existed };
  }

  async execWatchList() {
    return { ok: true as const, watchers: this.listActiveWatchersView() };
  }

  /**
   * Read-only facts the reaper needs to DESCRIBE one process. Local store reads
   * only — no backend call — so it keeps the reaper's load-bearing property of
   * never blocking or throwing on a dead sandbox.
   */
  processReapView(processId: string): { label: string; command: string } | null {
    const process = this.deps.store.getProcess(processId);
    if (!process) return null;
    return {
      label: process.label && process.label.length > 0 ? process.label : process.command,
      command: process.command,
    };
  }

  /**
   * Reaper teardown for one process, best-effort by contract (the caller has
   * already written the terminal and notified the model).
   *
   * The watcher always goes — that is local, and a dead watcher left armed is
   * what kept the thread polling a corpse forever. The KILL is opt-in because
   * it is only honest for some reasons: a `watch_timeout` process is still
   * running by definition (the model was told exactly that), and a
   * `sandbox_reset` has no container left to kill.
   *
   * Never provisions, mirroring `stopAllRunningProcesses`: resurrecting a
   * released sandbox to kill a process that died with it would be absurd, and
   * would make the reaper block on the very backend it exists to not touch.
   *
   * Deliberately calls `backend.stopProcess` DIRECTLY instead of `execStop`.
   * `execStop` goes through `ensureRuntime`, which (a) runs inside
   * `serializeCreation` — wired to `ctx.blockConcurrencyWhile` — and (b) on a
   * freshly constructed sweep service issues a `createDirectory` to ensure the
   * workspace root. `status === "active"` is our bookkeeping, not evidence the
   * container answers: `no_liveness` fires precisely BECAUSE it stopped
   * answering. A hanging mkdir inside `blockConcurrencyWhile` wedges the whole
   * DO — the exact incident this design exists to fix. The stop and the hold
   * release below are the only remaining backend calls, both outside
   * `blockConcurrencyWhile`, and the caller's terminal is already written and
   * delivered before we get here.
   *
   * The hold release runs LAST, after the kill, not before: on sprites the
   * refresher keeps running inside the sandbox until it observes the rc
   * sentinel, so releasing before the signal lands risks the refresher
   * `PUT`-ing the hold back after our `DELETE` — releasing first would
   * resurrect exactly the leak this exists to close.
   */
  async reapProcess(processId: string, options: { kill: boolean }): Promise<void> {
    this.deps.store.deleteWatcher(processId);
    if (!options.kill) {
      // No container to kill (`sandbox_reset`) or the process is meant to
      // keep running (`watch_timeout`, reaper path) — either way, release is
      // still this call's job: `terminalizeWork` only reaches here on the
      // call that itself closed the ledger row, so nothing else will.
      await this.releaseWorkHold(processId);
      return;
    }
    // No ledger work follows the stop: the reaper's caller closed the row first
    // (terminal-first) and already told the model, so a terminalize here would
    // be a no-op against a spent gate. A failed stop is swallowed by the
    // primitive — best-effort by contract, and the watcher is already gone.
    await this.stopProcessDirect(processId, "terminate");
    await this.releaseWorkHold(processId);
  }

  /**
   * Record a process exit the compute layer never polled — the sandbox
   * wrapper pushed it straight to `reportProcessCompletion` (see
   * `think-thread-agent.ts`), so there is no `getProcessStatus` read to react
   * to the way `pollWatcher` has. Without this, the store keeps whatever it
   * last observed (typically `status:"running"`, `exitCode:null`) even after
   * the model has been told the process exited, so `execOutput`,
   * `exec_watch_list`, and the background-work dock would all disagree with the card
   * the model just received.
   *
   * Mirrors `pollWatcher`'s exited branch: stamp the process row
   * (`updateTerminalProcess`, same call the poll path makes right after its
   * backend read) then tear down exactly as a clean exit does —
   * `reapProcess(processId, { kill: false })`. `kill: false` because there is
   * nothing to kill: the wrapper is reporting a process that has already
   * exited on its own, not asking to stop one.
   *
   * NOT local-only, and the caller must budget for that: `reapProcess` ->
   * `releaseWorkHold` issues a REAL backend `runCommand` (bounded to 10s) and
   * this method awaits it. Since the only caller is
   * `reportProcessCompletion`, reached from the `/api/compute/completion`
   * route, that backend round-trip sits inside the HTTP handler and the
   * sandbox's own `curl` waits on it — which is why that `curl`'s timeout is
   * budgeted against this teardown (see
   * {@link COMPLETION_CALLBACK_CURL_TIMEOUT_SECS}) rather than being tight.
   *
   * Caller's job, not this method's: the work-ledger terminal and the model
   * notification. This only brings the compute layer's own view into
   * agreement with them.
   */
  async recordPushedExit(processId: string, exitCode: number): Promise<void> {
    this.updateTerminalProcess(processId, { status: "exited", exitCode });
    await this.reapProcess(processId, { kill: false });
  }

  /**
   * Best-effort hold release. Not optional hygiene on sprites: a held sprite
   * bills CPU and RAM, and `nativeIdleSuspend = true` makes
   * `resolveIdleDisposition` skip the inferred discards that would otherwise
   * reclaim it — so a wedged process with no release stays awake and billing.
   * Swallows everything: the terminal is the caller's obligation, not this.
   *
   * Looks up the row's OWN `backendProcessRef` — never a locally-derived id —
   * because only the provider knows what identifies a hold to itself; a
   * provider-neutral caller computing that id itself is the layering
   * violation `ComputeBackend.workHold`'s `*For(process)` shape exists to
   * rule out.
   *
   * Uses `runCommand`, not `startProcess`: going through `startProcess` would
   * wrap this one-shot `DELETE` in `buildSpritesWrapper` again, taking a NEW
   * hold and spawning another refresher just to run it.
   */
  private async releaseWorkHold(processId: string): Promise<void> {
    const hold = this.deps.backend.workHold;
    const runCommand = this.deps.backend.runCommand;
    if (!hold || !runCommand) return;
    try {
      const state = this.deps.store.getComputeState();
      if (state?.status !== "active" || !state.runtimeRef) return;
      const process = this.deps.store.getProcess(processId);
      if (!process?.backendProcessRef) return;
      await runCommand(state.runtimeRef, {
        command: hold.releaseFor(process.backendProcessRef),
        timeoutMs: 10_000,
      });
    } catch (error) {
      log.warn("compute.work_hold_release_failed", { processId, error: String(error) });
    }
  }

  /**
   * Earliest `nextPollAt` across live watchers, or null when none are watched.
   * Read-only over the local watcher store — no backend call, so it cannot
   * block or throw on a dead sandbox. Exists so the alarm callback's fallback
   * re-arm can cover open WORK, not just open ledger rows: a live watcher whose
   * ledger row is already closed (terminal-first closes the row before delivery,
   * and a delivery throw skips `deleteWatcher`) is invisible to `listOpen()`,
   * and would otherwise never be polled again.
   */
  nextWatcherWakeAt(): number | null {
    return nextWakeAt(this.deps.store.listWatchers(), null);
  }

  /**
   * Whether this process is still being watched. Read-only over the local
   * watcher store — no backend call, so the reaper's sweep may call it without
   * giving up its never-block-on-a-dead-sandbox property.
   *
   * Exists for the sweep's delivery retry: a live watcher is a SECOND writer
   * that owes the same row a notification, and it delivers the strictly better
   * message (with the process's output tail) and is the only one that can tear
   * the watcher down. So an owed row that still has one is not stranded — it is
   * spoken for, and the watcher's own `nextPollAt` keeps the alarm armed for it.
   */
  hasWatcher(processId: string): boolean {
    return this.deps.store.listWatchers().some((watcher) => watcher.processId === processId);
  }

  /**
   * The service's own clock. Exists so the alarm callback's fallback re-arm
   * can floor `nextWatcherWakeAt()` against the SAME "now" the service (and
   * its tests) use, instead of a real wall clock the tests don't control.
   */
  now(): number {
    return this.deps.now();
  }

  listActiveWatchersView() {
    return this.deps.store.listWatchers().map((watcher) => ({
      processId: watcher.processId,
      label: watcher.label,
      command: this.deps.store.getProcess(watcher.processId)?.command ?? "",
      createdAt: watcher.createdAt,
      deadlineAt: watcher.deadlineAt,
      // Locally-known status (no backend call) so callers — notably the
      // exec_output anti-poll refusal — can tell a still-running watched
      // process from one that has already reached a terminal state, without
      // paying for a provider round-trip just to decide whether to refuse.
      status: this.deps.store.getProcess(watcher.processId)?.status,
      outputTail: this.buildOutputTail(watcher.processId),
    }));
  }

  async autoWatchRunningProcesses(options?: { minAgeMs?: number }) {
    if (!this.supportsProcessMonitor()) return { attached: [] as string[] };
    const minAgeMs = options?.minAgeMs ?? 0;
    const attached: string[] = [];
    for (const process of this.deps.store.listProcesses(1_000)) {
      if (process.status !== "running" || this.deps.now() - process.startedAt < minAgeMs) continue;
      if (this.deps.store.wasProcessAutoWatched(process.id)) continue;
      if (this.deps.store.listWatchers().some((watcher) => watcher.processId === process.id))
        continue;
      if (!canAddWatcher(this.deps.store.countWatchers())) break;
      await this.execWatch({ processId: process.id });
      this.deps.store.markProcessAutoWatched(process.id, this.deps.now());
      attached.push(process.id);
    }
    return { attached };
  }

  async runComputeTick(): Promise<void> {
    const state = this.deps.store.getComputeState();
    // Every exit path below arms. `armAlarm` is the thread's ONLY arm site, so
    // an early return that skips it strands whatever else needs a wake — open
    // ledger rows outlive the container by design, and the reaper rides this
    // alarm. `armAlarm(null)` contributes no release time of its own: with no
    // watchers and no open work it min-folds to null and arms nothing, exactly
    // as these paths behaved before.
    if (!state || this.deps.attachedRuntime) {
      if (this.deps.attachedRuntime) await this.pollDueWatchers();
      await this.armAlarm(null);
      return;
    }
    const now = this.deps.now();
    if (await this.cleanupExpiredRecovery(now)) {
      await this.armAlarm(null);
      return;
    }
    if (state.status === "recoverable" || state.status === "absent" || state.status === "error") {
      await this.armAlarm(null);
      return;
    }
    // The ledger row's TTL is only a little longer than the idle timeout, but a
    // tick can leave the container ALIVE (watchers pending, or blocking work in
    // releaseIfIdle) without any other refresh path running. Keep the lease warm
    // on every tick that confirms the container is still active, or a live
    // container silently loses its row and defeats the workspace cap.
    if (this.deps.store.getComputeState()?.status === "active") await this.deps.quota?.refresh();
    await this.pollDueWatchers();
    if (this.deps.store.countWatchers() > 0) {
      await this.armAlarm(nextWakeAt(this.deps.store.listWatchers(), null));
      return;
    }
    await this.releaseIfIdle();
  }

  async releaseIfIdle(): Promise<void> {
    if (this.deps.attachedRuntime) return;
    const state = this.deps.store.getComputeState();
    if (!state?.runtimeRef || state.status !== "active") return;
    const now = this.deps.now();
    const idleFor = now - state.lastUsedAt;
    if (idleFor < this.deps.config.idleTimeoutMs) {
      await this.refreshRelease(this.deps.config.idleTimeoutMs - idleFor);
      return;
    }
    if ((await this.deps.hasBlockingWork?.()) === true) {
      await this.armAlarm(now + this.deps.config.idleTimeoutMs);
      return;
    }
    // Preserve by default; discard only on proof. Proof is either a verified
    // clean declaration, or git proving every repo clean. Anything else —
    // dirty, unversioned files, an unreachable probe — preserves, because
    // preserving costs a 24h snapshot and discarding wrongly costs work.
    const disposition = await this.resolveIdleDisposition();
    const runtime = state.runtimeRef;
    // Both of these must be readable from the catch: once `backend.release`
    // resolves the container is GONE, so rolling back to `active` there would
    // point local state at a destroyed sandbox — and `markActive` also nulls
    // `recoveryRef`, throwing away the only handle on the backup we just made.
    let released = false;
    let recovery: BackendReference | null = null;
    this.deps.store.markReleasing(now);
    try {
      recovery = await this.deps.backend.release(runtime, {
        disposition,
        ...(disposition === "recoverable" ? { recoveryTtlMs: this.deps.config.recoveryTtlMs } : {}),
      });
      released = true;
      if (disposition === "recoverable") {
        if (!recovery) throw new ComputeError("provider_transient", "missing_recovery_reference");
        const expiresAt = now + this.deps.config.recoveryTtlMs;
        this.deps.store.markRecoverable(recovery, now, expiresAt);
        await this.deps.quota?.release();
        this.stopRunningProcesses(now, {
          deliver: false,
          detail: "process stopped (environment released; files preserved)",
        });
        await this.armAlarm(expiresAt);
        this.emitLifecycleEvent("release", "active_to_recoverable", "success");
      } else {
        this.deps.store.markAbsent(now);
        await this.deps.quota?.release();
        this.stopRunningProcesses(now, {
          deliver: true,
          detail: "process stopped (environment discarded after inactivity)",
        });
        await this.clearLifecycleState();
        this.emitLifecycleEvent("discard", "active_to_absent", "success");
        await this.deps.deliverSystemReminder?.(
          "The thread compute environment was discarded after inactivity. Future commands will run in a fresh environment.",
          "deferred",
        );
      }
    } catch {
      if (released) {
        await this.settleDestroyedRuntime(recovery, now);
        return;
      }
      // The release itself failed, so the container is presumed still alive.
      this.deps.store.markActive(runtime, now);
      this.emitLifecycleEvent("release", "active_to_active", "failure");
      await this.armAlarm(now + this.deps.config.idleTimeoutMs);
    }
  }

  /**
   * Discard only on proof: a verified clean declaration, or git proving every
   * repo clean. An absent probe dep defaults to `probe_failed` — NOT to
   * `clean` — so a service constructed without the dep preserves rather than
   * destroys. That default is the safety net for every ambiguous or unknown
   * state; do not change it to an optional-chaining `clean` default.
   */
  private async resolveIdleDisposition(): Promise<"discard" | "recoverable"> {
    if ((await this.deps.isSandboxDeclaredClean?.()) === true) {
      log.info("compute.retention_decision", {
        threadId: this.deps.threadId,
        disposition: "discard",
        reason: "declared_clean",
      });
      return "discard";
    }
    // Everything below this line is an INFERENCE about whether there is
    // anything to lose, and the reason we act on an inference at all is
    // billing: on providers whose idle runtime keeps burning compute, holding
    // it is expensive. A provider that suspends itself has already stopped the
    // meter, so inferring a discard buys only disk and risks work. The
    // declared-clean case above still discards — that is stated intent, not a
    // guess.
    if (this.deps.backend.nativeIdleSuspend === true) {
      log.info("compute.retention_decision", {
        threadId: this.deps.threadId,
        disposition: "recoverable",
        reason: "provider_native_idle",
      });
      return "recoverable";
    }
    const cleanliness = (await this.deps.probeWorkspaceCleanliness?.()) ?? {
      state: "probe_failed" as const,
      reason: "probe_unavailable",
    };
    // `no_repo` with NO files is genuinely nothing to lose, and it is the same
    // state `confirmWorkSaved` accepts and sets the bit on — the two deciders
    // have to agree or a workbench-less thread that ran one `exec` (a bare
    // command leaves /workspace empty, and a chat thread never calls
    // `confirm_work_saved`) keeps a 24h recovery snapshot forever.
    // `no_repo` WITH files still preserves: unversioned work is still work.
    const empty = cleanliness.state === "no_repo" && !cleanliness.hasFiles;
    const disposition = cleanliness.state === "clean" || empty ? "discard" : "recoverable";
    const reason =
      cleanliness.state === "clean"
        ? "git_clean"
        : empty
          ? "empty_workspace"
          : cleanliness.state === "dirty"
            ? "dirty"
            : cleanliness.state === "no_repo"
              ? "no_repo"
              : "probe_failed";
    log.info("compute.retention_decision", {
      threadId: this.deps.threadId,
      disposition,
      reason,
      ...(cleanliness.state === "dirty" ? { dirtyRepoCount: cleanliness.repos.length } : {}),
    });
    return disposition;
  }

  /**
   * The backend already destroyed the container and a LATER step threw (a DO
   * SQL write, the D1 ledger delete, setAlarm, a reminder). The runtime no
   * longer exists, so local state must never go back to `active`: converge on
   * the state the backend actually left us in, keeping `recoveryRef` reachable
   * when a backup was written. Everything here is best-effort by design — there
   * is nothing left to roll back to.
   */
  private async settleDestroyedRuntime(
    recovery: BackendReference | null,
    now: number,
  ): Promise<void> {
    if (recovery) {
      const expiresAt = now + this.deps.config.recoveryTtlMs;
      try {
        this.deps.store.markRecoverable(recovery, now, expiresAt);
      } catch {
        // nothing recoverable left to do; the backup expires at its provider TTL
      }
      try {
        await this.armAlarm(expiresAt);
      } catch {
        /* best effort */
      }
      this.emitLifecycleEvent("release", "active_to_recoverable", "failure");
    } else {
      try {
        this.deps.store.markAbsent(now);
      } catch {
        /* best effort */
      }
      this.emitLifecycleEvent("release", "active_to_absent", "failure");
    }
    try {
      this.stopRunningProcesses(now, {
        deliver: true,
        detail: "process stopped (environment destroyed)",
      });
    } catch {
      /* best effort */
    }
    // The slot IS free — the container is destroyed. Leaving the ledger row
    // behind would over-count the workspace cap until its TTL lapses.
    try {
      await this.deps.quota?.release();
    } catch {
      /* best effort; the row expires at its TTL */
    }
  }

  /**
   * Give up this thread's container so another thread in the workspace can have
   * the slot. Returns true only if a container was actually released.
   *
   * Refuses whenever the container is doing real work, and refuses unless it
   * has been untouched for RECLAIM_MIN_IDLE_MS — LRU order alone does NOT imply
   * the candidate is idle (a mid-turn thread can be the least-recently-used row
   * while the model is holding uncommitted edits in /workspace).
   *
   * ALWAYS uses the recoverable disposition, whatever the retention mode says:
   * a reclaim is not the thread's own decision, so it must never destroy work.
   * If the recoverable release cannot be completed we roll back and refuse —
   * never fall through to a discard. But once the backend HAS taken the backup
   * and destroyed the container, a later failure can no longer roll back: we
   * persist the recoverable state (keeping the backup reachable) and report the
   * slot as freed, because it genuinely is.
   */
  async releaseIfReclaimable(): Promise<boolean> {
    if (this.deps.attachedRuntime) return false; // a subagent is using it
    const state = this.deps.store.getComputeState();
    if (!state?.runtimeRef || state.status !== "active") return false;

    const running = this.deps.store
      .listProcesses(1_000)
      .filter((process) => process.status === "running");
    if (running.length > 0) return false;
    if (this.deps.store.countWatchers() > 0) return false;
    if ((await this.deps.hasBlockingWork?.()) === true) return false;

    const now = this.deps.now();
    if (now - state.lastUsedAt < RECLAIM_MIN_IDLE_MS) return false;

    const runtime = state.runtimeRef;

    let released = false;
    let recovery: BackendReference | null = null;

    this.deps.store.markReleasing(now);
    try {
      recovery = await this.deps.backend.release(runtime, {
        disposition: "recoverable",
        recoveryTtlMs: this.deps.config.recoveryTtlMs,
      });
      released = true;
      if (!recovery) throw new ComputeError("provider_transient", "missing_recovery_reference");
      const expiresAt = now + this.deps.config.recoveryTtlMs;
      this.deps.store.markRecoverable(recovery, now, expiresAt);
      await this.deps.quota?.release();
      await this.armAlarm(expiresAt);
      this.emitLifecycleEvent("release", "active_to_recoverable", "success");
      await this.deps.deliverSystemReminder?.(
        "The thread compute environment was released to free a sandbox slot for another thread. Files were preserved; future commands will restore it.",
        "deferred",
      );
      return true;
    } catch {
      if (released) {
        // The backup was taken and the container destroyed; a later step (DO
        // write, ledger delete, alarm, reminder) failed. Rolling back to active
        // would both point at a dead sandbox and NULL the recoveryRef — the one
        // handle on the user's uncommitted /workspace work. Persist the
        // recoverable state instead, and report the slot as freed: it is (the
        // container is gone), and the caller's ledger delete + re-admit are the
        // correct follow-up.
        await this.settleDestroyedRuntime(recovery, now);
        return true;
      }
      // The release itself failed: the container is presumed alive. Roll back to
      // active — the caller will just try the next candidate. Never degrade to a
      // discard here: that would destroy unsaved work.
      this.deps.store.markActive(runtime, now);
      this.emitLifecycleEvent("release", "active_to_active", "failure");
      return false;
    }
  }

  async execShutdown(input: { confirm?: boolean | undefined } = {}): Promise<
    | { ok: true; terminated: false; alreadyGone: true }
    | {
        ok: true;
        terminated: false;
        needsConfirmation: true;
        runningProcesses: Array<{ id: string; command: string; label: string | null }>;
      }
    | { ok: true; terminated: true; stoppedProcesses: number }
  > {
    if (this.deps.attachedRuntime) throw new Error("compute_not_owner");
    if ((await this.deps.hasBlockingWork?.()) === true) throw new Error("compute_children_active");
    const state = this.deps.store.getComputeState();
    if (state && (await this.cleanupExpiredRecovery(this.deps.now()))) {
      return { ok: true, terminated: true, stoppedProcesses: 0 };
    }
    const reference = state?.status === "active" ? state.runtimeRef : state?.recoveryRef;
    if (!reference) return { ok: true, terminated: false, alreadyGone: true };
    const running = this.deps.store
      .listProcesses(1_000)
      .filter((process) => process.status === "running");
    if (running.length > 0 && input.confirm !== true) {
      return {
        ok: true,
        terminated: false,
        needsConfirmation: true,
        runningProcesses: running.map(({ id, command, label }) => ({ id, command, label })),
      };
    }
    try {
      await this.deps.backend.destroy(reference);
    } catch (error) {
      if (!this.isRuntimeMissing(error)) throw error;
    }
    const now = this.deps.now();
    this.stopRunningProcesses(now, {
      deliver: true,
      detail: "process stopped (environment shut down on request)",
    });
    this.clearWatchers();
    this.deps.store.markAbsent(now);
    await this.deps.quota?.release();
    await this.clearLifecycleState();
    await this.deps.clearAlarm?.();
    await this.deps.deliverSystemReminder?.(
      "The thread compute environment was shut down on request. Files and running processes are gone; previous command output remains available.",
      "deferred",
    );
    return { ok: true, terminated: true, stoppedProcesses: running.length };
  }

  async execUploadFile(input: {
    destinationPath: string;
    bytes: ArrayBuffer;
    overwrite?: boolean;
  }) {
    // Infrastructure writes (workspace root creation, the liveness-generation
    // nonce) are deliberately excluded from dirty-tracking — see
    // ensureWorkspaceRootOnce below and src/compute/generation.ts. Do not
    // "complete" that coverage; it would clear the bit on every sandbox wake.
    await this.deps.markSandboxDirty?.();
    const path = validateComputePath(input.destinationPath);
    if (input.bytes.byteLength > this.deps.config.limits.maxUploadBytes)
      throw new Error("compute_file_too_large");
    const runtime = await this.ensureRuntime();
    await this.deps.backend.writeFile(runtime, path, input.bytes, {
      createParents: true,
      overwrite: input.overwrite ?? false,
    });
    this.deps.store.touchLastUsed(this.deps.now());
    await this.refreshRelease(this.deps.config.idleTimeoutMs);
    return { ok: true as const, destinationPath: path };
  }

  async execDownloadFile(input: { path: string; maxBytes: number }) {
    const path = validateComputePath(input.path);
    const runtime = await this.ensureRuntime();
    const maxBytes = Math.min(input.maxBytes, this.deps.config.limits.maxDownloadBytes);
    const { bytes, mimeType } = await this.deps.backend.readFile(runtime, path, maxBytes);
    this.deps.store.touchLastUsed(this.deps.now());
    await this.refreshRelease(this.deps.config.idleTimeoutMs);
    const filename = path.split("/").pop();
    return { bytes, ...(filename ? { filename } : {}), ...(mimeType ? { mimeType } : {}) };
  }

  async execPublishArtifact(input: {
    path: string;
    entryPath?: string;
    maxBytes?: number;
  }): Promise<{
    files: Array<{ relativePath: string; bytes: ArrayBuffer; mimeType: string }>;
    totalBytes: number;
  }> {
    const root = validateComputePath(input.path);
    const entryPath = input.entryPath ?? "index.html";
    if (entryPath.split("/").includes("..")) throw new Error("compute_invalid_path");
    const maxTotal = Math.min(input.maxBytes ?? 20_000_000, 20_000_000);
    const maxFiles = 100;
    const runtime = await this.ensureRuntime();
    // The tool tells the model to publish a single .html file by passing its
    // PARENT plus `entryPath`, so handing us the file itself is the expected
    // mistake — and nothing downstream catches it usefully. On sprites, listing
    // a file answers 200 with a one-entry listing OF THAT FILE (live
    // 2026-08-05), so `walk` composed `<file>/<file>` and failed on the read
    // with `sprites_read_missing`: a missing-file error naming a file that
    // exists, pointing at a path the model never wrote.
    //
    // Only a positive `file` verdict refuses. `inspectPath` returns null for
    // both "nothing there" and "the provider said something that reads like
    // not-found" (Cloudflare answers `{success:false}` in band), so treating
    // null as not-a-directory would refuse real directories. Anything we cannot
    // positively call a file still goes to the walk, which throws on its own.
    const rootInfo = await this.deps.backend.inspectPath(runtime, root);
    if (rootInfo?.type === "file") {
      throw new Error(
        `artifact_path_not_directory: ${root} is a file — pass its parent directory as path and its filename as entryPath`,
      );
    }
    const files: Array<{ relativePath: string; bytes: ArrayBuffer; mimeType: string }> = [];
    let total = 0;
    const walk = async (absDir: string, relBase: string) => {
      const entries = await this.deps.backend.listDirectory(runtime, absDir);
      for (const ent of entries) {
        if (ent.name === "." || ent.name === "..") continue;
        if (ent.type === "symlink" || ent.type === "other") continue;
        const rel = relBase ? `${relBase}/${ent.name}` : ent.name;
        const abs = `${absDir.replace(/\/$/, "")}/${ent.name}`;
        if (ent.type === "directory") {
          await walk(abs, rel);
        } else if (ent.type === "file") {
          if (files.length >= maxFiles) throw new Error("artifact_too_many_files");
          const remaining = maxTotal - total;
          if (remaining <= 0) throw new Error("artifact_too_large");
          const { bytes, mimeType: providerMime } = await this.deps.backend.readFile(
            runtime,
            abs,
            remaining,
          );
          total += bytes.byteLength;
          if (total > maxTotal) throw new Error("artifact_too_large");
          // Prefer the extension map for known web types so HTML/CSS/JS always
          // render on the artifact host even when the sandbox reports text/plain.
          const fromExt = mimeFromFilename(rel);
          const mimeType =
            fromExt === "application/octet-stream" ? (providerMime ?? fromExt) : fromExt;
          files.push({
            relativePath: rel,
            bytes,
            mimeType,
          });
        }
      }
    };
    await walk(root, "");
    if (!files.some((f) => f.relativePath === entryPath)) throw new Error("artifact_entry_missing");
    this.deps.store.touchLastUsed(this.deps.now());
    await this.refreshRelease(this.deps.config.idleTimeoutMs);
    return { files, totalBytes: total };
  }

  /**
   * Drop this thread's ledger row unconditionally. Used by thread destroy: the
   * DO (and its thread_index row) is about to disappear, so a surviving row
   * would consume a workspace slot AND keep being handed to `reclaimContainer`
   * as a candidate that can never answer.
   */
  async releaseQuotaSlot(): Promise<void> {
    await this.deps.quota?.release();
  }

  isComputeLive(): boolean {
    const state = this.deps.store.getComputeState();
    return Boolean(
      (state?.status === "active" && state.runtimeRef) ||
      (state?.status === "recoverable" && state.recoveryRef),
    );
  }

  /**
   * Widened form of {@link isComputeLive} that also counts `acquiring`, for the
   * workbench-switch decision only.
   *
   * `isComputeLive` is deliberately NOT widened: its other callers are eviction
   * backstops that read `!isComputeLive()` as "compute is gone, clear the
   * coding-task state". A wedged `acquiring` row must keep clearing there.
   *
   * The switch decision needs the opposite bias. A Daytona acquire takes
   * seconds to a minute; a switch landing inside that window would take the
   * immediate path, moving the snapshot to the new workbench while the
   * container that is still coming up gets cloned from the OLD one — with no
   * marker set, nothing ever tears it down or re-clones. Deferring instead
   * costs at worst one redundant save-work prompt.
   */
  isComputeLiveOrAcquiring(): boolean {
    return this.isComputeLive() || this.deps.store.getComputeState()?.status === "acquiring";
  }

  async destroyRecoverableComputeIfPresent(): Promise<void> {
    if (this.deps.attachedRuntime) return;
    const state = this.deps.store.getComputeState();
    if (state?.status !== "recoverable" || !state.recoveryRef) return;
    try {
      await this.deps.backend.destroy(state.recoveryRef);
    } catch (error) {
      if (!this.isRuntimeMissing(error)) throw error;
    }
    this.deps.store.markAbsent(this.deps.now());
    this.stopRunningProcesses(this.deps.now(), {
      deliver: true,
      detail: "process stopped (recoverable environment destroyed)",
    });
    this.clearWatchers();
    await this.clearLifecycleState();
    await this.deps.clearAlarm?.();
  }

  async cleanupExpiredRecoverableCompute(): Promise<void> {
    // A turn may clean up an expired recovery, but must not restore a live
    // sandbox until an actual compute or file operation calls ensureRuntime.
    if (this.deps.attachedRuntime) return;
    await this.cleanupExpiredRecovery(this.deps.now());
  }

  /** DEBUG: provider-neutral raw backend status for a process (diagnose exit detection). */
  /** DEBUG: what the backend reports for a path (verify symlink detection live). */
  async debugInspectPath(path: string): Promise<unknown> {
    const runtime = await this.ensureRuntime();
    const info = await this.deps.backend.inspectPath(runtime, path);
    const backend = this.deps.backend as {
      debugRawFileDetails?: (runtime: BackendReference, path: string) => Promise<unknown>;
    };
    const raw = backend.debugRawFileDetails
      ? await backend.debugRawFileDetails(runtime, path)
      : undefined;
    return { info, raw };
  }

  async debugRawProcessStatus(processId: string): Promise<unknown> {
    const process = this.deps.store.getProcess(processId);
    if (!process?.backendProcessRef) return { error: "process_not_found" };
    const runtime = this.deps.store.getComputeState()?.runtimeRef ?? this.deps.attachedRuntime;
    if (!runtime) return { error: "runtime_not_active" };
    return this.deps.backend.getProcessStatus(runtime, process.backendProcessRef);
  }

  /**
   * `backend.acquire` provisions the workspace root, but an already-active runtime
   * (and an attached subagent runtime) never re-acquires. A sandbox that was
   * running before the root existed would then get `exec` with a `cwd` that does
   * not exist. Ensure it once per service instance; `createDirectory` is idempotent.
   */
  private async ensureWorkspaceRootOnce(runtime: BackendReference): Promise<BackendReference> {
    if (this.workspaceRootEnsured) return runtime;
    // Deliberately NOT dirty-tracked: this is our own write, on every
    // acquisition. Marking it would clear the declared-clean bit on every
    // sandbox wake, so a declaration could never survive to release.
    await this.deps.backend.createDirectory(runtime, WORKSPACE_ROOT);
    this.workspaceRootEnsured = true;
    return runtime;
  }

  /**
   * Provisioning is serialized by the `acquisitionInFlight` latch ALONE — never
   * by `ctx.blockConcurrencyWhile`. It used to run inside it (as
   * `serializeCreation`), and that is now deliberately gone.
   *
   * What the gate bought: nothing else about creation. A Durable Object is
   * single-threaded, so the gate never prevented parallelism — it prevented
   * OTHER events (fetch, alarm, RPC) from interleaving at the awaits inside
   * `readOrAcquireRuntime`. Duplicate provisioning was, and still is, prevented
   * by the latch: two concurrent execs in one turn await one `backend.acquire`.
   *
   * What it cost, three ways:
   *
   *  1. Self-hosted celld kills an outbound WebSocket upgrade that SUCCEEDS
   *     while the gate is held — its stall detector does not count the pending
   *     upgrade as pending work ("handler stalled: awaited work with no pending
   *     op"). The sprites backend reaches `prepare()` through `execCollect`, so
   *     the upgrade is nested inside `acquire` itself. Reproduced minimally: the
   *     identical upgrade returns 101 outside the gate and stalls inside it.
   *     Every exec on celld failed on this.
   *  2. On Cloudflare, a gated acquire freezes EVERY event on the thread for as
   *     long as it runs — up to {@link ACQUIRE_DEADLINE_MS}. A sandbox booting
   *     should not stop the thread from answering.
   *  3. Overrunning the ~30s budget cancels the callback and RESETS the object,
   *     destroying the turn. One `exec` held it 154s and did exactly that.
   *
   * A backend call inside `blockConcurrencyWhile` is the hazard `reapProcess`
   * and `stopProcessDirect` already refuse to take; this was the last path
   * still taking it.
   *
   * The one thing the gate did protect is handled explicitly instead: see the
   * in-flight check in `cleanupExpiredRecovery`, which stops an interleaving
   * alarm from destroying the very snapshot a restore is reading.
   */
  private async ensureRuntime(): Promise<BackendReference> {
    if (this.deps.attachedRuntime) {
      const state = this.deps.store.getComputeState();
      if (state?.runtimeRef !== this.deps.attachedRuntime) {
        this.deps.store.markActive(this.deps.attachedRuntime, this.deps.now());
      }
      return this.ensureWorkspaceRootOnce(this.deps.attachedRuntime);
    }
    const runtime = await this.boundedAcquisition(() => this.readOrAcquireRuntime());
    return this.ensureWorkspaceRootOnce(runtime);
  }

  /**
   * One acquisition at a time, bounded by {@link ACQUIRE_DEADLINE_MS}.
   *
   * The deadline expiring does NOT abandon the provisioning — it is retained in
   * `acquisitionInFlight`, so a later call (a retry, or the next turn) awaits
   * the SAME work rather than asking the backend for a second sandbox. That
   * matters most in exactly the case the deadline fires: a slow backend is the
   * last thing that should be handed a duplicate create.
   */
  private boundedAcquisition(acquire: () => Promise<BackendReference>): Promise<BackendReference> {
    if (!this.acquisitionInFlight) {
      const started = acquire();
      this.acquisitionInFlight = started;
      // `catch` before `finally` so the cleanup chain cannot itself surface as
      // an unhandled rejection once a timed-out acquisition finally fails.
      // `started` keeps rejecting for its real awaiters either way.
      void started
        .catch(() => {})
        .finally(() => {
          if (this.acquisitionInFlight === started) this.acquisitionInFlight = undefined;
        });
    }
    return withDeadline(
      this.acquisitionInFlight,
      this.deps.acquireDeadlineMs ?? ACQUIRE_DEADLINE_MS,
      () =>
        new ComputeError(
          "provider_transient",
          "sandbox_acquire_deadline: the sandbox did not finish starting in time",
        ),
    );
  }

  private async readOrAcquireRuntime(): Promise<BackendReference> {
    const now = this.deps.now();
    await this.cleanupExpiredRecovery(now, { fromAcquisition: true });
    const state = this.deps.store.getComputeState();
    if (
      this.deps.config.provider === "daytona" &&
      (state?.status === "active" || state?.status === "recoverable") &&
      !sameAllowedHosts(state.acquiredAllowedHosts, this.deps.config.allowedHosts)
    ) {
      throw new ComputeError("policy_rejected", "daytona_egress_policy_changed_run_exec_shutdown");
    }
    if (state?.status === "active" && state.runtimeRef) return state.runtimeRef;
    const recovery = state?.status === "recoverable" ? state.recoveryRef : null;
    // Prefer a profile persisted on existing state over the settings default;
    // the default seeds only fresh state.
    const resourceProfile = state?.resourceProfile ?? this.deps.config.resourceProfile;
    const spec = this.computeSpec(resourceProfile);
    const startedAt = this.deps.now();
    if (!recovery) {
      this.deps.store.markAcquiring({
        provider: this.deps.backend.id,
        providerConfig: this.deps.config.providerConfig,
        allowedHosts: this.deps.config.allowedHosts,
        resourceProfile,
        now,
      });
    }
    let admitted = false;
    try {
      await this.deps.quota?.admit();
      admitted = true;
      const runtime = await this.deps.backend.acquire(spec, recovery ?? undefined);
      this.deps.store.markActive(runtime, this.deps.now());
      // The ONE genuine provision site, and so the only place a nonce is ever
      // written. Both branches below are a brand-new container on the provider:
      // a fresh acquire obviously, and a recovery restore too — `release()`
      // backs up /workspace and then DESTROYS the sandbox, so the restored
      // container's /tmp (and its nonce) is gone by design. `generation`
      // however SURVIVES active→releasing→recoverable→active (no markAcquiring
      // on the recovery path), so writing unconditionally is what stops the
      // restored container from adopting a destroyed container's nonce.
      //
      // Written once per container, at provision, and never lazily: a lazy
      // write-back would have to decide "is the persisted null a missing nonce
      // or a blipped read?" — it cannot, and answering it wrong overwrites a
      // healthy container's nonce and mass-faults every open ledger row.
      //
      // Writing only here does NOT mean `sandbox_reset` needs a re-provision.
      // An earlier comment claimed exactly that — "a silent OOM falls through
      // to no_liveness; that is correct, not a gap" — and the live run RETRACTED
      // it: Cloudflare hands back a working container on the SAME sandbox id
      // after a destroy/OOM, so nothing throws `SandboxNotFound`, the DO never
      // re-provisions, and the nonce never diverges. Under that theory
      // `sandbox_reset` was unreachable in production.
      //
      // The mechanism that actually fires it is ABSENT-BUT-ANSWERED: the
      // watcher poll-failure probe (`pollDueWatchers`) finds the container
      // answering with its nonce GONE and persists `{kind: "absent", observedAt}`.
      // `classifyWork` reads that as a reset for rows started strictly before
      // the observation. Divergence (store gen-b vs row gen-a) remains a second,
      // rarer path — it is not the only one.
      //
      // This site stays a genuine-provision-only write regardless: a lazy
      // write-back is what would mass-fault healthy rows. Do not add one.
      //
      // Persist BEFORE writing so a failed write leaves the store honestly
      // claiming the new container (old rows then mismatch = a true reset)
      // rather than still advertising the destroyed container's nonce.
      const generationNonce = crypto.randomUUID();
      this.deps.store.setGeneration({ kind: "known", nonce: generationNonce }, this.deps.now());
      try {
        await writeGeneration(this.deps.backend, runtime, generationNonce);
      } catch (error) {
        // The store now claims a nonce this container never accepted. Left
        // alone that is a false-fault shape on a HEALTHY container: rows
        // registered against the claim would carry the phantom nonce, and the
        // first poll-failure probe would find the container answering with no
        // nonce and diverge from it. Record what is actually true — the live
        // container has no nonce — which keeps the previous container's rows
        // correctly reset (this IS a new container), registers later rows as
        // `UNKNOWN_GENERATION` rather than against a phantom, and lets
        // `restoreGenerationAfterWipe` retry the write on the next probe.
        this.deps.store.setGeneration(
          { kind: "absent", observedAt: this.deps.now() },
          this.deps.now(),
        );
        throw error;
      }
      this.deps.store.touchLastUsed(this.deps.now());
      await this.refreshRelease(this.deps.config.idleTimeoutMs);
      if (recovery) {
        this.emitLifecycleEvent(
          "restore",
          "recoverable_to_active",
          "success",
          this.deps.now() - startedAt,
        );
        await this.deps.deliverSystemReminder?.(RESTORED_COMPUTE_REMINDER, "deferred");
      } else {
        this.emitLifecycleEvent(
          "acquire",
          "absent_to_active",
          "success",
          this.deps.now() - startedAt,
        );
        // Genuinely fresh (recovery === null, same condition markAcquiring
        // used above): an empty /workspace, so repos can be prepared without
        // clobbering anything. Never on the recovery branch — that /workspace
        // is restored from backup. A prep failure must not fail the
        // acquisition; the sandbox is still usable.
        try {
          await this.deps.onFreshRuntimeAcquired?.();
        } catch (error) {
          log.warn("compute.fresh_runtime_preparation_failed", { error: String(error) });
        }
      }
      return runtime;
    } catch (error) {
      if (admitted) {
        // Never leave a ledger row for a container that does not exist: if
        // admit() succeeded but the backend acquire then failed, the slot must
        // be freed immediately rather than left to expire after a full TTL.
        try {
          await this.deps.quota?.release();
        } catch {
          // A failing release must not mask the original acquire error.
        }
      }
      if (!recovery) {
        const detail = error instanceof Error ? error.message : String(error);
        const code = error instanceof ComputeError ? error.code : "compute_unavailable";
        this.deps.store.markError({ code, detail }, this.deps.now());
        this.emitLifecycleEvent(
          "acquire",
          "absent_to_error",
          "failure",
          this.deps.now() - startedAt,
        );
      } else {
        this.emitLifecycleEvent(
          "restore",
          "recoverable_to_recoverable",
          "failure",
          this.deps.now() - startedAt,
        );
      }
      throw error;
    }
  }

  private computeSpec(
    profile: ComputeResourceProfile = this.deps.config.resourceProfile,
  ): ComputeSpec {
    return {
      environmentId: this.deps.environmentId,
      profile,
      workspaceRoot: WORKSPACE_ROOT,
      env: this.deps.env,
      maxProcessRuntimeMs: this.deps.config.maxProcessRuntimeMs,
      allowedHosts: this.deps.config.allowedHosts,
    };
  }

  private async refreshProcessStatus(processId: string): Promise<void> {
    const process = this.requireProcessReference(processId);
    const runtime = await this.ensureRuntime();
    const status = await this.deps.backend.getProcessStatus(runtime, process.backendProcessRef);
    if (status.status !== process.status || status.exitCode !== undefined) {
      this.updateTerminalProcess(processId, status);
      if (status.status !== "running")
        this.emitCommandEvent("command_completion", processId, "success");
    }
    if (status.status !== "running") await this.refreshProcessOutput(processId);
  }

  private updateTerminalProcess(processId: string, status: ProcessStatus): void {
    this.deps.store.updateProcess(processId, {
      status: status.status,
      ...(status.status === "running" ? {} : { finishedAt: this.deps.now() }),
      ...(status.exitCode === undefined ? {} : { exitCode: status.exitCode }),
    });
  }

  private async refreshProcessOutput(processId: string): Promise<void> {
    const state = this.deps.store.getComputeState();
    const process = this.deps.store.getProcess(processId);
    if (state?.status !== "active" || !state.runtimeRef || !process?.backendProcessRef) return;
    try {
      const output = await this.deps.backend.readProcessOutput(
        state.runtimeRef,
        process.backendProcessRef,
      );
      this.ingestCumulativeOutput(processId, "stdout", output.stdout);
      this.ingestCumulativeOutput(processId, "stderr", output.stderr);
    } catch (error) {
      if (!this.isRuntimeMissing(error)) throw error;
      await this.markRuntimeMissing();
    }
  }

  private ingestCumulativeOutput(
    processId: string,
    stream: "stdout" | "stderr",
    cumulative?: string,
  ): void {
    if (!cumulative) return;
    const ingestedChars = this.deps.store
      .listOutputChunks(processId, stream)
      .reduce((total, chunk) => total + chunk.text.length, 0);
    if (cumulative.length > ingestedChars)
      this.appendOutput(processId, stream, cumulative.slice(ingestedChars));
  }

  private async pollDueWatchers(): Promise<void> {
    const now = this.deps.now();
    const due = this.deps.store.listWatchers().filter((watcher) => watcher.nextPollAt <= now);
    if (due.length === 0) return;
    let runtime: BackendReference;
    try {
      runtime = await this.ensureRuntime();
    } catch {
      for (const watcher of due)
        this.deps.store.upsertWatcher({ ...watcher, nextPollAt: now + watcher.pollIntervalMs });
      return;
    }
    let delivered = false;
    let probed = false;
    for (const watcher of due) {
      try {
        if (await this.pollWatcher(watcher, runtime, now)) delivered = true;
      } catch {
        // A poll failure is the signal that the sandbox may be gone. Probe the
        // nonce ONCE per sweep so the reaper can tell "your files are gone" from
        // "this process is stuck" — a distinction the model acts on differently.
        if (!probed) {
          probed = true;
          // Persist the observed result — not an instance field — so a
          // DIFFERENT service instance (the reaper's own resolveComputeService
          // call) can read it. All three arms are real, persisted results:
          // `unreadable` means "unknown" and classifyWork must never treat
          // unknown as a reset, while `absent` is the positive evidence of one.
          await this.probeAndRecordGeneration(runtime, now);
        }
        this.deps.store.upsertWatcher({ ...watcher, nextPollAt: now + watcher.pollIntervalMs });
      }
    }
    if (delivered) this.deps.store.touchLastUsed(now);
  }

  /**
   * The container answered and its nonce is GONE. Restore the invariant that a
   * live container always carries one, and record what we end up knowing.
   *
   * Why a write here does not break the "never write a nonce lazily" rule. That
   * rule was written when a probe produced `string | null` and `null` conflated
   * "the nonce is gone" with "we could not ask"; letting THAT license a write
   * meant a transient blip could overwrite a healthy container's nonce and
   * mass-fault every open row. `absent` is the opposite: it is positive,
   * corroborated evidence that the live container has no nonce — the one case
   * where a write cannot clobber anything, because there is nothing to clobber.
   * `found` and `unreadable` still never reach here.
   *
   * Why it is needed at all. Cloudflare hands back a WORKING container on the
   * same sandbox id after a wipe, so `execStart` never throws `SandboxNotFound`,
   * `markRuntimeMissing` never fires, and `readOrAcquireRuntime` early-returns
   * on `status === "active"`. Nothing re-provisions, so without this the
   * container stays nonce-less for the rest of its life and every subsequent
   * wipe — the flagship incident is an OOM-prone container OOMing TWICE — is
   * invisible, degrading the actionable "your files are gone" message to the
   * under-informative `no_liveness` one this design exists to replace.
   *
   * `markRuntimeMissing()` would also restore the invariant, by forcing a
   * re-provision. It is rejected because it throws away a container that is
   * demonstrably working (it just answered), paying a full acquire — and a
   * fresh container really would lose the post-wipe work, so it manufactures
   * the very data loss it is reporting.
   *
   * Blast radius: rows carrying the OLD nonce mismatch the new one and fault.
   * Rows registered after read the restored nonce and match; rows registered
   * during the absence carry `UNKNOWN_GENERATION`, which `classifyWork` never
   * treats as a mismatch.
   *
   * That last exemption NARROWS detection, and the trade is deliberate. An
   * earlier version of this comment claimed the `known` arm faults "the same set
   * the `absent` arm faults via `observedAt`". It does not. The `absent` arm
   * keys purely on `startedAt < observedAt`, so it faults an `UNKNOWN_GENERATION`
   * row regardless of its generation; the `known` arm cannot, and a successful
   * restore CLEARS `generationAbsentAt`, so the absent evidence is gone with it.
   * Concretely: one `unreadable` blip nulls `compute_state.generation`, every row
   * registered after it carries `UNKNOWN_GENERATION`, a genuine wipe follows, the
   * probe restores — and those rows degrade to `no_liveness` instead of the
   * actionable "your files are gone, redo the work". Under-informative beats a
   * false fault, which is why it is accepted rather than closed.
   *
   * The `observedAt` bound is NOT "≤1 poll interval" of imprecision — an earlier
   * version of this comment said so and it understated the window badly. When the
   * probe fired ONLY on a poll failure, a wipe with no watcher armed was probed
   * by nothing: the store kept advertising the stale nonce, work registered
   * afterwards inherited it, and its polls SUCCEEDED against the (healthy, wiped)
   * container. At the first later `absent` probe — possibly hours later — the
   * restore wrote a fresh nonce and every row still carrying the stale one
   * faulted `sandbox_reset` although its work was intact. The window was
   * unbounded until the next poll failure.
   *
   * `refreshGeneration` closes it by probing at REGISTRATION time — the moment
   * the row's generation is decided, and the only one that can distinguish
   * "registered before the wipe" from "registered after it but before anyone
   * noticed". Pinned by "spares work registered after a wipe is observed" in
   * `watcher-fault.test.ts`.
   */
  private async restoreGenerationAfterWipe(runtime: BackendReference, now: number): Promise<void> {
    // The probe's `runtime` was captured before two awaits. `readOrAcquireRuntime`
    // serializes provisions but this does not run inside that lock, so re-read
    // the state and bail if it moved: writing a nonce to a reference a concurrent
    // provision has already replaced would clobber the new container's nonce.
    if (!this.isCurrentRuntime(runtime)) return;
    const nonce = crypto.randomUUID();
    try {
      await writeGeneration(this.deps.backend, runtime, nonce);
    } catch {
      // The restore failed, so the live container still has no nonce we can
      // vouch for. Record the absence — it is exactly what we observed — and
      // let the next probe (poll-failure or registration) retry the write.
      // `observedAt` is write-once in the store, so a container that never
      // accepts the restore cannot manufacture a fresh reset out of a stale
      // absence — which matters more now that registration probes too, since a
      // re-stamp would fire on every new piece of work.
      //
      // Unless the write threw BECAUSE the reference died under us and a new
      // container took its place: the absence is then about a container that no
      // longer exists, and recording it would fault the new container's healthy
      // rows via the `absent` arm's `startedAt` bound. Say nothing instead.
      if (!this.isCurrentRuntime(runtime)) return;
      this.deps.store.setGeneration({ kind: "absent", observedAt: now }, now);
      return;
    }
    // Deliberately NOT guarded on `isCurrentRuntime` again. The container write
    // above already landed and cannot be taken back, so the store must record it
    // or it would advertise a nonce the container does not carry — which faults
    // every row on the container that IS live. If a concurrent provision
    // interleaved between the guard and here, this last-writer-wins over its
    // nonce; that is the accepted Task-5 "I5 first-write race" class, now
    // reachable with a container write attached. Narrowing it further needs the
    // restore to hold the provisioning latch across this write, which would put
    // a backend write under that latch.
    this.deps.store.setGeneration({ kind: "known", nonce }, this.deps.now());
  }

  /**
   * Is `runtime` still the live, active reference this thread is running on?
   *
   * A cheap guard, not a proof. `status === "active"` is the load-bearing half:
   * it catches a runtime that was released, discarded or marked missing while an
   * await was in flight. The ref comparison catches a genuine swap on providers
   * whose reference identifies the container — on Cloudflare it does NOT, because
   * The derived sandbox id is deterministic, so a re-provision hands back
   * an EQUAL ref. There is no cheaper discriminator there.
   */
  private isCurrentRuntime(runtime: BackendReference): boolean {
    const state = this.deps.store.getComputeState();
    if (state?.status !== "active" || !state.runtimeRef) return false;
    return JSON.stringify(state.runtimeRef) === JSON.stringify(runtime);
  }

  /**
   * The watcher poll's status read. When the backend declares
   * `ComputeBackend.buildBackstopProbe`, runs it FIRST: one exec that either
   * reports a recorded exit or (only when there is none) re-asserts
   * `workHold` in the same breath. If it reports an exit, that answer is
   * authoritative and `getProcessStatus` is skipped entirely.
   *
   * If it does NOT report an exit, this still falls back to
   * `getProcessStatus` — deliberately, on every such poll, not just once.
   * `getProcessStatus` is NOT an exec on sprites (it is `fsRead` +
   * `listSessions`, two control-plane reads with no shell involved), so this
   * fallback costs no exec and risks no VM wake; skipping it would mean
   * `classifyWatcher` never sees `"failed"` again for a process that died
   * without recording an exit, so the model would be told (falsely) that a
   * process which died up to an hour ago "is still running" once the
   * watcher's absolute timeout finally fires. The one exec this widening
   * exists to save is the hold reassert, not this read — see
   * `ComputeBackend.buildBackstopProbe`'s doc.
   *
   * Backends without the capability (no hold to reassert, e.g. Cloudflare,
   * or none of the above, e.g. tests) just call `getProcessStatus` directly.
   */
  private async pollProcessStatus(
    runtime: BackendReference,
    process: BackendProcessReference,
  ): Promise<ProcessStatus> {
    const backend = this.deps.backend;
    const buildProbe = backend.buildBackstopProbe;
    if (!buildProbe || !backend.runCommand) {
      return backend.getProcessStatus(runtime, process);
    }
    const result = await backend.runCommand(runtime, {
      command: buildProbe(process),
      // Bounded generously: a hibernated sprite's wake plus this exec can
      // exceed a tighter budget, but a timeout here degrades safely — the
      // poll just falls through to `getProcessStatus` below, and a process
      // that is genuinely wedged is still caught by the reaper's own
      // `no_liveness` fault (PROCESS_STALE_AFTER_MS, now 180s) if polls keep
      // failing to stamp liveness.
      timeoutMs: 10_000,
    });
    const exitCode = parseBackstopRc(result.stdout);
    if (exitCode !== undefined) return { status: "exited", exitCode };
    // No rc yet: fall back to the session-backed read so a process that died
    // without ever recording an exit is still detected as `"failed"`, not
    // silently `"running"` for an hour. A thrown `runCommand` (exec failure,
    // timeout) propagates past this method uncaught, same as a thrown
    // `getProcessStatus` always has — the sweep loop that calls `pollWatcher`
    // already treats a poll failure as "do not stamp, retry next poll".
    return backend.getProcessStatus(runtime, process);
  }

  private async pollWatcher(
    watcher: WatcherRow,
    runtime: BackendReference,
    now: number,
  ): Promise<boolean> {
    const process = this.deps.store.getProcess(watcher.processId);
    if (!process?.backendProcessRef) {
      this.deps.store.deleteWatcher(watcher.processId);
      return false;
    }
    const status = await this.pollProcessStatus(runtime, process.backendProcessRef);
    // Stamp only AFTER a successful read. A failed poll must not stamp — that
    // is exactly what lets the reaper reap a watcher whose backend has gone
    // away, without this error path having to cooperate.
    this.deps.workLedger?.stampAlive(watcher.processId, now);
    this.updateTerminalProcess(watcher.processId, status);
    const classification = classifyWatcher({ watcher, processStatus: status.status, now });
    if (classification === "pending") {
      this.deps.store.upsertWatcher({ ...watcher, nextPollAt: now + watcher.pollIntervalMs });
      return false;
    }
    if (classification === "renew") {
      this.deps.store.upsertWatcher({
        ...watcher,
        deadlineAt: now + DEFAULT_WATCH_TIMEOUT_MS,
        nextPollAt: now + watcher.pollIntervalMs,
      });
      return false;
    }
    const title = watcher.label || process.command;
    // Terminal path — one funnel: write the terminal FIRST, then deliver, then
    // tear down. This is a pure local SQL write and must not sit behind
    // anything that can throw: `refreshProcessOutput` re-throws non-
    // runtime-missing backend errors and `deliverSystemReminder` can throw
    // too, and `pollWatcher` stops stamping the row either way — so a row left
    // open behind a throw is reaped one `PROCESS_STALE_AFTER_MS` later as a
    // false `no_liveness` fault.
    // Delivery failure cannot suppress the terminal, because the terminal is
    // already written. The `terminalize` itself notifies nobody; the reminder
    // below is this path's notification, and `markDelivered` after it is what
    // tells the sweep the obligation is discharged.
    //
    // NOTE both terminals here are also reaper reasons on paper — `watch_timeout`
    // especially, which is the ordinary outcome for a healthy backgrounded
    // process that outlives its watch. Nothing may read a terminal's REASON to
    // decide who owed its delivery; only the `delivered_at` stamp says that.
    const closed = this.deps.workLedger?.terminalize(
      watcher.processId,
      classification === "exited"
        ? { outcome: "exited", reason: "process_exit", at: now, detail: "process exited" }
        : { outcome: "timeout", reason: "watch_timeout", at: now, detail: "watch timeout" },
    );
    // Somebody else closed this row AND already told the model about it — the
    // sweep's retry, having found no watcher, or a stop. Deliver now and the
    // model reads the same process twice: `markDelivered` is claim-after-success
    // (a delivery that throws must stay owed), so it is a receipt, not a lock,
    // and the injection buffer's dedupe key only suppresses a duplicate still
    // queued. So ASK before speaking. Teardown below still runs — the watcher
    // must go either way.
    //
    // `closed === false` alone is NOT this test, and reading it as one is the
    // trap: a row the reaper closed may be closed and SILENT (its own delivery
    // threw), and that case is exactly why this path delivers unconditionally
    // otherwise. Only the delivery gate distinguishes told from merely closed.
    //
    // At-most-once for THIS path is held by two guards, and only together:
    // this `isDelivered` read (below, moved to just before each
    // `deliverSystemReminder` call so the read-then-act window is one
    // non-backend await, not the wider `refreshProcessOutput` fetch) covers
    // "did someone already deliver for this row", and the sweep's `hasWatcher`
    // skip (`think-thread-agent.ts`, in `runWorkLedgerSweep`) covers the
    // opposite direction — "a live watcher still owes this row, so the sweep
    // must not deliver out from under it". Neither can be made atomic with its
    // delivery: both must read → deliver → stamp, because claiming BEFORE
    // delivering would resurrect the silent-loss bug this branch exists to
    // kill (a delivery that throws after claiming leaves the model never
    // told, the row closed, and the reaper never revisiting it). `isDelivered`
    // is a read-before-speaking gate, not a lock. If the `hasWatcher` skip is
    // ever removed as "redundant now that we have the delivery gate", this
    // path and the sweep can each deliver the same terminal in the same
    // window and the model gets two cards for one process.
    //
    // The `alreadyTold` arms below return TRUE despite not delivering, which
    // reads wrong — `pollDueWatchers` turns that into `touchLastUsed`, i.e. a
    // sandbox idle-life extension for a delivery that did not happen. It is
    // load-bearing anyway and must stay: this arm is reached on a tick where
    // the clock has already passed the watch timeout, so returning false lets
    // the same tick reclaim the sandbox as idle and the model is told its
    // environment was discarded instead of nothing at all. The stat is a
    // "this tick did real watcher work" signal, not a delivery count.
    if (classification === "exited") {
      await this.refreshProcessOutput(watcher.processId);
      const alreadyTold =
        closed === false && this.deps.workLedger?.isDelivered(watcher.processId) === true;
      if (alreadyTold) {
        this.deps.store.deleteWatcher(watcher.processId);
        return true;
      }
      const outputTail = this.buildOutputTail(watcher.processId);
      await this.deps.deliverSystemReminder?.(
        `Background process ${title} (${process.command}) exited with code ${status.exitCode ?? "unknown"}. Recent output:\n${outputTail}`,
        "proactive",
        {
          watcher: {
            title,
            command: process.command,
            processId: watcher.processId,
            outcome: "exited",
            exitCode: status.exitCode ?? null,
            outputTail,
          },
        },
      );
      this.emitCommandEvent("command_completion", watcher.processId, "success");
    } else {
      const alreadyTold =
        closed === false && this.deps.workLedger?.isDelivered(watcher.processId) === true;
      if (alreadyTold) {
        this.deps.store.deleteWatcher(watcher.processId);
        return true;
      }
      await this.deps.deliverSystemReminder?.(
        `Background process ${title} (${process.command}) is still running after the watch timeout; no longer watching it.`,
        "proactive",
        {
          watcher: {
            title,
            command: process.command,
            processId: watcher.processId,
            outcome: "timeout",
            exitCode: null,
          },
        },
      );
      this.emitCommandEvent("command_timeout", watcher.processId, "success");
    }
    // Unconditional stamp, paired with the unconditional call above: whenever
    // `deliverSystemReminder` is wired at all, this row's notification
    // obligation is discharged by the time we get here. AFTER the await, never
    // before — a throw must leave the row owed so the sweep retries it; before
    // this, such a throw left the row closed and silent while the watcher
    // re-polled to its deadline, and the model heard nothing at all. The
    // sweep's fallback text is poorer than the reminder above (no output
    // tail), but poorer beats silence.
    //
    // `deliverSystemReminder` is optional-chained (legacy `ThreadAgent` has no
    // reminder), but that path also has no `workLedger`, so `markDelivered`
    // is itself a no-op there — the pair is wired together by construction,
    // not by a runtime check here. `ThinkThreadAgent` always wires both.
    //
    // Unconditional, unlike `execStop`'s: this is justified by a delivery that
    // actually reached the model, not by an intent. That holds even if the
    // terminalize above returned false, and BOTH directions of that are real:
    // the other writer may have closed the row and been unable to deliver (the
    // reaper's own delivery threw; `facts.service` was null so `reapProcess`
    // never ran and this watcher survived) — the case this path exists to
    // rescue — or it may have delivered successfully, which is the duplicate the
    // `alreadyTold` gate above returns on before ever reaching here. Past that
    // gate, the model has now been told about this work exactly once, by a
    // message built from a live status read.
    this.deps.workLedger?.markDelivered(watcher.processId, now);
    // Hold release, gated on `closed`: only the call that ACTUALLY closed the
    // ledger row owns its teardown. When `closed` is false, the reaper's
    // `terminalizeWork` -> `reapProcess` got there first and already released
    // (or, for the still-open-but-undelivered rescue case above, will have —
    // that call's own `reapProcess` ran before this poll's delivery did).
    // Releasing unconditionally here would double-release: harmless on
    // sprites (`DELETE` on an already-gone task 404s and is swallowed), but
    // wrong in principle, since "whoever closes the row owns the teardown" is
    // the same invariant `reapProcess` already relies on.
    //
    // For `timeout` specifically the process may still be running, but the
    // wrapper's own refresher self-heals within 60s (`PUT` is an upsert), so
    // the worst case of releasing here is one missed refresh window, not a
    // stranded process.
    if (closed) await this.releaseWorkHold(watcher.processId);
    this.deps.store.deleteWatcher(watcher.processId);
    return true;
  }

  private buildOutputTail(processId: string): string {
    const chunks = this.deps.store.listOutputChunks(processId);
    const stdout = tailOutputChunks(chunks, {
      stream: "stdout",
      maxLines: REMINDER_TAIL_MAX_LINES,
      maxBytes: REMINDER_TAIL_MAX_BYTES,
    });
    if (stdout.text) return stdout.text;
    return tailOutputChunks(chunks, {
      stream: "stderr",
      maxLines: REMINDER_TAIL_MAX_LINES,
      maxBytes: REMINDER_TAIL_MAX_BYTES,
    }).text;
  }

  /**
   * @param fromAcquisition True only for the call `readOrAcquireRuntime` makes
   * on its own way in, which runs BEFORE it decides whether to restore and so
   * is never the racing caller this guards against.
   *
   * Every other caller is a different DO event — an alarm, a tick, a route —
   * and one of those landing mid-restore is the hazard. A restore does not move
   * the status off `recoverable` while it runs (`markAcquiring` fires only on
   * the fresh-acquire branch, by design), so a TTL expiring during one would
   * otherwise destroy the very backup the restore is reading, losing the
   * workspace.
   *
   * `blockConcurrencyWhile` used to make that unreachable by queueing the alarm
   * behind the acquisition; `ensureRuntime` no longer holds that gate, so the
   * exclusion is stated here instead. Skipping is safe: the recovery is about
   * to become `active`, and a failed restore leaves the latch clear for the
   * next tick to re-run this.
   */
  private async cleanupExpiredRecovery(
    now: number,
    { fromAcquisition = false }: { fromAcquisition?: boolean } = {},
  ): Promise<boolean> {
    if (this.acquisitionInFlight && !fromAcquisition) return false;
    const state = this.deps.store.getComputeState();
    if (
      state?.status !== "recoverable" ||
      !state.recoveryRef ||
      state.recoveryExpiresAt === null ||
      state.recoveryExpiresAt > now
    )
      return false;
    try {
      await this.deps.backend.destroy(state.recoveryRef);
    } catch (error) {
      if (!this.isRuntimeMissing(error)) throw error;
    }
    this.stopRunningProcesses(now, {
      deliver: true,
      detail: "process stopped (recovery window expired)",
    });
    this.clearWatchers();
    this.deps.store.markAbsent(now);
    await this.clearLifecycleState();
    await this.deps.clearAlarm?.();
    this.emitLifecycleEvent("recovery_expiry", "recoverable_to_absent", "success");
    await this.deps.deliverSystemReminder?.(EXPIRED_RECOVERY_REMINDER, "deferred");
    return true;
  }

  private async markRuntimeMissing(): Promise<void> {
    const now = this.deps.now();
    this.stopRunningProcesses(now, {
      deliver: true,
      detail: "process stopped (environment no longer exists)",
    });
    this.clearWatchers();
    this.deps.store.markAbsent(now);
    // The container is gone: its ledger row must go too, or it holds a phantom
    // slot for the rest of its TTL.
    await this.deps.quota?.release();
    await this.clearLifecycleState();
    await this.deps.clearAlarm?.();
    await this.deps.deliverSystemReminder?.(LOST_COMPUTE_REMINDER, "deferred");
  }

  /**
   * Stop every running process because the CONTAINER is going away, and close
   * each one's ledger row on the spot — the same funnel `execStop` and
   * `stopAllRunningProcesses` use, and for the same reason: a teardown settles
   * the process and drops its watcher, so a row left open here can never be
   * stamped again.
   *
   * Closing is not cosmetic. The next acquire writes a fresh generation nonce
   * (`readOrAcquireRuntime`) — including on a recovery RESTORE, by design — so
   * a surviving row carries a diverged nonce and `classifyWork` faults it
   * `sandbox_reset`: "the filesystem is now empty… usually the container
   * running out of memory". That is false after an `exec_shutdown` the model
   * asked for, and it is the exact inverse of the truth after a preserving
   * release, whose entire purpose was to keep the files. The model acts on
   * that sentence — in the incident it re-cloned the repo three times.
   *
   * `stopped`, never `exited`: the container was torn down mid-run, so the
   * output is partial and reporting a clean exit would have the model read a
   * truncated tail as the finished result.
   *
   * @param deliver Stamp the delivery gate, suppressing the reaper's per-process
   * card. Pass `true` only when the caller delivers a system reminder that
   * already tells the model these processes are gone (`exec_shutdown`, discard,
   * expired recovery, lost compute). The preserving release delivers no such
   * reminder, so it passes `false` and lets the reaper say the work was stopped
   * before it finished — the alternative there is silence.
   */
  private stopRunningProcesses(now: number, options: { deliver: boolean; detail: string }): void {
    for (const process of this.deps.store.listProcesses(1_000)) {
      if (process.status !== "running") continue;
      this.deps.store.updateProcess(process.id, { status: "stopped", finishedAt: now });
      const closed = this.deps.workLedger?.terminalize(process.id, {
        outcome: "stopped",
        reason: "process_stopped",
        at: now,
        detail: options.detail,
      });
      // Only when this call actually closed the row: a false return means the
      // reaper got there first and may still genuinely owe its delivery.
      if (closed && options.deliver) this.deps.workLedger?.markDelivered(process.id, now);
    }
  }

  private clearWatchers(): void {
    for (const watcher of this.deps.store.listWatchers())
      this.deps.store.deleteWatcher(watcher.processId);
  }

  private async clearLifecycleState(): Promise<void> {
    await this.deps.markSandboxDirty?.();
  }

  private supportsProcessMonitor(): boolean {
    return this.deps.supportsProcessMonitor !== false;
  }

  private computeReleaseAt(): number | null {
    const state = this.deps.store.getComputeState();
    return state ? state.lastUsedAt + this.deps.config.idleTimeoutMs : null;
  }

  private async refreshRelease(delayMs: number): Promise<void> {
    if (this.deps.attachedRuntime) return;
    await this.deps.quota?.refresh();
    await this.armAlarm(this.deps.now() + delayMs);
  }

  /**
   * The thread's ONLY arm point. Every wake reason — eviction/release,
   * watcher polls, and the work ledger's sweep horizon — is min-folded here.
   * Never add a second `setAlarm`/`scheduleEviction` caller: the scheduler
   * cancels the prior schedule, so a second arm point does not add an alarm,
   * it REPLACES this one.
   */
  private async armAlarm(releaseAt: number | null): Promise<void> {
    const wakeAt = nextWakeAt(
      this.deps.store.listWatchers(),
      releaseAt,
      this.deps.getWorkHorizon?.() ?? null,
    );
    if (wakeAt === null) return;
    await this.deps.setAlarm(wakeAt);
    // Count only a setAlarm that RESOLVED: a throw armed nothing, and the
    // callback's fallback is the only thing left that could still wake us.
    this.armCount += 1;
  }

  private requireProcess(processId: string): ComputeProcessRecord {
    const process = this.deps.store.getProcess(processId);
    if (!process) throw new ComputeError("process_missing");
    return process;
  }

  private requireProcessReference(
    processId: string,
  ): ComputeProcessRecord & { backendProcessRef: BackendProcessReference } {
    const process = this.requireProcess(processId);
    if (!process.backendProcessRef) throw new ComputeError("process_missing");
    return process as ComputeProcessRecord & { backendProcessRef: BackendProcessReference };
  }

  private isRuntimeMissing(error: unknown): boolean {
    return error instanceof ComputeError && error.code === "runtime_missing";
  }

  private emitLifecycleEvent(
    event: ComputeEvent["event"],
    transition: string,
    outcome: ComputeEvent["outcome"],
    durationMs?: number,
  ): void {
    this.emit({
      event,
      provider: this.deps.backend.id,
      profile: this.deps.config.resourceProfile,
      transition,
      outcome,
      ...(durationMs === undefined ? {} : { durationMs }),
    });
  }

  private emitCommandEvent(
    event: "command_completion" | "command_timeout" | "command_stop",
    processId: string,
    outcome: ComputeEvent["outcome"],
    durationMs?: number,
  ): void {
    const process = this.deps.store.getProcess(processId);
    this.emit({
      event,
      provider: this.deps.backend.id,
      profile: this.deps.config.resourceProfile,
      outcome,
      ...(durationMs === undefined ? {} : { durationMs }),
      ...(process ? { stdoutBytes: process.stdoutBytes, stderrBytes: process.stderrBytes } : {}),
    });
  }

  private emit(event: ComputeEvent): void {
    if (this.deps.recordEvent) this.deps.recordEvent(event);
    else recordComputeEvent(event);
  }
}

function sameAllowedHosts(
  acquired: string[] | null | undefined,
  desired: string[] | null,
): boolean {
  if (desired === null) return acquired === null || acquired === undefined;
  if (acquired === undefined || acquired === null) return false;
  const normalize = (hosts: string[]) =>
    [...new Set(hosts.map((host) => host.trim().toLowerCase()).filter(Boolean))].sort();
  return JSON.stringify(normalize(acquired)) === JSON.stringify(normalize(desired));
}

function validateComputePath(value: string): string {
  const path = value.trim();
  if (!path || path.includes("\0") || path.split("/").includes(".."))
    throw new Error("compute_invalid_path");
  return path;
}

function defaultSleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Parses `ComputeBackend.buildBackstopProbe`'s stdout for a `nadi-rc:<n>`
 * MARKED line, scanning from the end. Never the first line, and never a bare
 * unmarked number: sprites' fast-path replay can merge stderr onto the same
 * stream ahead of a command's real output (the same live hazard `parseStat`,
 * a few hundred lines down, exists to survive), so a warning line landing
 * before the marker must not shift which line this reads. Scanning backward
 * from the end also means a stray line that merged in AFTER the marker
 * cannot mask it either.
 *
 * Preserves the same "unparsable means no answer" contract `readRcOnce`
 * (sprites.ts) applies to its own sentinel reads: no marker line, an empty
 * read, or anything that isn't a bare integer after the marker must never be
 * mistaken for exit code 0.
 */
function parseBackstopRc(stdout: string): number | undefined {
  const lines = stdout.split("\n");
  for (let i = lines.length - 1; i >= 0; i -= 1) {
    const match = /^nadi-rc:(-?\d+)$/.exec((lines[i] ?? "").trim());
    if (!match) continue;
    const code = Number.parseInt(match[1] ?? "", 10);
    return Number.isSafeInteger(code) ? code : undefined;
  }
  return undefined;
}
