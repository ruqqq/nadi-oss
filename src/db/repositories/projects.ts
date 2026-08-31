import { and, desc, eq, isNotNull, isNull } from "drizzle-orm";
import type { DrizzleD1Database } from "drizzle-orm/d1";
import type * as schema from "../schema";
import { projects, type Project } from "../schema";

export type ProjectStatus = "active" | "archived" | "all";

export class ProjectRepository {
  constructor(private readonly db: DrizzleD1Database<typeof schema>) {}

  async create(input: typeof projects.$inferInsert): Promise<Project> {
    await this.db.insert(projects).values(input);
    const row = await this.getById(input.id);

    if (!row) {
      throw new Error("project_not_found");
    }

    return row;
  }

  async getById(id: string): Promise<Project | undefined> {
    return this.db.select().from(projects).where(eq(projects.id, id)).get();
  }

  async listForWorkspace(
    workspaceId: string,
    status: ProjectStatus = "active",
  ): Promise<Project[]> {
    const archiveFilter =
      status === "active"
        ? isNull(projects.archivedAt)
        : status === "archived"
          ? isNotNull(projects.archivedAt)
          : undefined;

    return this.db
      .select()
      .from(projects)
      .where(
        archiveFilter
          ? and(eq(projects.workspaceId, workspaceId), archiveFilter)
          : eq(projects.workspaceId, workspaceId),
      )
      .orderBy(status === "archived" ? desc(projects.archivedAt) : desc(projects.updatedAt))
      .all();
  }

  async update(
    id: string,
    patch: Partial<
      Pick<Project, "name" | "description" | "customInstructions" | "defaultAgentId" | "updatedAt">
    >,
  ): Promise<void> {
    await this.db.update(projects).set(patch).where(eq(projects.id, id));
  }

  async archive(id: string, archivedAt: number): Promise<void> {
    await this.db
      .update(projects)
      .set({ archivedAt })
      .where(and(eq(projects.id, id), isNull(projects.archivedAt)));
  }

  async assertActiveProjectInWorkspace(projectId: string, workspaceId: string): Promise<Project> {
    const row = await this.db
      .select()
      .from(projects)
      .where(
        and(
          eq(projects.id, projectId),
          eq(projects.workspaceId, workspaceId),
          isNull(projects.archivedAt),
        ),
      )
      .get();

    if (!row) throw new Error("project_not_found");
    return row;
  }

  async assertProjectInWorkspace(projectId: string, workspaceId: string): Promise<Project> {
    const row = await this.db
      .select()
      .from(projects)
      .where(and(eq(projects.id, projectId), eq(projects.workspaceId, workspaceId)))
      .get();

    if (!row) throw new Error("project_not_found");
    return row;
  }
}
