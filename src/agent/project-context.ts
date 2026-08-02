import { registryDb } from "../db/client";
import { ProjectRepository } from "../db/repositories/projects";
import { ThreadRepositorySnapshotRepository } from "../db/repositories/thread-repository-snapshots";
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
  const snapshots = await new ThreadRepositorySnapshotRepository(db).listForThread(
    input.thread.threadId,
  );

  return {
    name: project.name,
    description: project.description,
    instructions: project.customInstructions,
    repositories: snapshots.map((snapshot) => ({
      name: snapshot.name,
      url: snapshot.url,
      defaultBranch: snapshot.defaultBranch,
      checkoutPath: snapshot.checkoutPathName,
      rootDirectory: snapshot.rootDirectory,
      setupCommand: snapshot.setupCommand,
      packageManager: snapshot.packageManager,
    })),
  };
}
