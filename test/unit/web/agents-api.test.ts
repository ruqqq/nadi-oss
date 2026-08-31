import { describe, expect, it, vi } from "vitest";
import {
  archiveAgent,
  createAgent,
  deleteAgentSecret,
  listAgents,
  setAgentEnvVars,
  setAgentRepositories,
  setAgentSecret,
  updateAgent,
  type AgentRepository,
} from "../../../web/src/agents-api";
import { listInstallationRepositories } from "../../../web/src/github-api";

const repository: AgentRepository = {
  id: "repo1",
  agentId: "wb1",
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

const agent = {
  id: "wb1",
  workspaceId: "ws1",
  name: "Backend",
  description: "",
  setupScript: "",
  repositories: [] as AgentRepository[],
  envVars: {},
  secretEnvNames: [],
  archivedAt: null,
  createdAt: 1,
  updatedAt: 1,
};

describe("agents api helpers", () => {
  it("lists agents", async () => {
    const fetch = vi.fn(async () => Response.json({ agents: [agent] }));
    await expect(listAgents(undefined, fetch)).resolves.toEqual([agent]);
    expect(fetch).toHaveBeenCalledWith("/api/agents", { credentials: "include" });
  });

  it("lists agents with a status filter", async () => {
    const fetch = vi.fn(async () => Response.json({ agents: [] }));
    await listAgents("archived", fetch);
    expect(fetch).toHaveBeenCalledWith("/api/agents?status=archived", {
      credentials: "include",
    });
  });

  it("creates an agent", async () => {
    const fetch = vi.fn(async () => Response.json({ agent }, { status: 201 }));
    await expect(
      createAgent({ name: "Backend", description: "", setupScript: "" }, fetch),
    ).resolves.toEqual(agent);
    expect(fetch).toHaveBeenCalledWith("/api/agents", {
      method: "POST",
      credentials: "include",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ name: "Backend", description: "", setupScript: "" }),
    });
  });

  it("updates an agent", async () => {
    const updated = { ...agent, name: "Renamed" };
    const fetch = vi.fn(async () => Response.json({ agent: updated }));
    await expect(updateAgent("wb1", { name: "Renamed" }, fetch)).resolves.toEqual(updated);
    expect(fetch).toHaveBeenCalledWith("/api/agents/wb1", {
      method: "PATCH",
      credentials: "include",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ name: "Renamed" }),
    });
  });

  it("archives an agent", async () => {
    const archived = { ...agent, archivedAt: 2 };
    const fetch = vi.fn(async () => Response.json({ agent: archived }));
    await expect(archiveAgent("wb1", fetch)).resolves.toEqual(archived);
    expect(fetch).toHaveBeenCalledWith("/api/agents/wb1/archive", {
      method: "POST",
      credentials: "include",
    });
  });

  it("sets agent repositories", async () => {
    const updated = { ...agent, repositories: [repository] };
    const fetch = vi.fn(async () => Response.json({ agent: updated }));
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
    await expect(setAgentRepositories("wb1", input, fetch)).resolves.toEqual(updated);
    expect(fetch).toHaveBeenCalledWith("/api/agents/wb1/repositories", {
      method: "PUT",
      credentials: "include",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(input),
    });
  });

  it("sets agent env vars", async () => {
    const updated = { ...agent, envVars: { FOO: "bar" } };
    const fetch = vi.fn(async () => Response.json({ agent: updated }));
    await expect(setAgentEnvVars("wb1", { FOO: "bar" }, fetch)).resolves.toEqual(updated);
    expect(fetch).toHaveBeenCalledWith("/api/agents/wb1/env-vars", {
      method: "PUT",
      credentials: "include",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ envVars: { FOO: "bar" } }),
    });
  });

  it("sets an agent secret with an encoded name", async () => {
    const fetch = vi.fn(async () => Response.json({ agent }));
    await setAgentSecret("wb1", "A/B", "shh", fetch);
    expect(fetch).toHaveBeenCalledWith("/api/agents/wb1/secrets/A%2FB", {
      method: "PUT",
      credentials: "include",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ value: "shh" }),
    });
  });

  it("deletes an agent secret with an encoded name", async () => {
    const fetch = vi.fn(async () => Response.json({ agent }));
    await deleteAgentSecret("wb1", "A/B", fetch);
    expect(fetch).toHaveBeenCalledWith("/api/agents/wb1/secrets/A%2FB", {
      method: "DELETE",
      credentials: "include",
    });
  });

  it("throws human-readable errors for non-ok responses", async () => {
    await expect(
      listAgents(undefined, vi.fn(async () => new Response("", { status: 401 }))),
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
