import { registryDb } from "../db/client";
import { ProjectRepository } from "../db/repositories/projects";
import { AgentRepository } from "../db/repositories/agents";
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
  /** The thread's AGENT — which is its environment. REQUIRED, not optional:
   *  omitting it would silently drop every repository from the prompt. */
  agentId: string;
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
  // Read LIVE from the AGENT's repository list — the per-thread snapshot is
  // gone. Same ordering (by id) the snapshot rows had. Keyed on the thread's
  // agent id, which is what `agent_repositories.agent_id` now holds.
  const repositories = await new AgentRepository(db).listRepositories(input.thread.agentId);

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
