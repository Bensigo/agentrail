import { eq, and, lt, gte, lte, desc, isNull, count, inArray, gt, sql, or } from "drizzle-orm";
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
  failureResolutions,
  workspaceInvites,
  users,
  accounts,
} from "../schema/index.js";
import type {
  ReviewGate,
  ReviewGateFindingCategory,
} from "../schema/index.js";
import { reviewGateFindingCategories } from "../schema/index.js";

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

export async function getReviewGate(
  workspaceId: string,
  gateId: string
): Promise<ReviewGate | null> {
  const rows = await db
    .select()
    .from(reviewGates)
    .where(and(eq(reviewGates.workspaceId, workspaceId), eq(reviewGates.id, gateId)))
    .limit(1);
  return (rows[0] as ReviewGate) ?? null;
}

export interface CategoryStatus {
  category: ReviewGateFindingCategory;
  present: boolean;
  finding_count: number;
}

function isReviewGateFindingCategory(value: unknown): value is ReviewGateFindingCategory {
  return (
    typeof value === "string" &&
    (reviewGateFindingCategories as readonly string[]).includes(value)
  );
}

export async function getReviewGateExplainer(
  workspaceId: string,
  gateId: string
): Promise<{ gate: ReviewGate; explainer: CategoryStatus[] } | null> {
  const gate = await getReviewGate(workspaceId, gateId);
  if (!gate) return null;

  const counts = new Map<ReviewGateFindingCategory, number>(
    reviewGateFindingCategories.map((category) => [category, 0])
  );

  const findings = Array.isArray(gate.findings) ? gate.findings : [];
  for (const finding of findings) {
    if (!finding || typeof finding !== "object") continue;
    const category = (finding as Record<string, unknown>).category;
    if (isReviewGateFindingCategory(category)) {
      counts.set(category, (counts.get(category) ?? 0) + 1);
    }
  }

  return {
    gate,
    explainer: reviewGateFindingCategories.map((category) => {
      const findingCount = counts.get(category) ?? 0;
      return {
        category,
        present: findingCount > 0,
        finding_count: findingCount,
      };
    }),
  };
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

/**
 * Discord notify connector (M038, AC3): the channel webhook a workspace's run
 * completion / escalation notifications post to. Null = not connected.
 */
export async function getDiscordWebhookUrl(
  workspaceId: string
): Promise<string | null> {
  const rows = await db
    .select({ discordWebhookUrl: workspaces.discordWebhookUrl })
    .from(workspaces)
    .where(eq(workspaces.id, workspaceId))
    .limit(1);
  return rows[0]?.discordWebhookUrl ?? null;
}

/** Connect (set) or disconnect (pass null) the Discord webhook for a workspace. */
export async function setDiscordWebhookUrl(
  workspaceId: string,
  webhookUrl: string | null
): Promise<void> {
  await db
    .update(workspaces)
    .set({ discordWebhookUrl: webhookUrl, updatedAt: new Date() })
    .where(eq(workspaces.id, workspaceId));
}

/**
 * GitHub OAuth connector (MVP): the workspace owner's stored GitHub OAuth
 * `access_token`, used to poll labeled issues, post results, and create issues
 * over the GitHub REST API (no PAT, no `gh` CLI). The token is the one NextAuth
 * persisted in the `accounts` table at login; it carries the `repo` scope only
 * after the owner re-logs in once to grant it. Returns null when the workspace
 * has no owner, the owner never linked GitHub, or no token is stored.
 */
export async function getGithubToken(
  workspaceId: string
): Promise<string | null> {
  const rows = await db
    .select({ accessToken: accounts.access_token })
    .from(workspaceMemberships)
    .innerJoin(
      accounts,
      and(
        eq(accounts.userId, workspaceMemberships.userId),
        eq(accounts.provider, "github")
      )
    )
    .where(
      and(
        eq(workspaceMemberships.workspaceId, workspaceId),
        eq(workspaceMemberships.role, "owner")
      )
    )
    .limit(1);
  return rows[0]?.accessToken ?? null;
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
  prUrl: string | null;
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
  repositoryId: string | null;
  repositoryName: string | null;
  source: string;
  content: string;
  tags: string[];
  createdAt: Date;
  lastUsedAt: Date | null;
}

export async function listMemoryItems(workspaceId: string): Promise<MemoryItemRow[]> {
  const rows = await db
    .select({
      id: memoryItems.id,
      workspaceId: memoryItems.workspaceId,
      repositoryId: memoryItems.repositoryId,
      repositoryName: repositories.name,
      source: memoryItems.source,
      content: memoryItems.content,
      tags: memoryItems.tags,
      createdAt: memoryItems.createdAt,
      lastUsedAt: memoryItems.lastUsedAt,
    })
    .from(memoryItems)
    .leftJoin(repositories, eq(memoryItems.repositoryId, repositories.id))
    .where(eq(memoryItems.workspaceId, workspaceId))
    .orderBy(desc(memoryItems.createdAt));
  return rows as MemoryItemRow[];
}

export async function insertMemoryItems(data: {
  workspaceId: string;
  repositoryId?: string | null;
  source: string;
  items: Array<{ content: string; tags: string[] }>;
}): Promise<void> {
  if (data.items.length === 0) return;
  await db.insert(memoryItems).values(
    data.items.map((item) => ({
      workspaceId: data.workspaceId,
      repositoryId: data.repositoryId ?? null,
      source: data.source,
      content: item.content,
      tags: item.tags,
    }))
  );
}

// ---- Failure resolutions (is-this-fixed state) ----

export type FailureResolutionStatus = "open" | "fixed";

export interface FailureResolutionRow {
  failureKey: string;
  status: FailureResolutionStatus;
  note: string | null;
  resolvedByUserId: string | null;
  updatedAt: Date;
}

/**
 * Return the resolution row for a failure key, or null when the user has never
 * touched it (the implicit default is "open"). `failureKey` is the failure's
 * fingerprint, falling back to its event_id — see failure_resolutions schema.
 */
export async function getFailureResolution(
  workspaceId: string,
  failureKey: string
): Promise<FailureResolutionRow | null> {
  const rows = await db
    .select({
      failureKey: failureResolutions.failureKey,
      status: failureResolutions.status,
      note: failureResolutions.note,
      resolvedByUserId: failureResolutions.resolvedByUserId,
      updatedAt: failureResolutions.updatedAt,
    })
    .from(failureResolutions)
    .where(
      and(
        eq(failureResolutions.workspaceId, workspaceId),
        eq(failureResolutions.failureKey, failureKey)
      )
    )
    .limit(1);
  const row = rows[0];
  if (!row) return null;
  return { ...row, status: row.status as FailureResolutionStatus };
}

/** Set (upsert) the fixed/open state for a failure key. */
export async function upsertFailureResolution(data: {
  workspaceId: string;
  failureKey: string;
  status: FailureResolutionStatus;
  note?: string | null;
  resolvedByUserId?: string | null;
}): Promise<FailureResolutionRow> {
  const now = new Date();
  const rows = await db
    .insert(failureResolutions)
    .values({
      workspaceId: data.workspaceId,
      failureKey: data.failureKey,
      status: data.status,
      note: data.note ?? null,
      resolvedByUserId: data.resolvedByUserId ?? null,
      updatedAt: now,
    })
    .onConflictDoUpdate({
      target: [failureResolutions.workspaceId, failureResolutions.failureKey],
      set: {
        status: data.status,
        note: data.note ?? null,
        resolvedByUserId: data.resolvedByUserId ?? null,
        updatedAt: now,
      },
    })
    .returning({
      failureKey: failureResolutions.failureKey,
      status: failureResolutions.status,
      note: failureResolutions.note,
      resolvedByUserId: failureResolutions.resolvedByUserId,
      updatedAt: failureResolutions.updatedAt,
    });
  const row = rows[0]!;
  return { ...row, status: row.status as FailureResolutionStatus };
}

export async function listMemoryItemsByRunId(
  workspaceId: string,
  runId: string
): Promise<MemoryItemRow[]> {
  const tag = `run:${runId}`;
  const rows = await db
    .select()
    .from(memoryItems)
    .where(
      and(
        eq(memoryItems.workspaceId, workspaceId),
        sql`${memoryItems.tags} @> ARRAY[${tag}]::text[]`
      )
    )
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
        // Backfill startedAt when the caller supplies it: the finish upsert
        // carries the start time so a run whose start registration was lost
        // (server briefly down) still gets a duration.
        ...(input.startedAt ? { startedAt: new Date(input.startedAt) } : {}),
        finishedAt: input.finishedAt ? new Date(input.finishedAt) : null,
      },
    });
}

export interface UpsertReviewGateInput {
  id?: string;
  workspaceId: string;
  runId: string;
  gateName: string;
  status: "passed" | "failed" | "pending";
  conditions?: Record<string, unknown>[];
  blockingReasons?: Record<string, unknown>[];
  evidenceRefs?: Array<{ label: string; url: string }>;
  findings?: Array<{
    severity: "critical" | "major" | "minor";
    category: ReviewGateFindingCategory;
    description: string;
    suggested_fix: string;
  }>;
  evaluatedAt?: string | Date | null;
}

export async function upsertReviewGate(input: UpsertReviewGateInput): Promise<void> {
  const evaluatedAt = input.evaluatedAt
    ? input.evaluatedAt instanceof Date
      ? input.evaluatedAt
      : new Date(input.evaluatedAt)
    : new Date();

  await db
    .insert(reviewGates)
    .values({
      ...(input.id ? { id: input.id } : {}),
      workspaceId: input.workspaceId,
      runId: input.runId,
      gateName: input.gateName,
      status: input.status,
      conditions: input.conditions ?? [],
      blockingReasons: (input.blockingReasons ?? []) as unknown as string[],
      evidenceRefs: input.evidenceRefs ?? [],
      findings: input.findings ?? [],
      evaluatedAt,
    })
    .onConflictDoUpdate({
      target: reviewGates.id,
      set: {
        status: input.status,
        conditions: input.conditions ?? [],
        blockingReasons: (input.blockingReasons ?? []) as unknown as string[],
        findings: input.findings ?? [],
        evaluatedAt,
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

export interface StaleMemoryItemRow {
  id: string;
  source: string;
  lastUsedAt: Date | null;
}

/**
 * Returns memory items for a workspace whose `last_used_at` is null or older
 * than `before`. Used by the Context Rot Scorer to measure memory staleness.
 */
export async function getStaleMemoryItems(
  workspaceId: string,
  before: Date,
  repositoryId?: string
): Promise<StaleMemoryItemRow[]> {
  const conditions = [
    eq(memoryItems.workspaceId, workspaceId),
    or(isNull(memoryItems.lastUsedAt), lt(memoryItems.lastUsedAt, before)),
  ];
  if (repositoryId) {
    conditions.push(eq(memoryItems.repositoryId, repositoryId));
  }
  const rows = await db
    .select({
      id: memoryItems.id,
      source: memoryItems.source,
      lastUsedAt: memoryItems.lastUsedAt,
    })
    .from(memoryItems)
    .where(and(...conditions));
  return rows;
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

export interface AgentRunStatsRow {
  agent: string;
  runCount: number;
  finishedCount: number;
  successCount: number;
  successRate: number;
  avgDurationS: number | null;
  avgReviewRounds: number;
}

/**
 * Per-agent aggregate stats derived from runs and review_gates.
 * Skips runs with empty agent strings.
 */
export async function getAgentRunStats(
  workspaceId: string
): Promise<AgentRunStatsRow[]> {
  const result = await db.execute(sql`
    WITH gate_counts AS (
      SELECT run_id, COUNT(*) AS gate_count
      FROM review_gates
      WHERE workspace_id = ${workspaceId}
      GROUP BY run_id
    )
    SELECT
      LOWER(r.agent)                                                     AS agent,
      COUNT(*)                                                           AS run_count,
      COUNT(*) FILTER (WHERE r.status IN ('success', 'failed'))          AS finished_count,
      COUNT(*) FILTER (WHERE r.status = 'success')                      AS success_count,
      AVG(EXTRACT(EPOCH FROM (r.finished_at - r.started_at)))
        FILTER (WHERE r.started_at IS NOT NULL AND r.finished_at IS NOT NULL) AS avg_duration_s,
      AVG(COALESCE(gc.gate_count, 0))                                   AS avg_review_rounds
    FROM runs r
    LEFT JOIN gate_counts gc ON gc.run_id = r.id
    WHERE r.workspace_id = ${workspaceId}
      AND r.agent != ''
    GROUP BY LOWER(r.agent)
    ORDER BY run_count DESC
  `);

  return (Array.from(result) as Record<string, unknown>[]).map((r) => {
    const runCount = Number(r.run_count ?? 0);
    const finishedCount = Number(r.finished_count ?? 0);
    const successCount = Number(r.success_count ?? 0);
    const successRate = finishedCount > 0 ? successCount / finishedCount : 0;
    const avgDurationRaw = r.avg_duration_s !== null && r.avg_duration_s !== undefined
      ? Number(r.avg_duration_s)
      : null;
    return {
      agent: String(r.agent ?? ""),
      runCount,
      finishedCount,
      successCount,
      successRate,
      avgDurationS: avgDurationRaw !== null && !isNaN(avgDurationRaw) ? avgDurationRaw : null,
      avgReviewRounds: Number(r.avg_review_rounds ?? 0),
    };
  });
}

export interface WorkspaceOverviewCounts {
  runs: number;
  reviewGates: number;
  repositories: number;
  apiKeys: number;
  teams: number;
  members: number;
  memoryItems: number;
}

/** Row counts for the workspace Overview cards, fetched in one round of queries. */
export async function getWorkspaceOverviewCounts(
  workspaceId: string
): Promise<WorkspaceOverviewCounts> {
  const countWhere = async (table: any, condition: SQL | undefined) => {
    const rows = await db.select({ n: count() }).from(table).where(condition);
    return Number(rows[0]?.n ?? 0);
  };
  const [
    runCount,
    gateCount,
    repoCount,
    keyCount,
    teamCount,
    memberCount,
    memoryCount,
  ] = await Promise.all([
    countWhere(runs, eq(runs.workspaceId, workspaceId)),
    countWhere(reviewGates, eq(reviewGates.workspaceId, workspaceId)),
    countWhere(repositories, eq(repositories.workspaceId, workspaceId)),
    countWhere(
      apiKeys,
      and(eq(apiKeys.workspaceId, workspaceId), isNull(apiKeys.revokedAt))
    ),
    countWhere(teams, eq(teams.workspaceId, workspaceId)),
    countWhere(
      workspaceMemberships,
      eq(workspaceMemberships.workspaceId, workspaceId)
    ),
    countWhere(memoryItems, eq(memoryItems.workspaceId, workspaceId)),
  ]);
  return {
    runs: runCount,
    reviewGates: gateCount,
    repositories: repoCount,
    apiKeys: keyCount,
    teams: teamCount,
    members: memberCount,
    memoryItems: memoryCount,
  };
}

export interface RunnerRunStatsRow {
  runner_name: string;
  run_ids: string[];
  total_count: number;
  success_count: number;
  human_review_count: number | null;
  review_fix_count: number | null;
}

export interface GetRunnerRunStatsFilters {
  repositoryId?: string;
  from?: Date;
  to?: Date;
  taskType?: string;
}

/**
 * Per-runner aggregate stats from runs and review_gates.
 * Uses runs.runner_name as the runner identity source and falls back to
 * runs.agent for legacy rows that predate the migration.
 * review_fix_count = runs that have at least one review gate with status='passed'.
 */
export async function getRunnerRunStats(
  workspaceId: string,
  filters?: GetRunnerRunStatsFilters
): Promise<RunnerRunStatsRow[]> {
  const runnerIdentitySql = sql`LOWER(COALESCE(NULLIF(r.runner_name, ''), NULLIF(r.agent, '')))`;
  const conditions: SQL[] = [
    sql`r.workspace_id = ${workspaceId}`,
    sql`COALESCE(NULLIF(r.runner_name, ''), NULLIF(r.agent, '')) IS NOT NULL`,
  ];
  if (filters?.repositoryId) {
    conditions.push(sql`r.repository_id = ${filters.repositoryId}`);
  }
  if (filters?.from) {
    conditions.push(sql`r.created_at >= ${filters.from}`);
  }
  if (filters?.to) {
    conditions.push(sql`r.created_at <= ${filters.to}`);
  }
  if (filters?.taskType) {
    // runs.task_type does not exist yet. Fail closed instead of returning
    // misleading unfiltered scorecard rows for a requested task filter.
    conditions.push(sql`FALSE`);
  }

  const whereClause = sql.join(conditions, sql` AND `);

  const result = await db.execute(sql`
    WITH review_fix_runs AS (
      SELECT DISTINCT rg.run_id
      FROM review_gates rg
      WHERE rg.workspace_id = ${workspaceId}
        AND rg.status = 'passed'
    )
    SELECT
      ${runnerIdentitySql}                                          AS runner_name,
      ARRAY_AGG(r.id)                                                AS run_ids,
      COUNT(*)                                                       AS total_count,
      COUNT(*) FILTER (WHERE r.status = 'success')                  AS success_count,
      NULL::integer                                                  AS human_review_count,
      COUNT(*) FILTER (WHERE rfr.run_id IS NOT NULL)                AS review_fix_count
    FROM runs r
    LEFT JOIN review_fix_runs rfr ON rfr.run_id = r.id
    WHERE ${whereClause}
    GROUP BY ${runnerIdentitySql}
    ORDER BY total_count DESC
  `);

  return (Array.from(result) as Record<string, unknown>[]).map((r) => ({
    runner_name: String(r.runner_name ?? ""),
    run_ids: Array.isArray(r.run_ids) ? (r.run_ids as string[]) : [],
    total_count: Number(r.total_count ?? 0),
    success_count: Number(r.success_count ?? 0),
    human_review_count:
      r.human_review_count === null || r.human_review_count === undefined
        ? null
        : Number(r.human_review_count),
    review_fix_count:
      r.review_fix_count === null || r.review_fix_count === undefined
        ? null
        : Number(r.review_fix_count),
  }));
}

// Self-hosted runner protocol — device-flow auth, work-claim, and result.
// The Python CLI half (`agentrail/runner/*`) calls the console routes that wrap
// these; api_keys double as the runner token so `requireBearer` authenticates
// the claim/result endpoints for free.
export {
  mintApiKey,
  startDeviceCode,
  exchangeDeviceCode,
  approveDeviceCode,
  claimQueueEntry,
  listQueueEntries,
  recordRunnerResult,
  reconcileStaleRuns,
  STALE_RUN_MINUTES,
  DEVICE_CODE_TTL_MS,
  type StartedDeviceCode,
  type DeviceTokenResult,
  type ApproveDeviceCodeResult,
  type WorkItem,
  type QueueEntryListItem,
  type RunnerStatus,
} from "./runner.js";

// GitHub issue intake — the webhook half of the queue: the AC gate + workspace
// resolution + idempotent enqueue (deterministic id matches the Python store).
export {
  validateAcceptanceCriteria,
  findWorkspaceByRepo,
  enqueueGithubIssue,
  type AcGateResult,
  type EnqueueResult,
} from "./github_intake.js";

// Connectors — per-provider control surface that also configures the Heartbeat.
// Folds in the former standalone heartbeat_config (#816); the daemon reads
// connectors via list_active_connectors (agentrail/afk/connectors_store.py).
export {
  getConnectors,
  getConnector,
  upsertConnector,
  setConnectorSecret,
  getConnectorSecret,
  getMcpConnectorKeys,
  validateConnectorUpdate,
  isConnectorProvider,
  MIN_POLL_INTERVAL_SECONDS,
  MAX_POLL_INTERVAL_SECONDS,
  type ConnectorUpdate,
} from "./connectors.js";
