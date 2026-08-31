import { beforeEach, describe, expect, it, vi } from "vitest";

const { registryDbMock, assertProjectInWorkspaceMock, listRepositoriesMock } = vi.hoisted(() => ({
  registryDbMock: vi.fn(),
  assertProjectInWorkspaceMock: vi.fn(),
  listRepositoriesMock: vi.fn(),
}));

vi.mock("../../../src/db/client", () => ({
  registryDb: registryDbMock,
}));

vi.mock("../../../src/db/repositories/projects", () => ({
  ProjectRepository: class {
    assertProjectInWorkspace = assertProjectInWorkspaceMock;
  },
}));

vi.mock("../../../src/db/repositories/agents", () => ({
  AgentRepository: class {
    listRepositories = listRepositoriesMock;
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
          agentId: "env-1",
        },
      }),
    ).resolves.toBeUndefined();

    expect(registryDbMock).not.toHaveBeenCalled();
    expect(assertProjectInWorkspaceMock).not.toHaveBeenCalled();
    expect(listRepositoriesMock).not.toHaveBeenCalled();
  });

  it("uses the AGENT's LIVE repository list, keyed on the thread's agent id", async () => {
    assertProjectInWorkspaceMock.mockResolvedValue({
      name: "Nadi",
      description: "Main app",
      customInstructions: "Prefer focused tests.",
    });
    listRepositoriesMock.mockResolvedValue([
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
          agentId: "env-1",
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
    expect(listRepositoriesMock).toHaveBeenCalledWith("env-1");
  });
});
