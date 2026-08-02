import { describe, expect, it } from "vitest";
import { getProject } from "./projects-api";

function mockFetch(status: number, body: unknown): typeof fetch {
  return (async () =>
    new Response(JSON.stringify(body), {
      status,
      headers: { "content-type": "application/json" },
    })) as typeof fetch;
}

describe("getProject", () => {
  it("parses a project detail payload including its default workbench id", async () => {
    const project = await getProject(
      "proj-1",
      mockFetch(200, {
        project: {
          id: "proj-1",
          workspaceId: "ws-1",
          name: "Project 1",
          description: "",
          customInstructions: "",
          defaultWorkbenchId: "env-1",
          archivedAt: null,
          createdAt: 1,
          updatedAt: 2,
        },
      }),
    );

    expect(project.defaultWorkbenchId).toBe("env-1");
  });

  it("throws a human-readable error on a non-ok response", async () => {
    await expect(getProject("proj-1", mockFetch(404, {}))).rejects.toThrow(
      "That item couldn't be found — it may have already been removed.",
    );
  });
});
