import { describe, expect, test } from "vitest";
import type { ProjectSummary } from "../projects-api";
import { projectPickerState } from "./project-picker";

function project(id: string, name: string): ProjectSummary {
  return {
    id,
    workspaceId: "ws_1",
    name,
    description: "",
    customInstructions: "",
    defaultAgentId: null,
    archivedAt: null,
    createdAt: 0,
    updatedAt: 0,
  };
}

const projects = [project("p1", "Nadi"), project("p2", "Marketing site")];

describe("projectPickerState", () => {
  test("empty query lists all projects and offers no create", () => {
    expect(projectPickerState(projects, "")).toEqual({ matches: projects, createName: null });
  });

  test("whitespace-only query is treated as empty", () => {
    expect(projectPickerState(projects, "   ")).toEqual({ matches: projects, createName: null });
  });

  test("filters case-insensitively by substring", () => {
    const state = projectPickerState(projects, "mark");
    expect(state.matches.map((p) => p.id)).toEqual(["p2"]);
  });

  test("offers a trimmed create name when nothing matches exactly", () => {
    expect(projectPickerState(projects, "  Redesign  ").createName).toBe("Redesign");
  });

  test("does not offer create when an active project already has that name (case-insensitive)", () => {
    expect(projectPickerState(projects, "nadi").createName).toBeNull();
  });

  test("still filters matches while offering a create for a novel prefix", () => {
    const state = projectPickerState(projects, "Nadi 2");
    expect(state.matches).toEqual([]);
    expect(state.createName).toBe("Nadi 2");
  });
});
