import { eq, and, lt, gte, lte, desc, isNull, count, inArray, gt } from "drizzle-orm";
import type { SQL } from "drizzle-orm";
import { randomBytes } from "crypto";
import { db } from "../db.js";
import {
  workspaces,
  workspaceMemberships,
  runs,
  repositories,
  teams,
  teamMemberships,
  teamRepositories,
  apiKeys,
  reviewGates,
  memoryItems,
  workspaceInvites,
  users,
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

export async function getReviewGatesForRun(workspaceId: string, runId: string) {
  return db
    .select()
    .from(reviewGates)
    .where(
      and(
        eq(reviewGates.workspaceId, workspaceId),
        eq(reviewGates.runId, runId)
      )
    )
    .orderBy(reviewGates.createdAt);
}

export async function getRunEvidenceFields(workspaceId: string, runId: string) {
  const rows = await db
    .select({
      contextPackFile: runs.contextPackFile,
      selectedSources: runs.selectedSources,
      retrievalBudget: runs.retrievalBudget,
      citations: runs.citations,
    })
    .from(runs)
    .where(and(eq(runs.workspaceId, workspaceId), eq(runs.id, runId)))
    .limit(1);
  return rows[0] ?? null;
}

export async function createReviewGate(data: {
  workspaceId: string;
  runId: string;
  gateName: string;
  status: "passed" | "failed" | "pending";
  conditions?: Record<string, unknown>[];
  blockingReasons?: string[];
  evidenceRefs?: Array<{ label: string; url: string }>;
  evaluatedAt?: Date;
}) {
  const rows = await db
    .insert(reviewGates)
    .values({
      workspaceId: data.workspaceId,
      runId: data.runId,
      gateName: data.gateName,
      status: data.status,
      conditions: data.conditions ?? [],
      blockingReasons: data.blockingReasons ?? [],
      evidenceRefs: data.evidenceRefs ?? [],
      evaluatedAt: data.evaluatedAt ?? new Date(),
    })
    .returning();
  return rows[0]!;
}

export async function listReviewGatesForWorkspace(
  workspaceId: string,
  runId?: string
) {
  const conditions: SQL[] = [eq(reviewGates.workspaceId, workspaceId)];
  if (runId) {
    conditions.push(eq(reviewGates.runId, runId));
  }
  return db
    .select()
    .from(reviewGates)
    .where(and(...conditions))
    .orderBy(desc(reviewGates.createdAt));
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
  title: string | null;
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

export interface MemoryItemRow {
  id: string;
  workspaceId: string;
  source: string;
  content: string;
  tags: string[];
  createdAt: Date;
  lastUsedAt: Date | null;
}

export async function listMemoryItems(workspaceId: string): Promise<MemoryItemRow[]> {
  const rows = await db
    .select()
    .from(memoryItems)
    .where(eq(memoryItems.workspaceId, workspaceId))
    .orderBy(desc(memoryItems.createdAt));
  return rows as MemoryItemRow[];
}

export async function listWorkspaceRepositories(workspaceId: string) {
  return db
    .select()
    .from(repositories)
    .where(eq(repositories.workspaceId, workspaceId))
    .orderBy(repositories.name);
}

export async function getRepositoryByName(workspaceId: string, name: string) {
  const rows = await db
    .select()
    .from(repositories)
    .where(
      and(
        eq(repositories.workspaceId, workspaceId),
        eq(repositories.name, name)
      )
    )
    .limit(1);
  return rows[0] ?? null;
}

export async function createRepository(data: {
  workspaceId: string;
  name: string;
  url: string;
  defaultBranch: string;
}) {
  const rows = await db
    .insert(repositories)
    .values({
      workspaceId: data.workspaceId,
      name: data.name,
      url: data.url,
      defaultBranch: data.defaultBranch,
    })
    .returning();
  return rows[0]!;
}

export async function listApiKeys(workspaceId: string) {
  return db
    .select()
    .from(apiKeys)
    .where(eq(apiKeys.workspaceId, workspaceId))
    .orderBy(desc(apiKeys.createdAt));
}

export async function createApiKey(data: {
  workspaceId: string;
  teamId?: string | null;
  name: string;
  keyPrefix: string;
  keyHash: string;
}) {
  const rows = await db
    .insert(apiKeys)
    .values({
      workspaceId: data.workspaceId,
      teamId: data.teamId ?? null,
      name: data.name,
      keyPrefix: data.keyPrefix,
      keyHash: data.keyHash,
    })
    .returning();
  return rows[0]!;
}

export async function revokeApiKey(workspaceId: string, keyId: string) {
  const rows = await db
    .update(apiKeys)
    .set({ revokedAt: new Date() })
    .where(
      and(
        eq(apiKeys.id, keyId),
        eq(apiKeys.workspaceId, workspaceId),
        isNull(apiKeys.revokedAt)
      )
    )
    .returning();
  return rows[0] ?? null;
}

export async function getApiKey(workspaceId: string, keyId: string) {
  const rows = await db
    .select()
    .from(apiKeys)
    .where(and(eq(apiKeys.id, keyId), eq(apiKeys.workspaceId, workspaceId)))
    .limit(1);
  return rows[0] ?? null;
}

export async function lookupApiKeyByHash(keyHash: string) {
  const rows = await db
    .select()
    .from(apiKeys)
    .where(and(eq(apiKeys.keyHash, keyHash), isNull(apiKeys.revokedAt)))
    .limit(1);
  return rows[0] ?? null;
}

export async function touchApiKeyLastUsed(keyId: string) {
  await db
    .update(apiKeys)
    .set({ lastUsedAt: new Date() })
    .where(eq(apiKeys.id, keyId));
}

export async function getRepository(workspaceId: string, repositoryId: string) {
  const rows = await db
    .select()
    .from(repositories)
    .where(and(eq(repositories.id, repositoryId), eq(repositories.workspaceId, workspaceId)))
    .limit(1);
  return rows[0] ?? null;
}

export interface TeamRow {
  id: string;
  name: string;
  createdAt: Date;
  memberCount: number;
  repositories: string[];
}

export async function createWorkspace(data: {
  name: string;
  slug: string;
  userId: string;
}) {
  return db.transaction(async (tx) => {
    const rows = await tx
      .insert(workspaces)
      .values({ name: data.name, slug: data.slug })
      .returning();
    const workspace = rows[0]!;
    await tx.insert(workspaceMemberships).values({
      workspaceId: workspace.id,
      userId: data.userId,
      role: "owner",
    });
    return workspace;
  });
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

// ---- Workspace Invites ----

function generateToken(): string {
  return randomBytes(32).toString("base64url");
}

function expiresAt14Days(): Date {
  const d = new Date();
  d.setDate(d.getDate() + 14);
  return d;
}

export async function createInvite(data: {
  workspaceId: string;
  email: string;
  role?: "member" | "admin" | "viewer";
  invitedByUserId: string;
}) {
  const email = data.email.toLowerCase();
  const token = generateToken();
  const expiresAt = expiresAt14Days();
  const role = data.role ?? "member";

  const rows = await db
    .insert(workspaceInvites)
    .values({
      workspaceId: data.workspaceId,
      email,
      role,
      token,
      invitedByUserId: data.invitedByUserId,
      status: "pending",
      expiresAt,
    })
    .onConflictDoUpdate({
      target: [workspaceInvites.workspaceId, workspaceInvites.email],
      set: {
        token,
        role,
        status: "pending",
        expiresAt,
      },
    })
    .returning();
  return rows[0]!;
}

export async function listInvites(workspaceId: string) {
  return db
    .select()
    .from(workspaceInvites)
    .where(
      and(
        eq(workspaceInvites.workspaceId, workspaceId),
        eq(workspaceInvites.status, "pending"),
        gt(workspaceInvites.expiresAt, new Date())
      )
    )
    .orderBy(desc(workspaceInvites.createdAt));
}

export async function revokeInvite(workspaceId: string, inviteId: string) {
  const rows = await db
    .update(workspaceInvites)
    .set({ status: "revoked" })
    .where(
      and(
        eq(workspaceInvites.id, inviteId),
        eq(workspaceInvites.workspaceId, workspaceId)
      )
    )
    .returning();
  return rows[0] ?? null;
}

export async function getInviteByToken(token: string) {
  const rows = await db
    .select()
    .from(workspaceInvites)
    .where(eq(workspaceInvites.token, token))
    .limit(1);
  return rows[0] ?? null;
}

export interface UpsertRunInput {
  id: string;
  workspaceId: string;
  repositoryId: string;
  agent: string;
  branch: string;
  title?: string | null;
  status: "queued" | "running" | "success" | "failed";
  startedAt?: string | null;
  finishedAt?: string | null;
}

export async function upsertRun(input: UpsertRunInput): Promise<void> {
  await db
    .insert(runs)
    .values({
      id: input.id,
      workspaceId: input.workspaceId,
      repositoryId: input.repositoryId,
      agent: input.agent,
      branch: input.branch,
      title: input.title ?? null,
      status: input.status,
      startedAt: input.startedAt ? new Date(input.startedAt) : null,
      finishedAt: input.finishedAt ? new Date(input.finishedAt) : null,
    })
    .onConflictDoUpdate({
      target: runs.id,
      set: {
        status: input.status,
        title: input.title ?? null,
        finishedAt: input.finishedAt ? new Date(input.finishedAt) : null,
      },
    });
}

export async function claimInvitesForUser(data: {
  userId: string;
  email: string;
}): Promise<string[]> {
  const email = data.email.toLowerCase();
  const now = new Date();

  const pending = await db
    .select()
    .from(workspaceInvites)
    .where(
      and(
        eq(workspaceInvites.email, email),
        eq(workspaceInvites.status, "pending"),
        gt(workspaceInvites.expiresAt, now)
      )
    );

  if (pending.length === 0) return [];

  const claimedWorkspaceIds: string[] = [];

  for (const invite of pending) {
    await db
      .insert(workspaceMemberships)
      .values({
        userId: data.userId,
        workspaceId: invite.workspaceId,
        role: invite.role,
      })
      .onConflictDoNothing();

    await db
      .update(workspaceInvites)
      .set({ status: "accepted" })
      .where(eq(workspaceInvites.id, invite.id));

    claimedWorkspaceIds.push(invite.workspaceId);
  }

  return claimedWorkspaceIds;
}

export async function listWorkspaceMembers(workspaceId: string) {
  const rows = await db
    .select({
      userId: workspaceMemberships.userId,
      role: workspaceMemberships.role,
      joinedAt: workspaceMemberships.createdAt,
      name: users.name,
      email: users.email,
    })
    .from(workspaceMemberships)
    .innerJoin(users, eq(users.id, workspaceMemberships.userId))
    .where(eq(workspaceMemberships.workspaceId, workspaceId))
    .orderBy(workspaceMemberships.createdAt);
  return rows;
}
