import { describe, expect, it, vi } from "vitest";
import {
  archiveWorkbench,
  createWorkbench,
  deleteWorkbenchSecret,
  listWorkbenches,
  setWorkbenchEnvVars,
  setWorkbenchRepositories,
  setWorkbenchSecret,
  updateWorkbench,
  type WorkbenchRepository,
} from "../../../web/src/workbenches-api";
import { listInstallationRepositories } from "../../../web/src/github-api";

const repository: WorkbenchRepository = {
  id: "repo1",
  workbenchId: "wb1",
  source: "github",
  name: "widgets",
  url: "https://github.com/acme/widgets",
  githubRepoId: 1,
  sourceInstallationId: "inst1",
  accessStatus: "ok",
  checkoutPathName: "widgets",
  defaultBranch: "main",
  rootDirectory: "",
  setupCommand: "",
  packageManager: "",
  createdAt: 0,
};

const workbench = {
  id: "wb1",
  workspaceId: "ws1",
  name: "Backend",
  description: "",
  setupScript: "",
  repositories: [] as WorkbenchRepository[],
  envVars: {},
  secretEnvNames: [],
  archivedAt: null,
  createdAt: 1,
  updatedAt: 1,
};

describe("workbenches api helpers", () => {
  it("lists workbenches", async () => {
    const fetch = vi.fn(async () => Response.json({ workbenches: [workbench] }));
    await expect(listWorkbenches(undefined, fetch)).resolves.toEqual([workbench]);
    expect(fetch).toHaveBeenCalledWith("/api/workbenches", { credentials: "include" });
  });

  it("lists workbenches with a status filter", async () => {
    const fetch = vi.fn(async () => Response.json({ workbenches: [] }));
    await listWorkbenches("archived", fetch);
    expect(fetch).toHaveBeenCalledWith("/api/workbenches?status=archived", {
      credentials: "include",
    });
  });

  it("creates a workbench", async () => {
    const fetch = vi.fn(async () => Response.json({ workbench }, { status: 201 }));
    await expect(
      createWorkbench({ name: "Backend", description: "", setupScript: "" }, fetch),
    ).resolves.toEqual(workbench);
    expect(fetch).toHaveBeenCalledWith("/api/workbenches", {
      method: "POST",
      credentials: "include",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ name: "Backend", description: "", setupScript: "" }),
    });
  });

  it("updates a workbench", async () => {
    const updated = { ...workbench, name: "Renamed" };
    const fetch = vi.fn(async () => Response.json({ workbench: updated }));
    await expect(updateWorkbench("wb1", { name: "Renamed" }, fetch)).resolves.toEqual(updated);
    expect(fetch).toHaveBeenCalledWith("/api/workbenches/wb1", {
      method: "PATCH",
      credentials: "include",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ name: "Renamed" }),
    });
  });

  it("archives a workbench", async () => {
    const archived = { ...workbench, archivedAt: 2 };
    const fetch = vi.fn(async () => Response.json({ workbench: archived }));
    await expect(archiveWorkbench("wb1", fetch)).resolves.toEqual(archived);
    expect(fetch).toHaveBeenCalledWith("/api/workbenches/wb1/archive", {
      method: "POST",
      credentials: "include",
    });
  });

  it("sets workbench repositories", async () => {
    const updated = { ...workbench, repositories: [repository] };
    const fetch = vi.fn(async () => Response.json({ workbench: updated }));
    const input = [
      {
        source: "github" as const,
        name: "widgets",
        url: "https://github.com/acme/widgets",
        githubRepoId: 1,
        sourceInstallationId: "inst1",
        checkoutPathName: "widgets",
        defaultBranch: "main",
      },
    ];
    await expect(setWorkbenchRepositories("wb1", input, fetch)).resolves.toEqual(updated);
    expect(fetch).toHaveBeenCalledWith("/api/workbenches/wb1/repositories", {
      method: "PUT",
      credentials: "include",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(input),
    });
  });

  it("sets workbench env vars", async () => {
    const updated = { ...workbench, envVars: { FOO: "bar" } };
    const fetch = vi.fn(async () => Response.json({ workbench: updated }));
    await expect(setWorkbenchEnvVars("wb1", { FOO: "bar" }, fetch)).resolves.toEqual(updated);
    expect(fetch).toHaveBeenCalledWith("/api/workbenches/wb1/env-vars", {
      method: "PUT",
      credentials: "include",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ envVars: { FOO: "bar" } }),
    });
  });

  it("sets a workbench secret with an encoded name", async () => {
    const fetch = vi.fn(async () => Response.json({ workbench }));
    await setWorkbenchSecret("wb1", "A/B", "shh", fetch);
    expect(fetch).toHaveBeenCalledWith("/api/workbenches/wb1/secrets/A%2FB", {
      method: "PUT",
      credentials: "include",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ value: "shh" }),
    });
  });

  it("deletes a workbench secret with an encoded name", async () => {
    const fetch = vi.fn(async () => Response.json({ workbench }));
    await deleteWorkbenchSecret("wb1", "A/B", fetch);
    expect(fetch).toHaveBeenCalledWith("/api/workbenches/wb1/secrets/A%2FB", {
      method: "DELETE",
      credentials: "include",
    });
  });

  it("throws human-readable errors for non-ok responses", async () => {
    await expect(
      listWorkbenches(undefined, vi.fn(async () => new Response("", { status: 401 }))),
    ).rejects.toThrow("Your session expired. Refresh the page and sign in again.");
  });
});

describe("listInstallationRepositories", () => {
  it("lists repositories for an installation", async () => {
    const repositories = [
      {
        id: 1,
        fullName: "acme/widgets",
        owner: "acme",
        name: "widgets",
        defaultBranch: "main",
        cloneUrl: "https://github.com/acme/widgets.git",
        private: false,
      },
    ];
    const fetch = vi.fn(async () => Response.json({ repositories, hasNextPage: false }));
    await expect(listInstallationRepositories("42", undefined, fetch)).resolves.toEqual({
      repositories,
      hasNextPage: false,
    });
    expect(fetch).toHaveBeenCalledWith("/api/settings/github/installations/42/repositories", {
      credentials: "include",
    });
  });

  it("includes the page query param when provided", async () => {
    const fetch = vi.fn(async () => Response.json({ repositories: [], hasNextPage: true }));
    await listInstallationRepositories("42", 2, fetch);
    expect(fetch).toHaveBeenCalledWith(
      "/api/settings/github/installations/42/repositories?page=2",
      { credentials: "include" },
    );
  });
});
