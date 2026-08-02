import type { ProjectSummary } from "../projects-api";

/**
 * Pure decision logic for the composer project picker. Given the current
 * search text and the active projects, decide which projects to show and
 * whether an inline "create" action is offered.
 *
 * Kept DOM-free so the create-vs-select rules (trim, case-insensitive
 * dedupe, empty guard) are testable without rendering the combobox.
 */
export type ProjectPickerState = {
  /** Projects matching the query, in the given order. */
  matches: ProjectSummary[];
  /**
   * The trimmed name to offer as a new project, or null when creation is not
   * offered (empty query, or an active project already has that name).
   */
  createName: string | null;
};

function normalize(value: string): string {
  return value.trim().toLowerCase();
}

export function projectPickerState(projects: ProjectSummary[], query: string): ProjectPickerState {
  const trimmed = query.trim();
  const needle = trimmed.toLowerCase();
  const matches = needle
    ? projects.filter((project) => project.name.toLowerCase().includes(needle))
    : projects;
  const exists = projects.some((project) => normalize(project.name) === needle);
  return {
    matches,
    createName: trimmed && !exists ? trimmed : null,
  };
}
