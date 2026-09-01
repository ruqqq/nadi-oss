import type {
  BackendProcessReference,
  BackendReference,
  ComputeBackend,
  ComputeProviderId,
  ComputeSpec,
  DirEntry,
  PathInfo,
  ProcessOutput,
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

/**
 * The `mock` compute provider: an in-memory sandbox for LOCAL development, so a
 * workspace can enable the sandbox and the exec/file tools run without Daytona
 * credentials, Cloudflare containers (Docker), or R2. It is the compute analogue
 * of the `mock` model provider — a real, selectable provider that never leaves
 * the Worker. It is never selected in production (the default is `cloudflare`);
 * `DEFAULT_SANDBOX_PROVIDER=mock` in `.dev.vars` opts local dev into it.
 *
 * State lives in a PROCESS-GLOBAL map keyed by sandbox id (not per instance):
 * `buildComputeBackend` constructs a fresh backend every turn, and a thread's
 * runtime reference is persisted in DO storage across turns, so the state a
 * later turn recovers must outlive the instance that created it. It resets when
 * the Worker process restarts (a `wrangler dev` reload) — acceptable for a
 * local-only stand-in, and recovery degrades to a fresh sandbox rather than
 * throwing so a reload never wedges a thread.
 */

type MockRuntimeStatus = "ready" | "suspended";
type MockProcessStatus = "running" | "exited" | "failed" | "stopped";

interface MockProcess {
  status: MockProcessStatus;
  exitCode: number | undefined;
  stdout: string;
  stderr: string;
}

interface MockSandbox {
  status: MockRuntimeStatus;
  directories: Set<string>;
  files: Map<string, Uint8Array>;
  processes: Map<string, MockProcess>;
  processSeq: number;
}

/** Survives per-turn backend re-construction; see the file header. */
const SANDBOXES = new Map<string, MockSandbox>();
let sandboxSeq = 0;

function seedSandbox(workspaceRoot: string): MockSandbox {
  return {
    status: "ready",
    // `/tmp` mirrors the real containers `readGeneration` probes as a liveness
    // witness; the workspace root is where the agent's work lands.
    directories: new Set(["/", "/tmp", workspaceRoot]),
    files: new Map(),
    processes: new Map(),
    processSeq: 0,
  };
}

export class MockComputeBackend implements ComputeBackend {
  readonly id: ComputeProviderId = "mock";

  async acquire(spec: ComputeSpec, recovery?: BackendReference): Promise<BackendReference> {
    if (recovery) {
      const sandboxId = referenceSandboxId(recovery);
      // Lenient recovery: a missing sandbox (e.g. after a dev-server restart)
      // is restored as a fresh one instead of throwing, so a reload never
      // strands a thread that persisted a now-stale recovery reference.
      const sandbox = SANDBOXES.get(sandboxId) ?? seedSandbox(spec.workspaceRoot);
      sandbox.status = "ready";
      SANDBOXES.set(sandboxId, sandbox);
      return runtimeReference(sandboxId);
    }
    sandboxSeq += 1;
    const sandboxId = `mock_${sandboxSeq}_${spec.environmentId}`;
    SANDBOXES.set(sandboxId, seedSandbox(spec.workspaceRoot));
    return runtimeReference(sandboxId);
  }

  async release(
    runtime: BackendReference,
    options: ReleaseOptions,
  ): Promise<BackendReference | null> {
    const sandboxId = referenceSandboxId(runtime);
    if (options.disposition === "discard") {
      SANDBOXES.delete(sandboxId);
      return null;
    }
    const sandbox = SANDBOXES.get(sandboxId);
    if (sandbox) sandbox.status = "suspended";
    return recoveryReference(sandboxId);
  }

  /** {@link ComputeBackend.externalRuntimeId} — the in-memory sandbox id. */
  externalRuntimeId(reference: BackendReference): string | null {
    try {
      return referenceSandboxId(reference);
    } catch {
      return null;
    }
  }

  async destroy(reference: BackendReference): Promise<void> {
    SANDBOXES.delete(referenceSandboxId(reference));
  }

  async startProcess(
    runtime: BackendReference,
    input: StartProcessInput,
  ): Promise<StartProcessResult> {
    const { sandbox, sandboxId } = this.activeSandbox(runtime);
    const { processId, state } = this.runFakeProcess(sandbox, input.command, input.stdin);
    const process = processReference(sandboxId, processId);
    return {
      process,
      status: state.status,
      stdout: state.stdout,
      stderr: state.stderr,
      ...(state.exitCode === undefined ? {} : { exitCode: state.exitCode }),
    };
  }

  async runCommand(runtime: BackendReference, input: RunCommandInput): Promise<RunCommandResult> {
    const { sandbox } = this.activeSandbox(runtime);
    // stdin echoed into stdout, exactly as `startProcess` models it here.
    const { state } = this.runFakeProcess(sandbox, input.command, input.stdin, {
      foreground: true,
    });
    return {
      status: state.exitCode === 0 ? "exited" : "failed",
      exitCode: state.exitCode ?? 0,
      stdout: state.stdout,
      stderr: state.stderr,
    };
  }

  async getProcessStatus(
    runtime: BackendReference,
    process: BackendProcessReference,
  ): Promise<ProcessStatus> {
    const state = this.requireProcess(runtime, process);
    return {
      status: state.status,
      ...(state.exitCode === undefined ? {} : { exitCode: state.exitCode }),
    };
  }

  async readProcessOutput(
    runtime: BackendReference,
    process: BackendProcessReference,
  ): Promise<ProcessOutput> {
    const state = this.requireProcess(runtime, process);
    return { stdout: state.stdout, stderr: state.stderr };
  }

  async stopProcess(
    runtime: BackendReference,
    process: BackendProcessReference,
    _mode: StopMode,
  ): Promise<ProcessStatus> {
    const state = this.requireProcess(runtime, process);
    if (state.status === "running") {
      state.status = "stopped";
      state.exitCode = 130;
    }
    return {
      status: state.status,
      ...(state.exitCode === undefined ? {} : { exitCode: state.exitCode }),
    };
  }

  async inspectPath(runtime: BackendReference, path: string): Promise<PathInfo | null> {
    const sandbox = this.runtime(referenceSandboxId(runtime));
    const file = sandbox.files.get(path);
    if (file) return { type: "file", size: file.byteLength, resolvedPath: path };
    if (sandbox.directories.has(path)) return { type: "directory", size: 0, resolvedPath: path };
    return null;
  }

  async pathExists(runtime: BackendReference, path: string): Promise<boolean> {
    const sandbox = this.runtime(referenceSandboxId(runtime));
    return sandbox.files.has(path) || sandbox.directories.has(path);
  }

  async listDirectory(runtime: BackendReference, path: string): Promise<DirEntry[]> {
    const sandbox = this.runtime(referenceSandboxId(runtime));
    if (!sandbox.directories.has(path)) {
      throw new ComputeError("provider_transient", "mock_directory_not_found");
    }
    const entries: DirEntry[] = [];
    for (const filePath of sandbox.files.keys()) {
      if (parentPath(filePath) === path) entries.push({ name: baseName(filePath), type: "file" });
    }
    for (const directoryPath of sandbox.directories) {
      if (directoryPath !== path && parentPath(directoryPath) === path) {
        entries.push({ name: baseName(directoryPath), type: "directory" });
      }
    }
    return entries;
  }

  async readFile(
    runtime: BackendReference,
    path: string,
    maxBytes: number,
  ): Promise<ReadFileResult> {
    const sandbox = this.runtime(referenceSandboxId(runtime));
    const file = sandbox.files.get(path);
    if (!file) throw new ComputeError("provider_transient", "mock_file_not_found");
    if (file.byteLength > maxBytes) {
      throw new ComputeError("compute_file_too_large", "mock_file_too_large");
    }
    const bytes = file.buffer.slice(
      file.byteOffset,
      file.byteOffset + file.byteLength,
    ) as ArrayBuffer;
    return { bytes };
  }

  async writeFile(
    runtime: BackendReference,
    path: string,
    bytes: ArrayBuffer,
    options: WriteFileOptions,
  ): Promise<void> {
    const sandbox = this.runtime(referenceSandboxId(runtime));
    const parent = parentPath(path);
    if (options.createParents) createParents(sandbox.directories, parent);
    if (!sandbox.directories.has(parent)) {
      throw new ComputeError("provider_transient", "mock_parent_directory_missing");
    }
    if (!options.overwrite && sandbox.files.has(path)) {
      throw new ComputeError("provider_transient", "mock_file_already_exists");
    }
    sandbox.files.set(path, new Uint8Array(bytes.slice(0)));
  }

  async createDirectory(runtime: BackendReference, path: string): Promise<void> {
    const sandbox = this.runtime(referenceSandboxId(runtime));
    createParents(sandbox.directories, parentPath(path));
    sandbox.directories.add(path);
  }

  async deletePath(runtime: BackendReference, path: string): Promise<void> {
    const sandbox = this.runtime(referenceSandboxId(runtime));
    sandbox.files.delete(path);
    for (const filePath of sandbox.files.keys()) {
      if (filePath.startsWith(`${path}/`)) sandbox.files.delete(filePath);
    }
    for (const directoryPath of sandbox.directories) {
      if (directoryPath === path || directoryPath.startsWith(`${path}/`)) {
        sandbox.directories.delete(directoryPath);
      }
    }
  }

  async movePath(
    runtime: BackendReference,
    from: string,
    to: string,
    overwrite: boolean,
  ): Promise<void> {
    const sandbox = this.runtime(referenceSandboxId(runtime));
    const sourceFile = sandbox.files.get(from);
    if (!sourceFile && !sandbox.directories.has(from)) {
      throw new ComputeError("provider_transient", "mock_move_source_not_found");
    }
    if (!overwrite && (sandbox.files.has(to) || sandbox.directories.has(to))) {
      throw new ComputeError("provider_transient", "mock_move_destination_exists");
    }
    await this.deletePath(runtime, to);
    createParents(sandbox.directories, parentPath(to));
    if (sourceFile) {
      sandbox.files.set(to, sourceFile);
      sandbox.files.delete(from);
      return;
    }
    const directories = [...sandbox.directories].filter(
      (directoryPath) => directoryPath === from || directoryPath.startsWith(`${from}/`),
    );
    const files = [...sandbox.files.entries()].filter(([filePath]) =>
      filePath.startsWith(`${from}/`),
    );
    for (const directoryPath of directories) sandbox.directories.delete(directoryPath);
    for (const [filePath] of files) sandbox.files.delete(filePath);
    for (const directoryPath of directories) {
      sandbox.directories.add(`${to}${directoryPath.slice(from.length)}`);
    }
    for (const [filePath, file] of files) {
      sandbox.files.set(`${to}${filePath.slice(from.length)}`, file);
    }
  }

  private runFakeProcess(
    sandbox: MockSandbox,
    command: string,
    stdin: string | undefined,
    options: { foreground?: boolean } = {},
  ): { processId: string; state: MockProcess } {
    sandbox.processSeq += 1;
    const processId = `mock_proc_${sandbox.processSeq}`;
    // A long-running `sleep` stays "running" for a foreground-less start so the
    // exec background path is exercised; everything else finishes immediately.
    const isSleep = !options.foreground && /^\s*sleep\b/.test(command);
    const state: MockProcess = {
      status: isSleep ? "running" : "exited",
      exitCode: isSleep ? undefined : 0,
      stdout: simulateStdout(command) + (stdin ?? ""),
      stderr: "",
    };
    sandbox.processes.set(processId, state);
    return { processId, state };
  }

  private activeSandbox(runtime: BackendReference): { sandbox: MockSandbox; sandboxId: string } {
    const sandboxId = referenceSandboxId(runtime);
    const sandbox = this.runtime(sandboxId);
    if (sandbox.status !== "ready") {
      throw new ComputeError("runtime_missing", "mock_sandbox_suspended");
    }
    return { sandbox, sandboxId };
  }

  private runtime(sandboxId: string): MockSandbox {
    const sandbox = SANDBOXES.get(sandboxId);
    if (!sandbox) throw new ComputeError("runtime_missing", "mock_sandbox_not_found");
    return sandbox;
  }

  private requireProcess(runtime: BackendReference, process: BackendProcessReference): MockProcess {
    const sandbox = this.runtime(referenceSandboxId(runtime));
    const processId = referenceProcessId(process);
    const state = sandbox.processes.get(processId);
    if (!state) throw new ComputeError("process_missing", "mock_process_not_found");
    return state;
  }
}

/** Test-only: wipe the process-global sandbox state between cases. */
export function __resetMockComputeState(): void {
  SANDBOXES.clear();
  sandboxSeq = 0;
}

function runtimeReference(sandboxId: string): BackendReference {
  return { provider: "mock", version: 1, payload: { kind: "runtime", sandboxId } };
}

function recoveryReference(sandboxId: string): BackendReference {
  return { provider: "mock", version: 1, payload: { kind: "recovery", sandboxId } };
}

function processReference(sandboxId: string, processId: string): BackendProcessReference {
  return { provider: "mock", version: 1, payload: { kind: "process", sandboxId, processId } };
}

function payload(reference: BackendReference): {
  kind: string;
  sandboxId: string;
  processId?: string;
} {
  if (
    reference.provider !== "mock" ||
    reference.version !== 1 ||
    typeof reference.payload !== "object" ||
    reference.payload === null
  ) {
    throw new ComputeError("runtime_missing", "mock_reference_invalid");
  }
  const record = reference.payload as { kind?: unknown; sandboxId?: unknown; processId?: unknown };
  if (typeof record.kind !== "string" || typeof record.sandboxId !== "string") {
    throw new ComputeError("runtime_missing", "mock_reference_invalid");
  }
  return {
    kind: record.kind,
    sandboxId: record.sandboxId,
    ...(typeof record.processId === "string" ? { processId: record.processId } : {}),
  };
}

function referenceSandboxId(reference: BackendReference): string {
  return payload(reference).sandboxId;
}

function referenceProcessId(process: BackendProcessReference): string {
  const parsed = payload(process);
  if (parsed.kind !== "process" || typeof parsed.processId !== "string") {
    throw new ComputeError("process_missing", "mock_process_reference_invalid");
  }
  return parsed.processId;
}

/**
 * A best-effort stand-in for a command's stdout. `echo`/`printf` are echoed
 * (so the connection-test probe's `printf nadi-compute-ready` round-trips, and
 * an agent's `echo` shows output); every other command "succeeds" silently.
 * `printf` mirrors the shell in not appending a trailing newline; `echo` does.
 */
function simulateStdout(command: string): string {
  if (command.startsWith("echo ")) return `${command.slice("echo ".length)}\n`;
  if (command.startsWith("printf ")) return command.slice("printf ".length);
  return "";
}

function parentPath(path: string): string {
  const lastSlash = path.lastIndexOf("/");
  return lastSlash <= 0 ? "/" : path.slice(0, lastSlash);
}

function baseName(path: string): string {
  return path.slice(path.lastIndexOf("/") + 1);
}

function createParents(directories: Set<string>, path: string): void {
  const missing: string[] = [];
  for (let current = path; !directories.has(current); current = parentPath(current)) {
    missing.push(current);
    if (current === "/") break;
  }
  for (const directory of missing.reverse()) directories.add(directory);
}
