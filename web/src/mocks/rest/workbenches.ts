/**
 * `/api/workbenches*`. Note `PUT /:id/repositories` takes a BARE ARRAY body,
 * not `{repositories}` — see `setWorkbenchRepositories`.
 */

import { http, HttpResponse } from "msw";
import type {
  WorkbenchRepository,
  WorkbenchRepositoryInput,
  WorkbenchResourceProfile,
  WorkbenchSummary,
} from "../../workbenches-api";
import { getStore } from "../store";
import { mockId, notFound, pathParam } from "./util";

function find(workbenchId: string): WorkbenchSummary | undefined {
  return getStore().workbenches.find((w) => w.id === workbenchId);
}

export const workbenchHandlers = [
  http.get("/api/workbenches", ({ request }) => {
    const status = new URL(request.url).searchParams.get("status") ?? "active";
    const workbenches = getStore().workbenches.filter((w) => {
      if (status === "all") return true;
      if (status === "archived") return w.archivedAt !== null;
      return w.archivedAt === null;
    });
    return HttpResponse.json({ workbenches });
  }),

  http.post("/api/workbenches", async ({ request }) => {
    const store = getStore();
    const input = (await request.json().catch(() => ({}))) as {
      name?: string;
      description?: string;
      setupScript?: string;
      resourceProfile?: WorkbenchResourceProfile;
      networkDomainAllowlist?: string;
    };
    const name = (input.name ?? "").trim();
    if (!name) return HttpResponse.json({ error: "A workbench needs a name." }, { status: 400 });
    const now = Date.now();
    const workbench: WorkbenchSummary = {
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
    store.workbenches.push(workbench);
    return HttpResponse.json({ workbench }, { status: 201 });
  }),

  http.patch("/api/workbenches/:workbenchId", async ({ params, request }) => {
    const workbench = find(pathParam(params, "workbenchId"));
    if (!workbench) return notFound("That workbench");
    const patch = (await request.json().catch(() => ({}))) as {
      name?: string;
      description?: string;
      setupScript?: string;
      resourceProfile?: WorkbenchResourceProfile;
      networkDomainAllowlist?: string;
    };
    if (typeof patch.name === "string") workbench.name = patch.name;
    if (typeof patch.description === "string") workbench.description = patch.description;
    if (typeof patch.setupScript === "string") workbench.setupScript = patch.setupScript;
    if (patch.resourceProfile !== undefined) workbench.resourceProfile = patch.resourceProfile;
    if (typeof patch.networkDomainAllowlist === "string")
      workbench.networkDomainAllowlist = patch.networkDomainAllowlist;
    workbench.updatedAt = Date.now();
    return HttpResponse.json({ workbench });
  }),

  http.post("/api/workbenches/:workbenchId/archive", ({ params }) => {
    const workbench = find(pathParam(params, "workbenchId"));
    if (!workbench) return notFound("That workbench");
    workbench.archivedAt = Date.now();
    workbench.updatedAt = Date.now();
    return HttpResponse.json({ workbench });
  }),

  http.put("/api/workbenches/:workbenchId/repositories", async ({ params, request }) => {
    const workbench = find(pathParam(params, "workbenchId"));
    if (!workbench) return notFound("That workbench");
    const body = (await request.json().catch(() => [])) as WorkbenchRepositoryInput[];
    const input = Array.isArray(body) ? body : [];
    workbench.repositories = input.map(
      (repo, index): WorkbenchRepository => ({
        id: mockId("wbr"),
        workbenchId: workbench.id,
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
    workbench.updatedAt = Date.now();
    return HttpResponse.json({ workbench });
  }),

  http.put("/api/workbenches/:workbenchId/env-vars", async ({ params, request }) => {
    const workbench = find(pathParam(params, "workbenchId"));
    if (!workbench) return notFound("That workbench");
    const body = (await request.json().catch(() => ({}))) as {
      envVars?: Record<string, string>;
    };
    workbench.envVars = body.envVars ?? {};
    workbench.updatedAt = Date.now();
    return HttpResponse.json({ workbench });
  }),

  http.put("/api/workbenches/:workbenchId/secrets/:name", ({ params }) => {
    const workbench = find(pathParam(params, "workbenchId"));
    if (!workbench) return notFound("That workbench");
    const name = pathParam(params, "name");
    if (!workbench.secretEnvNames.includes(name)) workbench.secretEnvNames.push(name);
    workbench.updatedAt = Date.now();
    return HttpResponse.json({ workbench });
  }),

  http.delete("/api/workbenches/:workbenchId/secrets/:name", ({ params }) => {
    const workbench = find(pathParam(params, "workbenchId"));
    if (!workbench) return notFound("That workbench");
    const name = pathParam(params, "name");
    workbench.secretEnvNames = workbench.secretEnvNames.filter((n) => n !== name);
    workbench.updatedAt = Date.now();
    return HttpResponse.json({ workbench });
  }),
];
