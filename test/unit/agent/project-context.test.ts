import { beforeEach, describe, expect, it, vi } from "vitest";

const { registryDbMock, assertProjectInWorkspaceMock, listForThreadMock } = vi.hoisted(() => ({
  registryDbMock: vi.fn(),
  assertProjectInWorkspaceMock: vi.fn(),
  listForThreadMock: vi.fn(),
}));

vi.mock("../../../src/db/client", () => ({
  registryDb: registryDbMock,
}));

vi.mock("../../../src/db/repositories/projects", () => ({
  ProjectRepository: class {
    assertProjectInWorkspace = assertProjectInWorkspaceMock;
  },
}));

vi.mock("../../../src/db/repositories/thread-repository-snapshots", () => ({
  ThreadRepositorySnapshotRepository: class {
    listForThread = listForThreadMock;
  },
}));

import { resolveProjectPromptContext } from "../../../src/agent/project-context";

describe("resolveProjectPromptContext", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    registryDbMock.mockReturnValue({ db: "mock" });
  });

  it("returns undefined immediately for unassigned threads", async () => {
    await expect(
      resolveProjectPromptContext({
        env: {} as never,
        thread: {
          threadId: "thread-1",
          workspaceId: "workspace-1",
          projectId: null,
        },
      }),
    ).resolves.toBeUndefined();

    expect(registryDbMock).not.toHaveBeenCalled();
    expect(assertProjectInWorkspaceMock).not.toHaveBeenCalled();
    expect(listForThreadMock).not.toHaveBeenCalled();
  });

  it("uses the provided thread context to resolve project and repository snapshots", async () => {
    assertProjectInWorkspaceMock.mockResolvedValue({
      name: "Nadi",
      description: "Main app",
      customInstructions: "Prefer focused tests.",
    });
    listForThreadMock.mockResolvedValue([
      {
        name: "nadi",
        url: "https://github.com/acme/nadi.git",
        defaultBranch: "main",
        checkoutPathName: "nadi",
        rootDirectory: "/",
        setupCommand: "pnpm install",
        packageManager: "pnpm",
      },
    ]);

    await expect(
      resolveProjectPromptContext({
        env: {} as never,
        thread: {
          threadId: "thread-1",
          workspaceId: "workspace-1",
          projectId: "project-1",
        },
      }),
    ).resolves.toEqual({
      name: "Nadi",
      description: "Main app",
      instructions: "Prefer focused tests.",
      repositories: [
        {
          name: "nadi",
          url: "https://github.com/acme/nadi.git",
          defaultBranch: "main",
          checkoutPath: "nadi",
          rootDirectory: "/",
          setupCommand: "pnpm install",
          packageManager: "pnpm",
        },
      ],
    });

    expect(registryDbMock).toHaveBeenCalledTimes(1);
    expect(assertProjectInWorkspaceMock).toHaveBeenCalledWith("project-1", "workspace-1");
    expect(listForThreadMock).toHaveBeenCalledWith("thread-1");
  });
});
