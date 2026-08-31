import { RpcTarget } from "cloudflare:workers";
import { ComputeError, ComputePartialWriteError, ComputeStaleFileError } from "./errors";
import type { ThreadComputeService } from "./thread-service";

/**
 * Every method returns one of these. NOTHING throws across the RPC boundary:
 * a throw over DO RPC reaches the caller as a phantom rejection it cannot
 * attribute to a call, so failures are encoded here and re-thrown on the near
 * side by {@link unwrapSandboxCall}.
 */
export type SandboxCallResult<T> = { ok: true; value: T } | { ok: false; error: SandboxCallError };

/**
 * The wire form of a caught error.
 *
 * `compute` is what keeps the tool surface honest: `toErrorResult`
 * (`compute-tools.ts:699`) branches on `error instanceof ComputeError` to turn a
 * failure into `{ ok: false, error: <code>, detail }` the model can act on. A
 * plain `{code, message}` would arrive as an anonymous `Error` on the near side
 * and every compute failure would collapse into one opaque string, so the
 * concrete class — and the extra fields its two subclasses carry, which the
 * model uses to retarget a retry — travels with it.
 */
export interface SandboxCallError {
  code: string;
  message: string;
  compute?:
    | { kind: "error" }
    | { kind: "stale"; path: string; currentHash: string }
    | { kind: "partial"; affectedPaths: string[] };
}

export function sandboxFailure(code: string, message: string): SandboxCallResult<never> {
  return { ok: false, error: { code, message } };
}

export function encodeSandboxError(error: unknown): SandboxCallError {
  if (error instanceof ComputeStaleFileError) {
    return {
      code: error.code,
      message: error.message,
      compute: { kind: "stale", path: error.path, currentHash: error.currentHash },
    };
  }
  if (error instanceof ComputePartialWriteError) {
    return {
      code: error.code,
      message: error.message,
      compute: { kind: "partial", affectedPaths: error.affectedPaths },
    };
  }
  if (error instanceof ComputeError) {
    return { code: error.code, message: error.message, compute: { kind: "error" } };
  }
  return {
    code: "sandbox_call_failed",
    message: error instanceof Error ? error.message : String(error),
  };
}

/** Rebuilds the far side's error and throws it, or returns the value. */
export function unwrapSandboxCall<T>(result: SandboxCallResult<T>): T {
  if (result.ok) return result.value;
  throw decodeSandboxError(result.error);
}

export function decodeSandboxError(error: SandboxCallError): Error {
  const compute = error.compute;
  if (compute?.kind === "stale") {
    return new ComputeStaleFileError(compute.path, compute.currentHash, error.message);
  }
  if (compute?.kind === "partial") {
    return new ComputePartialWriteError(compute.affectedPaths, error.message);
  }
  if (compute?.kind === "error") {
    // `code` came off a real `ComputeError`, so it is a `ComputeErrorCode`.
    return new ComputeError(error.code as ComputeError["code"], error.message);
  }
  // A plain `Error`, name untouched: `code` here is the synthetic
  // `sandbox_call_failed`, and stamping it onto `name` would change every
  // `String(error)` log line the near side already writes.
  return new Error(error.message);
}

async function guard<T>(fn: () => Promise<T>): Promise<SandboxCallResult<T>> {
  try {
    return { ok: true, value: await fn() };
  } catch (error) {
    return { ok: false, error: encodeSandboxError(error) };
  }
}

type S = ThreadComputeService;
type Arg<K extends keyof S, N extends number> = S[K] extends (...args: infer A) => unknown
  ? A[N]
  : never;
type Ret<K extends keyof S> = S[K] extends (...args: never[]) => Promise<infer R> ? R : never;
type Call<K extends keyof S> = Promise<SandboxCallResult<Ret<K>>>;
type FileCall<K extends keyof S["files"]> = Promise<
  SandboxCallResult<Awaited<ReturnType<S["files"][K]>>>
>;

/**
 * ONE resolved {@link ThreadComputeService}, reachable over RPC for the life of
 * a turn.
 *
 * The shape is a session and not a flat method-per-operation surface because
 * `resolveComputeService` costs several D1 reads plus a GitHub App token mint —
 * which is exactly why the thread DO memoizes it for the whole turn
 * (`think-thread-agent.ts:1418`). Re-resolving per operation would pay that on
 * every tool call.
 *
 * The file surface is FLAT (`readFile`/`writeFile`/`applyPatch` here, not a
 * nested `files()` target) for two reasons: `service.files` returns a live
 * `ComputeFileService` closing over non-cloneable deps and so cannot cross the
 * boundary at all, and a nested `RpcTarget` would cost a second round trip per
 * file operation plus a second stub whose lifetime would have to be reasoned
 * about separately. The near-side client re-groups them as `.files` locally, so
 * consumers keep the `ComputeFileService` shape they already have.
 */
export class SandboxSession extends RpcTarget {
  constructor(private readonly service: ThreadComputeService) {
    super();
  }

  // --- lifecycle / generation ---
  alarmArmCount(): Call<"alarmArmCount"> {
    return guard(() => this.service.alarmArmCount());
  }
  getGeneration(): Call<"getGeneration"> {
    return guard(() => this.service.getGeneration());
  }
  getGenerationView(): Call<"getGenerationView"> {
    return guard(() => this.service.getGenerationView());
  }
  refreshGeneration(): Call<"refreshGeneration"> {
    return guard(() => this.service.refreshGeneration());
  }
  refreshWorkAlarm(): Call<"refreshWorkAlarm"> {
    return guard(() => this.service.refreshWorkAlarm());
  }
  ensureRuntimeReference(): Call<"ensureRuntimeReference"> {
    return guard(() => this.service.ensureRuntimeReference());
  }
  now(): Call<"now"> {
    return guard(() => this.service.now());
  }

  // --- exec ---
  execStart(input: Arg<"execStart", 0>): Call<"execStart"> {
    return guard(() => this.service.execStart(input));
  }
  exec(input: Arg<"exec", 0>): Call<"exec"> {
    return guard(() => this.service.exec(input));
  }
  execRun(input: Arg<"execRun", 0>): Call<"execRun"> {
    return guard(() => this.service.execRun(input));
  }
  execOutput(input: Arg<"execOutput", 0>): Call<"execOutput"> {
    return guard(() => this.service.execOutput(input));
  }
  execOutputHeadTail(input: Arg<"execOutputHeadTail", 0>): Call<"execOutputHeadTail"> {
    return guard(() => this.service.execOutputHeadTail(input));
  }
  execOutputGrep(input: Arg<"execOutputGrep", 0>): Call<"execOutputGrep"> {
    return guard(() => this.service.execOutputGrep(input));
  }
  execOutputRead(input: Arg<"execOutputRead", 0>): Call<"execOutputRead"> {
    return guard(() => this.service.execOutputRead(input));
  }
  execStatus(input: Arg<"execStatus", 0>): Call<"execStatus"> {
    return guard(() => this.service.execStatus(input));
  }
  execList(input: Arg<"execList", 0>): Call<"execList"> {
    return guard(() => this.service.execList(input));
  }
  execStop(input: Arg<"execStop", 0>): Call<"execStop"> {
    return guard(() => this.service.execStop(input));
  }
  stopAllRunningProcesses(
    input: Arg<"stopAllRunningProcesses", 0>,
  ): Call<"stopAllRunningProcesses"> {
    return guard(() => this.service.stopAllRunningProcesses(input));
  }
  execShutdown(input?: Arg<"execShutdown", 0>): Call<"execShutdown"> {
    return guard(() => this.service.execShutdown(input));
  }
  execUploadFile(input: Arg<"execUploadFile", 0>): Call<"execUploadFile"> {
    return guard(() => this.service.execUploadFile(input));
  }
  execDownloadFile(input: Arg<"execDownloadFile", 0>): Call<"execDownloadFile"> {
    return guard(() => this.service.execDownloadFile(input));
  }
  execPublishArtifact(input: Arg<"execPublishArtifact", 0>): Call<"execPublishArtifact"> {
    return guard(() => this.service.execPublishArtifact(input));
  }

  // --- watchers / processes ---
  execWatch(input: Arg<"execWatch", 0>): Call<"execWatch"> {
    return guard(() => this.service.execWatch(input));
  }
  execUnwatch(input: Arg<"execUnwatch", 0>): Call<"execUnwatch"> {
    return guard(() => this.service.execUnwatch(input));
  }
  execWatchList(): Call<"execWatchList"> {
    return guard(() => this.service.execWatchList());
  }
  listActiveWatchersView(): Call<"listActiveWatchersView"> {
    return guard(() => this.service.listActiveWatchersView());
  }
  autoWatchRunningProcesses(
    input?: Arg<"autoWatchRunningProcesses", 0>,
  ): Call<"autoWatchRunningProcesses"> {
    return guard(() => this.service.autoWatchRunningProcesses(input));
  }
  nextWatcherWakeAt(): Call<"nextWatcherWakeAt"> {
    return guard(() => this.service.nextWatcherWakeAt());
  }
  hasWatcher(processId: Arg<"hasWatcher", 0>): Call<"hasWatcher"> {
    return guard(() => this.service.hasWatcher(processId));
  }
  processReapView(processId: Arg<"processReapView", 0>): Call<"processReapView"> {
    return guard(() => this.service.processReapView(processId));
  }
  reapProcess(
    processId: Arg<"reapProcess", 0>,
    options: Arg<"reapProcess", 1>,
  ): Call<"reapProcess"> {
    return guard(() => this.service.reapProcess(processId, options));
  }
  recordPushedExit(
    processId: Arg<"recordPushedExit", 0>,
    exitCode: Arg<"recordPushedExit", 1>,
  ): Call<"recordPushedExit"> {
    return guard(() => this.service.recordPushedExit(processId, exitCode));
  }
  runComputeTick(): Call<"runComputeTick"> {
    return guard(() => this.service.runComputeTick());
  }

  // --- release / liveness ---
  releaseIfIdle(): Call<"releaseIfIdle"> {
    return guard(() => this.service.releaseIfIdle());
  }
  releaseIfReclaimable(): Call<"releaseIfReclaimable"> {
    return guard(() => this.service.releaseIfReclaimable());
  }
  releaseQuotaSlot(): Call<"releaseQuotaSlot"> {
    return guard(() => this.service.releaseQuotaSlot());
  }
  isComputeLive(): Call<"isComputeLive"> {
    return guard(() => this.service.isComputeLive());
  }
  isComputeLiveOrAcquiring(): Call<"isComputeLiveOrAcquiring"> {
    return guard(() => this.service.isComputeLiveOrAcquiring());
  }
  destroyRecoverableComputeIfPresent(): Call<"destroyRecoverableComputeIfPresent"> {
    return guard(() => this.service.destroyRecoverableComputeIfPresent());
  }
  cleanupExpiredRecoverableCompute(): Call<"cleanupExpiredRecoverableCompute"> {
    return guard(() => this.service.cleanupExpiredRecoverableCompute());
  }

  // --- debug ---
  debugInspectPath(path: Arg<"debugInspectPath", 0>): Call<"debugInspectPath"> {
    return guard(() => this.service.debugInspectPath(path));
  }
  debugRawProcessStatus(processId: Arg<"debugRawProcessStatus", 0>): Call<"debugRawProcessStatus"> {
    return guard(() => this.service.debugRawProcessStatus(processId));
  }

  // --- files (flat facet; see the class doc) ---
  readFile(input: Parameters<S["files"]["readFile"]>[0]): FileCall<"readFile"> {
    return guard(() => this.service.files.readFile(input));
  }
  writeFile(input: Parameters<S["files"]["writeFile"]>[0]): FileCall<"writeFile"> {
    return guard(() => this.service.files.writeFile(input));
  }
  applyPatch(input: Parameters<S["files"]["applyPatch"]>[0]): FileCall<"applyPatch"> {
    return guard(() => this.service.files.applyPatch(input));
  }
}
