import type { ThreadSummary } from "../threads-api";

export type ProjectThreadFilter = "all" | "unassigned" | string;

export function buildProjectThreadQuery(filter: ProjectThreadFilter): {
  project?: "unassigned";
  projectId?: string;
} {
  if (filter === "all") return {};
  if (filter === "unassigned") return { project: "unassigned" };
  return { projectId: filter };
}

export function threadMatchesProjectFilter(
  thread: Pick<ThreadSummary, "projectId">,
  filter: ProjectThreadFilter,
): boolean {
  const query = buildProjectThreadQuery(filter);
  if (query.project === "unassigned") return thread.projectId === null;
  if (query.projectId) return thread.projectId === query.projectId;
  return true;
}
