import { eq, and } from "drizzle-orm";
import { db } from "./client";
import { workspaces, workspaceMemberships } from "./schema";

export async function listWorkspacesForUser(userId: string) {
  return db
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
}

export async function getWorkspace(id: string) {
  const results = await db
    .select()
    .from(workspaces)
    .where(eq(workspaces.id, id))
    .limit(1);
  return results[0] ?? null;
}

export async function getWorkspaceMembership(
  userId: string,
  workspaceId: string
) {
  const results = await db
    .select()
    .from(workspaceMemberships)
    .where(
      and(
        eq(workspaceMemberships.userId, userId),
        eq(workspaceMemberships.workspaceId, workspaceId)
      )
    )
    .limit(1);
  return results[0] ?? null;
}
