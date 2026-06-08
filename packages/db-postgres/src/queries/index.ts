import { eq, and } from "drizzle-orm";
import { db } from "../db.js";
import { workspaces, workspaceMemberships, runs } from "../schema/index.js";

export type RunStatus = "queued" | "running" | "success" | "failed";

export interface ListRunsFilters {
  status?: RunStatus;
  repositoryId?: string;
  agent?: string;
}

export async function listRuns(
  workspaceId: string,
  filters?: ListRunsFilters
) {
  const conditions = [eq(runs.workspaceId, workspaceId)];
  if (filters?.status) {
    conditions.push(eq(runs.status, filters.status));
  }
  if (filters?.repositoryId) {
    conditions.push(eq(runs.repositoryId, filters.repositoryId));
  }
  if (filters?.agent) {
    conditions.push(eq(runs.agent, filters.agent));
  }
  return db
    .select()
    .from(runs)
    .where(and(...conditions))
    .orderBy(runs.createdAt);
}

export async function listWorkspacesForUser(userId: string) {
  const rows = await db
    .select({
      id: workspaces.id,
      name: workspaces.name,
      slug: workspaces.slug,
      createdAt: workspaces.createdAt,
      updatedAt: workspaces.updatedAt,
      role: workspaceMemberships.role,
    })
    .from(workspaceMemberships)
    .innerJoin(workspaces, eq(workspaceMemberships.workspaceId, workspaces.id))
    .where(eq(workspaceMemberships.userId, userId));

  return rows;
}

export async function getWorkspace(id: string) {
  const rows = await db
    .select()
    .from(workspaces)
    .where(eq(workspaces.id, id))
    .limit(1);

  return rows[0] ?? null;
}

export async function getWorkspaceMembership(
  userId: string,
  workspaceId: string
) {
  const rows = await db
    .select()
    .from(workspaceMemberships)
    .where(
      and(
        eq(workspaceMemberships.userId, userId),
        eq(workspaceMemberships.workspaceId, workspaceId)
      )
    )
    .limit(1);

  return rows[0] ?? null;
}
