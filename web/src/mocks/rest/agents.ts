/**
 * `/api/agents*`. Note `PUT /:id/repositories` takes a BARE ARRAY body,
 * not `{repositories}` — see `setAgentRepositories`.
 */

import { http, HttpResponse } from "msw";
import type {
  AgentRepository,
  AgentRepositoryInput,
  AgentResourceProfile,
  AgentSummary,
} from "../../agents-api";
import { getStore } from "../store";
import { mockId, notFound, pathParam } from "./util";

function find(agentId: string): AgentSummary | undefined {
  return getStore().agents.find((w) => w.id === agentId);
}

export const agentHandlers = [
  http.get("/api/agents", ({ request }) => {
    const status = new URL(request.url).searchParams.get("status") ?? "active";
    const agents = getStore().agents.filter((w) => {
      if (status === "all") return true;
      if (status === "archived") return w.archivedAt !== null;
      return w.archivedAt === null;
    });
    return HttpResponse.json({ agents });
  }),

  http.post("/api/agents", async ({ request }) => {
    const store = getStore();
    const input = (await request.json().catch(() => ({}))) as {
      name?: string;
      description?: string;
      setupScript?: string;
      resourceProfile?: AgentResourceProfile;
      networkDomainAllowlist?: string;
    };
    const name = (input.name ?? "").trim();
    if (!name) return HttpResponse.json({ error: "An agent needs a name." }, { status: 400 });
    const now = Date.now();
    const agent: AgentSummary = {
      id: mockId("wb"),
      workspaceId: store.settings?.workspace.id ?? "ws_mock",
      name,
      description: input.description ?? "",
      setupScript: input.setupScript ?? "",
      resourceProfile: input.resourceProfile ?? "small",
      repositories: [],
      envVars: {},
      secretEnvNames: [],
      networkDomainAllowlist: input.networkDomainAllowlist ?? "",
      archivedAt: null,
      createdAt: now,
      updatedAt: now,
    };
    store.agents.push(agent);
    return HttpResponse.json({ agent }, { status: 201 });
  }),

  http.patch("/api/agents/:agentId", async ({ params, request }) => {
    const agent = find(pathParam(params, "agentId"));
    if (!agent) return notFound("That agent");
    const patch = (await request.json().catch(() => ({}))) as {
      name?: string;
      description?: string;
      setupScript?: string;
      resourceProfile?: AgentResourceProfile;
      networkDomainAllowlist?: string;
    };
    if (typeof patch.name === "string") agent.name = patch.name;
    if (typeof patch.description === "string") agent.description = patch.description;
    if (typeof patch.setupScript === "string") agent.setupScript = patch.setupScript;
    if (patch.resourceProfile !== undefined) agent.resourceProfile = patch.resourceProfile;
    if (typeof patch.networkDomainAllowlist === "string")
      agent.networkDomainAllowlist = patch.networkDomainAllowlist;
    agent.updatedAt = Date.now();
    return HttpResponse.json({ agent });
  }),

  http.post("/api/agents/:agentId/archive", ({ params }) => {
    const agent = find(pathParam(params, "agentId"));
    if (!agent) return notFound("That agent");
    agent.archivedAt = Date.now();
    agent.updatedAt = Date.now();
    return HttpResponse.json({ agent });
  }),

  http.put("/api/agents/:agentId/repositories", async ({ params, request }) => {
    const agent = find(pathParam(params, "agentId"));
    if (!agent) return notFound("That agent");
    const body = (await request.json().catch(() => [])) as AgentRepositoryInput[];
    const input = Array.isArray(body) ? body : [];
    agent.repositories = input.map(
      (repo, index): AgentRepository => ({
        id: mockId("wbr"),
        agentId: agent.id,
        source: repo.source,
        name: repo.name,
        url: repo.url,
        githubRepoId: repo.githubRepoId ?? null,
        sourceInstallationId: repo.sourceInstallationId ?? null,
        accessStatus: "ok",
        checkoutPathName: repo.checkoutPathName || `repo-${index + 1}`,
        defaultBranch: repo.defaultBranch ?? "main",
        rootDirectory: repo.rootDirectory ?? "",
        setupCommand: repo.setupCommand ?? "",
        packageManager: repo.packageManager ?? "pnpm",
        createdAt: Date.now(),
      }),
    );
    agent.updatedAt = Date.now();
    return HttpResponse.json({ agent });
  }),

  http.put("/api/agents/:agentId/env-vars", async ({ params, request }) => {
    const agent = find(pathParam(params, "agentId"));
    if (!agent) return notFound("That agent");
    const body = (await request.json().catch(() => ({}))) as {
      envVars?: Record<string, string>;
    };
    agent.envVars = body.envVars ?? {};
    agent.updatedAt = Date.now();
    return HttpResponse.json({ agent });
  }),

  http.put("/api/agents/:agentId/secrets/:name", ({ params }) => {
    const agent = find(pathParam(params, "agentId"));
    if (!agent) return notFound("That agent");
    const name = pathParam(params, "name");
    if (!agent.secretEnvNames.includes(name)) agent.secretEnvNames.push(name);
    agent.updatedAt = Date.now();
    return HttpResponse.json({ agent });
  }),

  http.delete("/api/agents/:agentId/secrets/:name", ({ params }) => {
    const agent = find(pathParam(params, "agentId"));
    if (!agent) return notFound("That agent");
    const name = pathParam(params, "name");
    agent.secretEnvNames = agent.secretEnvNames.filter((n) => n !== name);
    agent.updatedAt = Date.now();
    return HttpResponse.json({ agent });
  }),
];
