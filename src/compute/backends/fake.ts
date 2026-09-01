import type {
  BackendProcessReference,
  BackendReference,
  ComputeBackend,
  ComputeSpec,
  DirEntry,
  PathInfo,
  ProcessOutput,
  ProcessOutputSink,
  ProcessStatus,
  ReadFileResult,
  ReleaseOptions,
  RunCommandInput,
  RunCommandResult,
  StartProcessInput,
  StartProcessResult,
  StopMode,
  WriteFileOptions,
} from "../backend";
import { ComputeError } from "../errors";
import { PREPARED_GATE_MARKER } from "../workspace-layout";

type FakeRuntimeStatus = "ready" | "suspended";
type FakeProcessStatus = "running" | "exited" | "failed" | "stopped";

interface FakeRuntimeState {
  status: FakeRuntimeStatus;
  directories: Set<string>;
  files: Map<string, Uint8Array>;
  // Optional per-file mime, only set via `seedFile` (writeFile carries no mime).
  fileMimes: Map<string, string>;
  // Symlink targets, only set via `seedSymlink` (used to test path-escape guards).
  symlinks: Map<string, string>;
}

interface FakeProcessState {
  runtimeId: string;
  status: FakeProcessStatus;
  exitCode: number | undefined;
  stdout: string;
  stderr: string;
}

interface LegacySandboxHandle {
  provider: string;
  providerSandboxId: string;
}

interface LegacyProcessHandle {
  processId?: string;
}

type LegacyStartProcessInput = Omit<StartProcessInput, "stdin" | "timeoutMs"> & {
  timeoutMs?: number;
};

type LegacyStartProcessResult = Omit<StartProcessResult, "process" | "status"> & {
  process: LegacyProcessHandle;
  status: "running" | "exited" | "failed";
};

/** In-memory compute backend used by unit and integration tests. */
export class FakeComputeBackend implements ComputeBackend {
  readonly id = "fake" as const;

  readonly acquireCalls: Array<{
    spec: ComputeSpec;
    recovery?: BackendReference;
    runtime: BackendReference;
  }> = [];
  readonly releaseCalls: Array<{
    runtime: BackendReference;
    options: ReleaseOptions;
    recovery: BackendReference | null;
  }> = [];
  readonly destroyCalls: BackendReference[] = [];
  readonly startProcessCalls: Array<{
    command: string;
    cwd?: string;
    completionCallback?: string;
  }> = [];
  readonly runCommandCalls: Array<{ command: string; cwd?: string; stdin?: string }> = [];
  readonly writeFileCalls: Array<{ path: string }> = [];
  readonly movePathCalls: Array<{ from: string; to: string }> = [];
  readonly deletePathCalls: Array<{ path: string }> = [];

  private nextWriteFileError: Error | undefined;
  private nextMovePathError: Error | undefined;
  private nextDeletePathError: Error | undefined;
  private nextPathExistsError: Error | undefined;

  private runtimeSeq = 0;
  private processSeq = 0;
  private readonly runtimes = new Map<string, FakeRuntimeState>();
  private readonly processes = new Map<string, FakeProcessState>();
  private readonly blindInspectPaths = new Set<string>();
  private nextReleaseError: Error | undefined;
  private nextAcquireError: Error | undefined;
  /**
   * Test seam: a persistent per-command answer, matched on a substring of the
   * command.
   *
   * `nextProcessResult` is single-shot and positional, which cannot express
   * "this particular probe answers this, every time". First match wins, so a
   * test can push a later override in front of an earlier one.
   */
  readonly scriptedExits: Array<{ match: string; exitCode: number }> = [];

  /**
   * An exit code this fake will not let a test acquire by accident.
   *
   * Repository preparation's gate is a `sh -lc 'test ...'` carrying
   * `PREPARED_GATE_MARKER` — matched on the marker, NOT on the sentinel's name,
   * which the cleanliness probe also mentions.
   * This fake answers every command 0, so the gate would read "already
   * prepared" by DEFAULT — and a preparation test that forgot to say otherwise
   * would become a no-op that still passed its summary assertion, which is the
   * exact defect class the seam was added for. An empty fake box IS unprepared,
   * so that is what it says; a test wanting "prepared" must push a
   * `scriptedExits` entry and say so out loud.
   *
   * It outranks `nextProcessResult` deliberately: a stray positional stub aimed
   * at some later command must not be able to answer the gate. And when it
   * applies, `nextProcessResult` is left UNCONSUMED, so the stub still reaches
   * the command it was written for.
   */
  private forcedExitFor(command: string): number | undefined {
    const scripted = this.scriptedExits.find((entry) => command.includes(entry.match));
    if (scripted) return scripted.exitCode;
    return command.includes(PREPARED_GATE_MARKER) ? 1 : undefined;
  }

  private nextProcessResult:
    | {
        status: "running" | "exited" | "failed";
        exitCode?: number;
        stdout?: string;
        stderr?: string;
      }
    | undefined;

  lastDomainAllowlist: string[] | undefined;
  lastEnv: Record<string, string> | undefined;

  async acquire(spec: ComputeSpec, recovery?: BackendReference): Promise<BackendReference> {
    if (this.nextAcquireError) {
      const error = this.nextAcquireError;
      this.nextAcquireError = undefined;
      throw error;
    }

    this.lastEnv = spec.env;
    this.lastDomainAllowlist = spec.allowedHosts ?? undefined;
    if (recovery) {
      const runtimeId = this.recoveryRuntimeId(recovery);
      const runtime = this.runtimes.get(runtimeId);
      if (!runtime || runtime.status !== "suspended") {
        throw new ComputeError("recovery_failed", "fake_recovery_not_found");
      }
      runtime.status = "ready";
      const active = this.runtimeReference(runtimeId);
      this.acquireCalls.push({ spec, recovery, runtime: active });
      return active;
    }

    this.runtimeSeq += 1;
    const runtimeId = `fake_runtime_${this.runtimeSeq}_${spec.environmentId}`;
    this.runtimes.set(runtimeId, {
      status: "ready",
      // `/tmp` is not decoration: every real container has one, and
      // `readGeneration` probes it as the container's liveness witness. A fake
      // without it would model a reset container as unreachable.
      directories: new Set(["/", "/tmp", spec.workspaceRoot]),
      files: new Map(),
      fileMimes: new Map(),
      symlinks: new Map(),
    });
    const active = this.runtimeReference(runtimeId);
    this.acquireCalls.push({ spec, runtime: active });
    return active;
  }

  async release(
    runtime: BackendReference,
    options: ReleaseOptions,
  ): Promise<BackendReference | null> {
    if (this.nextReleaseError) {
      const error = this.nextReleaseError;
      this.nextReleaseError = undefined;
      throw error;
    }

    const runtimeId = this.activeRuntimeId(runtime);
    if (options.disposition === "discard") {
      this.removeRuntime(runtimeId);
      this.releaseCalls.push({ runtime, options, recovery: null });
      return null;
    }

    this.runtimes.get(runtimeId)!.status = "suspended";
    const recovery = this.recoveryReference(runtimeId);
    this.releaseCalls.push({ runtime, options, recovery });
    return recovery;
  }

  async destroy(reference: BackendReference): Promise<void> {
    this.destroyCalls.push(reference);
    const runtimeId = this.referenceRuntimeId(reference);
    if (!this.runtimes.has(runtimeId)) {
      throw new ComputeError("runtime_missing", "fake_runtime_not_found");
    }
    this.removeRuntime(runtimeId);
  }

  async startProcess(
    runtime: BackendReference,
    input: StartProcessInput,
  ): Promise<StartProcessResult>;
  async startProcess(
    runtime: LegacySandboxHandle,
    input: LegacyStartProcessInput,
  ): Promise<LegacyStartProcessResult>;
  async startProcess(
    runtime: BackendReference | LegacySandboxHandle,
    input: StartProcessInput | LegacyStartProcessInput,
  ): Promise<StartProcessResult | LegacyStartProcessResult> {
    const runtimeReference = isBackendReference(runtime)
      ? runtime
      : this.legacyRuntimeReference(runtime);
    const runtimeId = this.activeRuntimeId(runtimeReference);
    const result = this.startFakeProcess(runtimeId, input);
    if (isBackendReference(runtime)) return result;

    return {
      ...result,
      process: { processId: this.processId(result.process) },
      status: result.status as "running" | "exited" | "failed",
    };
  }

  /**
   * Run to completion in one call, like the real providers. `nextProcessResult`
   * still steers the outcome, so a test can force a nonzero exit or stderr.
   */
  async runCommand(runtime: BackendReference, input: RunCommandInput): Promise<RunCommandResult> {
    this.runCommandCalls.push({
      command: input.command,
      ...(input.cwd === undefined ? {} : { cwd: input.cwd }),
      ...(input.stdin === undefined ? {} : { stdin: input.stdin }),
    });
    const runtimeId = this.activeRuntimeId(runtime);
    void runtimeId;
    const forced = this.forcedExitFor(input.command);
    // Left unconsumed when `forced` applies — see `forcedExitFor`.
    const configured = forced === undefined ? this.nextProcessResult : undefined;
    if (forced === undefined) this.nextProcessResult = undefined;
    const isEcho = input.command.startsWith("echo ");
    const exitCode = forced ?? configured?.exitCode ?? 0;
    return {
      status: exitCode === 0 ? "exited" : "failed",
      exitCode,
      stdout: configured?.stdout ?? (isEcho ? `${input.command.slice("echo ".length)}\n` : ""),
      stderr: configured?.stderr ?? "",
    };
  }

  async getProcessStatus(
    runtime: BackendReference,
    process: BackendProcessReference,
  ): Promise<ProcessStatus>;
  async getProcessStatus(
    runtime: LegacySandboxHandle,
    process: LegacyProcessHandle,
  ): Promise<ProcessStatus>;
  async getProcessStatus(
    runtime: BackendReference | LegacySandboxHandle,
    process: BackendProcessReference | LegacyProcessHandle,
  ): Promise<ProcessStatus> {
    const runtimeReference = isBackendReference(runtime)
      ? runtime
      : this.legacyRuntimeReference(runtime);
    const state = this.requireProcess(this.activeRuntimeId(runtimeReference), process);
    return {
      status: state.status,
      ...(state.exitCode === undefined ? {} : { exitCode: state.exitCode }),
    };
  }

  async readProcessOutput(
    runtime: BackendReference,
    process: BackendProcessReference,
  ): Promise<ProcessOutput>;
  async readProcessOutput(
    runtime: LegacySandboxHandle,
    process: LegacyProcessHandle,
  ): Promise<ProcessOutput>;
  async readProcessOutput(
    runtime: BackendReference | LegacySandboxHandle,
    process: BackendProcessReference | LegacyProcessHandle,
  ): Promise<ProcessOutput> {
    const runtimeReference = isBackendReference(runtime)
      ? runtime
      : this.legacyRuntimeReference(runtime);
    const state = this.requireProcess(this.activeRuntimeId(runtimeReference), process);
    return { stdout: state.stdout, stderr: state.stderr };
  }

  async streamProcessOutput(
    runtime: BackendReference,
    process: BackendProcessReference,
    sink: ProcessOutputSink,
  ): Promise<void>;
  async streamProcessOutput(
    runtime: LegacySandboxHandle,
    process: LegacyProcessHandle,
    sink: ProcessOutputSink,
  ): Promise<void>;
  async streamProcessOutput(
    runtime: BackendReference | LegacySandboxHandle,
    process: BackendProcessReference | LegacyProcessHandle,
    sink: ProcessOutputSink,
  ): Promise<void> {
    const runtimeReference = isBackendReference(runtime)
      ? runtime
      : this.legacyRuntimeReference(runtime);
    const state = this.requireProcess(this.activeRuntimeId(runtimeReference), process);
    if (state.stdout) await sink.stdout(state.stdout);
    if (state.stderr) await sink.stderr(state.stderr);
  }

  async stopProcess(
    runtime: BackendReference,
    process: BackendProcessReference,
    mode: StopMode,
  ): Promise<ProcessStatus>;
  async stopProcess(
    runtime: LegacySandboxHandle,
    process: LegacyProcessHandle,
    mode: StopMode,
  ): Promise<ProcessStatus & { appliedMode: StopMode }>;
  async stopProcess(
    runtime: BackendReference | LegacySandboxHandle,
    process: BackendProcessReference | LegacyProcessHandle,
    mode: StopMode,
  ): Promise<ProcessStatus & { appliedMode: StopMode }> {
    const runtimeReference = isBackendReference(runtime)
      ? runtime
      : this.legacyRuntimeReference(runtime);
    const state = this.requireProcess(this.activeRuntimeId(runtimeReference), process);
    if (state.status === "running") {
      state.status = "stopped";
      state.exitCode = 130;
    }
    return {
      status: state.status,
      appliedMode: mode,
      ...(state.exitCode === undefined ? {} : { exitCode: state.exitCode }),
    };
  }

  async inspectPath(runtime: BackendReference, path: string): Promise<PathInfo | null> {
    if (this.blindInspectPaths.has(this.activeRuntimeId(runtime) + "\0" + path)) return null;
    const state = this.runtime(this.activeRuntimeId(runtime));
    const symlinkTarget = state.symlinks.get(path);
    if (symlinkTarget) return { type: "symlink", size: 0, resolvedPath: symlinkTarget };
    const file = state.files.get(path);
    if (file) return { type: "file", size: file.byteLength, resolvedPath: path };
    if (state.directories.has(path)) return { type: "directory", size: 0, resolvedPath: path };
    return null;
  }

  async pathExists(runtime: BackendReference, path: string): Promise<boolean> {
    if (this.nextPathExistsError) {
      const error = this.nextPathExistsError;
      this.nextPathExistsError = undefined;
      throw error;
    }
    const state = this.runtime(this.activeRuntimeId(runtime));
    return state.files.has(path) || state.directories.has(path) || state.symlinks.has(path);
  }

  async listDirectory(runtime: BackendReference, path: string): Promise<DirEntry[]> {
    const state = this.runtime(this.activeRuntimeId(runtime));
    // Answers or throws, like the real backends: a directory that is not there
    // is a THROW, never an empty listing. Callers read an answered listing as
    // positive evidence, so a fake that resolved `[]` here would agree with our
    // assumptions instead of with the provider.
    if (!state.directories.has(path)) {
      throw new ComputeError("provider_transient", "fake_directory_not_found");
    }
    const entries: DirEntry[] = [];
    for (const filePath of state.files.keys()) {
      if (parentPath(filePath) === path) entries.push({ name: baseName(filePath), type: "file" });
    }
    for (const directoryPath of state.directories) {
      if (directoryPath !== path && parentPath(directoryPath) === path) {
        entries.push({ name: baseName(directoryPath), type: "directory" });
      }
    }
    for (const linkPath of state.symlinks.keys()) {
      if (parentPath(linkPath) === path)
        entries.push({ name: baseName(linkPath), type: "symlink" });
    }
    return entries;
  }

  async readFile(
    runtime: BackendReference,
    path: string,
    maxBytes: number,
  ): Promise<ReadFileResult> {
    const state = this.runtime(this.activeRuntimeId(runtime));
    const file = state.files.get(path);
    if (!file) throw new ComputeError("provider_transient", "fake_file_not_found");
    if (file.byteLength > maxBytes) {
      // Oversize is a permanent condition, not a transient one: retrying won't help.
      throw new ComputeError("compute_file_too_large", "sandbox_file_too_large");
    }
    const bytes = file.buffer.slice(
      file.byteOffset,
      file.byteOffset + file.byteLength,
    ) as ArrayBuffer;
    const mimeType = state.fileMimes.get(path);
    return { bytes, ...(mimeType ? { mimeType } : {}) };
  }

  /** Test helper: seed a file with a known mime (writeFile carries no mime). */
  seedFile(runtime: BackendReference, path: string, bytes: Uint8Array, mimeType: string): void {
    const state = this.runtime(this.activeRuntimeId(runtime));
    state.files.set(path, bytes);
    state.fileMimes.set(path, mimeType);
  }

  /** Test helper: seed a symlink so `inspectPath` reports a resolvedPath other than `path`. */
  seedSymlink(runtime: BackendReference, path: string, resolvedPath: string): void {
    const state = this.runtime(this.activeRuntimeId(runtime));
    state.symlinks.set(path, resolvedPath);
  }

  /**
   * Test helper: make `inspectPath` report `null` for a path that IS there,
   * modelling Cloudflare's fail-open — an in-band `{ success: false }` listing
   * becomes "does not exist". `pathExists` is deliberately unaffected: that
   * asymmetry is exactly the bug under test.
   */
  seedBlindInspect(runtime: BackendReference, path: string): void {
    this.blindInspectPaths.add(this.activeRuntimeId(runtime) + "\0" + path);
  }

  async writeFile(
    runtime: BackendReference,
    path: string,
    bytes: ArrayBuffer,
    options: WriteFileOptions,
  ): Promise<void> {
    this.writeFileCalls.push({ path });
    if (this.nextWriteFileError) {
      const error = this.nextWriteFileError;
      this.nextWriteFileError = undefined;
      throw error;
    }
    const state = this.runtime(this.activeRuntimeId(runtime));
    const parent = parentPath(path);
    if (options.createParents) this.createParents(state.directories, parent);
    if (!state.directories.has(parent)) {
      throw new ComputeError("provider_transient", "fake_parent_directory_missing");
    }
    if (!options.overwrite && state.files.has(path)) {
      throw new ComputeError("provider_transient", "fake_file_already_exists");
    }
    state.files.set(path, new Uint8Array(bytes.slice(0)));
  }

  async createDirectory(runtime: BackendReference, path: string): Promise<void> {
    const state = this.runtime(this.activeRuntimeId(runtime));
    this.createParents(state.directories, parentPath(path));
    state.directories.add(path);
  }

  async deletePath(runtime: BackendReference, path: string): Promise<void> {
    this.deletePathCalls.push({ path });
    if (this.nextDeletePathError) {
      const error = this.nextDeletePathError;
      this.nextDeletePathError = undefined;
      throw error;
    }
    const state = this.runtime(this.activeRuntimeId(runtime));
    state.files.delete(path);
    for (const filePath of state.files.keys()) {
      if (filePath.startsWith(`${path}/`)) state.files.delete(filePath);
    }
    for (const directoryPath of state.directories) {
      if (directoryPath === path || directoryPath.startsWith(`${path}/`)) {
        state.directories.delete(directoryPath);
      }
    }
  }

  async movePath(
    runtime: BackendReference,
    from: string,
    to: string,
    overwrite: boolean,
  ): Promise<void> {
    this.movePathCalls.push({ from, to });
    if (this.nextMovePathError) {
      const error = this.nextMovePathError;
      this.nextMovePathError = undefined;
      throw error;
    }
    const state = this.runtime(this.activeRuntimeId(runtime));
    const sourceFile = state.files.get(from);
    const sourceDirectory = state.directories.has(from);
    if (!sourceFile && !sourceDirectory) {
      throw new ComputeError("provider_transient", "fake_move_source_not_found");
    }
    if (!overwrite && (state.files.has(to) || state.directories.has(to))) {
      throw new ComputeError("provider_transient", "fake_move_destination_exists");
    }
    await this.deletePath(runtime, to);
    this.createParents(state.directories, parentPath(to));
    if (sourceFile) {
      state.files.set(to, sourceFile);
      state.files.delete(from);
      return;
    }

    const directories = [...state.directories].filter(
      (directoryPath) => directoryPath === from || directoryPath.startsWith(`${from}/`),
    );
    const files = [...state.files.entries()].filter(([filePath]) =>
      filePath.startsWith(`${from}/`),
    );
    for (const directoryPath of directories) state.directories.delete(directoryPath);
    for (const [filePath] of files) state.files.delete(filePath);
    for (const directoryPath of directories) {
      state.directories.add(`${to}${directoryPath.slice(from.length)}`);
    }
    for (const [filePath, file] of files) {
      state.files.set(`${to}${filePath.slice(from.length)}`, file);
    }
  }

  async createSandbox(input: {
    image?: string;
    snapshot?: string;
    env?: Record<string, string>;
    idleTimeoutMs?: number;
    domainAllowlist?: string[];
  }): Promise<LegacySandboxHandle> {
    const runtime = await this.acquire({
      environmentId: input.snapshot ?? input.image ?? "unset",
      profile: "small",
      workspaceRoot: "/workspace",
      env: input.env ?? {},
      maxProcessRuntimeMs: input.idleTimeoutMs ?? 0,
      allowedHosts: input.domainAllowlist ?? null,
    });
    return { provider: this.id, providerSandboxId: this.referenceRuntimeId(runtime) };
  }

  async deleteSandbox(handle: LegacySandboxHandle): Promise<void> {
    await this.destroy(this.legacyRuntimeReference(handle));
  }

  async suspendSandbox(handle: LegacySandboxHandle): Promise<void> {
    await this.release(this.legacyRuntimeReference(handle), { disposition: "recoverable" });
  }

  async resumeSandbox(handle: LegacySandboxHandle): Promise<void> {
    await this.acquire(this.legacySpec(), this.recoveryReference(handle.providerSandboxId));
  }

  async writeProcessInput(
    handle: LegacySandboxHandle,
    process: LegacyProcessHandle,
    input: string,
  ): Promise<void> {
    const state = this.requireProcess(
      this.activeRuntimeId(this.legacyRuntimeReference(handle)),
      process,
    );
    if (state.status !== "running") {
      throw new ComputeError("provider_transient", "fake_process_already_completed");
    }
    state.stdout += input;
  }

  async uploadFile(
    handle: LegacySandboxHandle,
    input: { destinationPath: string; bytes: ArrayBuffer; overwrite: boolean },
  ): Promise<void> {
    await this.writeFile(this.legacyRuntimeReference(handle), input.destinationPath, input.bytes, {
      createParents: true,
      overwrite: input.overwrite,
    });
  }

  async downloadFile(
    handle: LegacySandboxHandle,
    input: { path: string; maxBytes: number },
  ): Promise<{ bytes: ArrayBuffer; filename?: string; mimeType?: string }> {
    const { bytes, mimeType } = await this.readFile(
      this.legacyRuntimeReference(handle),
      input.path,
      input.maxBytes,
    );
    const filename = input.path.split("/").pop();
    return { bytes, ...(filename ? { filename } : {}), ...(mimeType ? { mimeType } : {}) };
  }

  seedExistingSandbox(providerSandboxId: string): void {
    this.runtimes.set(providerSandboxId, {
      status: "ready",
      directories: new Set(["/", "/tmp", "/workspace"]),
      files: new Map(),
      fileMimes: new Map(),
      symlinks: new Map(),
    });
  }

  failNextRelease(error: Error): void {
    this.nextReleaseError = error;
  }

  failNextAcquire(error: Error): void {
    this.nextAcquireError = error;
  }

  failNextWriteFile(error: Error): void {
    this.nextWriteFileError = error;
  }

  failNextMovePath(error: Error): void {
    this.nextMovePathError = error;
  }

  failNextDeletePath(error: Error): void {
    this.nextDeletePathError = error;
  }

  failNextPathExists(error: Error): void {
    this.nextPathExistsError = error;
  }

  deleteRuntimeOutOfBand(runtime: BackendReference): void;
  deleteRuntimeOutOfBand(runtime: LegacySandboxHandle): void;
  deleteRuntimeOutOfBand(runtime: BackendReference | LegacySandboxHandle): void {
    this.removeRuntime(
      isBackendReference(runtime) ? this.referenceRuntimeId(runtime) : runtime.providerSandboxId,
    );
  }

  failNextSuspend(error: Error): void {
    this.failNextRelease(error);
  }

  failNextResume(error: Error): void {
    this.failNextAcquire(error);
  }

  setNextProcessResult(result: {
    status: "running" | "exited" | "failed";
    exitCode?: number;
    stdout?: string;
    stderr?: string;
  }): void {
    this.nextProcessResult = result;
  }

  finishProcess(
    process: BackendProcessReference | LegacyProcessHandle,
    status: "exited" | "failed" = "exited",
    exitCode = 0,
  ): void {
    const processId = isBackendReference(process) ? this.processId(process) : process.processId;
    if (!processId) throw new ComputeError("process_missing", "fake_process_handle_invalid");
    const state = this.processes.get(processId);
    if (!state) throw new ComputeError("process_missing", "fake_process_not_found");
    state.status = status;
    state.exitCode = exitCode;
  }

  private startFakeProcess(runtimeId: string, input: StartProcessInput | LegacyStartProcessInput) {
    this.startProcessCalls.push({
      command: input.command,
      ...(input.cwd === undefined ? {} : { cwd: input.cwd }),
      ...("completionCallback" in input && input.completionCallback !== undefined
        ? { completionCallback: input.completionCallback }
        : {}),
    });
    this.processSeq += 1;
    const processId = `fake_proc_${this.processSeq}`;
    const forced = this.forcedExitFor(input.command);
    // Left unconsumed when `forced` applies — see `forcedExitFor`.
    const configured = forced === undefined ? this.nextProcessResult : undefined;
    if (forced === undefined) this.nextProcessResult = undefined;
    const isSleep = /^\s*sleep\b/.test(input.command);
    const isEcho = input.command.startsWith("echo ");
    const state: FakeProcessState = {
      runtimeId,
      status:
        forced !== undefined ? "exited" : (configured?.status ?? (isSleep ? "running" : "exited")),
      exitCode: forced ?? configured?.exitCode ?? (isSleep ? undefined : 0),
      stdout: configured?.stdout ?? (isEcho ? `${input.command.slice("echo ".length)}\n` : ""),
      stderr: configured?.stderr ?? "",
    };
    if ("stdin" in input && input.stdin) state.stdout += input.stdin;
    this.processes.set(processId, state);
    return {
      process: this.processReference(runtimeId, processId),
      status: state.status,
      stdout: state.stdout,
      stderr: state.stderr,
      ...(state.exitCode === undefined ? {} : { exitCode: state.exitCode }),
    } as StartProcessResult;
  }

  private runtimeReference(runtimeId: string): BackendReference {
    return { provider: this.id, version: 1, payload: { kind: "runtime", runtimeId } };
  }

  private recoveryReference(runtimeId: string): BackendReference {
    return { provider: this.id, version: 1, payload: { kind: "recovery", runtimeId } };
  }

  private processReference(runtimeId: string, processId: string): BackendProcessReference {
    return { provider: this.id, version: 1, payload: { kind: "process", runtimeId, processId } };
  }

  private activeRuntimeId(reference: BackendReference): string {
    const runtimeId = this.runtimeId(reference, "runtime");
    const runtime = this.runtimes.get(runtimeId);
    if (!runtime) {
      throw new ComputeError("runtime_missing", "fake_runtime_not_found");
    }
    if (runtime.status !== "ready") {
      throw new ComputeError("runtime_missing", "fake_sandbox_suspended");
    }
    return runtimeId;
  }

  private recoveryRuntimeId(reference: BackendReference): string {
    return this.runtimeId(reference, "recovery");
  }

  private referenceRuntimeId(reference: BackendReference): string {
    const payload = this.payload(reference);
    if (payload.kind !== "runtime" && payload.kind !== "recovery") {
      throw new ComputeError("runtime_missing", "fake_runtime_reference_invalid");
    }
    return payload.runtimeId;
  }

  private runtimeId(reference: BackendReference, kind: "runtime" | "recovery"): string {
    const payload = this.payload(reference);
    if (payload.kind !== kind) {
      throw new ComputeError("runtime_missing", "fake_runtime_reference_invalid");
    }
    return payload.runtimeId;
  }

  private payload(reference: BackendReference): {
    kind: string;
    runtimeId: string;
    processId?: string;
  } {
    if (
      reference.provider !== this.id ||
      reference.version !== 1 ||
      !isRecord(reference.payload) ||
      typeof reference.payload.kind !== "string" ||
      typeof reference.payload.runtimeId !== "string"
    ) {
      throw new ComputeError("runtime_missing", "fake_runtime_reference_invalid");
    }
    return reference.payload as { kind: string; runtimeId: string; processId?: string };
  }

  private processId(process: BackendProcessReference): string {
    const payload = this.payload(process);
    if (payload.kind !== "process" || typeof payload.processId !== "string") {
      throw new ComputeError("process_missing", "fake_process_reference_invalid");
    }
    return payload.processId;
  }

  private requireProcess(
    runtimeId: string,
    process: BackendProcessReference | LegacyProcessHandle,
  ): FakeProcessState {
    const processId = isBackendReference(process) ? this.processId(process) : process.processId;
    if (!processId) throw new ComputeError("process_missing", "fake_process_handle_invalid");
    const state = this.processes.get(processId);
    if (!state || state.runtimeId !== runtimeId) {
      throw new ComputeError("process_missing", "fake_process_not_found");
    }
    return state;
  }

  private runtime(runtimeId: string): FakeRuntimeState {
    const state = this.runtimes.get(runtimeId);
    if (!state) throw new ComputeError("runtime_missing", "fake_runtime_not_found");
    return state;
  }

  private removeRuntime(runtimeId: string): void {
    this.runtimes.delete(runtimeId);
    for (const [processId, process] of this.processes) {
      if (process.runtimeId === runtimeId) this.processes.delete(processId);
    }
  }

  private legacyRuntimeReference(handle: LegacySandboxHandle): BackendReference {
    if (!this.runtimes.has(handle.providerSandboxId)) {
      throw new ComputeError("runtime_missing", "fake_runtime_not_found");
    }
    return this.runtimeReference(handle.providerSandboxId);
  }

  private legacySpec(): ComputeSpec {
    return {
      environmentId: "legacy",
      profile: "small",
      workspaceRoot: "/workspace",
      env: {},
      maxProcessRuntimeMs: 0,
      allowedHosts: null,
    };
  }

  private createParents(directories: Set<string>, path: string): void {
    const missing: string[] = [];
    for (let current = path; !directories.has(current); current = parentPath(current)) {
      missing.push(current);
    }
    for (const directory of missing.reverse()) directories.add(directory);
  }
}

function isBackendReference(value: unknown): value is BackendReference {
  return isRecord(value) && value.version === 1 && "payload" in value;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function parentPath(path: string): string {
  const lastSlash = path.lastIndexOf("/");
  return lastSlash <= 0 ? "/" : path.slice(0, lastSlash);
}

function baseName(path: string): string {
  return path.slice(path.lastIndexOf("/") + 1);
}
