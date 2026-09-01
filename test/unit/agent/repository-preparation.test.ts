import { spawnSync } from "node:child_process";
import { mkdtempSync, readdirSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { AgentRepositoryRow } from "../../../src/db/schema";

const { registryDbMock, getThreadMock, listRepositoriesMock, getAgentMock } = vi.hoisted(() => ({
  registryDbMock: vi.fn(),
  getThreadMock: vi.fn(),
  listRepositoriesMock: vi.fn(),
  getAgentMock: vi.fn(),
}));

vi.mock("../../../src/db/client", () => ({
  registryDb: registryDbMock,
}));

vi.mock("../../../src/db/repositories/threads", () => ({
  ThreadRepository: class {
    getById = getThreadMock;
  },
}));

vi.mock("../../../src/db/repositories/agents", () => ({
  AgentRepository: class {
    listRepositories = listRepositoriesMock;
    getById = getAgentMock;
  },
}));

import { createRepositoryPreparation } from "../../../src/agent/repository-preparation";
import {
  agentClonePath,
  threadWorkRoot,
  threadWorktreeBranch,
  threadWorktreePath,
} from "../../../src/compute/workspace-layout";

// A realistic id: the layout and the branch name are both derived from it, and
// `thr_<uuid>` is what every production caller mints.
const THREAD_ID = "thr_9e0b60c1-0000-4000-8000-000000000001";
const CLONE_PATH = agentClonePath("nadi");
const WORKTREE_PATH = threadWorktreePath(THREAD_ID, "nadi");
const BRANCH = threadWorktreeBranch(THREAD_ID);

type ExecResult = {
  status: "exited" | "backgrounded" | "failed" | "stopped";
  processId: string;
  exitCode?: number;
  text?: string;
};

function makeRepository(overrides: Partial<AgentRepositoryRow> = {}): AgentRepositoryRow {
  return {
    id: "repo-1",
    agentId: "env-1",
    source: "github",
    name: "nadi",
    url: "https://github.com/acme/nadi.git",
    githubRepoId: null,
    sourceInstallationId: null,
    accessStatus: "ok",
    defaultBranch: "",
    checkoutPathName: "nadi",
    rootDirectory: "/",
    setupCommand: "",
    packageManager: "pnpm",
    createdAt: 1,
    ...overrides,
  };
}

/**
 * A sandbox whose `exec` answers the two BOOKKEEPING commands by label and
 * everything else from a script.
 *
 * Preparation brackets its work with a gate probe and a sentinel write, both
 * inside the box (see `isAlreadyPrepared` / `writePreparedSentinel`). Answering
 * those by label rather than by position keeps every scripted sequence below
 * about the thing it is testing, and makes "was this run recorded as prepared"
 * a direct observation instead of an off-by-one in a queue.
 */
function makeService(
  execResults: ExecResult[],
  execOutputResults: ExecResult[] = [],
  options?: { alreadyPrepared?: boolean },
) {
  const queue = [...execResults];
  /** The sentinel-write commands issued — empty means the run was NOT recorded. */
  const sentinelWrites: string[] = [];
  /** The gate probes issued, so a test can assert what was actually checked. */
  const gateProbes: string[] = [];

  const exec = vi.fn(async (input: { command: string; label?: string }) => {
    if (input.label === "check thread preparation") {
      gateProbes.push(input.command);
      return {
        status: "exited" as const,
        processId: "gate",
        exitCode: options?.alreadyPrepared ? 0 : 1,
      };
    }
    if (input.label === "record thread preparation") {
      sentinelWrites.push(input.command);
      return { status: "exited" as const, processId: "sentinel", exitCode: 0 };
    }
    const next = queue.shift();
    if (!next) throw new Error(`unscripted exec: ${input.command}`);
    return next;
  });

  const execOutput = vi.fn();
  for (const result of execOutputResults) {
    execOutput.mockResolvedValueOnce(result);
  }

  return { exec, execOutput, sentinelWrites, gateProbes };
}

function prepare(service: { exec: unknown; execOutput: unknown }) {
  return createRepositoryPreparation({
    env: {} as never,
    threadId: THREAD_ID,
    resolveComputeService: async () => ({ service }) as never,
  });
}

function commandsOf(service: { exec: { mock: { calls: unknown[][] } } }): string[] {
  return service.exec.mock.calls.map((call) => (call[0] as { command: string })?.command);
}

describe("createRepositoryPreparation", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    registryDbMock.mockReturnValue({ db: "mock" });
    // Every case runs against a thread whose AGENT is `env-1` — the agent IS
    // the environment, and `agent_repositories.agent_id` is keyed on it.
    getThreadMock.mockResolvedValue({ id: THREAD_ID, agentId: "env-1" });
    getAgentMock.mockResolvedValue(undefined);
  });

  /**
   * The whole shape of P3 in one case: ONE clone for the agent, at
   * `/workspace/repos/<name>`, and a worktree per thread hanging off it at
   * `/workspace/threads/<threadId>/<name>`. The reported `checkoutPath` is the
   * WORKTREE — that is the thread's cwd and the only path the model should ever
   * be handed.
   */
  it("clones into the agent's repo root and adds a worktree for the thread", async () => {
    listRepositoriesMock.mockResolvedValue([makeRepository()]);
    const service = makeService([
      { status: "exited", processId: "mkdir", exitCode: 0 },
      { status: "exited", processId: "clone-exists", exitCode: 1 },
      { status: "exited", processId: "clone", exitCode: 0 },
      { status: "exited", processId: "worktree-exists", exitCode: 1 },
      { status: "exited", processId: "branch-probe", exitCode: 1 },
      { status: "exited", processId: "worktree", exitCode: 0 },
    ]);

    await expect(prepare(service)()).resolves.toMatchObject({
      summary: "Repositories are ready for coding work.",
      prepared: [
        {
          name: "nadi",
          checkoutPath: WORKTREE_PATH,
          status: "cloned",
          setup: { state: "skipped", detail: "no setup command configured" },
        },
      ],
    });

    expect(CLONE_PATH).toBe("/workspace/repos/nadi");
    expect(WORKTREE_PATH).toBe(`/workspace/threads/${THREAD_ID}/nadi`);
    expect(service.exec).toHaveBeenCalledWith(
      expect.objectContaining({
        command: `git clone https://x-access-token:\${GH_TOKEN}@github.com/acme/nadi.git '${CLONE_PATH}'`,
      }),
    );
    expect(service.exec).toHaveBeenCalledWith(
      expect.objectContaining({
        command:
          `git -C '${CLONE_PATH}' worktree prune && ` +
          `git -C '${CLONE_PATH}' worktree add -b '${BRANCH}' '${WORKTREE_PATH}' 'HEAD'`,
      }),
    );
  });

  /**
   * A branch per thread, and never a detached HEAD: `worktree add` REFUSES a
   * branch that is already checked out elsewhere, so two threads both wanting
   * `main` would collide on the second one. `-b` with a per-thread name is the
   * only shape that survives a second thread.
   */
  it("checks the worktree out on a per-thread branch, from origin/<defaultBranch>", async () => {
    listRepositoriesMock.mockResolvedValue([makeRepository({ defaultBranch: "main" })]);
    const service = makeService([
      { status: "exited", processId: "mkdir", exitCode: 0 },
      { status: "exited", processId: "clone-exists", exitCode: 1 },
      { status: "exited", processId: "clone", exitCode: 0 },
      { status: "exited", processId: "checkout", exitCode: 0 },
      { status: "exited", processId: "worktree-exists", exitCode: 1 },
      { status: "exited", processId: "branch-probe", exitCode: 1 },
      { status: "exited", processId: "worktree", exitCode: 0 },
    ]);

    await prepare(service)();

    const worktreeCommand = commandsOf(service).find((command) =>
      command.includes("worktree add"),
    ) as string;
    expect(worktreeCommand).toContain(`-b '${BRANCH}'`);
    expect(worktreeCommand).toContain("'origin/main'");
    expect(worktreeCommand).not.toContain("--detach");
    // Two different threads of the same agent must not ask for one branch.
    expect(threadWorktreeBranch("thr_00000000-0000-4000-8000-000000000002")).not.toBe(BRANCH);
  });

  /**
   * Idempotence, the property that keeps a returning thread's uncommitted work
   * alive: a present clone is not re-cloned and a present worktree is not
   * re-added. `worktree add` on an existing path fails, so getting this wrong
   * would degrade a returning thread into a permanent skip.
   */
  it("reuses an existing clone and an existing worktree", async () => {
    listRepositoriesMock.mockResolvedValue([makeRepository()]);
    const service = makeService(
      [
        { status: "exited", processId: "mkdir", exitCode: 0 },
        { status: "exited", processId: "clone-exists", exitCode: 0 },
        { status: "exited", processId: "rev-parse", exitCode: 0 },
        { status: "exited", processId: "remote", exitCode: 0 },
        { status: "exited", processId: "worktree-exists", exitCode: 0 },
      ],
      [
        {
          status: "exited",
          processId: "remote",
          exitCode: 0,
          text: "https://x-access-token:tok@github.com/acme/nadi.git",
        },
      ],
    );

    await expect(prepare(service)()).resolves.toMatchObject({
      prepared: [{ name: "nadi", checkoutPath: WORKTREE_PATH, status: "already_cloned" }],
    });

    expect(service.exec).not.toHaveBeenCalledWith(
      expect.objectContaining({ command: expect.stringContaining("git clone") }),
    );
    expect(service.exec).not.toHaveBeenCalledWith(
      expect.objectContaining({ command: expect.stringContaining("worktree add") }),
    );
  });

  /**
   * The clone is shared by every thread of the agent, so a thread arriving at a
   * box that already has one adds only its own worktree. The clone probe still
   * runs (the clone has to be VALIDATED, not assumed), but nothing re-clones.
   */
  it("adds only a worktree when the agent's clone already exists", async () => {
    listRepositoriesMock.mockResolvedValue([makeRepository()]);
    const service = makeService(
      [
        { status: "exited", processId: "mkdir", exitCode: 0 },
        { status: "exited", processId: "clone-exists", exitCode: 0 },
        { status: "exited", processId: "rev-parse", exitCode: 0 },
        { status: "exited", processId: "remote", exitCode: 0 },
        { status: "exited", processId: "worktree-exists", exitCode: 1 },
        { status: "exited", processId: "branch-probe", exitCode: 1 },
        { status: "exited", processId: "worktree", exitCode: 0 },
      ],
      [
        {
          status: "exited",
          processId: "remote",
          exitCode: 0,
          text: "https://github.com/acme/nadi.git",
        },
      ],
    );

    await expect(prepare(service)()).resolves.toMatchObject({
      prepared: [{ name: "nadi", status: "cloned", checkoutPath: WORKTREE_PATH }],
    });
    expect(service.exec).not.toHaveBeenCalledWith(
      expect.objectContaining({ command: expect.stringContaining("git clone") }),
    );
  });

  /**
   * The Cloudflare backend reports ANY non-zero exit as `status: "failed"` —
   * `cloudflare.ts:275` maps `exitCode === 0 ? "exited" : "failed"` — so on that
   * provider a missing checkout arrives as `failed`/1, never `exited`/1. Every
   * probe here classified on `status === "exited"`, which is Daytona's contract
   * ("ran to completion, whatever the code"), so a missing repo fell through to
   * the `error` branch and was SKIPPED instead of cloned.
   *
   * The result: every fresh agent sandbox came up with an empty /workspace
   * and the model had to improvise a clone by hand. The skip was invisible —
   * `onFreshRuntimeAcquired` discards the returned summary. Observed live on
   * thr_92e0b60c: `test -e /workspace/nadi` returned status `failed`, exitCode 1.
   *
   * BOTH probes are on this path now (clone, then worktree), so both are driven
   * with the Cloudflare shape here.
   */
  it("clones and adds a worktree when MISSING is reported as failed/1 (the Cloudflare shape)", async () => {
    listRepositoriesMock.mockResolvedValue([makeRepository()]);
    const service = makeService([
      { status: "exited", processId: "mkdir", exitCode: 0 },
      { status: "failed", processId: "clone-exists", exitCode: 1 },
      { status: "exited", processId: "clone", exitCode: 0 },
      { status: "failed", processId: "worktree-exists", exitCode: 1 },
      { status: "failed", processId: "branch-probe", exitCode: 1 },
      { status: "exited", processId: "worktree", exitCode: 0 },
    ]);

    await expect(prepare(service)()).resolves.toMatchObject({
      prepared: [{ name: "nadi", status: "cloned" }],
    });
  });

  it("treats a failed/1 rev-parse as a non-git path, not a probe error", async () => {
    listRepositoriesMock.mockResolvedValue([makeRepository()]);
    const service = makeService([
      { status: "exited", processId: "mkdir", exitCode: 0 },
      { status: "exited", processId: "clone-exists", exitCode: 0 },
      { status: "failed", processId: "rev-parse", exitCode: 1 },
    ]);

    await expect(prepare(service)()).resolves.toMatchObject({
      skipped: [{ name: "nadi", reason: "path exists but is not a git checkout" }],
    });
  });

  it("skips an existing non-git clone path when rev-parse exits non-zero", async () => {
    listRepositoriesMock.mockResolvedValue([makeRepository()]);
    const service = makeService([
      { status: "exited", processId: "mkdir", exitCode: 0 },
      { status: "exited", processId: "clone-exists", exitCode: 0 },
      { status: "exited", processId: "rev-parse", exitCode: 1 },
    ]);

    await expect(prepare(service)()).resolves.toMatchObject({
      summary: "Repositories are ready for coding work.",
      skipped: [{ name: "nadi", reason: "path exists but is not a git checkout" }],
    });

    expect(service.exec).not.toHaveBeenCalledWith(
      expect.objectContaining({ command: expect.stringContaining("remote get-url origin") }),
    );
    expect(service.exec).not.toHaveBeenCalledWith(
      expect.objectContaining({ command: expect.stringContaining("git clone") }),
    );
    // And no worktree is added off a directory that is not a repository.
    expect(service.exec).not.toHaveBeenCalledWith(
      expect.objectContaining({ command: expect.stringContaining("worktree add") }),
    );
  });

  it("reports clone failure as skipped when clone exits non-zero", async () => {
    listRepositoriesMock.mockResolvedValue([makeRepository()]);
    const service = makeService([
      { status: "exited", processId: "mkdir", exitCode: 0 },
      { status: "exited", processId: "clone-exists", exitCode: 1 },
      { status: "exited", processId: "clone", exitCode: 128 },
    ]);

    await expect(prepare(service)()).resolves.toMatchObject({
      summary: "Repositories are ready for coding work.",
      skipped: [{ name: "nadi", reason: "clone failed with exit code 128" }],
    });

    expect(service.exec).not.toHaveBeenCalledWith(
      expect.objectContaining({ command: expect.stringContaining("worktree add") }),
    );
  });

  /**
   * The failure this task most needs to be LOUD about. A worktree that cannot be
   * added leaves the thread with a working directory containing no code, and the
   * caller only logs `skipped` — so the reason has to name the operation.
   */
  it("reports worktree-add failure as a skip naming the operation", async () => {
    listRepositoriesMock.mockResolvedValue([makeRepository()]);
    const service = makeService([
      { status: "exited", processId: "mkdir", exitCode: 0 },
      { status: "exited", processId: "clone-exists", exitCode: 1 },
      { status: "exited", processId: "clone", exitCode: 0 },
      { status: "exited", processId: "worktree-exists", exitCode: 1 },
      { status: "exited", processId: "branch-probe", exitCode: 1 },
      { status: "exited", processId: "worktree", exitCode: 128 },
    ]);

    await expect(prepare(service)()).resolves.toMatchObject({
      skipped: [{ name: "nadi", reason: "worktree add failed with exit code 128" }],
    });
  });

  /**
   * H2, the second work-loss seam. `worktree prune` clears a worktree's
   * REGISTRATION and never its branch, so a branch outliving its worktree is
   * both reachable and permanent — Task 4's reclaim removes the directory and
   * prunes, and a provider restore can bring `repos/` back without `threads/`.
   * `add -b` on an existing branch is exit 128 forever, which is a thread that
   * never gets its code back AND loses whatever it had committed on that branch.
   */
  it("re-attaches an existing branch instead of trying to create it again", async () => {
    listRepositoriesMock.mockResolvedValue([makeRepository({ defaultBranch: "main" })]);
    const service = makeService(
      [
        { status: "exited", processId: "mkdir", exitCode: 0 },
        { status: "exited", processId: "clone-exists", exitCode: 0 },
        { status: "exited", processId: "rev-parse", exitCode: 0 },
        { status: "exited", processId: "remote", exitCode: 0 },
        { status: "exited", processId: "worktree-exists", exitCode: 1 },
        // The branch is still there — its worktree is not.
        { status: "exited", processId: "branch-probe", exitCode: 0 },
        { status: "exited", processId: "worktree", exitCode: 0 },
      ],
      [
        {
          status: "exited",
          processId: "remote",
          exitCode: 0,
          text: "https://github.com/acme/nadi.git",
        },
      ],
    );

    await expect(prepare(service)()).resolves.toMatchObject({
      prepared: [{ name: "nadi", status: "cloned", checkoutPath: WORKTREE_PATH }],
    });

    const worktreeCommand = commandsOf(service).find((command) =>
      command.includes("worktree add"),
    ) as string;
    // Re-attach: the path then the branch, and NO start point.
    expect(worktreeCommand).toContain(`worktree add '${WORKTREE_PATH}' '${BRANCH}'`);
    expect(worktreeCommand).not.toContain("-b ");
    // `-B` would have worked too, and would have reset the branch to
    // origin/main — silently dropping every commit the thread never pushed.
    expect(worktreeCommand).not.toContain("-B ");
    expect(worktreeCommand).not.toContain("origin/main");
  });

  it("probes the branch by its exact ref", async () => {
    listRepositoriesMock.mockResolvedValue([makeRepository()]);
    const service = makeService([
      { status: "exited", processId: "mkdir", exitCode: 0 },
      { status: "exited", processId: "clone-exists", exitCode: 1 },
      { status: "exited", processId: "clone", exitCode: 0 },
      { status: "exited", processId: "worktree-exists", exitCode: 1 },
      { status: "exited", processId: "branch-probe", exitCode: 1 },
      { status: "exited", processId: "worktree", exitCode: 0 },
    ]);

    await prepare(service)();

    expect(service.exec).toHaveBeenCalledWith(
      expect.objectContaining({
        command: `git -C '${CLONE_PATH}' show-ref --verify --quiet 'refs/heads/${BRANCH}'`,
      }),
    );
  });

  it("skips when the branch probe fails indeterminately, rather than guessing", async () => {
    listRepositoriesMock.mockResolvedValue([makeRepository()]);
    const service = makeService([
      { status: "exited", processId: "mkdir", exitCode: 0 },
      { status: "exited", processId: "clone-exists", exitCode: 1 },
      { status: "exited", processId: "clone", exitCode: 0 },
      { status: "exited", processId: "worktree-exists", exitCode: 1 },
      { status: "stopped", processId: "branch-probe" },
    ]);

    await expect(prepare(service)()).resolves.toMatchObject({
      skipped: [{ name: "nadi", reason: "thread branch probe failed (status: stopped)" }],
    });
    expect(service.exec).not.toHaveBeenCalledWith(
      expect.objectContaining({ command: expect.stringContaining("worktree add") }),
    );
  });

  /**
   * The gate that makes preparing on every turn affordable — and the reason it
   * lives INSIDE the box rather than in the sandbox DO's storage.
   *
   * A stored row survives everything except a fresh acquire. Task 4's reclaim
   * (`rm -rf /workspace/threads/<id>` plus a prune) and a restore that brings
   * `repos/` back without `threads/` both leave it matching, so a reopened
   * thread would read as prepared, get the empty directory
   * `ensureWorkspaceRootOnce` had just recreated, and work with no code in it —
   * H1's failure, re-entered through the bookkeeping and needing no container
   * reset. A sentinel in the thread's own directory is destroyed by every one
   * of those events, with nobody having to remember.
   */
  describe("the preparation gate", () => {
    const CLEAN_RUN: ExecResult[] = [
      { status: "exited", processId: "mkdir", exitCode: 0 },
      { status: "exited", processId: "clone-exists", exitCode: 1 },
      { status: "exited", processId: "clone", exitCode: 0 },
      { status: "exited", processId: "worktree-exists", exitCode: 1 },
      { status: "exited", processId: "branch-probe", exitCode: 1 },
      { status: "exited", processId: "worktree", exitCode: 0 },
    ];

    it("asks the BOX, checking the sentinel and every path it stands for", async () => {
      listRepositoriesMock.mockResolvedValue([makeRepository()]);
      const service = makeService(CLEAN_RUN);

      await prepare(service)();

      expect(service.gateProbes).toHaveLength(1);
      const probe = service.gateProbes[0] as string;
      // The sentinel lives in the thread's own directory, so a reclaim of that
      // directory takes it.
      expect(probe).toContain(`${threadWorkRoot(THREAD_ID)}/.nadi-prepared`);
      // And the paths are checked too: a sentinel can outlive the checkouts it
      // stands for when a restore brings one directory back without the other.
      // The whole test is nested inside `sh -lc '...'`, so the inner quoting is
      // escaped — match the paths and the operator, not a literal spelling.
      expect(probe).toContain("test -e");
      expect(probe).toContain(CLONE_PATH);
      expect(probe).toContain(WORKTREE_PATH);
    });

    it("records the thread as prepared, and a prepared box does nothing at all", async () => {
      listRepositoriesMock.mockResolvedValue([makeRepository()]);
      const first = makeService(CLEAN_RUN);
      await expect(prepare(first)()).resolves.toMatchObject({
        prepared: [{ name: "nadi", status: "cloned" }],
      });
      expect(first.sentinelWrites).toHaveLength(1);
      // The written value is the signature the gate will compare against.
      const written = first.sentinelWrites[0] as string;
      expect(written).toMatch(/[0-9a-f]{64}/);

      // Second turn, box already prepared: the gate answers yes and nothing
      // else runs — no root preparation, no probe, no setup command.
      const second = makeService([], [], { alreadyPrepared: true });
      await expect(prepare(second)()).resolves.toEqual({
        summary: "Repositories were already prepared for this thread.",
        signature: written.match(/[0-9a-f]{64}/)?.[0],
      });
      expect(second.exec).toHaveBeenCalledTimes(1);
      expect(second.sentinelWrites).toEqual([]);
    });

    /**
     * The signature covers the agent's declared configuration, so ADDING a
     * repository re-opens preparation. The gate's exec is what carries it: the
     * sentinel holds the OLD signature, so the comparison fails even though the
     * file and every old path are still there.
     */
    it("re-prepares when the agent's repository list changes", async () => {
      listRepositoriesMock.mockResolvedValue([makeRepository()]);
      const first = makeService(CLEAN_RUN);
      await prepare(first)();

      listRepositoriesMock.mockResolvedValue([
        makeRepository(),
        makeRepository({ id: "repo-2", name: "other", checkoutPathName: "other" }),
      ]);
      const second = makeService(
        [
          { status: "exited", processId: "mkdir", exitCode: 0 },
          { status: "exited", processId: "clone-exists", exitCode: 0 },
          { status: "exited", processId: "rev-parse", exitCode: 0 },
          { status: "exited", processId: "remote", exitCode: 0 },
          { status: "exited", processId: "worktree-exists", exitCode: 0 },
          { status: "exited", processId: "clone-exists-2", exitCode: 1 },
          { status: "exited", processId: "clone-2", exitCode: 0 },
          { status: "exited", processId: "worktree-exists-2", exitCode: 1 },
          { status: "exited", processId: "branch-probe-2", exitCode: 1 },
          { status: "exited", processId: "worktree-2", exitCode: 0 },
        ],
        [
          {
            status: "exited",
            processId: "remote",
            exitCode: 0,
            text: "https://github.com/acme/nadi.git",
          },
        ],
      );
      await expect(prepare(second)()).resolves.toMatchObject({
        prepared: [
          { name: "nadi", status: "already_cloned" },
          { name: "other", status: "cloned" },
        ],
      });
      // A different configuration, so a different signature is recorded.
      expect(second.sentinelWrites[0]).not.toBe(first.sentinelWrites[0]);
    });

    /**
     * A skip means something the agent declares is NOT in the box. Recording
     * that as prepared freezes the thread in that state until its configuration
     * changes or the box is destroyed.
     */
    it("does NOT record a run that skipped a repository", async () => {
      listRepositoriesMock.mockResolvedValue([makeRepository()]);
      const service = makeService([
        { status: "exited", processId: "mkdir", exitCode: 0 },
        { status: "exited", processId: "clone-exists", exitCode: 1 },
        { status: "exited", processId: "clone", exitCode: 128 },
      ]);

      await expect(prepare(service)()).resolves.toMatchObject({
        skipped: [{ name: "nadi" }],
        failures: ["nadi: clone failed with exit code 128"],
      });
      expect(service.sentinelWrites).toEqual([]);
    });

    /**
     * NEW-3. A failed setup command is NOT a skip: the repository cloned, the
     * worktree was added, and the failure is a string inside a `prepared` entry.
     * Gating the record on `skipped` alone therefore marked a transient
     * `npm ci` failure as prepared — never retried until the configuration
     * changed or the box was destroyed — and the caller, which logged only
     * `skipped`, said nothing about it either. `failures` is the one list both
     * questions are answered from.
     */
    it("does NOT record a run whose per-repo setup command failed", async () => {
      listRepositoriesMock.mockResolvedValue([makeRepository({ setupCommand: "pnpm install" })]);
      const service = makeService([
        ...CLEAN_RUN,
        { status: "exited", processId: "setup", exitCode: 2 },
      ]);

      await expect(prepare(service)()).resolves.toMatchObject({
        prepared: [
          {
            name: "nadi",
            setup: { state: "failed", detail: "pnpm install failed with exit code 2" },
          },
        ],
        failures: ["nadi: pnpm install failed with exit code 2"],
      });
      // No `skipped` at all — this is exactly the run the old gate marked.
      expect(service.sentinelWrites).toEqual([]);
    });

    it("does NOT record a run whose agent setup script failed", async () => {
      listRepositoriesMock.mockResolvedValue([]);
      getAgentMock.mockResolvedValue({
        id: "env-1",
        workspaceId: "workspace-1",
        name: "env",
        setupScript: "echo hi",
      });
      const service = makeService([
        { status: "exited", processId: "mkdir", exitCode: 0 },
        { status: "exited", processId: "env-setup", exitCode: 3 },
      ]);

      await expect(prepare(service)()).resolves.toMatchObject({
        environmentSetup: {
          state: "failed",
          detail: "environment setup failed with exit code 3",
        },
        failures: ["environment setup: environment setup failed with exit code 3"],
      });
      expect(service.sentinelWrites).toEqual([]);
    });

    it("records a clean run and reports no failures", async () => {
      listRepositoriesMock.mockResolvedValue([makeRepository({ setupCommand: "pnpm install" })]);
      const service = makeService([
        ...CLEAN_RUN,
        { status: "exited", processId: "setup", exitCode: 0 },
      ]);

      const result = await prepare(service)();
      expect(result.failures).toBeUndefined();
      expect(service.sentinelWrites).toHaveLength(1);
    });
  });

  it("skips when the clone path probe fails indeterminately", async () => {
    listRepositoriesMock.mockResolvedValue([makeRepository()]);
    const service = makeService([
      { status: "exited", processId: "mkdir", exitCode: 0 },
      { status: "failed", processId: "clone-exists" },
    ]);

    await expect(prepare(service)()).resolves.toMatchObject({
      summary: "Repositories are ready for coding work.",
      skipped: [{ name: "nadi", reason: "repository path probe failed (status: failed)" }],
    });

    // 3, not 2: the gate probe, the root preparation, then the failing probe.
    expect(service.exec).toHaveBeenCalledTimes(3);
    expect(service.exec).not.toHaveBeenCalledWith(
      expect.objectContaining({ command: expect.stringContaining("git clone") }),
    );
  });

  it("skips when the worktree path probe fails indeterminately", async () => {
    listRepositoriesMock.mockResolvedValue([makeRepository()]);
    const service = makeService([
      { status: "exited", processId: "mkdir", exitCode: 0 },
      { status: "exited", processId: "clone-exists", exitCode: 1 },
      { status: "exited", processId: "clone", exitCode: 0 },
      { status: "failed", processId: "worktree-exists" },
    ]);

    await expect(prepare(service)()).resolves.toMatchObject({
      skipped: [{ name: "nadi", reason: "repository path probe failed (status: failed)" }],
    });
    expect(service.exec).not.toHaveBeenCalledWith(
      expect.objectContaining({ command: expect.stringContaining("worktree add") }),
    );
  });

  it("reports setup failure instead of claiming setup completed on non-zero exit", async () => {
    listRepositoriesMock.mockResolvedValue([
      makeRepository({
        setupCommand: "pnpm install",
      }),
    ]);
    const service = makeService(
      [
        { status: "exited", processId: "mkdir", exitCode: 0 },
        { status: "exited", processId: "clone-exists", exitCode: 0 },
        { status: "exited", processId: "rev-parse", exitCode: 0 },
        { status: "exited", processId: "remote", exitCode: 0 },
        { status: "exited", processId: "worktree-exists", exitCode: 0 },
        { status: "exited", processId: "setup", exitCode: 2 },
      ],
      [
        {
          status: "exited",
          processId: "remote",
          exitCode: 0,
          text: "https://github.com/acme/nadi.git",
        },
      ],
    );

    await expect(prepare(service)()).resolves.toMatchObject({
      summary: "Repositories are ready for coding work.",
      prepared: [
        {
          name: "nadi",
          status: "already_cloned",
          setup: { state: "failed", detail: "pnpm install failed with exit code 2" },
        },
      ],
    });
  });

  /**
   * Per-repo setup runs in the THREAD's worktree, not the agent's shared clone.
   * Running it in the clone would install into the directory `git worktree`
   * owns, where the thread's own build never looks — and would race every other
   * thread of the agent doing the same.
   */
  it("runs per-repo setup inside the thread's worktree", async () => {
    listRepositoriesMock.mockResolvedValue([
      makeRepository({ setupCommand: "pnpm install", rootDirectory: "packages/api" }),
    ]);
    const service = makeService(
      [
        { status: "exited", processId: "mkdir", exitCode: 0 },
        { status: "exited", processId: "clone-exists", exitCode: 0 },
        { status: "exited", processId: "rev-parse", exitCode: 0 },
        { status: "exited", processId: "remote", exitCode: 0 },
        { status: "exited", processId: "worktree-exists", exitCode: 0 },
        { status: "exited", processId: "setup", exitCode: 0 },
      ],
      [
        {
          status: "exited",
          processId: "remote",
          exitCode: 0,
          text: "https://github.com/acme/nadi.git",
        },
      ],
    );

    await prepare(service)();

    expect(service.exec).toHaveBeenCalledWith(
      expect.objectContaining({
        cwd: `${WORKTREE_PATH}/packages/api`,
        label: "setup nadi",
      }),
    );
  });

  /**
   * Two migrations, and the second is the one this task adds: pre-P3 boxes hold
   * a clone at `/workspace/<name>` which may carry uncommitted work. Leaving it
   * where it is would strand it — this preparation would clone a SECOND copy
   * under `repos/` and hand the thread the empty one, with nothing failing.
   */
  it("prepares the layout and migrates both earlier checkout roots into it", async () => {
    listRepositoriesMock.mockResolvedValue([makeRepository()]);
    const service = makeService([
      { status: "exited", processId: "mkdir", exitCode: 0 },
      { status: "exited", processId: "clone-exists", exitCode: 1 },
      { status: "exited", processId: "clone", exitCode: 0 },
      { status: "exited", processId: "worktree-exists", exitCode: 1 },
      { status: "exited", processId: "branch-probe", exitCode: 1 },
      { status: "exited", processId: "worktree", exitCode: 0 },
    ]);

    await prepare(service)();

    // NOT index 0 — the gate probe runs first now.
    const rootPrepCommand = commandsOf(service).find((command) =>
      command.includes("mkdir -p"),
    ) as string;
    expect(rootPrepCommand).toContain(`mkdir -p /workspace/repos ${threadWorkRoot(THREAD_ID)}`);
    // Legacy pre-/workspace root, into the agent's repo root.
    expect(rootPrepCommand).toContain("/home/exedev/work");
    expect(rootPrepCommand).toContain('mv "$d" "/workspace/repos/$name"');
    // Pre-P3 top-level checkouts, into the agent's repo root — but never the two
    // directories that ARE the new layout.
    expect(rootPrepCommand).toContain("for d in /workspace/*/");
    expect(rootPrepCommand).toContain('case "$name" in repos|threads) continue;; esac');

    // ORDER. Both migrations claim `/workspace/repos/<name>` and both move only
    // when the destination is absent, so on a box carrying BOTH an old
    // `/home/exedev/work/<name>` and a live `/workspace/<name>` the loop that
    // runs first wins. The live one must. Running legacy first installs a copy
    // nothing has touched since before the /workspace move as the agent's
    // clone, and orphans the checkout the user was actually editing —
    // unreferenced, with nothing failing.
    expect(rootPrepCommand.indexOf("for d in /workspace/*/")).toBeLessThan(
      rootPrepCommand.indexOf("for d in /home/exedev/work/*/"),
    );
  });

  it("runs multi-line per-repo setup as a single bash-wrapped call and the environment script once, after all repos", async () => {
    listRepositoriesMock.mockResolvedValue([
      makeRepository({
        id: "repo-1",
        name: "repo-a",
        checkoutPathName: "repo-a",
        setupCommand: "echo a\necho b",
      }),
      makeRepository({
        id: "repo-2",
        name: "repo-b",
        checkoutPathName: "repo-b",
        setupCommand: "echo a\necho b",
      }),
    ]);
    getAgentMock.mockResolvedValue({
      id: "env-1",
      workspaceId: "workspace-1",
      name: "env",
      setupScript: "echo env-setup",
    });
    const service = makeService([
      { status: "exited", processId: "mkdir", exitCode: 0 },
      // repo-a: clone probe (missing) -> clone -> worktree probe (missing) -> worktree -> setup
      { status: "exited", processId: "clone-exists-a", exitCode: 1 },
      { status: "exited", processId: "clone-a", exitCode: 0 },
      { status: "exited", processId: "wt-exists-a", exitCode: 1 },
      { status: "exited", processId: "branch-a", exitCode: 1 },
      { status: "exited", processId: "wt-a", exitCode: 0 },
      { status: "exited", processId: "setup-a", exitCode: 0 },
      // repo-b: same
      { status: "exited", processId: "clone-exists-b", exitCode: 1 },
      { status: "exited", processId: "clone-b", exitCode: 0 },
      { status: "exited", processId: "wt-exists-b", exitCode: 1 },
      { status: "exited", processId: "branch-b", exitCode: 1 },
      { status: "exited", processId: "wt-b", exitCode: 0 },
      { status: "exited", processId: "setup-b", exitCode: 0 },
      // environment setup script
      { status: "exited", processId: "env-setup", exitCode: 0 },
    ]);

    const result = await prepare(service)();

    expect(result).toMatchObject({
      environmentSetup: { state: "ok", detail: "environment setup completed" },
    });

    const calls = commandsOf(service);
    // By LABEL, not by position: preparation now brackets its work with a gate
    // probe and a sentinel write, so neither end of the list is the setup.
    const labels = service.exec.mock.calls.map((call) => (call[0] as { label?: string })?.label);
    const envSetupIndex = labels.indexOf("environment setup");
    const setupACallIndex = labels.indexOf("setup repo-a");
    expect(setupACallIndex).toBeGreaterThan(-1);
    expect(envSetupIndex).toBeGreaterThan(-1);

    // Each per-repo setup is a single bash-wrapped invocation (base64 | bash),
    // never two separate exec calls and never the raw multi-line command.
    const bashWrappedCalls = calls.filter((command) => command.includes("| base64 -d | bash"));
    expect(bashWrappedCalls).toHaveLength(3);
    expect(calls).not.toContain("echo a\necho b");
    expect(calls).not.toContain("echo env-setup");

    // The environment script runs exactly once.
    expect(getAgentMock).toHaveBeenCalledTimes(1);

    // It runs after both repos' clone + setup (by call index).
    expect(envSetupIndex).toBeGreaterThan(setupACallIndex);
    expect(calls[envSetupIndex]).toContain("| base64 -d | bash");
    expect(service.exec).toHaveBeenCalledTimes(16);

    // And it runs in the THREAD's working directory — the cwd every later exec
    // defaults to — not `/workspace`.
    expect(service.exec).toHaveBeenCalledWith(
      expect.objectContaining({ cwd: threadWorkRoot(THREAD_ID), label: "environment setup" }),
    );
    // The sentinel is written LAST, after everything it vouches for.
    expect(labels.at(-1)).toBe("record thread preparation");
  });

  it("skips when the git probe fails indeterminately", async () => {
    listRepositoriesMock.mockResolvedValue([makeRepository()]);
    const service = makeService([
      { status: "exited", processId: "mkdir", exitCode: 0 },
      { status: "exited", processId: "clone-exists", exitCode: 0 },
      { status: "failed", processId: "rev-parse" },
    ]);

    await expect(prepare(service)()).resolves.toMatchObject({
      summary: "Repositories are ready for coding work.",
      skipped: [{ name: "nadi", reason: "git checkout probe failed (status: failed)" }],
    });

    // 4, not 3: the gate probe runs before the root preparation.
    expect(service.exec).toHaveBeenCalledTimes(4);
    expect(service.exec).not.toHaveBeenCalledWith(
      expect.objectContaining({ command: expect.stringContaining("remote get-url origin") }),
    );
  });

  it("skips a clone whose origin remote does not match, without touching the worktree", async () => {
    listRepositoriesMock.mockResolvedValue([makeRepository()]);
    const service = makeService(
      [
        { status: "exited", processId: "mkdir", exitCode: 0 },
        { status: "exited", processId: "clone-exists", exitCode: 0 },
        { status: "exited", processId: "rev-parse", exitCode: 0 },
        { status: "exited", processId: "remote", exitCode: 0 },
      ],
      [
        {
          status: "exited",
          processId: "remote",
          exitCode: 0,
          text: "https://github.com/other/repo.git",
        },
      ],
    );

    await expect(prepare(service)()).resolves.toMatchObject({
      skipped: [
        { name: "nadi", reason: "path exists but remote does not match configured repository" },
      ],
    });
    expect(service.exec).not.toHaveBeenCalledWith(
      expect.objectContaining({ command: expect.stringContaining("worktree add") }),
    );
  });

  // The two "nothing to do" branches. Neither had a test in any project, and
  // both are the exact shape a MIS-KEYED repository lookup degrades into: the
  // result carries no `skipped` entries, so the `log.warn` in
  // `agent-sandbox-do.ts` never fires either, and a thread that silently clones
  // nothing is indistinguishable from a thread that was never meant to clone
  // anything. Asserting the ABSENCE of `prepared`/`skipped` (toEqual, not
  // toMatchObject) is the point — the summary string alone cannot tell the two
  // apart. The key the lookup is made with is asserted for the same reason.
  it("returns the no-repositories summary WITHOUT resolving compute when the thread has no agent", async () => {
    getThreadMock.mockResolvedValue({ id: THREAD_ID, agentId: null });
    const resolveComputeService = vi.fn();

    const prepareRepositories = createRepositoryPreparation({
      env: {} as never,
      threadId: THREAD_ID,
      resolveComputeService,
    });

    await expect(prepareRepositories()).resolves.toEqual({
      summary: "No project repositories are configured for this thread.",
      signature: null,
    });
    expect(listRepositoriesMock).not.toHaveBeenCalled();
    expect(resolveComputeService).not.toHaveBeenCalled();
  });

  it("returns the no-repositories summary WITHOUT resolving compute when the thread row is missing", async () => {
    getThreadMock.mockResolvedValue(undefined);
    const resolveComputeService = vi.fn();

    const prepareRepositories = createRepositoryPreparation({
      env: {} as never,
      threadId: THREAD_ID,
      resolveComputeService,
    });

    await expect(prepareRepositories()).resolves.toEqual({
      summary: "No project repositories are configured for this thread.",
      signature: null,
    });
    expect(listRepositoriesMock).not.toHaveBeenCalled();
    expect(resolveComputeService).not.toHaveBeenCalled();
  });

  it("returns the no-repositories summary WITHOUT resolving compute when the agent declares none", async () => {
    listRepositoriesMock.mockResolvedValue([]);
    const resolveComputeService = vi.fn();

    const prepareRepositories = createRepositoryPreparation({
      env: {} as never,
      threadId: THREAD_ID,
      resolveComputeService,
    });

    await expect(prepareRepositories()).resolves.toEqual({
      summary: "No project repositories are configured for this thread.",
      signature: null,
    });
    expect(listRepositoriesMock).toHaveBeenCalledWith("env-1");
    expect(resolveComputeService).not.toHaveBeenCalled();
  });

  /**
   * WHAT THE SIGNATURE COVERS, one input at a time.
   *
   * The gate here is a REAL comparison, not a boolean the test sets: `makeBox`
   * keeps the value the sentinel write stored and answers the gate probe by
   * comparing it against the digest that probe carries — the same thing
   * `test "$(cat sentinel)" = <signature>` does inside the container. So
   * "preparation re-ran" is observed, not asserted about a hash.
   *
   * Each input is proved ALONE: everything else about the agent is held fixed
   * and one field moves. A test that changed two things at once would still
   * pass if only one of them were hashed.
   *
   * And the value case is the load-bearing one. `sandbox_env_vars_json` is a
   * NAME -> VALUE map, the signature is written into a file inside a sandbox
   * the model can read, and hashing the map wholesale would put every secret's
   * value into that digest. Changing only a VALUE must therefore leave the
   * signature alone — which is exactly the assertion that fails if someone
   * hashes the object instead of `Object.keys`.
   */
  describe("the signature covers the agent's whole sandbox configuration", () => {
    /** An agent with a setup script and no repositories: the shortest run. */
    function agentRow(overrides: Record<string, unknown> = {}) {
      return {
        id: "env-1",
        workspaceId: "workspace-1",
        name: "env",
        setupScript: "echo hi",
        resourceProfile: "small",
        sandboxNetworkDomainAllowlist: null,
        sandboxEnvVarsJson: null,
        ...overrides,
      };
    }

    /** The 64-hex digest a gate probe or a sentinel write carries. */
    function digestOf(command: string): string {
      const match = /[0-9a-f]{64}/.exec(command);
      expect(match, `no signature in: ${command}`).toBeTruthy();
      return (match as RegExpExecArray)[0];
    }

    /**
     * A box that REMEMBERS its sentinel across turns, and answers the gate by
     * comparing — the in-container `test "$(cat ...)" = <sig>`, in memory.
     */
    function makeBox() {
      let stored: string | null = null;
      /** One turn against this box. Resolves to whether preparation RAN. */
      return {
        get sentinel() {
          return stored;
        },
        async turn(): Promise<{ ran: boolean; signature: string }> {
          let ran = false;
          let seen: string | null = null;
          const exec = vi.fn(async (input: { command: string; label?: string }) => {
            if (input.label === "check thread preparation") {
              seen = digestOf(input.command);
              return {
                status: "exited" as const,
                processId: "gate",
                exitCode: stored !== null && stored === seen ? 0 : 1,
              };
            }
            if (input.label === "record thread preparation") {
              stored = digestOf(input.command);
              return { status: "exited" as const, processId: "sentinel", exitCode: 0 };
            }
            ran = true;
            return { status: "exited" as const, processId: "work", exitCode: 0 };
          });
          const result = await createRepositoryPreparation({
            env: {} as never,
            threadId: THREAD_ID,
            resolveComputeService: async () =>
              ({ service: { exec, execOutput: vi.fn() } }) as never,
          })();
          expect(result.signature).toBe(seen);
          return { ran, signature: seen as unknown as string };
        },
      };
    }

    /**
     * Prepare once with `before`, then once with `after`, on the SAME box.
     * Returns whether the second turn re-prepared.
     */
    async function reprepared(
      before: Record<string, unknown>,
      after: Record<string, unknown>,
    ): Promise<boolean> {
      listRepositoriesMock.mockResolvedValue([]);
      const box = makeBox();
      getAgentMock.mockResolvedValue(agentRow(before));
      const first = await box.turn();
      // ANTI-VACUITY: the first turn must actually have prepared and recorded,
      // or "the second turn re-prepared" would be meaningless.
      expect(first.ran).toBe(true);
      expect(box.sentinel).toBe(first.signature);
      getAgentMock.mockResolvedValue(agentRow(after));
      return (await box.turn()).ran;
    }

    it("does NOT re-prepare when nothing changed", async () => {
      expect(await reprepared({}, {})).toBe(false);
    });

    it("re-prepares when only the setup script changed", async () => {
      expect(await reprepared({ setupScript: "echo hi" }, { setupScript: "echo bye" })).toBe(true);
    });

    it("re-prepares when only the resource profile changed", async () => {
      expect(await reprepared({ resourceProfile: "small" }, { resourceProfile: "medium" })).toBe(
        true,
      );
    });

    it("re-prepares when only the network allowlist changed", async () => {
      expect(
        await reprepared(
          { sandboxNetworkDomainAllowlist: null },
          { sandboxNetworkDomainAllowlist: "github.com" },
        ),
      ).toBe(true);
    });

    /**
     * An allowlist is a SET. Two agents that allow the same hosts are one
     * configuration, and re-typing the same list in another order must not cost
     * every thread of the agent a fresh clone and setup run.
     */
    it("does NOT re-prepare when the allowlist is only reordered or re-spaced", async () => {
      expect(
        await reprepared(
          { sandboxNetworkDomainAllowlist: "github.com,registry.npmjs.org" },
          { sandboxNetworkDomainAllowlist: " REGISTRY.NPMJS.ORG , github.com " },
        ),
      ).toBe(false);
    });

    it("re-prepares when only an env var NAME changed", async () => {
      expect(
        await reprepared(
          { sandboxEnvVarsJson: JSON.stringify({ API_BASE: "https://one.example" }) },
          { sandboxEnvVarsJson: JSON.stringify({ API_HOST: "https://one.example" }) },
        ),
      ).toBe(true);
    });

    it("re-prepares when an env var is ADDED", async () => {
      expect(
        await reprepared(
          { sandboxEnvVarsJson: JSON.stringify({ A: "1" }) },
          { sandboxEnvVarsJson: JSON.stringify({ A: "1", B: "2" }) },
        ),
      ).toBe(true);
    });

    /**
     * THE ONE THAT PROVES NAMES-ONLY. If the signature hashed the env var map
     * rather than its keys, this would re-prepare — and every value in it would
     * be inside a digest written to a file the model can `cat`.
     */
    it("does NOT re-prepare when only an env var VALUE changed", async () => {
      expect(
        await reprepared(
          { sandboxEnvVarsJson: JSON.stringify({ TOKEN: "secret-one" }) },
          { sandboxEnvVarsJson: JSON.stringify({ TOKEN: "secret-two" }) },
        ),
      ).toBe(false);
    });

    /** Belt and braces on the same point, stated as a property of the digest. */
    it("never writes an env var value into the digest input", async () => {
      listRepositoriesMock.mockResolvedValue([]);
      const box = makeBox();
      getAgentMock.mockResolvedValue(
        agentRow({ sandboxEnvVarsJson: JSON.stringify({ TOKEN: "secret-one" }) }),
      );
      const { signature } = await box.turn();
      // A digest is 64 hex characters and cannot contain the value, so the
      // meaningful check is the one above; this pins the shape of what lands in
      // the box beside it.
      expect(signature).toMatch(/^[0-9a-f]{64}$/);
      expect(signature).not.toContain("secret");
    });
  });
});

/**
 * The root-preparation command, run by a REAL `/bin/sh` (dash, as in the
 * sandbox) against real directories.
 *
 * Two things only a shell can answer. The `case ... esac` and the two globs are
 * POSIX constructs that a string assertion cannot execute — and the ORDER of the
 * two migrations decides which of two checkouts becomes the agent's clone, which
 * no assertion about substrings can decide either.
 *
 * Per `nadi-live-shell-test-eval-template` the command is used VERBATIM apart
 * from repointing its two absolute roots at temp directories, and that
 * substitution is asserted so a rename cannot quietly turn this into a no-op.
 */
describe("rootPreparationCommand against a real shell", () => {
  function rootedCommand(command: string, workspace: string, legacy: string) {
    const rooted = command
      .split("/home/exedev/work")
      .join(legacy)
      .split("/workspace")
      .join(workspace);
    expect(rooted).not.toBe(command);
    return rooted;
  }

  function sh(script: string): void {
    const result = spawnSync("/bin/sh", ["-c", script], { encoding: "utf8" });
    if (result.status !== 0) {
      throw new Error(`shell failed (${result.status}): ${script}\n${result.stderr}`);
    }
  }

  /** Runs the real command against a fixture built by `build`. */
  async function runRootPreparation(build: (workspace: string, legacy: string) => void) {
    listRepositoriesMock.mockResolvedValue([makeRepository()]);
    const service = makeService([{ status: "exited", processId: "mkdir", exitCode: 0 }]);
    // The probe after root prep gets no mocked result, so preparation throws
    // after issuing the ONE command this test is about. That is fine and is
    // asserted rather than swallowed.
    await prepare(service)().catch(() => undefined);
    const command = commandsOf(service).find((entry) => entry.includes("mkdir -p")) as string;
    expect(command, "the root preparation command must have been issued").toBeTruthy();

    const base = mkdtempSync(join(tmpdir(), "nadi-rootprep-"));
    const workspace = join(base, "workspace");
    const legacy = join(base, "legacy");
    sh(`mkdir -p "${workspace}" "${legacy}"`);
    build(workspace, legacy);
    sh(rootedCommand(command, workspace, legacy));
    return { workspace, legacy };
  }

  it("creates the layout and moves a pre-P3 top-level checkout into repos/", async () => {
    const { workspace } = await runRootPreparation((ws) => {
      sh(`mkdir -p "${ws}/nadi" && echo live > "${ws}/nadi/marker.txt"`);
    });

    expect(readdirSync(join(workspace, "repos"))).toContain("nadi");
    expect(readFileSync(join(workspace, "repos", "nadi", "marker.txt"), "utf8")).toBe("live\n");
    // The layout's own directories are not swept into themselves.
    expect(readdirSync(join(workspace, "repos"))).not.toContain("repos");
    expect(readdirSync(join(workspace, "repos"))).not.toContain("threads");
    expect(readdirSync(workspace).sort()).toEqual(["repos", "threads"]);
  });

  /**
   * M1. A box can carry BOTH roots — the pre-change command moved
   * `/home/exedev/work/<name>` only when `/workspace/<name>` was absent, so a
   * stale legacy copy survives beside the live one. Both migrations claim
   * `repos/<name>` and both move only when the destination is absent, so the
   * loop that runs first wins.
   *
   * The live copy must win. Running legacy first installs a directory nothing
   * has touched since before the /workspace move as the agent's clone, and
   * orphans the checkout the user was actually editing — unreferenced, with
   * nothing failing anywhere.
   */
  it("prefers the live /workspace checkout over a stale legacy one of the same name", async () => {
    const { workspace, legacy } = await runRootPreparation((ws, lg) => {
      sh(`mkdir -p "${ws}/nadi" && echo live > "${ws}/nadi/marker.txt"`);
      sh(`mkdir -p "${lg}/nadi" && echo stale > "${lg}/nadi/marker.txt"`);
    });

    expect(readFileSync(join(workspace, "repos", "nadi", "marker.txt"), "utf8")).toBe("live\n");
    // The loser is left where it was rather than deleted — never clobbered.
    expect(readFileSync(join(legacy, "nadi", "marker.txt"), "utf8")).toBe("stale\n");
  });

  it("still migrates the legacy root when nothing at /workspace claims the name", async () => {
    const { workspace } = await runRootPreparation((_ws, lg) => {
      sh(`mkdir -p "${lg}/nadi" && echo legacy > "${lg}/nadi/marker.txt"`);
    });

    expect(readFileSync(join(workspace, "repos", "nadi", "marker.txt"), "utf8")).toBe("legacy\n");
  });
});
