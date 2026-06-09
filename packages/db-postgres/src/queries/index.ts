import { eq, and, lt, gte, lte, desc, count, inArray } from "drizzle-orm";
import type { SQL } from "drizzle-orm";
import { db } from "../db.js";
import {
  workspaces,
  workspaceMemberships,
  runs,
  repositories,
  teams,
  teamMemberships,
  teamRepositories,
} from "../schema/index.js";

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

export async function getRun(
  workspaceId: string,
  runId: string
): Promise<RunRow | null> {
  const rows = await db
    .select()
    .from(runs)
    .where(and(eq(runs.workspaceId, workspaceId), eq(runs.id, runId)))
    .limit(1);
  return (rows[0] as RunRow) ?? null;
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

export interface ListRunsCursorFilters {
  status?: RunStatus;
  repositoryId?: string;
  timeFrom?: Date;
  timeTo?: Date;
  cursor?: string;
  limit?: number;
}

export interface RunRow {
  id: string;
  workspaceId: string;
  repositoryId: string;
  agent: string;
  branch: string;
  status: RunStatus;
  startedAt: Date | null;
  finishedAt: Date | null;
  createdAt: Date;
}

export interface ListRunsResult {
  runs: RunRow[];
  nextCursor: string | null;
}

export async function listRunsWithCursor(
  workspaceId: string,
  filters?: ListRunsCursorFilters
): Promise<ListRunsResult> {
  const limit = filters?.limit ?? 50;
  const conditions: SQL[] = [eq(runs.workspaceId, workspaceId)];

  if (filters?.status) {
    conditions.push(eq(runs.status, filters.status));
  }
  if (filters?.repositoryId) {
    conditions.push(eq(runs.repositoryId, filters.repositoryId));
  }
  if (filters?.timeFrom) {
    conditions.push(gte(runs.createdAt, filters.timeFrom));
  }
  if (filters?.timeTo) {
    conditions.push(lte(runs.createdAt, filters.timeTo));
  }
  if (filters?.cursor) {
    const cursorDate = new Date(
      Buffer.from(filters.cursor, "base64").toString("utf-8")
    );
    conditions.push(lt(runs.createdAt, cursorDate));
  }

  const rows = await db
    .select()
    .from(runs)
    .where(and(...conditions))
    .orderBy(desc(runs.createdAt))
    .limit(limit + 1);

  let nextCursor: string | null = null;
  if (rows.length > limit) {
    rows.pop();
    const last = rows[rows.length - 1];
    nextCursor = Buffer.from(last.createdAt.toISOString()).toString("base64");
  }

  return { runs: rows as RunRow[], nextCursor };
}

export async function listWorkspaceRepositories(workspaceId: string) {
  return db
    .select()
    .from(repositories)
    .where(eq(repositories.workspaceId, workspaceId))
    .orderBy(repositories.name);
}

export interface TeamRow {
  id: string;
  name: string;
  createdAt: Date;
  memberCount: number;
  repositories: string[];
}

export async function listWorkspaceTeams(workspaceId: string): Promise<TeamRow[]> {
  const rows = await db
    .select({
      id: teams.id,
      name: teams.name,
      createdAt: teams.createdAt,
      memberCount: count(teamMemberships.userId),
    })
    .from(teams)
    .leftJoin(teamMemberships, eq(teamMemberships.teamId, teams.id))
    .where(eq(teams.workspaceId, workspaceId))
    .groupBy(teams.id, teams.name, teams.createdAt)
    .orderBy(teams.name);

  if (rows.length === 0) return [];

  const teamIds = rows.map((r) => r.id);

  const repoLinks = await db
    .select({
      teamId: teamRepositories.teamId,
      repoName: repositories.name,
    })
    .from(teamRepositories)
    .innerJoin(repositories, eq(repositories.id, teamRepositories.repositoryId))
    .where(inArray(teamRepositories.teamId, teamIds));

  const reposByTeam = new Map<string, string[]>();
  for (const link of repoLinks) {
    const existing = reposByTeam.get(link.teamId) ?? [];
    existing.push(link.repoName);
    reposByTeam.set(link.teamId, existing);
  }

  return rows.map((r) => ({
    id: r.id,
    name: r.name,
    createdAt: r.createdAt,
    memberCount: Number(r.memberCount),
    repositories: reposByTeam.get(r.id) ?? [],
  }));
}
