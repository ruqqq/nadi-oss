import { posix as path } from "node:path";
import { registryDb } from "../db/client";
import { ThreadRepository } from "../db/repositories/threads";
import { AgentRepository } from "../db/repositories/agents";
import type { Env } from "../env";
import type { ThreadComputeService } from "../compute/thread-service";

export interface RepositoryPreparationPrepared {
  name: string;
  checkoutPath: string;
  status: "cloned" | "already_cloned";
  setup: string;
}

export interface RepositoryPreparationSkipped {
  name: string;
  reason: string;
}

export interface RepositoryPreparationResult {
  summary: string;
  prepared?: RepositoryPreparationPrepared[];
  skipped?: RepositoryPreparationSkipped[];
  environmentSetup?: string;
}

// Repository checkouts land under the same root the file tools guard, so a
// relative path resolves identically for exec, read_file, and the model.
const SANDBOX_WORK_ROOT = "/workspace";
// Checkouts made before the /workspace move lived here; migrate them in place so
// a suspended sandbox is not re-cloned (which would strand uncommitted work).
const LEGACY_SANDBOX_WORK_ROOT = "/home/exedev/work";
const REPOSITORY_SETUP_TIMEOUT_MS = 15 * 60 * 1000;
const REPOSITORY_SETUP_POLL_MS = 1_000;

type RepositoryExecService = Pick<ThreadComputeService, "exec" | "execOutput">;
type CommandResult = { ok: true } | { ok: false; exitCode: number | null; status: string };
type PathProbeResult = { kind: "exists" } | { kind: "missing" } | { kind: "error"; reason: string };
type GitProbeResult = { kind: "git" } | { kind: "not_git" } | { kind: "error"; reason: string };

export function createRepositoryPreparation(input: {
  env: Env;
  threadId: string;
  resolveComputeService: () => Promise<{ service: RepositoryExecService } | null>;
}): () => Promise<RepositoryPreparationResult> {
  return async () => {
    const db = registryDb(input.env);
    // LIVE, not snapshotted: a thread clones whatever its AGENT currently
    // declares, so editing the repository list takes effect on the next
    // preparation. The per-thread snapshot this used to read is gone — a shared
    // box cannot honour a per-thread config version.
    //
    // Keyed on `agentId`, which is what `agent_repositories.agent_id` holds now.
    // That column's values and this key moved in one commit deliberately: a lag
    // in either direction returns zero rows, which lands in the branch below
    // with an EMPTY `skipped` list, so nothing is cloned and nothing anywhere
    // says so. See the tests for both no-op branches.
    const configId = (await new ThreadRepository(db).getById(input.threadId))?.agentId ?? null;
    if (configId === null) {
      return { summary: "No project repositories are configured for this thread." };
    }
    const environmentRepo = new AgentRepository(db);
    // Ordered by id — the same order the snapshot rows were built and read in.
    const repositories = await environmentRepo.listRepositories(configId);
    // Preserved exactly: with no repositories configured this returns BEFORE
    // resolving compute and before the environment setup script. An environment
    // whose only content is a setup script never ran it, and this task is not
    // the place to change that.
    if (repositories.length === 0) {
      return { summary: "No project repositories are configured for this thread." };
    }

    const resolved = await input.resolveComputeService();
    if (!resolved) throw new Error("sandbox execution is not enabled for this thread");

    const rootPreparation = await runCommand(
      resolved.service,
      rootPreparationCommand(),
      undefined,
      "prepare sandbox work root",
    );
    if (!rootPreparation.ok) {
      throw new Error(
        `prepare sandbox work root failed${formatExitCodeSuffix(rootPreparation.exitCode)}`,
      );
    }

    const prepared: RepositoryPreparationPrepared[] = [];
    const skipped: RepositoryPreparationSkipped[] = [];
    for (const repository of repositories) {
      const checkoutPath = path.join(SANDBOX_WORK_ROOT, repository.checkoutPathName);
      const repositoryRoot = resolveRepositoryRoot(checkoutPath, repository.rootDirectory);
      const pathProbe = await pathExists(resolved.service, checkoutPath);
      if (pathProbe.kind === "error") {
        skipped.push({
          name: repository.name,
          reason: pathProbe.reason,
        });
        continue;
      }
      if (pathProbe.kind === "missing") {
        const cloneResult = await runCommand(
          resolved.service,
          `git clone ${formatCloneUrlForShell(repository.url)} ${shellQuote(checkoutPath)}`,
          undefined,
          `clone ${repository.name}`,
        );
        if (!cloneResult.ok) {
          skipped.push({
            name: repository.name,
            reason: formatFailedCommandReason("clone", cloneResult),
          });
          continue;
        }
        if (repository.defaultBranch.trim() !== "") {
          const checkoutResult = await runCommand(
            resolved.service,
            `git -C ${shellQuote(checkoutPath)} checkout ${shellQuote(repository.defaultBranch)}`,
            undefined,
            `checkout ${repository.name}`,
          );
          if (!checkoutResult.ok) {
            skipped.push({
              name: repository.name,
              reason: formatFailedCommandReason("checkout", checkoutResult),
            });
            continue;
          }
        }
        prepared.push(
          await prepareRepositoryCheckout({
            service: resolved.service,
            name: repository.name,
            checkoutPath,
            repositoryRoot,
            status: "cloned",
            setupCommand: repository.setupCommand,
          }),
        );
        continue;
      }

      const gitProbe = await isGitRepository(resolved.service, checkoutPath);
      if (gitProbe.kind === "error") {
        skipped.push({
          name: repository.name,
          reason: gitProbe.reason,
        });
        continue;
      }
      if (gitProbe.kind === "not_git") {
        skipped.push({
          name: repository.name,
          reason: "path exists but is not a git checkout",
        });
        continue;
      }

      const remoteUrl = await readOriginRemoteUrl(resolved.service, checkoutPath);
      if (!remoteUrl || normalizeGitUrl(remoteUrl) !== normalizeGitUrl(repository.url)) {
        skipped.push({
          name: repository.name,
          reason: "path exists but remote does not match configured repository",
        });
        continue;
      }

      prepared.push(
        await prepareRepositoryCheckout({
          service: resolved.service,
          name: repository.name,
          checkoutPath,
          repositoryRoot,
          status: "already_cloned",
          setupCommand: repository.setupCommand,
        }),
      );
    }

    const environmentSetup = await runEnvironmentSetup(environmentRepo, configId, resolved.service);

    return {
      summary: "Repositories are ready for coding work.",
      ...(prepared.length > 0 ? { prepared } : {}),
      ...(skipped.length > 0 ? { skipped } : {}),
      ...(environmentSetup !== null ? { environmentSetup } : {}),
    };
  };
}

// Runs the environment bundle's setup script exactly once, after every repo has
// been cloned and had its own per-repo setup run — so environment-level setup
// (e.g. cross-repo tooling) can assume all checkouts already exist. Returns
// `null` (skipped silently) when the thread has no environment bundle or the
// bundle has no setup script configured. Read LIVE, like the repository list.
async function runEnvironmentSetup(
  environmentRepo: AgentRepository,
  configId: string,
  service: RepositoryExecService,
): Promise<string | null> {
  const environment = await environmentRepo.getById(configId);
  if (!environment) return null;
  const script = environment.setupScript.trim();
  if (script === "") return null;

  const result = await runCommand(
    service,
    bashScriptCommand(script),
    SANDBOX_WORK_ROOT,
    "environment setup",
  );
  return result.ok
    ? "environment setup completed"
    : `environment setup failed${formatExitCodeSuffix(result.exitCode)}`;
}

async function prepareRepositoryCheckout(input: {
  service: RepositoryExecService;
  name: string;
  checkoutPath: string;
  repositoryRoot: string;
  status: "cloned" | "already_cloned";
  setupCommand: string;
}): Promise<RepositoryPreparationPrepared> {
  return {
    name: input.name,
    checkoutPath: input.checkoutPath,
    status: input.status,
    setup: await runSetupCommand(
      input.service,
      input.repositoryRoot,
      input.setupCommand,
      input.name,
    ),
  };
}

async function runSetupCommand(
  service: RepositoryExecService,
  repositoryRoot: string,
  setupCommand: string,
  repositoryName: string,
): Promise<string> {
  const command = setupCommand.trim();
  if (command === "") return "no setup command configured";
  const result = await runCommand(
    service,
    bashScriptCommand(command),
    repositoryRoot,
    `setup ${repositoryName}`,
  );
  return result.ok
    ? `${command} completed`
    : `${command} failed${formatExitCodeSuffix(result.exitCode)}`;
}

// Runs an arbitrary multi-line bash script safely: base64 avoids all quoting
// pitfalls, and `set -e` fails the step on the first failing line.
function bashScriptCommand(script: string): string {
  const encoded = Buffer.from(`set -e\n${script}`, "utf8").toString("base64");
  return `printf %s ${shellQuote(encoded)} | base64 -d | bash`;
}

async function runCommand(
  service: RepositoryExecService,
  command: string,
  cwd: string | undefined,
  summary: string,
): Promise<CommandResult> {
  const result = await service.exec({
    command,
    ...(cwd ? { cwd } : {}),
    timeoutMs: REPOSITORY_SETUP_TIMEOUT_MS,
    label: summary,
  });
  if (result.status === "backgrounded") {
    const completed = await waitForBackgroundedCommand(service, result.processId, summary);
    return classifyCommandResult(completed);
  }
  return classifyCommandResult(result);
}

async function waitForBackgroundedCommand(
  service: RepositoryExecService,
  processId: string,
  summary: string,
): Promise<{ status: string; exitCode?: number | undefined; text?: string | undefined }> {
  const startedAt = Date.now();
  while (Date.now() - startedAt < REPOSITORY_SETUP_TIMEOUT_MS) {
    const result = await service.execOutput({ processId, stream: "stdout" });
    if (result.status !== "running") return result;
    await sleep(REPOSITORY_SETUP_POLL_MS);
  }
  throw new Error(`${summary} timed out`);
}

async function pathExists(
  service: RepositoryExecService,
  checkoutPath: string,
): Promise<PathProbeResult> {
  const result = await service.exec({
    command: `sh -lc 'test -e "$1"' -- ${shellQuote(checkoutPath)}`,
    timeoutMs: REPOSITORY_SETUP_TIMEOUT_MS,
    label: "check repository path",
  });
  const code = terminalExitCode(result);
  if (code === 0) return { kind: "exists" };
  if (code === 1) return { kind: "missing" };
  return {
    kind: "error",
    reason: formatProbeFailureReason("repository path probe", result),
  };
}

async function isGitRepository(
  service: RepositoryExecService,
  checkoutPath: string,
): Promise<GitProbeResult> {
  const result = await service.exec({
    command: `git -C ${shellQuote(checkoutPath)} rev-parse --is-inside-work-tree`,
    timeoutMs: REPOSITORY_SETUP_TIMEOUT_MS,
    label: "check git repository",
  });
  const code = terminalExitCode(result);
  if (code === 0) return { kind: "git" };
  if (code !== null) return { kind: "not_git" };
  return {
    kind: "error",
    reason: formatProbeFailureReason("git checkout probe", result),
  };
}

/**
 * A probe's verdict is its EXIT CODE, never its status.
 *
 * The two backends disagree about `status`. Daytona means "ran to completion,
 * whatever the code", so `exited`/1 is how it says "no". Cloudflare maps
 * `exitCode === 0 ? "exited" : "failed"` (`backends/cloudflare.ts:275`), so it
 * says "no" as `failed`/1 and NEVER produces `exited`/1. Probes written against
 * the Daytona shape therefore read every negative answer on Cloudflare as a
 * broken probe: a missing checkout was skipped instead of cloned, so every fresh
 * agent sandbox came up with an empty /workspace and the model had to
 * improvise a clone by hand.
 *
 * Returns null only when the command did not reach a terminal state at all
 * (`stopped`, `backgrounded`) or genuinely reported no code — the cases where
 * "the probe failed" is the honest answer and skipping is right.
 */
function terminalExitCode(result: {
  status: string;
  exitCode?: number | null | undefined;
}): number | null {
  if (result.status !== "exited" && result.status !== "failed") return null;
  return result.exitCode ?? null;
}

async function readOriginRemoteUrl(
  service: RepositoryExecService,
  checkoutPath: string,
): Promise<string | null> {
  const result = await service.exec({
    command: `git -C ${shellQuote(checkoutPath)} remote get-url origin`,
    timeoutMs: REPOSITORY_SETUP_TIMEOUT_MS,
    label: "read origin remote",
  });
  if (result.status === "backgrounded") return null;
  if (!exitedSuccessfully(result)) return null;
  return await readCommandOutput(service, result.processId);
}

async function readCommandOutput(
  service: RepositoryExecService,
  processId: string,
): Promise<string | null> {
  const output = await service.execOutput({ processId, stream: "stdout" });
  if (!exitedSuccessfully(output)) return null;
  return output.text.trim() || null;
}

function classifyCommandResult(result: {
  status: string;
  exitCode?: number | null | undefined;
}): CommandResult {
  if (exitedSuccessfully(result)) return { ok: true };
  return {
    ok: false,
    status: result.status,
    exitCode: result.exitCode ?? null,
  };
}

function exitedSuccessfully(result: {
  status: string;
  exitCode?: number | null | undefined;
}): boolean {
  return (
    result.status === "exited" &&
    (result.exitCode === undefined || result.exitCode === null || result.exitCode === 0)
  );
}

function formatFailedCommandReason(operation: string, result: { exitCode: number | null }): string {
  return `${operation} failed${formatExitCodeSuffix(result.exitCode)}`;
}

function formatProbeFailureReason(
  operation: string,
  result: { status: string; exitCode?: number | null | undefined },
): string {
  if (result.status === "exited") {
    return `${operation} failed with exit code ${result.exitCode ?? "unknown"}`;
  }
  return `${operation} failed (status: ${result.status})`;
}

function formatExitCodeSuffix(exitCode: number | null): string {
  return exitCode === null ? "" : ` with exit code ${exitCode}`;
}

function resolveRepositoryRoot(checkoutPath: string, rootDirectory: string): string {
  const normalizedRoot = rootDirectory.trim();
  if (normalizedRoot === "" || normalizedRoot === "/") return checkoutPath;
  const resolved = path.join(checkoutPath, normalizedRoot.replace(/^\/+/, ""));
  if (resolved !== checkoutPath && !resolved.startsWith(`${checkoutPath}/`)) {
    throw new Error("repository root directory escapes checkout path");
  }
  return resolved;
}

function formatCloneUrlForShell(value: string): string {
  const githubUrl = parseGithubHttpsUrl(value);
  if (!githubUrl) return shellQuote(value);
  return `https://x-access-token:\${GH_TOKEN}@github.com${githubUrl.pathname}`;
}

function normalizeGitUrl(value: string): string {
  const githubUrl = parseGithubHttpsUrl(value);
  const normalized = githubUrl ? `https://github.com${githubUrl.pathname}` : value.trim();
  return normalized.replace(/\.git$/, "").replace(/\/$/, "");
}

function parseGithubHttpsUrl(value: string): URL | null {
  try {
    const parsed = new URL(value.trim());
    if (parsed.protocol !== "https:" || parsed.hostname.toLowerCase() !== "github.com") {
      return null;
    }
    return parsed;
  } catch {
    return null;
  }
}

// Create the work root and migrate any pre-/workspace checkouts into it, moving
// each only when the destination is absent so a fresh checkout is never
// clobbered. Both roots are fixed, metacharacter-free constants, so they embed
// safely; the body uses only double quotes and runs under `sh -lc '…'`.
function rootPreparationCommand(): string {
  return (
    `sh -lc 'mkdir -p ${SANDBOX_WORK_ROOT} && ` +
    `if [ -d ${LEGACY_SANDBOX_WORK_ROOT} ]; then ` +
    `for d in ${LEGACY_SANDBOX_WORK_ROOT}/*/; do ` +
    `[ -d "$d" ] || continue; name="$(basename "$d")"; ` +
    `[ -e "${SANDBOX_WORK_ROOT}/$name" ] || mv "$d" "${SANDBOX_WORK_ROOT}/$name"; ` +
    `done; fi'`
  );
}

function shellQuote(value: string): string {
  return `'${value.replace(/'/g, `'\\''`)}'`;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
