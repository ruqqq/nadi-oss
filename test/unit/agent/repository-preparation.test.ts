import { beforeEach, describe, expect, it, vi } from "vitest";
import type { AgentRepositoryRow } from "../../../src/db/schema";

const { registryDbMock, getThreadMock, listRepositoriesMock, getWorkbenchMock } = vi.hoisted(
  () => ({
    registryDbMock: vi.fn(),
    getThreadMock: vi.fn(),
    listRepositoriesMock: vi.fn(),
    getWorkbenchMock: vi.fn(),
  }),
);

vi.mock("../../../src/db/client", () => ({
  registryDb: registryDbMock,
}));

vi.mock("../../../src/db/repositories/threads", () => ({
  ThreadRepository: class {
    getById = getThreadMock;
  },
}));

vi.mock("../../../src/db/repositories/workbenches", () => ({
  WorkbenchRepository: class {
    listRepositories = listRepositoriesMock;
    getById = getWorkbenchMock;
  },
}));

import { createRepositoryPreparation } from "../../../src/agent/repository-preparation";

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

function makeService(execResults: ExecResult[], execOutputResults: ExecResult[] = []) {
  const exec = vi.fn();
  for (const result of execResults) {
    exec.mockResolvedValueOnce(result);
  }

  const execOutput = vi.fn();
  for (const result of execOutputResults) {
    execOutput.mockResolvedValueOnce(result);
  }

  return { exec, execOutput };
}

describe("createRepositoryPreparation", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    registryDbMock.mockReturnValue({ db: "mock" });
    // Every case runs against a thread assigned to environment `env-1`.
    getThreadMock.mockResolvedValue({ id: "thread-1", workbenchId: "env-1" });
    getWorkbenchMock.mockResolvedValue(undefined);
  });

  it("clones when the checkout path test exits non-zero for a missing path", async () => {
    listRepositoriesMock.mockResolvedValue([makeRepository()]);
    const service = makeService([
      { status: "exited", processId: "mkdir", exitCode: 0 },
      { status: "exited", processId: "exists", exitCode: 1 },
      { status: "exited", processId: "clone", exitCode: 0 },
    ]);

    const prepareRepositories = createRepositoryPreparation({
      env: {} as never,
      threadId: "thread-1",
      resolveComputeService: async () => ({ service }),
    });

    await expect(prepareRepositories()).resolves.toMatchObject({
      summary: "Repositories are ready for coding work.",
      prepared: [
        {
          name: "nadi",
          checkoutPath: "/workspace/nadi",
          status: "cloned",
          setup: "no setup command configured",
        },
      ],
    });

    expect(service.exec).toHaveBeenCalledWith(
      expect.objectContaining({
        command:
          "git clone https://x-access-token:${GH_TOKEN}@github.com/acme/nadi.git '/workspace/nadi'",
      }),
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
   * The result: every fresh workbench sandbox came up with an empty /workspace
   * and the model had to improvise a clone by hand. The skip was invisible —
   * `onFreshRuntimeAcquired` discards the returned summary. Observed live on
   * thr_92e0b60c: `test -e /workspace/nadi` returned status `failed`, exitCode 1.
   */
  it("clones when a MISSING path is reported as failed/1 (the Cloudflare shape)", async () => {
    listRepositoriesMock.mockResolvedValue([makeRepository()]);
    const service = makeService([
      { status: "exited", processId: "mkdir", exitCode: 0 },
      { status: "failed", processId: "exists", exitCode: 1 },
      { status: "exited", processId: "clone", exitCode: 0 },
    ]);

    const prepareRepositories = createRepositoryPreparation({
      env: {} as never,
      threadId: "thread-1",
      resolveComputeService: async () => ({ service }),
    });

    await expect(prepareRepositories()).resolves.toMatchObject({
      prepared: [{ name: "nadi", status: "cloned" }],
    });
  });

  it("treats a failed/1 rev-parse as a non-git path, not a probe error", async () => {
    listRepositoriesMock.mockResolvedValue([makeRepository()]);
    const service = makeService([
      { status: "exited", processId: "mkdir", exitCode: 0 },
      { status: "exited", processId: "exists", exitCode: 0 },
      { status: "failed", processId: "rev-parse", exitCode: 1 },
    ]);

    const prepareRepositories = createRepositoryPreparation({
      env: {} as never,
      threadId: "thread-1",
      resolveComputeService: async () => ({ service }),
    });

    await expect(prepareRepositories()).resolves.toMatchObject({
      skipped: [
        {
          name: "nadi",
          reason: "path exists but is not a git checkout",
        },
      ],
    });
  });

  it("skips an existing non-git path when rev-parse exits non-zero", async () => {
    listRepositoriesMock.mockResolvedValue([makeRepository()]);
    const service = makeService([
      { status: "exited", processId: "mkdir", exitCode: 0 },
      { status: "exited", processId: "exists", exitCode: 0 },
      { status: "exited", processId: "rev-parse", exitCode: 1 },
    ]);

    const prepareRepositories = createRepositoryPreparation({
      env: {} as never,
      threadId: "thread-1",
      resolveComputeService: async () => ({ service }),
    });

    await expect(prepareRepositories()).resolves.toMatchObject({
      summary: "Repositories are ready for coding work.",
      skipped: [{ name: "nadi", reason: "path exists but is not a git checkout" }],
    });

    expect(service.exec).not.toHaveBeenCalledWith(
      expect.objectContaining({ command: expect.stringContaining("remote get-url origin") }),
    );
    expect(service.exec).not.toHaveBeenCalledWith(
      expect.objectContaining({ command: expect.stringContaining("git clone") }),
    );
  });

  it("reports clone failure as skipped when clone exits non-zero", async () => {
    listRepositoriesMock.mockResolvedValue([makeRepository()]);
    const service = makeService([
      { status: "exited", processId: "mkdir", exitCode: 0 },
      { status: "exited", processId: "exists", exitCode: 1 },
      { status: "exited", processId: "clone", exitCode: 128 },
    ]);

    const prepareRepositories = createRepositoryPreparation({
      env: {} as never,
      threadId: "thread-1",
      resolveComputeService: async () => ({ service }),
    });

    await expect(prepareRepositories()).resolves.toMatchObject({
      summary: "Repositories are ready for coding work.",
      skipped: [{ name: "nadi", reason: "clone failed with exit code 128" }],
    });

    expect(service.exec).not.toHaveBeenCalledWith(
      expect.objectContaining({ command: expect.stringContaining("git reset") }),
    );
    expect(service.exec).not.toHaveBeenCalledWith(
      expect.objectContaining({ command: expect.stringContaining("git pull") }),
    );
  });

  it("skips when the repository path probe fails indeterminately", async () => {
    listRepositoriesMock.mockResolvedValue([makeRepository()]);
    const service = makeService([
      { status: "exited", processId: "mkdir", exitCode: 0 },
      { status: "failed", processId: "exists" },
    ]);

    const prepareRepositories = createRepositoryPreparation({
      env: {} as never,
      threadId: "thread-1",
      resolveComputeService: async () => ({ service }),
    });

    await expect(prepareRepositories()).resolves.toMatchObject({
      summary: "Repositories are ready for coding work.",
      skipped: [{ name: "nadi", reason: "repository path probe failed (status: failed)" }],
    });

    expect(service.exec).toHaveBeenCalledTimes(2);
    expect(service.exec).not.toHaveBeenCalledWith(
      expect.objectContaining({ command: expect.stringContaining("git clone") }),
    );
    expect(service.exec).not.toHaveBeenCalledWith(
      expect.objectContaining({ command: expect.stringContaining("pnpm install") }),
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
        { status: "exited", processId: "exists", exitCode: 0 },
        { status: "exited", processId: "rev-parse", exitCode: 0 },
        { status: "exited", processId: "remote", exitCode: 0 },
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

    const prepareRepositories = createRepositoryPreparation({
      env: {} as never,
      threadId: "thread-1",
      resolveComputeService: async () => ({ service }),
    });

    await expect(prepareRepositories()).resolves.toMatchObject({
      summary: "Repositories are ready for coding work.",
      prepared: [
        {
          name: "nadi",
          status: "already_cloned",
          setup: "pnpm install failed with exit code 2",
        },
      ],
    });
  });

  it("reuses an existing checkout when the authenticated origin remote matches", async () => {
    listRepositoriesMock.mockResolvedValue([makeRepository()]);
    const service = makeService(
      [
        { status: "exited", processId: "mkdir", exitCode: 0 },
        { status: "exited", processId: "exists", exitCode: 0 },
        { status: "exited", processId: "rev-parse", exitCode: 0 },
        { status: "exited", processId: "remote", exitCode: 0 },
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

    const prepareRepositories = createRepositoryPreparation({
      env: {} as never,
      threadId: "thread-1",
      resolveComputeService: async () => ({ service }),
    });

    await expect(prepareRepositories()).resolves.toMatchObject({
      summary: "Repositories are ready for coding work.",
      prepared: [
        {
          name: "nadi",
          checkoutPath: "/workspace/nadi",
          status: "already_cloned",
          setup: "no setup command configured",
        },
      ],
    });

    expect(service.exec).not.toHaveBeenCalledWith(
      expect.objectContaining({ command: expect.stringContaining("git clone") }),
    );
    expect(service.exec).not.toHaveBeenCalledWith(
      expect.objectContaining({ command: expect.stringContaining("checkout") }),
    );
  });

  it("migrates legacy checkouts from the pre-/workspace root while preparing the root", async () => {
    listRepositoriesMock.mockResolvedValue([makeRepository()]);
    const service = makeService([
      { status: "exited", processId: "mkdir", exitCode: 0 },
      { status: "exited", processId: "exists", exitCode: 1 },
      { status: "exited", processId: "clone", exitCode: 0 },
    ]);

    const prepareRepositories = createRepositoryPreparation({
      env: {} as never,
      threadId: "thread-1",
      resolveComputeService: async () => ({ service }),
    });

    await prepareRepositories();

    const rootPrepCommand = service.exec.mock.calls[0]?.[0]?.command as string;
    // New root is created, and any checkout under the old root is moved over only
    // when the destination is absent (never clobbering a fresh checkout).
    expect(rootPrepCommand).toContain("mkdir -p /workspace");
    expect(rootPrepCommand).toContain("/home/exedev/work");
    expect(rootPrepCommand).toMatch(/mv .*\/workspace/);
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
    getWorkbenchMock.mockResolvedValue({
      id: "env-1",
      workspaceId: "workspace-1",
      name: "env",
      setupScript: "echo env-setup",
    });
    const service = makeService([
      { status: "exited", processId: "mkdir", exitCode: 0 },
      // repo-a: exists probe (missing) -> clone -> setup
      { status: "exited", processId: "exists-a", exitCode: 1 },
      { status: "exited", processId: "clone-a", exitCode: 0 },
      { status: "exited", processId: "setup-a", exitCode: 0 },
      // repo-b: exists probe (missing) -> clone -> setup
      { status: "exited", processId: "exists-b", exitCode: 1 },
      { status: "exited", processId: "clone-b", exitCode: 0 },
      { status: "exited", processId: "setup-b", exitCode: 0 },
      // environment setup script
      { status: "exited", processId: "env-setup", exitCode: 0 },
    ]);

    const prepareRepositories = createRepositoryPreparation({
      env: {} as never,
      threadId: "thread-1",
      resolveComputeService: async () => ({ service }),
    });

    const result = await prepareRepositories();

    expect(result).toMatchObject({
      environmentSetup: "environment setup completed",
    });

    const calls = service.exec.mock.calls.map((call) => call[0]?.command as string);
    const setupACallIndex = calls.findIndex(
      (command) => command.includes("| base64 -d | bash") && command !== calls[calls.length - 1],
    );

    // Each per-repo setup is a single bash-wrapped invocation (base64 | bash),
    // never two separate exec calls and never the raw multi-line command.
    const bashWrappedCalls = calls.filter((command) => command.includes("| base64 -d | bash"));
    expect(bashWrappedCalls).toHaveLength(3);
    expect(calls).not.toContain("echo a\necho b");
    expect(calls).not.toContain("echo env-setup");

    // The environment script runs exactly once.
    expect(getWorkbenchMock).toHaveBeenCalledTimes(1);

    // It runs after both repos' clone + setup (by call index).
    const envSetupIndex = calls.length - 1;
    expect(envSetupIndex).toBeGreaterThan(setupACallIndex);
    expect(calls[envSetupIndex]).toContain("| base64 -d | bash");
    expect(service.exec).toHaveBeenCalledTimes(8);
  });

  it("skips when the git probe fails indeterminately", async () => {
    listRepositoriesMock.mockResolvedValue([makeRepository()]);
    const service = makeService([
      { status: "exited", processId: "mkdir", exitCode: 0 },
      { status: "exited", processId: "exists", exitCode: 0 },
      { status: "failed", processId: "rev-parse" },
    ]);

    const prepareRepositories = createRepositoryPreparation({
      env: {} as never,
      threadId: "thread-1",
      resolveComputeService: async () => ({ service }),
    });

    await expect(prepareRepositories()).resolves.toMatchObject({
      summary: "Repositories are ready for coding work.",
      skipped: [{ name: "nadi", reason: "git checkout probe failed (status: failed)" }],
    });

    expect(service.exec).toHaveBeenCalledTimes(3);
    expect(service.exec).not.toHaveBeenCalledWith(
      expect.objectContaining({ command: expect.stringContaining("remote get-url origin") }),
    );
    expect(service.exec).not.toHaveBeenCalledWith(
      expect.objectContaining({ command: expect.stringContaining("pnpm install") }),
    );
  });
});
