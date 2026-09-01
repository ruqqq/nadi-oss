import { posix as path } from "node:path";
import { registryDb } from "../db/client";
import { ThreadRepository } from "../db/repositories/threads";
import { AgentRepository } from "../db/repositories/agents";
import type { Env } from "../env";
import type { ThreadComputeService } from "../compute/thread-service";
import { sha256Hex } from "../compute/files/hash";
import { parseDomainList } from "../compute/config";
import { parseEnvVarsJson } from "../compute/env-vars";
import {
  AGENT_REPOS_ROOT,
  LEGACY_WORKSPACE_ROOT,
  RECLAIM_MARKER,
  RESERVED_WORKSPACE_DIR_NAMES,
  PREPARED_GATE_MARKER,
  PREPARED_SENTINEL_NAME,
  THREAD_WORKTREE_GIT_SCAN_DEPTH,
  WORKSPACE_ROOT,
  agentClonePath,
  threadWorkRoot,
  threadWorktreeBranch,
  threadWorktreePath,
} from "../compute/workspace-layout";

/**
 * How one setup command went, as a VALUE rather than a sentence.
 *
 * It used to be the sentence alone — `"pnpm install failed with exit code 2"`
 * — and that is why a failed setup was marked prepared: the only way to ask
 * "did this fail" was to match a substring, so nothing did. A transient
 * `npm ci` failure became a permanent state, never retried until the agent's
 * configuration changed or the box was destroyed, and never logged. `detail`
 * is still the sentence; `state` is the question the code needs to ask.
 */
export type PreparationStepOutcome =
  | { state: "ok"; detail: string }
  | { state: "skipped"; detail: string }
  | { state: "failed"; detail: string };

export interface RepositoryPreparationPrepared {
  name: string;
  checkoutPath: string;
  status: "cloned" | "already_cloned";
  setup: PreparationStepOutcome;
}

export interface RepositoryPreparationSkipped {
  name: string;
  reason: string;
}

export interface RepositoryPreparationResult {
  summary: string;
  prepared?: RepositoryPreparationPrepared[];
  skipped?: RepositoryPreparationSkipped[];
  environmentSetup?: PreparationStepOutcome;
  /**
   * EVERY reason this run was not clean — skipped repositories and failed setup
   * commands alike, in one list.
   *
   * One list, because it has two consumers that must not be able to disagree:
   * the sentinel is written if and only if this is empty, and the caller logs
   * exactly this. Previously the mark was gated on `skipped` while the setup
   * outcomes were only strings inside `prepared`, so a failed `setupCommand`
   * was both marked prepared AND never logged.
   */
  failures?: string[];
  /**
   * The configuration fingerprint this run was performed FOR, or `null` when
   * there was no configuration to prepare.
   *
   * REQUIRED rather than optional, and returned on every path including the
   * no-op ones, because its only consumer is the caller's suspension record
   * (`AgentSandbox.ensureThreadWorkspacePrepared`): a record stamped with the
   * wrong signature — or with none — suppresses preparation for the rest of a
   * DO wake after the user has already fixed the configuration, and nothing
   * fails. An optional field would let a future return site omit it silently.
   */
  signature: string | null;
}

// The layout is constructed in ONE place; see `compute/workspace-layout.ts`.
// Every checkout lands under the same root the file tools guard, so a relative
// path resolves identically for exec, read_file, and the model.
const REPOSITORY_SETUP_TIMEOUT_MS = 15 * 60 * 1000;
const REPOSITORY_SETUP_POLL_MS = 1_000;

type RepositoryExecService = Pick<ThreadComputeService, "exec" | "execOutput">;
type CommandResult = { ok: true } | { ok: false; exitCode: number | null; status: string };
type PathProbeResult = { kind: "exists" } | { kind: "missing" } | { kind: "error"; reason: string };
type GitProbeResult = { kind: "git" } | { kind: "not_git" } | { kind: "error"; reason: string };

/**
 * A repository as preparation and the signature both see it.
 *
 * Named rather than inlined so the projection has ONE shape: a new
 * `agent_repositories` column reaches the signature only by being added here,
 * at the single load site below, and in the digest — never in one and not the
 * others.
 */
export interface PreparationRepository {
  name: string;
  url: string;
  defaultBranch: string;
  checkoutPathName: string;
  rootDirectory: string;
  setupCommand: string;
}

/**
 * THE agent configuration one preparation is performed for — every input the
 * signature covers, read LIVE from D1 in ONE place.
 *
 * `envVarNames` is a `string[]`, never the map it came from, and that is the
 * whole safeguard rather than a comment: the signature is written into a file
 * inside a sandbox the model can read, so an env var VALUE must be structurally
 * unable to reach it. `preparationSignature` is handed only this type, so there
 * is no value in its scope to hash even by accident. The projection happens at
 * the single load site below.
 *
 * `resourceProfile` is the agent's DECLARED profile, not the one the live box
 * was acquired under (`EffectiveComputeConfig.resourceProfile`, which prefers
 * the stored value while a runtime exists). The signature answers "which
 * configuration was this prepared for", and the declared value is the one a
 * user edits; hashing the effective one would make a profile edit invisible for
 * exactly as long as the stale box lived.
 */
export interface PreparationConfig {
  repositories: PreparationRepository[];
  setupScript: string;
  resourceProfile: string;
  /** Normalized, deduped and SORTED — see {@link preparationSignature}. */
  networkDomainAllowlist: string[];
  /** NAMES only, sorted. Never values. */
  envVarNames: string[];
}

/**
 * Read the agent configuration `threadId` would be prepared for, or `null` when
 * the thread has no agent row.
 *
 * ONE load site for two callers — preparation itself, and the sandbox DO's
 * suspension check, which needs the current signature WITHOUT running a
 * preparation. A second construction of this projection is how the two would
 * come to disagree about what "changed".
 */
export async function loadPreparationConfig(
  env: Env,
  threadId: string,
): Promise<PreparationConfig | null> {
  const db = registryDb(env);
  // LIVE, not snapshotted: a thread clones whatever its AGENT currently
  // declares, so editing the repository list takes effect on the next
  // preparation. The per-thread snapshot this used to read is gone — a shared
  // box cannot honour a per-thread config version.
  //
  // Keyed on `agentId`, which is what `agent_repositories.agent_id` holds now.
  // That column's values and this key moved in one commit deliberately: a lag
  // in either direction returns zero rows, which lands in the caller's no-op
  // branch with an EMPTY `skipped` list, so nothing is cloned and nothing
  // anywhere says so. See the tests for both no-op branches.
  const configId = (await new ThreadRepository(db).getById(threadId))?.agentId ?? null;
  if (configId === null) return null;
  const environmentRepo = new AgentRepository(db);
  // Ordered by id — the same order the snapshot rows were built and read in.
  const repositories = await environmentRepo.listRepositories(configId);
  const agent = await environmentRepo.getById(configId);
  return {
    repositories: repositories.map((repository) => ({
      name: repository.name,
      url: repository.url,
      defaultBranch: repository.defaultBranch,
      checkoutPathName: repository.checkoutPathName,
      rootDirectory: repository.rootDirectory,
      setupCommand: repository.setupCommand,
    })),
    // The setup script is a STANDALONE machine field on the agent now (it used
    // to be a workbench field that only ever appeared alongside repositories),
    // so it is resolved HERE rather than only in the repository path's tail: a
    // user who writes a setup script and adds no repositories must still get it
    // run. Read LIVE, like the repository list.
    setupScript: agent?.setupScript.trim() ?? "",
    resourceProfile: agent?.resourceProfile ?? "",
    // `parseDomainList` already trims, lowercases and drops blanks; the dedupe
    // and the sort are added here so a reorder — or the same domain typed twice
    // — is the SAME configuration. Two agents allowing the same hosts are one
    // configuration, not two.
    networkDomainAllowlist: [
      ...new Set(parseDomainList(agent?.sandboxNetworkDomainAllowlist)),
    ].sort(),
    // The projection to NAMES happens HERE and only here. `parseEnvVarsJson`
    // returns the map; nothing downstream of this line ever holds it.
    envVarNames: Object.keys(parseEnvVarsJson(agent?.sandboxEnvVarsJson)).sort(),
  };
}

/**
 * The current signature for `threadId`, or `null` when there is no agent
 * configuration to prepare. D1 reads only — no sandbox, no `exec`.
 */
export async function currentPreparationSignature(
  env: Env,
  threadId: string,
): Promise<string | null> {
  const config = await loadPreparationConfig(env, threadId);
  return config === null ? null : await preparationSignature(config);
}

export function createRepositoryPreparation(input: {
  env: Env;
  threadId: string;
  resolveComputeService: () => Promise<{ service: RepositoryExecService } | null>;
}): () => Promise<RepositoryPreparationResult> {
  return async () => {
    const config = await loadPreparationConfig(input.env, input.threadId);
    if (config === null) {
      return {
        summary: "No project repositories are configured for this thread.",
        signature: null,
      };
    }
    const { repositories, setupScript } = config;
    // The zero-repo early exit is KEPT for its other purpose: an agent with
    // neither repositories NOR a setup script has nothing to prepare, and must
    // not start acquiring compute just to discover that.
    if (repositories.length === 0 && setupScript === "") {
      return {
        summary: "No project repositories are configured for this thread.",
        signature: null,
      };
    }

    const resolved = await input.resolveComputeService();
    if (!resolved) throw new Error("sandbox execution is not enabled for this thread");

    const signature = await preparationSignature(config);
    const layout = preparedLayout(input.threadId, repositories);
    if (await isAlreadyPrepared(resolved.service, layout, signature)) {
      return { summary: "Repositories were already prepared for this thread.", signature };
    }

    const rootPreparation = await runCommand(
      resolved.service,
      WORKSPACE_SCAFFOLDING_COMMANDS.workRoot({ threadId: input.threadId, signature }),
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
      // TWO paths per repository since P3, and they are not interchangeable.
      // `clonePath` is the AGENT's canonical clone — one per repository for the
      // whole box, owned by git, never the model's cwd. `worktreePath` is THIS
      // thread's `git worktree` of it, and is the only one reported back or
      // used as a working directory.
      const clonePath = agentClonePath(repository.checkoutPathName);
      const worktreePath = threadWorktreePath(input.threadId, repository.checkoutPathName);
      const repositoryRoot = resolveRepositoryRoot(worktreePath, repository.rootDirectory);

      const clone = await ensureAgentClone(resolved.service, repository, clonePath);
      if (clone.kind === "skip") {
        skipped.push({ name: repository.name, reason: clone.reason });
        continue;
      }

      const worktree = await ensureThreadWorktree({
        service: resolved.service,
        clonePath,
        worktreePath,
        branch: threadWorktreeBranch(input.threadId),
        defaultBranch: repository.defaultBranch,
      });
      if (worktree.kind === "skip") {
        skipped.push({ name: repository.name, reason: worktree.reason });
        continue;
      }

      prepared.push(
        await prepareRepositoryCheckout({
          service: resolved.service,
          name: repository.name,
          checkoutPath: worktreePath,
          repositoryRoot,
          status: worktree.status,
          setupCommand: repository.setupCommand,
        }),
      );
    }

    const environmentSetup = await runEnvironmentSetup(
      setupScript,
      resolved.service,
      threadWorkRoot(input.threadId),
    );

    // EVERY way this run fell short, in one list — skips AND failed setup
    // commands. Built once and used twice, so the "is it clean enough to mark"
    // question and the "what do we log" question cannot drift apart. They did:
    // the mark was gated on `skipped` alone, so a repository that cloned fine
    // and whose `pnpm install` exited 2 was marked prepared and never retried,
    // while `agent-sandbox-do.ts` logged only skips and therefore said nothing.
    const failures = [
      ...skipped.map((entry) => `${entry.name}: ${entry.reason}`),
      ...prepared
        .filter((entry) => entry.setup.state === "failed")
        .map((entry) => `${entry.name}: ${entry.setup.detail}`),
      ...(environmentSetup?.state === "failed"
        ? [`environment setup: ${environmentSetup.detail}`]
        : []),
    ];

    // The sentinel is written ONLY on a clean run. Anything in `failures` means
    // something the agent declares is not in the box or did not finish, and
    // recording that as prepared would freeze the thread in that state until
    // its configuration changed or the box was destroyed. Retrying costs a
    // clone attempt (or a setup command) per turn for a genuinely broken
    // configuration; the trade is deliberate, because the alternative is a
    // failure that happens once, silently, and is permanent.
    if (failures.length === 0) {
      await writePreparedSentinel(resolved.service, input.threadId, signature);
    }

    return {
      summary:
        repositories.length === 0
          ? "No repositories are configured for this thread; the agent's setup script ran."
          : "Repositories are ready for coding work.",
      ...(prepared.length > 0 ? { prepared } : {}),
      ...(skipped.length > 0 ? { skipped } : {}),
      ...(environmentSetup !== null ? { environmentSetup } : {}),
      ...(failures.length > 0 ? { failures } : {}),
      signature,
    };
  };
}

/**
 * WHERE the prepared-record lives is the whole design; the name itself is in
 * `workspace-layout.ts`, because the cleanliness probe reads it too.
 *
 * It sits inside the thread's own working directory, so every event that
 * destroys the preparation destroys the record of it, with nobody having to
 * remember: Task 4's reclaim (`rm -rf /workspace/threads/<id>` plus a prune)
 * takes it, a fresh acquire's empty `/workspace` has never had it, and a
 * restore that brings `repos/` back without `threads/` leaves it gone.
 *
 * The alternative — a row in the sandbox DO's storage — was tried and is what
 * this replaces. It survives everything except a fresh acquire, so a reclaimed
 * thread reopened on the SAME box read as prepared, `ensureWorkspaceRootOnce`
 * recreated its directory empty, and it worked with no code in it: H1's exact
 * failure, re-entered through the bookkeeping. It also created a cross-task
 * obligation (Task 4 must delete the row) whose omission fails nothing.
 */

/** Every path a prepared thread must still have, plus its sentinel. */
function preparedLayout(
  threadId: string,
  repositories: Array<{ checkoutPathName: string }>,
): { sentinel: string; required: string[] } {
  return {
    sentinel: path.join(threadWorkRoot(threadId), PREPARED_SENTINEL_NAME),
    required: repositories.flatMap((repository) => [
      agentClonePath(repository.checkoutPathName),
      threadWorktreePath(threadId, repository.checkoutPathName),
    ]),
  };
}

/**
 * Is this thread ALREADY prepared for `signature` — asked of the box itself?
 *
 * ONE `exec`, and it checks two things that a stored answer conflates: that the
 * sentinel records this exact configuration, AND that every clone and worktree
 * it stands for is still on disk. The paths matter because the sentinel and the
 * checkouts can be destroyed independently — a restore of `threads/` without
 * `repos/` leaves a sentinel whose worktrees have no repository behind them, and
 * that direction has no other detector.
 *
 * Positive evidence, in the sense this codebase already uses: the answer "yes"
 * is only reachable when the container answered and every path was found. Any
 * other outcome — a non-zero exit, a probe that never reached a terminal state,
 * a container that could not run it — resolves to "not prepared", which costs an
 * idempotent re-run and never costs an empty working directory.
 *
 * All interpolated values are safe: the paths come from `workspace-layout`'s
 * `assertSafeSegment`, and the signature is a hex digest.
 */
async function isAlreadyPrepared(
  service: RepositoryExecService,
  layout: { sentinel: string; required: string[] },
  signature: string,
): Promise<boolean> {
  const tests = [
    `test "$(cat ${shellQuote(layout.sentinel)} 2>/dev/null)" = ${shellQuote(signature)}`,
    ...layout.required.map((target) => `test -e ${shellQuote(target)}`),
  ].join(" && ");
  const result = await service.exec({
    // The marker rides in a shell comment: inert to `sh`, and the only way a
    // test fake can tell this command apart from the cleanliness probe, which
    // legitimately names the sentinel too. See `PREPARED_GATE_MARKER`.
    command: `sh -lc ${shellQuote(`: ${PREPARED_GATE_MARKER}; ${tests}`)}`,
    timeoutMs: REPOSITORY_SETUP_TIMEOUT_MS,
    label: "check thread preparation",
  });
  return terminalExitCode(result) === 0;
}

/**
 * Record that this thread is prepared for `signature`.
 *
 * Failure is swallowed on purpose and is the SAFE direction: an unwritten
 * sentinel costs one idempotent re-preparation next turn, while refusing the
 * turn over a bookkeeping write would fail work that actually succeeded.
 */
async function writePreparedSentinel(
  service: RepositoryExecService,
  threadId: string,
  signature: string,
): Promise<void> {
  await runCommand(
    service,
    WORKSPACE_SCAFFOLDING_COMMANDS.sentinel({ threadId, signature }),
    undefined,
    "record thread preparation",
  );
}

/**
 * A stable fingerprint of the configuration preparation acts on.
 *
 * Takes {@link PreparationConfig} and nothing else. That is the safeguard on
 * "names, never values": there is no env var map in this scope to hash by
 * mistake, because the projection to names happened at the single load site.
 * The digest is written into `.nadi-prepared` INSIDE the sandbox, which the
 * model can read, so a leaked value would be a leaked secret.
 *
 * Repository order comes from `listRepositories` (by id), which is the order
 * preparation itself iterates, so a reorder there is a real change. The
 * allowlist and the env var names are SORTED at the load site instead: they are
 * sets, and two agents allowing the same hosts in a different order are one
 * configuration.
 *
 * Hashed rather than stored raw so an agent with many repositories cannot grow
 * the file inside the box without bound.
 *
 * `v` is bumped whenever the shape below changes, so a sentinel written by an
 * older deployment cannot be read as covering inputs it never hashed. Bumping
 * it costs one idempotent re-preparation per live thread on rollout, which is
 * the safe direction.
 */
async function preparationSignature(config: PreparationConfig): Promise<string> {
  const payload = JSON.stringify({
    v: 2,
    repositories: config.repositories.map((repository) => [
      repository.name,
      repository.url,
      repository.defaultBranch,
      repository.checkoutPathName,
      repository.rootDirectory,
      repository.setupCommand,
    ]),
    setupScript: config.setupScript,
    resourceProfile: config.resourceProfile,
    networkDomainAllowlist: config.networkDomainAllowlist,
    envVarNames: config.envVarNames,
  });
  return sha256Hex(new TextEncoder().encode(payload).buffer as ArrayBuffer);
}

type EnsureResult<T> = ({ kind: "ok" } & T) | { kind: "skip"; reason: string };

/**
 * Ensures the AGENT's canonical clone exists at `clonePath` and points at the
 * configured repository. Idempotent: a present, matching clone is left alone.
 *
 * This is the only clone in the box. Every thread's worktree is created FROM
 * it, which is exactly why the "exists but is not a git checkout" and "remote
 * does not match" verdicts stay skips rather than a re-clone: a re-clone here
 * would take every other thread's worktree with it.
 */
async function ensureAgentClone(
  service: RepositoryExecService,
  repository: { name: string; url: string; defaultBranch: string },
  clonePath: string,
): Promise<{ kind: "ok" } | { kind: "skip"; reason: string }> {
  const pathProbe = await pathExists(service, clonePath);
  if (pathProbe.kind === "error") return { kind: "skip", reason: pathProbe.reason };

  if (pathProbe.kind === "missing") {
    const cloneResult = await runCommand(
      service,
      `git clone ${formatCloneUrlForShell(repository.url)} ${shellQuote(clonePath)}`,
      undefined,
      `clone ${repository.name}`,
    );
    if (!cloneResult.ok) {
      return { kind: "skip", reason: formatFailedCommandReason("clone", cloneResult) };
    }
    if (repository.defaultBranch.trim() !== "") {
      const checkoutResult = await runCommand(
        service,
        `git -C ${shellQuote(clonePath)} checkout ${shellQuote(repository.defaultBranch)}`,
        undefined,
        `checkout ${repository.name}`,
      );
      if (!checkoutResult.ok) {
        return { kind: "skip", reason: formatFailedCommandReason("checkout", checkoutResult) };
      }
    }
    return { kind: "ok" };
  }

  const gitProbe = await isGitRepository(service, clonePath);
  if (gitProbe.kind === "error") return { kind: "skip", reason: gitProbe.reason };
  if (gitProbe.kind === "not_git") {
    return { kind: "skip", reason: "path exists but is not a git checkout" };
  }

  const remoteUrl = await readOriginRemoteUrl(service, clonePath);
  if (!remoteUrl || normalizeGitUrl(remoteUrl) !== normalizeGitUrl(repository.url)) {
    return {
      kind: "skip",
      reason: "path exists but remote does not match configured repository",
    };
  }
  return { kind: "ok" };
}

/**
 * Ensures THIS thread has its own worktree of the agent's clone.
 *
 * A BRANCH PER THREAD, never a detached HEAD. `worktree add` refuses a branch
 * that is already checked out in another worktree, so every thread that wanted
 * the repository's default branch would collide from the second thread onwards;
 * `-b <branch>` sidesteps that. Detaching would sidestep it too and is rejected
 * deliberately — a detached HEAD is the classic way to lose work, and a later
 * task reclaims these worktrees unconditionally.
 *
 * `worktree prune` first: git keeps an administrative record per worktree, and a
 * directory removed out from under it (a half-finished reclaim, a restore from a
 * backup that predates it) leaves `add` failing with "already registered" for a
 * path that is not there. Pruning is a no-op when the records are consistent.
 *
 * Start point: `origin/<defaultBranch>` when the agent declares one, else the
 * clone's `HEAD` — which a fresh clone leaves on the remote's default branch.
 * NOT a bare `-b` with no start point: that would branch from whatever the
 * clone's main worktree happens to be sitting on.
 *
 * AND `-b` only when the branch does not already exist. `worktree prune` clears
 * the worktree REGISTRATION; it never deletes the branch. So a branch outliving
 * its worktree is reachable and permanent: the reclaim of an archived thread
 * removes `/workspace/threads/<id>` and prunes, and a provider restore can bring
 * `repos/` back without `threads/`. Either way the next turn probes the worktree
 * as missing, runs `add -b`, and git answers "branch already exists" with exit
 * 128 — a skip, forever, for a thread whose code is simply never checked out
 * again. Re-attaching the existing branch restores the thread's own commits
 * instead.
 *
 * `-B` is NOT the alternative. It force-resets the branch to the start point,
 * which silently discards every commit the thread made and never pushed — the
 * one outcome this whole design exists to prevent.
 */
async function ensureThreadWorktree(input: {
  service: RepositoryExecService;
  clonePath: string;
  worktreePath: string;
  branch: string;
  defaultBranch: string;
}): Promise<EnsureResult<{ status: "cloned" | "already_cloned" }>> {
  const pathProbe = await pathExists(input.service, input.worktreePath);
  if (pathProbe.kind === "error") return { kind: "skip", reason: pathProbe.reason };
  if (pathProbe.kind === "exists") return { kind: "ok", status: "already_cloned" };

  const branchProbe = await branchExists(input.service, input.clonePath, input.branch);
  if (branchProbe.kind === "error") return { kind: "skip", reason: branchProbe.reason };

  const declared = input.defaultBranch.trim();
  const startPoint = declared === "" ? "HEAD" : `origin/${declared}`;
  // Re-attach an orphaned branch; create one only when there is none. Stated as
  // two whole command tails rather than a flag toggle so the two shapes are
  // readable side by side: create takes a start point, re-attach must NOT (a
  // start point applied to an existing branch is what `-B` does, and that drops
  // commits).
  const addTail =
    branchProbe.kind === "exists"
      ? `${shellQuote(input.worktreePath)} ${shellQuote(input.branch)}`
      : `-b ${shellQuote(input.branch)} ${shellQuote(input.worktreePath)} ${shellQuote(startPoint)}`;
  const result = await runCommand(
    input.service,
    `git -C ${shellQuote(input.clonePath)} worktree prune && ` +
      `git -C ${shellQuote(input.clonePath)} worktree add ${addTail}`,
    undefined,
    "add thread worktree",
  );
  if (!result.ok) {
    return { kind: "skip", reason: formatFailedCommandReason("worktree add", result) };
  }
  return { kind: "ok", status: "cloned" };
}

/**
 * Does `refs/heads/<branch>` exist in the agent's clone?
 *
 * `show-ref --verify --quiet` is exact-ref, not a glob: `--verify` refuses an
 * abbreviated name, so `nadi/thread-a` cannot match `nadi/thread-abc`. Exit 0
 * means present, non-zero means absent — read through `terminalExitCode` for
 * the same reason every other probe here does (Cloudflare reports any non-zero
 * exit as `failed`, Daytona as `exited`; classifying on status would read every
 * "absent" on Cloudflare as a broken probe).
 */
async function branchExists(
  service: RepositoryExecService,
  clonePath: string,
  branch: string,
): Promise<{ kind: "exists" } | { kind: "missing" } | { kind: "error"; reason: string }> {
  const result = await service.exec({
    command: `git -C ${shellQuote(clonePath)} show-ref --verify --quiet ${shellQuote(`refs/heads/${branch}`)}`,
    timeoutMs: REPOSITORY_SETUP_TIMEOUT_MS,
    label: "check thread branch",
  });
  const code = terminalExitCode(result);
  if (code === 0) return { kind: "exists" };
  if (code !== null) return { kind: "missing" };
  return { kind: "error", reason: formatProbeFailureReason("thread branch probe", result) };
}

// Runs the agent's setup script exactly once, after every repo has been cloned
// and had its own per-repo setup run — so agent-level setup (e.g. cross-repo
// tooling) can assume all checkouts already exist. Returns `null` (skipped
// silently) when the agent has no setup script configured. The script itself is
// resolved by the CALLER, which needs it before it can decide whether acquiring
// compute is worth it at all.
async function runEnvironmentSetup(
  script: string,
  service: RepositoryExecService,
  threadWorkingDirectory: string,
): Promise<PreparationStepOutcome | null> {
  if (script === "") return null;

  // Runs in THIS thread's working directory, not `/workspace`: that is the cwd
  // every later `exec` defaults to, so a setup script that drops a file or a
  // tool beside the checkouts must put it where the model will look for it.
  const result = await runCommand(
    service,
    bashScriptCommand(script),
    threadWorkingDirectory,
    "environment setup",
  );
  return result.ok
    ? { state: "ok", detail: "environment setup completed" }
    : {
        state: "failed",
        detail: `environment setup failed${formatExitCodeSuffix(result.exitCode)}`,
      };
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
): Promise<PreparationStepOutcome> {
  const command = setupCommand.trim();
  if (command === "") return { state: "skipped", detail: "no setup command configured" };
  const result = await runCommand(
    service,
    bashScriptCommand(command),
    repositoryRoot,
    `setup ${repositoryName}`,
  );
  return result.ok
    ? { state: "ok", detail: `${command} completed` }
    : {
        state: "failed",
        detail: `${command} failed${formatExitCodeSuffix(result.exitCode)}`,
      };
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

/**
 * Creates the layout this thread needs and migrates every earlier layout into it.
 *
 * Two migrations, both "move only when the destination is absent" so a fresh
 * checkout is never clobbered:
 *
 * 1. `/workspace/<name>` (pre-P3, one clone per box at the top level) into the
 *    agent's repo root. Skipped for the two names that ARE the new layout.
 * 2. `/home/exedev/work/<name>` (pre-/workspace) into the agent's repo root.
 *
 * The first is not cosmetic. Those checkouts can hold uncommitted work, and
 * this preparation would otherwise clone a second copy alongside them and hand
 * the thread the empty one, leaving the user's work in a directory nothing ever
 * looks at again.
 *
 * ORDER IS LOAD-BEARING, and it is the reverse of the order the two roots were
 * introduced in. A box can carry BOTH — the pre-change command moved
 * `/home/exedev/work/<name>` only when `/workspace/<name>` was absent, so a
 * legacy copy survives beside a live one. Both migrations claim the SAME
 * destination and both are move-only-when-absent, so whichever runs first wins.
 * The `/workspace` copy is the one the user has been editing; the legacy copy
 * is the stale one nothing has touched since before that move. Running legacy
 * first would install the stale copy as the agent's clone and orphan the live
 * one, unreferenced, with nothing failing.
 *
 * Every interpolated path is a fixed constant or has been through
 * `assertSafeSegment`, so none can carry a metacharacter; the body uses only
 * double quotes and runs under `sh -lc '...'`.
 */
/**
 * Everything a preparation writes for `threadId`, and what the signature was.
 * One shape for every entry in {@link WORKSPACE_SCAFFOLDING_COMMANDS}, so the
 * set can be enumerated and run without knowing which one is which.
 */
export interface WorkspaceScaffoldingInput {
  threadId: string;
  signature: string;
}

/**
 * EVERY command this system runs that creates something inside the workspace
 * root WITHOUT a user asking — the box's own scaffolding — as one object.
 *
 * This is not a registry that has to be kept in step with the code; it is where
 * the commands are DEFINED, so a new one is added here or it does not exist.
 * That is the point. The cleanliness probe treats a box as EMPTY — i.e.
 * DISCARDABLE — when the only non-directory entries under the root are ones it
 * excludes by name (`PREPARED_SENTINEL_NAME`). A new scaffolding FILE that
 * nobody told the probe about flips every box in the fleet to `NOREPO FILES`,
 * which preserves it, and a preserved sprite bills until something deletes it.
 * There is no auto-destroy.
 *
 * `workspace-cleanliness-script.test.ts` runs every value here against a real
 * `/bin/sh` and asserts the probe still reports EMPTY afterwards, so adding a
 * file here goes RED instead of silently preserving the fleet. When it does go
 * red, the fix is NOT to widen the probe's exclusions by reflex: excluding more
 * makes DISCARD more likely, and discard destroys a user's filesystem, which is
 * the unrecoverable direction. Deciding that the new file makes a box non-empty
 * is a legitimate answer; it just has to be a decision.
 *
 * `ensureWorkspaceRootOnce` is deliberately not here: it goes through
 * `backend.createDirectory`, not a shell command, and creates DIRECTORIES only
 * — which the probe already discounts (`! -type d`), because an empty directory
 * holds nothing a user could lose.
 */
export const WORKSPACE_SCAFFOLDING_COMMANDS = {
  /**
   * Make the agent's clone root and this thread's working directory, and sweep
   * any pre-P3 top-level checkout (or a pre-`/workspace` one) into the clone
   * root. Directories only.
   */
  workRoot: ({ threadId }: WorkspaceScaffoldingInput): string => rootPreparationCommand(threadId),
  /**
   * Record that this thread is prepared for `signature`. The one scaffolding
   * FILE — see {@link PREPARED_SENTINEL_NAME}, which the probe excludes by
   * name.
   */
  sentinel: ({ threadId, signature }: WorkspaceScaffoldingInput): string => {
    const sentinel = path.join(threadWorkRoot(threadId), PREPARED_SENTINEL_NAME);
    return `sh -lc ${shellQuote(`printf %s ${shellQuote(signature)} > ${shellQuote(sentinel)}`)}`;
  },
} as const satisfies Record<string, (input: WorkspaceScaffoldingInput) => string>;

function rootPreparationCommand(threadId: string): string {
  const workRoot = threadWorkRoot(threadId);
  return (
    `sh -lc 'mkdir -p ${AGENT_REPOS_ROOT} ${workRoot} && ` +
    `for d in ${WORKSPACE_ROOT}/*/; do ` +
    `[ -d "$d" ] || continue; name="$(basename "$d")"; ` +
    `case "$name" in ${RESERVED_WORKSPACE_DIR_NAMES.join("|")}) continue;; esac; ` +
    `[ -e "${AGENT_REPOS_ROOT}/$name" ] || mv "$d" "${AGENT_REPOS_ROOT}/$name"; ` +
    `done; ` +
    `if [ -d ${LEGACY_WORKSPACE_ROOT} ]; then ` +
    `for d in ${LEGACY_WORKSPACE_ROOT}/*/; do ` +
    `[ -d "$d" ] || continue; name="$(basename "$d")"; ` +
    `[ -e "${AGENT_REPOS_ROOT}/$name" ] || mv "$d" "${AGENT_REPOS_ROOT}/$name"; ` +
    `done; fi'`
  );
}

function shellQuote(value: string): string {
  return `'${value.replace(/'/g, `'\\''`)}'`;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/* ------------------------------------------------------------------------- *
 * RECLAIM — the inverse of `ensureThreadWorktree`, kept in this file on
 * purpose: the reason the reclaim leaves the BRANCH behind is written down at
 * the `add` site, and the two have to be read together or the next person
 * deletes it "for tidiness" and takes every unpushed commit with it.
 * ------------------------------------------------------------------------- */

/** The service a reclaim runs on — one run-to-completion command, nothing else. */
export type ReclaimExecService = Pick<ThreadComputeService, "execRun">;

/**
 * Generous, and for one reason: `rm -rf` of a prepared checkout is
 * `node_modules`-sized. Shorter than the setup timeout because nothing here
 * builds anything.
 *
 * IT IS ALSO A STALL BUDGET, and worth naming as one. The reclaim runs from
 * `ensureThreadWorkspace`, i.e. BEFORE preparation on the first `exec` of a
 * turn, so a pass that takes this long delays a user's first tool call by that
 * long. `MAX_RECLAIM_ATTEMPTS` bounds repeated FAILURE, not slowness — three
 * slow-but-successful passes are three separate stalls.
 *
 * Left at five minutes rather than tightened, deliberately: nothing here knows
 * how long `rm -rf` of several checkouts actually takes on a sprite's disk, and
 * picking a smaller number from imagination is precisely the "value whose wrong
 * setting changes behaviour without failing anything" defect this phase keeps
 * hitting — too short and every pass times out, keeps its rows, and the
 * directories are never reclaimed at all. The live smoke measures it; see the
 * task report's live-smoke list, which names this specific number.
 */
const RECLAIM_TIMEOUT_MS = 5 * 60 * 1000;

/** One worktree the reclaim destroyed, and what was in it when it did. */
export interface DiscardedThreadWorktree {
  threadId: string;
  path: string;
  /** `git status --porcelain` line count — uncommitted changes, gone with it. */
  changes: number;
  /** Commits that existed only inside the box (`rev-list HEAD --not --remotes`). */
  unpushed: number;
}

export type ReclaimOutcome =
  | {
      ok: true;
      discarded: DiscardedThreadWorktree[];
      /**
       * The audit lines were a TAIL. The removal still happened — this says the
       * log beside it is incomplete, never that the reclaim failed.
       */
      auditTruncated: boolean;
    }
  | { ok: false; reason: string };

/**
 * THE reclaim command. One `exec` for a BATCH of threads, not one per thread:
 * an agent whose auto-archive cron retired 300 threads between two turns would
 * otherwise pay 300 round trips on the first tool call of the next turn.
 *
 * What it does, in order, per thread:
 *
 *  1. AUDIT FIRST. For every worktree under the thread's work root, emit its
 *     dirty-file count and its unpushed-commit count. The removal below is
 *     unconditional — no dirty check, no unpushed check, the user's explicit
 *     call, since the work ledger already pressures the model to push — so this
 *     line is the only thing that can ever answer "where did my work go". It
 *     costs two git commands on a box that is awake anyway.
 *  2. `rm -rf` the thread's work root — its worktrees, its scratch files and
 *     the preparation sentinel that lives inside it, all in one.
 *  3. `git worktree prune` in every clone under the agent's repo root, which is
 *     what clears the administrative record the removed directory left behind.
 *
 * THE BRANCH IS DELIBERATELY LEFT. `prune` clears the registration and never
 * the branch, and neither `branch -D` nor `add -B` is used here, because both
 * discard commits the thread made and never pushed IMMEDIATELY and with nothing
 * to restore from. The unconditional-removal ruling is about the WORKTREE, and
 * a checkout can be recreated from its branch; the branch is the only copy of
 * those commits. `ensureThreadWorktree` re-attaches an orphaned branch rather
 * than failing on it, so the cost of keeping one is a ref per archived thread
 * in the clone.
 *
 * WHAT KEEPING IT DOES *NOT* BUY, because a comment that over-claims here is
 * worse than none: the branch is not preserved forever, and this reclaim
 * SHORTENS the window it survives. `PROBE_SCRIPT` measures each repo's own
 * `HEAD` against its own upstream and nothing else, so commits sitting on a
 * kept, not-checked-out `nadi/thread-<id>` ref are INVISIBLE to it. Remove the
 * dirty worktree that was the box's only evidence of work and the agent's clone
 * probes `clean`, so on any provider WITHOUT `nativeIdleSuspend` the next idle
 * wake DISCARDS the box — clone, branch and commits together. The honest claim
 * is therefore: keeping the branch is strictly better than deleting it (which
 * loses the commits now, on every provider), and it buys a recovery window
 * bounded by the box's idle timeout, not an indefinite one.
 *
 * The probe is deliberately NOT widened to count refs unmerged into any remote.
 * It would be the safe DIRECTION (more preserve, less discard), but a thread
 * that commits without pushing is the normal shape of a coding turn, so after
 * the first such thread every agent's box would probe dirty forever and be
 * preserved forever — and a preserved sprite bills until something deletes it,
 * with no auto-destroy. The bounded fix is retiring branches whose commits a
 * remote already has, which needs its own task and its own ruling.
 *
 * The repo root is swept by GLOB rather than from the agent's configured
 * repository list, and that is load-bearing twice over: a DELETED thread has no
 * `thread_index` row left to read a config from, and a repository dropped from
 * the agent's config since would keep its stale registration forever.
 *
 * Every interpolated value is a constant or has been through
 * `assertSafeSegment` in `workspace-layout`, so none can carry a metacharacter.
 */
export function reclaimThreadWorkspacesScript(threadIds: string[]): string {
  if (threadIds.length === 0) throw new Error("reclaim script requires at least one thread");
  const roots = threadIds.map((threadId) => shellQuote(threadWorkRoot(threadId))).join(" ");
  return `# ${RECLAIM_MARKER} reclaim thread workspaces (marker word load-bearing: test fakes match it in the command string — don't remove)
set -u
for root in ${roots}; do
  [ -d "$root" ] || continue
  while IFS= read -r gitdir; do
    [ -z "$gitdir" ] && continue
    repo=$(dirname "$gitdir")
    changes=$(git -C "$repo" status --porcelain 2>/dev/null | grep -c . || true)
    if git -C "$repo" rev-parse --abbrev-ref --symbolic-full-name '@{upstream}' >/dev/null 2>&1; then
      unpushed=$(git -C "$repo" rev-list --count '@{upstream}..HEAD' 2>/dev/null || echo 0)
    else
      unpushed=$(git -C "$repo" rev-list --count HEAD --not --remotes 2>/dev/null || echo 0)
    fi
    printf '${RECLAIM_MARKER}\\t%s\\t%s\\t%s\\t%s\\n' "$root" "$repo" "$changes" "$unpushed"
  done <<EOF
$(find "$root" -maxdepth ${THREAD_WORKTREE_GIT_SCAN_DEPTH} \\( -type d -o -type f \\) -name .git 2>/dev/null)
EOF
  rm -rf "$root" || exit 1
done
for clone in ${AGENT_REPOS_ROOT}/*/; do
  [ -d "$clone" ] || continue
  git -C "$clone" worktree prune >/dev/null 2>&1 || true
done
`;
}

/**
 * Run {@link reclaimThreadWorkspacesScript} and report what it destroyed.
 *
 * SUCCESS IS THE EXIT CODE, never the output. Unrecognized stdout is IGNORED
 * rather than treated as a failure — the opposite of the cleanliness probe, and
 * deliberately so. The probe's output decides whether to destroy a filesystem,
 * so anything it cannot parse must fail closed; here the destruction has
 * already happened by the time the output is read, and failing on a line we
 * could not parse would leave the pending row in place and re-run `rm -rf`
 * against a directory that is already gone, on every turn, forever.
 */
export async function reclaimThreadWorkspaces(input: {
  service: ReclaimExecService;
  threadIds: string[];
}): Promise<ReclaimOutcome> {
  const requested = new Set(input.threadIds);
  const result = await input.service.execRun({
    command: reclaimThreadWorkspacesScript(input.threadIds),
    timeoutMs: RECLAIM_TIMEOUT_MS,
    label: "reclaim thread workspaces",
  });
  if (result.exitCode !== 0) {
    return {
      ok: false,
      reason: `reclaim exited ${result.exitCode}: ${result.stderr || result.stdout || "no output"}`,
    };
  }
  const discarded: DiscardedThreadWorktree[] = [];
  for (const line of result.stdout.split("\n")) {
    const fields = line.split("\t");
    if (fields.length !== 5 || fields[0] !== RECLAIM_MARKER) continue;
    const [, root, repoPath, changesRaw, unpushedRaw] = fields as [
      string,
      string,
      string,
      string,
      string,
    ];
    // The thread id is the LAST SEGMENT of its work root — that is what
    // `threadWorkRoot` builds, and `assertSafeSegment` guarantees the id holds
    // no separator. Read back this way rather than matched against the absolute
    // path we asked for, so the parser is a function of the id alone: a caller
    // that runs the same command against a relocated root (the live-shell tests
    // do exactly that) still gets attributed lines, instead of silently dropping
    // every one and reporting that nothing was discarded.
    const threadId = root.slice(root.lastIndexOf("/") + 1);
    if (!requested.has(threadId)) continue;
    discarded.push({
      threadId,
      path: repoPath,
      changes: countField(changesRaw),
      unpushed: countField(unpushedRaw),
    });
  }
  return { ok: true, discarded, auditTruncated: result.stdoutTruncated };
}

/** An unparseable count becomes -1, which reads as "unknown" in the log. */
function countField(value: string): number {
  const parsed = Number.parseInt(value.trim(), 10);
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : -1;
}
