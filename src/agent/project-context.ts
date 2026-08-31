import { registryDb } from "../db/client";
import { ProjectRepository } from "../db/repositories/projects";
import { WorkbenchRepository } from "../db/repositories/workbenches";
import type { Env } from "../env";

export interface ProjectPromptRepositoryContext {
  name: string;
  url: string;
  defaultBranch: string;
  checkoutPath: string;
  rootDirectory: string;
  setupCommand: string;
  packageManager: string;
}

export interface ProjectPromptContext {
  name: string;
  description: string;
  instructions: string;
  repositories: ProjectPromptRepositoryContext[];
}

export interface ProjectPromptThreadContext {
  threadId: string;
  workspaceId: string;
  projectId: string | null;
  /** The thread's environment. REQUIRED, not optional: omitting it would
   *  silently drop every repository from the prompt. */
  workbenchId: string | null;
}

export async function resolveProjectPromptContext(input: {
  env: Env;
  thread: ProjectPromptThreadContext;
}): Promise<ProjectPromptContext | undefined> {
  if (input.thread.projectId === null) {
    return undefined;
  }

  const db = registryDb(input.env);
  const project = await new ProjectRepository(db).assertProjectInWorkspace(
    input.thread.projectId,
    input.thread.workspaceId,
  );
  // Read LIVE from the environment's repository list — the per-thread snapshot
  // is gone. Same ordering (by id) the snapshot rows had.
  const repositories =
    input.thread.workbenchId === null
      ? []
      : await new WorkbenchRepository(db).listRepositories(input.thread.workbenchId);

  return {
    name: project.name,
    description: project.description,
    instructions: project.customInstructions,
    repositories: repositories.map((repository) => ({
      name: repository.name,
      url: repository.url,
      defaultBranch: repository.defaultBranch,
      checkoutPath: repository.checkoutPathName,
      rootDirectory: repository.rootDirectory,
      setupCommand: repository.setupCommand,
      packageManager: repository.packageManager,
    })),
  };
}
