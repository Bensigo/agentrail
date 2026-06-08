import { eq, and, desc } from "drizzle-orm";
import type { SQL } from "drizzle-orm";
import { db } from "./client";
import { workspaces, workspaceMemberships, runs, reviewGates, repositories, teams, teamMemberships } from "./schema";

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

export async function listRuns(
  workspaceId: string,
  filters?: {
    status?: "queued" | "running" | "success" | "failed";
    agent?: string;
    limit?: number;
  }
) {
  const conditions: SQL[] = [eq(runs.workspaceId, workspaceId)];
  if (filters?.status) {
    conditions.push(eq(runs.status, filters.status));
  }
  if (filters?.agent) {
    conditions.push(eq(runs.agent, filters.agent));
  }

  return db
    .select()
    .from(runs)
    .where(and(...conditions))
    .orderBy(desc(runs.createdAt))
    .limit(filters?.limit ?? 50);
}

export async function getRun(workspaceId: string, runId: string) {
  const results = await db
    .select()
    .from(runs)
    .where(and(eq(runs.workspaceId, workspaceId), eq(runs.id, runId)))
    .limit(1);
  return results[0] ?? null;
}

export async function listRepositories(workspaceId: string) {
  return db
    .select()
    .from(repositories)
    .where(eq(repositories.workspaceId, workspaceId))
    .orderBy(desc(repositories.updatedAt));
}

export async function listTeams(workspaceId: string) {
  return db
    .select()
    .from(teams)
    .where(eq(teams.workspaceId, workspaceId))
    .orderBy(desc(teams.createdAt));
}

export async function getTeamMemberCounts(teamIds: string[]) {
  if (teamIds.length === 0) return new Map<string, number>();
  const rows = await db
    .select({ teamId: teamMemberships.teamId })
    .from(teamMemberships);
  const counts = new Map<string, number>();
  for (const row of rows) {
    if (teamIds.includes(row.teamId)) {
      counts.set(row.teamId, (counts.get(row.teamId) ?? 0) + 1);
    }
  }
  return counts;
}

export async function listReviewGates(workspaceId: string, runId: string) {
  return db
    .select()
    .from(reviewGates)
    .where(
      and(eq(reviewGates.workspaceId, workspaceId), eq(reviewGates.runId, runId))
    )
    .orderBy(desc(reviewGates.createdAt));
}
