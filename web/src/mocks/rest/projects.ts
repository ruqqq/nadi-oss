/** `/api/projects*`. Every single-item response is wrapped as `{project}`. */

import { http, HttpResponse } from "msw";
import type { ProjectSummary } from "../../projects-api";
import { getStore } from "../store";
import { mockId, notFound, pathParam } from "./util";

export const projectHandlers = [
  http.get("/api/projects", ({ request }) => {
    const status = new URL(request.url).searchParams.get("status") ?? "active";
    const projects = getStore().projects.filter((p) => {
      if (status === "all") return true;
      if (status === "archived") return p.archivedAt !== null;
      return p.archivedAt === null;
    });
    return HttpResponse.json({ projects });
  }),

  http.post("/api/projects", async ({ request }) => {
    const store = getStore();
    const input = (await request.json().catch(() => ({}))) as {
      name?: string;
      description?: string;
      customInstructions?: string;
    };
    const name = (input.name ?? "").trim();
    if (!name) return HttpResponse.json({ error: "A project needs a name." }, { status: 400 });
    const now = Date.now();
    const project: ProjectSummary = {
      id: mockId("prj"),
      workspaceId: store.settings?.workspace.id ?? "ws_mock",
      name,
      description: input.description ?? "",
      customInstructions: input.customInstructions ?? "",
      defaultWorkbenchId: null,
      archivedAt: null,
      createdAt: now,
      updatedAt: now,
    };
    store.projects.push(project);
    return HttpResponse.json({ project }, { status: 201 });
  }),

  http.get("/api/projects/:projectId", ({ params }) => {
    const project = getStore().projects.find((p) => p.id === pathParam(params, "projectId"));
    if (!project) return notFound("That project");
    return HttpResponse.json({ project });
  }),

  http.patch("/api/projects/:projectId", async ({ params, request }) => {
    const store = getStore();
    const project = store.projects.find((p) => p.id === pathParam(params, "projectId"));
    if (!project) return notFound("That project");
    const patch = (await request.json().catch(() => ({}))) as Partial<ProjectSummary>;
    if (typeof patch.name === "string") project.name = patch.name;
    if (typeof patch.description === "string") project.description = patch.description;
    if (typeof patch.customInstructions === "string") {
      project.customInstructions = patch.customInstructions;
    }
    if (patch.defaultWorkbenchId !== undefined) {
      project.defaultWorkbenchId = patch.defaultWorkbenchId;
    }
    project.updatedAt = Date.now();
    // Threads carry a denormalized project name; leaving it stale is exactly the
    // kind of drift the mock is supposed to make visible, so keep it in sync.
    for (const thread of store.threads) {
      if (thread.projectId === project.id) thread.projectName = project.name;
    }
    return HttpResponse.json({ project });
  }),

  http.post("/api/projects/:projectId/archive", ({ params }) => {
    const project = getStore().projects.find((p) => p.id === pathParam(params, "projectId"));
    if (!project) return notFound("That project");
    project.archivedAt = Date.now();
    project.updatedAt = Date.now();
    return HttpResponse.json({ project });
  }),
];
