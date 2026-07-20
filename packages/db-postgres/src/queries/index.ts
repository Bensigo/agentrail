import { eq, and, lt, gte, lte, desc, isNull, count, max, inArray, gt, sql, or } from "drizzle-orm";
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
  evalArmMetrics,
  chatIdentities,
} from "../schema/index.js";
import type { EvalArmMetric } from "../schema/index.js";
import type {
  ReviewGate,
  ReviewGateFindingCategory,
  MemoryItem,
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

/**
 * Look up a run by its own primary key, with NO workspace scope — the read
 * behind `GET /api/v1/runner/failure-bundle` under the central-secret auth
 * model (JACE_CONSOLE_TOKEN, no per-workspace bearer to scope by). `id` is
 * `runs.id`, `uuid("id").primaryKey().defaultRandom()`
 * (`schema/runs.ts`) — server-minted, never caller-guessable — so no further
 * scoping is needed here (mirrors `getApprovalById`'s and
 * `getJaceSessionById`'s own no-workspace-scope rationale:
 * `queries/jace_sessions.ts`, "the id IS the security boundary").
 *
 * The caller MUST read `.workspaceId` off the returned row and use THAT
 * value — never a caller-supplied one — to scope every subsequent
 * workspace-filtered read (review gates, ClickHouse failure events / run
 * events): this is what lets `failure-bundle`'s route resolve its own tenant
 * from `run_id` alone without trusting anything the request itself claims
 * about which workspace it belongs to.
 */
export async function getRunById(runId: string): Promise<RunRow | null> {
  const rows = await db.select().from(runs).where(eq(runs.id, runId)).limit(1);
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

/** Typed classification of a memory entry (#1032). */
export type MemoryType = "decision" | "preference" | "fact";

export interface MemoryItemRow {
  id: string;
  workspaceId: string;
  repositoryId: string | null;
  repositoryName: string | null;
  source: string;
  content: string;
  /** Enum-constrained entry type (#1032); pre-v2 rows backfill to "fact". */
  type: MemoryType;
  /** Writer attribution (#1032); pre-v2 rows backfill from `source`. */
  writtenBy: string;
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
      type: memoryItems.type,
      writtenBy: memoryItems.writtenBy,
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

// ---- retrieveMemory: BM25 + heuristic-rerank workspace-memory retriever ----
//
// `listMemoryItems` above returns EVERY row for a workspace — no limit, no
// relevance ranking (issue #1215). That's fine for the admin "list all notes"
// view but unusable as a context source for an agent: it dumps the whole
// table into the prompt. `retrieveMemory` is the replacement retrieval path —
// a small, ranked, budget-capped slice, reusable by any future caller (the
// Jace context-pack consumer wires it up in a follow-up PR; this function
// stays runtime-agnostic and does no sanitization of its own).
//
// Pipeline:
//   1. FTS prefilter  → ≤30 candidates via websearch_to_tsquery + GIN index,
//      falling back to the 30 most-recent notes when nothing matches lexically.
//   2. Real BM25 (k1=1.2, b=0.75) over those ≤30 candidates.
//   3. Heuristic blend (bm25 + recency + type + repo match) → keep top k.
//   4. Pinned core: up to 3 most-recent decisions always ride along.
//   5. Trim each returned note's content to a fixed budget.

const MEMORY_CANDIDATE_LIMIT = 30;
const MEMORY_PINNED_DECISION_LIMIT = 3;
const MEMORY_DEFAULT_K = 8;
const MEMORY_CONTENT_MAX_CHARS = 1000;
const BM25_K1 = 1.2;
const BM25_B = 0.75;
const MEMORY_TYPE_RANK: Record<MemoryType, number> = {
  decision: 1.0,
  preference: 0.6,
  fact: 0.3,
};

export interface RetrieveMemoryOptions {
  /** Max ranked results to return (before the pinned-decision core is added). Default 8. */
  k?: number;
  /** When set, scopes candidate fetching to this repo and awards a repo-match bonus. */
  repositoryId?: string;
}

/** Map a raw (snake_case) `db.execute` row back to the typed `MemoryItem` shape. */
function mapMemoryExecRow(r: Record<string, unknown>): MemoryItem {
  return {
    id: String(r.id),
    workspaceId: String(r.workspace_id),
    repositoryId: (r.repository_id as string | null) ?? null,
    source: String(r.source),
    content: String(r.content),
    type: r.type as MemoryItem["type"],
    writtenBy: String(r.written_by),
    tags: (r.tags as string[] | null) ?? [],
    createdAt: r.created_at as Date,
    lastUsedAt: (r.last_used_at as Date | null) ?? null,
  };
}

/** Scope condition shared by the FTS and recency-fallback candidate queries. */
function memoryScopeConditions(workspaceId: string, repositoryId?: string): SQL[] {
  const conditions: SQL[] = [sql`workspace_id = ${workspaceId}`];
  if (repositoryId) {
    conditions.push(sql`repository_id = ${repositoryId}`);
  }
  return conditions;
}

/** Step 1a: FTS candidates ranked by ts_rank_cd, scoped by workspace (+ repo). */
async function fetchFtsCandidates(
  workspaceId: string,
  query: string,
  repositoryId?: string
): Promise<MemoryItem[]> {
  const whereClause = sql.join(memoryScopeConditions(workspaceId, repositoryId), sql` AND `);
  const result = await db.execute(sql`
    SELECT id, workspace_id, repository_id, source, content, type, written_by, tags, created_at, last_used_at
    FROM memory_items
    WHERE ${whereClause}
      AND to_tsvector('english', content) @@ websearch_to_tsquery('english', ${query})
    ORDER BY ts_rank_cd(to_tsvector('english', content), websearch_to_tsquery('english', ${query})) DESC
    LIMIT ${MEMORY_CANDIDATE_LIMIT}
  `);
  return (Array.from(result) as Record<string, unknown>[]).map(mapMemoryExecRow);
}

/** Step 1b: fallback when FTS finds nothing — the 30 most-recent notes. */
async function fetchRecentCandidates(
  workspaceId: string,
  repositoryId?: string
): Promise<MemoryItem[]> {
  const whereClause = sql.join(memoryScopeConditions(workspaceId, repositoryId), sql` AND `);
  const result = await db.execute(sql`
    SELECT id, workspace_id, repository_id, source, content, type, written_by, tags, created_at, last_used_at
    FROM memory_items
    WHERE ${whereClause}
    ORDER BY created_at DESC
    LIMIT ${MEMORY_CANDIDATE_LIMIT}
  `);
  return (Array.from(result) as Record<string, unknown>[]).map(mapMemoryExecRow);
}

/** Step 4: the pinned core — up to 3 most-recent `decision` notes for the workspace. */
async function fetchPinnedDecisions(workspaceId: string): Promise<MemoryItem[]> {
  const result = await db.execute(sql`
    SELECT id, workspace_id, repository_id, source, content, type, written_by, tags, created_at, last_used_at
    FROM memory_items
    WHERE workspace_id = ${workspaceId}
      AND type = 'decision'
    ORDER BY created_at DESC
    LIMIT ${MEMORY_PINNED_DECISION_LIMIT}
  `);
  return (Array.from(result) as Record<string, unknown>[]).map(mapMemoryExecRow);
}

/** Lowercase, alnum-run tokenizer shared by BM25 term-frequency and query parsing. */
function tokenizeForBm25(text: string): string[] {
  return text.toLowerCase().match(/[a-z0-9]+/g) ?? [];
}

/** Min-max normalize to [0,1]; a zero-spread set collapses to 1 (nonzero) or 0 (all-zero). */
function minMaxNormalize(values: number[]): number[] {
  if (values.length === 0) return [];
  const min = Math.min(...values);
  const max = Math.max(...values);
  if (max === min) {
    return values.map(() => (max === 0 ? 0 : 1));
  }
  return values.map((v) => (v - min) / (max - min));
}

/**
 * Step 2 + 3: score each candidate with Okapi BM25 (k1=1.2, b=0.75) blended with
 * recency / type / repo-match, then return candidates sorted best-first.
 *
 * IDF choice: document frequency is computed OVER THE CANDIDATE SET (≤30 rows),
 * not a second workspace-wide aggregate query. The candidate set is already the
 * FTS-narrowed population the ranker competes within, so a corpus-wide IDF query
 * would add a DB round trip to re-rank the same rows against a slightly
 * different (larger) population — a real fidelity trade, but one candidate-set
 * IDF makes reasonable given the candidate window mirrors relevance already.
 */
function rerankCandidates(
  candidates: MemoryItem[],
  queryTerms: string[],
  repositoryId?: string
): MemoryItem[] {
  if (candidates.length === 0) return [];

  const docs = candidates.map((c) => tokenizeForBm25(c.content));
  const docLengths = docs.map((d) => d.length);
  const avgDocLen = docLengths.reduce((a, b) => a + b, 0) / (docLengths.length || 1);
  const docCount = candidates.length;

  const documentFrequency = new Map<string, number>();
  for (const term of new Set(queryTerms)) {
    let df = 0;
    for (const doc of docs) {
      if (doc.includes(term)) df++;
    }
    documentFrequency.set(term, df);
  }

  const bm25Raw = candidates.map((_, i) => {
    const doc = docs[i]!;
    const docLen = docLengths[i] ?? 0;
    let score = 0;
    for (const term of queryTerms) {
      const df = documentFrequency.get(term) ?? 0;
      if (df === 0) continue;
      const tf = doc.filter((t) => t === term).length;
      if (tf === 0) continue;
      const idf = Math.log(1 + (docCount - df + 0.5) / (df + 0.5));
      const denom = tf + BM25_K1 * (1 - BM25_B + BM25_B * (docLen / (avgDocLen || 1)));
      score += idf * ((tf * (BM25_K1 + 1)) / (denom || 1));
    }
    return score;
  });
  const bm25Norm = minMaxNormalize(bm25Raw);

  const recencyRaw = candidates.map((c) => (c.lastUsedAt ?? c.createdAt).getTime());
  const recencyNorm = minMaxNormalize(recencyRaw);

  const scored = candidates.map((c, i) => {
    const typeRank = MEMORY_TYPE_RANK[c.type as MemoryType];
    const repoMatch = repositoryId && c.repositoryId === repositoryId ? 1 : 0;
    const score =
      0.5 * bm25Norm[i]! + 0.2 * recencyNorm[i]! + 0.2 * typeRank + 0.1 * repoMatch;
    return { item: c, score };
  });

  scored.sort((a, b) => b.score - a.score);
  return scored.map((s) => s.item);
}

/** Trim content to the context budget, marking truncation with an ellipsis. */
function trimMemoryContent(content: string): string {
  if (content.length <= MEMORY_CONTENT_MAX_CHARS) return content;
  return content.slice(0, MEMORY_CONTENT_MAX_CHARS - 1) + "…";
}

/**
 * Retrieve a ranked, budget-capped slice of workspace memory for a query —
 * FTS prefilter → BM25 → heuristic rerank → pinned decisions → content trim.
 * See the pipeline comment above `MEMORY_CANDIDATE_LIMIT` for the full algorithm.
 *
 * Tenant safety: every underlying query is scoped by `workspace_id`, and the
 * result is re-filtered by `workspaceId` in application code as a defense-in-
 * depth net — this function must never leak a row from another workspace.
 */
export async function retrieveMemory(
  workspaceId: string,
  query: string,
  opts?: RetrieveMemoryOptions
): Promise<MemoryItem[]> {
  const k = Math.max(0, opts?.k ?? MEMORY_DEFAULT_K);
  const repositoryId = opts?.repositoryId;
  const trimmedQuery = query.trim();

  // Step 1: FTS prefilter, falling back to recency when it has no matches. An
  // empty/whitespace query has no lexical content to rank on, so skip the FTS
  // round trip entirely and go straight to the recency fallback.
  let candidates =
    trimmedQuery.length > 0
      ? await fetchFtsCandidates(workspaceId, trimmedQuery, repositoryId)
      : [];
  if (candidates.length === 0) {
    candidates = await fetchRecentCandidates(workspaceId, repositoryId);
  }
  candidates = candidates.filter((c) => c.workspaceId === workspaceId);

  const pinned = (await fetchPinnedDecisions(workspaceId))
    .filter((c) => c.workspaceId === workspaceId)
    .slice(0, MEMORY_PINNED_DECISION_LIMIT);

  // Steps 2 + 3: BM25 + heuristic blend, ranked desc, capped at k.
  const queryTerms = Array.from(new Set(tokenizeForBm25(trimmedQuery)));
  const topK = rerankCandidates(candidates, queryTerms, repositoryId).slice(0, k);

  // Step 4: pinned core ∪ top-k, decisions first, deduped, capped at k+3.
  const pinnedIds = new Set(pinned.map((p) => p.id));
  const merged = [...pinned, ...topK.filter((item) => !pinnedIds.has(item.id))].slice(
    0,
    k + MEMORY_PINNED_DECISION_LIMIT
  );

  // Step 5: trim content to the context budget.
  return merged.map((item) => ({ ...item, content: trimMemoryContent(item.content) }));
}

/**
 * Newest onboarder-written memory timestamp for a repo (by owner/name), or null
 * if the repo has never been onboarded. Used by the runner to skip re-onboarding
 * when fresh notes already exist. Scoped to written_by = "onboarder".
 */
export async function getLatestOnboardMemoryAt(
  workspaceId: string,
  repoFullName: string,
): Promise<{ onboardedAt: Date | null; count: number }> {
  // Single aggregate over onboarder-written memory for the repo whose
  // (workspace_id, name) match. When the repo row is absent or has no such
  // memory the inner-join yields no rows and Postgres still returns one row
  // with max=NULL / count=0 — i.e. { onboardedAt: null, count: 0 }.
  const rows = await db
    .select({
      onboardedAt: max(memoryItems.createdAt),
      count: count(memoryItems.id),
    })
    .from(memoryItems)
    .innerJoin(repositories, eq(memoryItems.repositoryId, repositories.id))
    .where(
      and(
        eq(repositories.workspaceId, workspaceId),
        eq(repositories.name, repoFullName),
        eq(memoryItems.writtenBy, "onboarder"),
      ),
    );

  const row = rows[0];
  return {
    onboardedAt: row?.onboardedAt ?? null,
    count: Number(row?.count ?? 0),
  };
}

export async function insertMemoryItems(data: {
  workspaceId: string;
  repositoryId?: string | null;
  source: string;
  /**
   * Batch-level writer attribution (#1032). Defaults to `source` when omitted so
   * every insert path records who/what wrote the entry.
   */
  writtenBy?: string;
  items: Array<{
    content: string;
    tags: string[];
    /** Per-item entry type (#1032). Defaults to "fact" (lowest authority). */
    type?: MemoryType;
  }>;
}): Promise<void> {
  if (data.items.length === 0) return;
  const writtenBy = data.writtenBy ?? data.source;
  await db.insert(memoryItems).values(
    data.items.map((item) => ({
      workspaceId: data.workspaceId,
      repositoryId: data.repositoryId ?? null,
      source: data.source,
      content: item.content,
      type: item.type ?? "fact",
      writtenBy,
      tags: item.tags,
    }))
  );
}

/**
 * Idempotent re-seed: atomically remove all memory items previously written by
 * `writtenBy` for (workspaceId, repositoryId), then insert the new batch. Used
 * by the onboarder so a re-run REPLACES its own notes instead of appending
 * duplicates. Scope is strict — it only ever deletes rows matching that exact
 * (workspace, repo, writer) triple, so human/review memory is never touched.
 * Requires a repositoryId (workspace-wide replace is intentionally unsupported).
 */
export async function replaceMemoryItemsByWriter(data: {
  workspaceId: string;
  repositoryId: string;
  writtenBy: string;
  source: string;
  items: Array<{ content: string; tags: string[]; type?: MemoryType }>;
}): Promise<void> {
  // delete + insert in ONE transaction so a re-run never leaves the writer's
  // notes half-cleared (matches the `db.transaction` pattern used elsewhere).
  await db.transaction(async (tx) => {
    // Strict scope: only rows matching this exact (workspace, repo, writer)
    // triple are removed — human/review memory for the same repo is untouched.
    await tx
      .delete(memoryItems)
      .where(
        and(
          eq(memoryItems.workspaceId, data.workspaceId),
          eq(memoryItems.repositoryId, data.repositoryId),
          eq(memoryItems.writtenBy, data.writtenBy)
        )
      );
    // A re-run with zero items still clears stale notes (delete already ran);
    // only skip the insert itself.
    if (data.items.length === 0) return;
    await tx.insert(memoryItems).values(
      data.items.map((item) => ({
        workspaceId: data.workspaceId,
        repositoryId: data.repositoryId,
        source: data.source,
        content: item.content,
        type: item.type ?? "fact",
        writtenBy: data.writtenBy,
        tags: item.tags,
      }))
    );
  });
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

/**
 * True when the workspace has a non-revoked API key used within `windowMs`
 * (default 60 min). api_keys double as the self-hosted runner token, and
 * `last_used_at` is bumped on every claim/result poll — so a recent, live key
 * is a strong "a runner is here to claim work" signal. Used to gate onboard
 * enqueue so we never queue an onboard entry no runner will pick up.
 */
export async function hasActiveRunner(
  workspaceId: string,
  windowMs = 60 * 60 * 1000,
): Promise<boolean> {
  const since = new Date(Date.now() - windowMs);
  const rows = await db
    .select({ id: apiKeys.id })
    .from(apiKeys)
    .where(
      and(
        eq(apiKeys.workspaceId, workspaceId),
        isNull(apiKeys.revokedAt),
        gte(apiKeys.lastUsedAt, since),
      ),
    )
    .limit(1);
  return rows.length > 0;
}

/**
 * Same presence heuristic as {@link hasActiveRunner} above, narrowed to
 * `kind = 'self_hosted'` (#1267 PR ①): a non-revoked SELF-HOSTED key whose
 * `last_used_at` is within `windowMs`. This is the signal the runner claim
 * route's fleet-precedence guard uses — a `kind: 'fleet'` bearer backs off a
 * workspace with a live self-hosted runner, and must not be fooled by ITS OWN
 * `last_used_at` touches (which `hasActiveRunner` above, being kind-agnostic,
 * would count).
 *
 * `hasActiveRunner` itself is UNCHANGED and still kind-agnostic. Its three
 * former callers were swapped off it (#1268): the two onboard-enqueue gates
 * (`runner/repos/route.ts`, `workspaces/[workspaceId]/repos/route.ts`) now
 * call {@link workspaceHasExecutionPath} below, which composes THIS function
 * with `workspaces.hostedExecution` rather than narrowing to self-hosted
 * alone — see that function's own doc-comment for why. The third
 * (`onboarding-data.ts`, a 4-second wizard poll) needs the bare self-hosted
 * signal too, so it calls THIS function once plus `getWorkspace` and derives
 * the same disjunct locally rather than paying for the presence probe twice
 * per tick.
 */
export async function hasActiveSelfHostedRunner(
  workspaceId: string,
  windowMs = 60 * 60 * 1000,
): Promise<boolean> {
  const since = new Date(Date.now() - windowMs);
  const rows = await db
    .select({ id: apiKeys.id })
    .from(apiKeys)
    .where(
      and(
        eq(apiKeys.workspaceId, workspaceId),
        eq(apiKeys.kind, "self_hosted"),
        isNull(apiKeys.revokedAt),
        gte(apiKeys.lastUsedAt, since),
      ),
    )
    .limit(1);
  return rows.length > 0;
}

/**
 * The race-free onboard-enqueue gate (#1268): true when the workspace has ANY
 * path to execution — `workspaces.hostedExecution` (a static column,
 * defaulting `true` for every workspace, see its own doc-comment) OR a
 * currently-live self-hosted runner ({@link hasActiveSelfHostedRunner}).
 *
 * Composed from the two existing reads (one `getWorkspace` lookup, one
 * `hasActiveSelfHostedRunner` presence check), run concurrently, rather than
 * a single fused query with a correlated EXISTS: this predicate only runs at
 * repo-connect time (not a hot loop), so the second round trip is immaterial,
 * while composition reuses `hasActiveSelfHostedRunner`'s window/kind logic
 * verbatim instead of re-deriving it inline — one source of truth for "is a
 * self-hosted runner active right now" rather than two copies that could
 * drift apart.
 *
 * Why not `hasActiveRunner` / `hasActiveSelfHostedRunner` alone: both require
 * a PRIOR claim to have already touched `last_used_at`. For a brand-new
 * workspace at the exact instant its first repo is connected, no runner has
 * claimed anything yet — the hosted fleet mints/rotates `kind: 'fleet'` keys
 * on its own sync schedule (boot + every `FLEET_SYNC_INTERVAL_SECONDS`,
 * sweeping every workspace in the deployment), not triggered by repo-connect
 * — so that heuristic is essentially always false at the one moment
 * `enqueueOnboard` needs it to be true. `enqueueOnboard` is called
 * synchronously, exactly once, with no retry path (idempotent via a
 * deterministic id + `onConflictDoNothing` — see its own doc-comment): miss
 * this one instant and the repo is never onboarded, ever. `hostedExecution`
 * is a plain column on `workspaces`, readable synchronously with zero
 * dependency on fleet timing, so ORing it in closes that race outright for
 * every hosted-eligible workspace (the default for all of them).
 */
export async function workspaceHasExecutionPath(
  workspaceId: string,
): Promise<boolean> {
  const [workspace, selfHostedActive] = await Promise.all([
    getWorkspace(workspaceId),
    hasActiveSelfHostedRunner(workspaceId),
  ]);
  return Boolean(workspace?.hostedExecution) || selfHostedActive;
}

export interface FleetProvisionStateRow {
  workspaceId: string;
  slug: string;
  hostedExecution: boolean;
  /** True when a live (non-revoked) `kind: 'fleet'` api_key already exists. */
  hasActiveFleetKey: boolean;
  /** The active fleet key's id, or null when it has none (mint) or is
   * self-hosted-only (revoke has nothing to do). */
  fleetKeyId: string | null;
}

/**
 * One row per workspace, describing exactly what the hosted fleet sync
 * endpoint (#1267 PR ①, `POST /api/v1/fleet/workspace-tokens/sync`) needs to
 * decide whether to mint, leave alone, or revoke that workspace's `kind:
 * 'fleet'` api_key:
 *   - hostedExecution=true,  hasActiveFleetKey=false -> mint
 *   - hostedExecution=true,  hasActiveFleetKey=true  -> already active, no-op
 *   - hostedExecution=false, hasActiveFleetKey=true   -> revoke
 *   - hostedExecution=false, hasActiveFleetKey=false  -> nothing to do
 *
 * The LEFT JOIN is safe against fan-out: `api_keys_one_active_fleet_key_idx`
 * (migration 0033) guarantees at most one non-revoked `kind='fleet'` row per
 * workspace, so this never returns more than one row per workspace.
 */
export async function listFleetProvisionState(): Promise<FleetProvisionStateRow[]> {
  const rows = await db
    .select({
      workspaceId: workspaces.id,
      slug: workspaces.slug,
      hostedExecution: workspaces.hostedExecution,
      fleetKeyId: apiKeys.id,
    })
    .from(workspaces)
    .leftJoin(
      apiKeys,
      and(
        eq(apiKeys.workspaceId, workspaces.id),
        eq(apiKeys.kind, "fleet"),
        isNull(apiKeys.revokedAt),
      ),
    );

  return rows.map((r) => ({
    workspaceId: r.workspaceId,
    slug: r.slug,
    hostedExecution: r.hostedExecution,
    hasActiveFleetKey: r.fleetKeyId != null,
    fleetKeyId: r.fleetKeyId ?? null,
  }));
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

/**
 * Create a workspace whose owner is not yet a linked user — the chat-first
 * creation path (issue #1264 PR ①, spec §4.2). Jace's `create_workspace` tool
 * calls this (via the console's runner endpoint) when the CALLING
 * conversation's chat identity has no linked user yet: the workspace is
 * created and the identity is bound to it (`chat_identities.workspace_id`),
 * but — unlike `createWorkspace` above — NO `workspace_memberships` row is
 * inserted. "Owner-elect" names that gap precisely: there is no owner (a
 * membership requires a `user_id`) until the identity completes a GitHub bind
 * (issue #1263's connect flow) and issue #1264 PR ② promotes the
 * now-linked user to an owner membership on this same workspace. Until then
 * the workspace is real and visible on the console — reachable by this
 * identity via `listWorkspacesForChatIdentity`'s own-`workspace_id` join —
 * but ownerless.
 *
 * `chatIdentityId` must be server-derived (the caller's own conversation,
 * resolved through the session ledger — see `connect-link/route.ts`'s
 * doc-comment for the pattern) — same SECURITY contract as
 * `bindChatIdentityWorkspace` itself (chat_identities.ts): binding an
 * attacker-chosen id here would let that identity reach a workspace it has
 * no legitimate claim to.
 *
 * `slug` is caller-supplied — the console endpoint derives it from `name` and
 * owns collision-retry policy. A unique violation on `workspaces.slug`
 * bubbles up as a thrown error for the caller to catch; this function does
 * not auto-suffix.
 *
 * Both writes happen in ONE transaction, so a crash between them can never
 * leave a workspace with no bound identity. The bind is inlined here as
 * `tx.update(chatIdentities)...` rather than calling the exported
 * `bindChatIdentityWorkspace` — that helper writes through the top-level `db`
 * handle, not `tx`, so reusing it here would silently commit the bind
 * outside this transaction.
 */
export async function createWorkspaceOwnerElect(data: {
  name: string;
  slug: string;
  chatIdentityId: string;
}) {
  return db.transaction(async (tx) => {
    const rows = await tx
      .insert(workspaces)
      .values({ name: data.name, slug: data.slug })
      .returning();
    const workspace = rows[0]!;
    await tx
      .update(chatIdentities)
      .set({ workspaceId: workspace.id, updatedAt: new Date() })
      .where(eq(chatIdentities.id, data.chatIdentityId));
    return workspace;
  });
}

/**
 * Complete an owner-elect workspace's ownership (issue #1264 PR ②) — the
 * other half of `createWorkspaceOwnerElect` above (PR ①). That function
 * creates a workspace bound to a chat identity with NO `workspace_memberships`
 * row; this is what fills the gap once that identity completes a GitHub bind
 * (the `/connect/[token]` flow, issue #1263) and has a real linked user to
 * promote into the owner seat.
 *
 * ONE atomic statement — `INSERT ... SELECT ... WHERE NOT EXISTS` — not a
 * read-then-write pair, so there is no window between "does this workspace
 * already have an owner" and "write the owner row" for a race to land in.
 * The `NOT EXISTS` guard is what makes this safe to call unconditionally
 * against ANY workspace, not just a genuine owner-elect one: it checks
 * whether the workspace has an owner AT ALL (`role = 'owner'`, any user),
 * not whether THIS `userId` already holds one. If it already has an owner
 * (via any path), the SELECT yields zero rows, nothing is written, and this
 * returns `completed: false` — an existing owner is never demoted or
 * replaced. Re-running for the SAME (userId, workspaceId) pair after a first
 * success also returns `completed: false`: the workspace now has an owner
 * (itself), so the `NOT EXISTS` guard alone already blocks the retry; the
 * trailing `ON CONFLICT (user_id, workspace_id) DO NOTHING` is a defensive
 * second layer for the identical-retry race window, not the mechanism this
 * guard relies on for the general "someone else already owns it" case.
 *
 * SECURITY: `userId` must be the server-derived session user from the bind
 * flow (`session.user.id` in `/connect/[token]/page.tsx`), never
 * model/input-supplied — this inserts a real ownership grant.
 */
export async function completeOwnerElectWorkspace(data: {
  workspaceId: string;
  userId: string;
}): Promise<{ completed: boolean }> {
  const rows = (await db.execute(sql`
    INSERT INTO workspace_memberships (user_id, workspace_id, role)
    SELECT ${data.userId}, ${data.workspaceId}, 'owner'
    WHERE NOT EXISTS (
      SELECT 1 FROM workspace_memberships
      WHERE workspace_id = ${data.workspaceId} AND role = 'owner'
    )
    ON CONFLICT (user_id, workspace_id) DO NOTHING
    RETURNING user_id
  `)) as unknown as Array<{ user_id: string }>;

  return { completed: Array.from(rows).length > 0 };
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
  latestRunForIssue,
  STALE_RUN_MINUTES,
  DEVICE_CODE_TTL_MS,
  type StartedDeviceCode,
  type DeviceTokenResult,
  type ApproveDeviceCodeResult,
  type WorkItem,
  type QueueEntryListItem,
  type RunnerStatus,
  type LatestRunForIssue,
  type RecordRunnerResult,
  type TerminalQueueState,
} from "./runner.js";

// CI reconciliation (#891b) — reconcile a run's DISPLAYED status against the
// PR's real CI so a green-CI PR is not shown as `failed` from the local gate
// verdict. Pure mapping + a best-effort GitHub fetch + a throttled read-path
// enricher. `getGithubToken` is resolved lazily at call time, so the
// index<->ci-reconcile import cycle is load-order-safe.
export {
  parsePrUrl,
  reconcileRunDisplayStatus,
  rollupCheckRuns,
  fetchPrCiConclusion,
  reconcileRunsCiStatus,
  type RunDisplayStatus,
  type CiConclusion,
  type PrRef,
  type ReconcilableRun,
} from "./ci-reconcile.js";

// GitHub issue intake — the webhook half of the queue: the AC gate + workspace
// resolution + idempotent enqueue (deterministic id matches the Python store).
// ONBOARD_EXTERNAL_ID_PREFIX (#1268 PR②) is the onboard rows' external-id
// marker, single-sourced next to its writer so every reader (deriveRepoSlug,
// the console's onboardRepoFullName) imports the same string.
// #1274 PR ①: githubIssueUrl is the single-sourced issue-URL shape both the
// admission-time confirmed-lookup (hasConfirmedAlignmentBrief, internal to
// enqueueGithubIssue) and the console github-webhook route's brief
// composition key off — so the two can never drift on formatting.
// ALIGNMENT_PARK_REASON/ALIGNMENT_DENIED_PARK_REASON are the exact vocabulary
// the console's formatParkReason renders verbatim. confirmAlignmentBrief/
// denyAlignmentBrief are the OTHER half of the gate: the Telegram webhook's
// (and, #1276 PR ②, the console approvals page's) confirm/deny side-effect
// once a human answers the posted brief. requeueParkedQueueEntry (#1276
// PR ②) is the approvals page's Requeue action for a guardrail/dependency
// park — it refuses an alignment-held row server-side by construction,
// mirroring unparkDependents' aligned check (kind/estimatedBudgetUsd/
// require_alignment, denial unconditional) rather than any parkReason
// string match, so the exclusion can never drift from what actually marks a
// row aligned (#1276 fix round).
// findAlignmentBriefCandidates (#1274 PR③) is the find-side of
// apps/console/lib/alignment-reconciler.ts::reconcileAlignmentBriefs — every
// raw drizzle/SQL access stays in this package (see findWorkspaceByRepo's own
// raw-SQL idiom this mirrors); the console layer only ever calls this
// exported function.
export {
  validateAcceptanceCriteria,
  findWorkspaceByRepo,
  enqueueGithubIssue,
  enqueueOnboard,
  ONBOARD_EXTERNAL_ID_PREFIX,
  githubIssueUrl,
  ALIGNMENT_PARK_REASON,
  ALIGNMENT_DENIED_PARK_REASON,
  confirmAlignmentBrief,
  denyAlignmentBrief,
  requeueParkedQueueEntry,
  findAlignmentBriefCandidates,
  type AcGateResult,
  type EnqueueResult,
  type RequeueParkedQueueEntryResult,
  type AlignmentBriefCandidate,
} from "./github_intake.js";

// Jace inbound intake — the coordinator's kill switch: a pure allow/deny gate on
// the `jace` connector row plus an enabled-connector lookup. The inbound Jace
// webhook route calls these at the boundary before forwarding to the Eve
// sidecar, so flipping the `jace` connector's `enabled=false` HALTS inbound Jace
// while the factory (a separate `github` row) keeps running. Sibling of the
// github_intake block above.
export {
  jaceInboundAllowed,
  jaceOwnsTelegramNotify,
  jaceOwnsDiscordNotify,
  jaceOwnsSlackNotify,
  jaceOwnsIMessageNotify,
  findEnabledJaceWorkspace,
  type JaceConnectorRowish,
  type JaceNotifyConnectorRowish,
  type JaceNotifyChannelFlag,
  type JaceInboundDecision,
} from "./jace_intake.js";

// Connectors — per-provider control surface that also configures the Heartbeat.
// Folds in the former standalone heartbeat_config (#816); the daemon reads
// connectors via list_active_connectors (agentrail/afk/connectors_store.py).
export {
  getConnectors,
  getConnector,
  listEnabledConnectors,
  upsertConnector,
  setConnectorSecret,
  getConnectorSecret,
  getMcpConnectorKeys,
  validateConnectorUpdate,
  isConnectorProvider,
  MIN_POLL_INTERVAL_SECONDS,
  MAX_POLL_INTERVAL_SECONDS,
  type ConnectorUpdate,
  type EnabledConnectorRow,
} from "./connectors.js";

// ---- Eval arm metrics (offline eval harness reporter, issue #942) ----

/**
 * One per-arm metric row as produced by the eval reporter's `arm_metric_rows`
 * (agentrail/evals/reporter.py). NULL `dollarsPerSolved` / `falseGreenRate` mean
 * an undefined denominator (no rep solved / no gate-passed run) — distinct from
 * a real 0.0; callers must preserve the distinction.
 */
export interface EvalArmMetricInput {
  runId: string;
  arm: string;
  repetitions: number;
  solvedCount: number;
  failedCount: number;
  solveRate: number;
  spread: number;
  totalInputTokens: number;
  totalOutputTokens: number;
  totalCacheTokens: number;
  totalCacheCreationTokens: number;
  totalTokens: number;
  totalCostUsd: number;
  dollarsPerSolved: number | null;
  gatePassedCount: number;
  falseGreenCount: number;
  falseGreenRate: number | null;
  strata: Array<Record<string, unknown>>;
}

/**
 * Insert per-arm eval metric rows for a workspace. Idempotent per
 * (workspace, run_id, arm): re-posting the same eval run overwrites the prior
 * numbers rather than duplicating, so the console always reads the latest write.
 */
export async function insertEvalArmMetrics(data: {
  workspaceId: string;
  rows: EvalArmMetricInput[];
}): Promise<number> {
  if (data.rows.length === 0) return 0;
  const values = data.rows.map((r) => ({
    workspaceId: data.workspaceId,
    runId: r.runId,
    arm: r.arm,
    repetitions: r.repetitions,
    solvedCount: r.solvedCount,
    failedCount: r.failedCount,
    solveRate: r.solveRate,
    spread: r.spread,
    totalInputTokens: r.totalInputTokens,
    totalOutputTokens: r.totalOutputTokens,
    totalCacheTokens: r.totalCacheTokens,
    totalCacheCreationTokens: r.totalCacheCreationTokens,
    totalTokens: r.totalTokens,
    totalCostUsd: r.totalCostUsd,
    dollarsPerSolved: r.dollarsPerSolved,
    gatePassedCount: r.gatePassedCount,
    falseGreenCount: r.falseGreenCount,
    falseGreenRate: r.falseGreenRate,
    strata: r.strata,
  }));
  await db
    .insert(evalArmMetrics)
    .values(values)
    .onConflictDoUpdate({
      target: [
        evalArmMetrics.workspaceId,
        evalArmMetrics.runId,
        evalArmMetrics.arm,
      ],
      set: {
        repetitions: sql`excluded.repetitions`,
        solvedCount: sql`excluded.solved_count`,
        failedCount: sql`excluded.failed_count`,
        solveRate: sql`excluded.solve_rate`,
        spread: sql`excluded.spread`,
        totalInputTokens: sql`excluded.total_input_tokens`,
        totalOutputTokens: sql`excluded.total_output_tokens`,
        totalCacheTokens: sql`excluded.total_cache_tokens`,
        totalCacheCreationTokens: sql`excluded.total_cache_creation_tokens`,
        totalTokens: sql`excluded.total_tokens`,
        totalCostUsd: sql`excluded.total_cost_usd`,
        dollarsPerSolved: sql`excluded.dollars_per_solved`,
        gatePassedCount: sql`excluded.gate_passed_count`,
        falseGreenCount: sql`excluded.false_green_count`,
        falseGreenRate: sql`excluded.false_green_rate`,
        strata: sql`excluded.strata`,
        createdAt: sql`now()`,
      },
    });
  return values.length;
}

export interface LatestEvalRun {
  runId: string;
  createdAt: Date;
  arms: EvalArmMetric[];
}

/**
 * Return every arm row for the most recent eval run in a workspace (by
 * created_at), or null when no eval run has been recorded. Arms are sorted by
 * name so the console renders deterministically. The latest run is the one whose
 * newest row is newest; all its arm rows are returned together.
 */
export async function getLatestEvalArmMetrics(
  workspaceId: string
): Promise<LatestEvalRun | null> {
  // Most-recent row tells us the latest run_id (a single eval run's rows are
  // written together, so they share a created_at within the same write).
  const newest = await db
    .select({ runId: evalArmMetrics.runId, createdAt: evalArmMetrics.createdAt })
    .from(evalArmMetrics)
    .where(eq(evalArmMetrics.workspaceId, workspaceId))
    .orderBy(desc(evalArmMetrics.createdAt))
    .limit(1);
  const top = newest[0];
  if (!top) return null;

  const arms = await db
    .select()
    .from(evalArmMetrics)
    .where(
      and(
        eq(evalArmMetrics.workspaceId, workspaceId),
        eq(evalArmMetrics.runId, top.runId)
      )
    )
    .orderBy(evalArmMetrics.arm);

  return { runId: top.runId, createdAt: top.createdAt, arms };
}

// Channel inbox — the async ingest buffer between channel webhooks and the
// Jace dispatcher worker (issue #1246, spec §4). Bounded retry with backoff is
// a pure decision function (nextInboxStateAfterFailure) so the retry policy is
// unit-testable and can't drift from the SQL that applies it.
export {
  INBOX_MAX_ATTEMPTS,
  INBOX_BACKOFF_SECONDS,
  INBOX_STALE_PROCESSING_MINUTES,
  nextInboxStateAfterFailure,
  enqueueChannelMessage,
  claimNextChannelMessage,
  completeChannelMessage,
  failChannelMessage,
  reclaimStaleChannelMessages,
  deadLettersForWorkspace,
  requeueDeadChannelMessage,
  type InboxRetryDecision,
  type EnqueueChannelMessageInput,
  type EnqueueChannelMessageResult,
  type ClaimedChannelInboxRow,
  type ClaimNextChannelMessageOptions,
  type DeadLetterChannelMessageRow,
} from "./channel_inbox.js";

// Jace session map + pending approvals (issue #1246, spec §4). Maps
// (workspace, channel, conversation) -> one Eve session; resolveApproval is
// the publication idempotency guard (atomic pending->resolved flip) that lets
// callers publish a downstream side effect exactly once per approval.
// getOrCreateIntroJaceSession + bindJaceSessionWorkspace (issue #1261 PR ②)
// are the workspace-less counterpart: a session anchored to chat_identity_id
// for a sender with no resolved workspace yet, that graduates in place.
// resolveConversationWorkspace + pinConversationWorkspace (issue #1261 PR ③)
// complete the spine: deciding which workspace a conversation belongs to when
// an identity reaches more than one, and pinning that decision to the
// (channel, conversationKey) session row.
// getJaceSessionByEveSessionId + latestTelegramSessionForChatIdentity (issue
// #1263 PR ②) round out the connect-GitHub flow: the former resolves the
// mint endpoint's calling conversation (ctx.session.id) down to its chat
// identity server-side; the latter finds which Telegram chat to post the
// post-bind confirmation into. latestTelegramSessionForWorkspace (issue
// #1269 PR ②a) is the same lookup keyed by workspace instead of chat
// identity — the monthly-budget-ceiling notify's destination resolver.
// getApprovalByCallbackToken (issue #1273 PR ①) is the console-gated approval
// seam's own lookup: a Telegram button callback carries only the opaque
// callback_data token, with no workspace to scope by yet, unlike the
// workspace-scoped findApprovalByCallbackToken above. getApprovalById is the
// GET /api/v1/runner/approvals/[id] poller's own read, scoped by the
// console-minted uuid alone. getJaceSessionById (issue #1273 review fix)
// resolves a session by its own PK — the null-chatIdentityId SENDER CHECK
// fallback's read of the owning session's conversationKey. recordApprovalRequest
// (issue #1273 PR ②) is now idempotent on the (eveSessionId, requestId)
// unique: a caller composes requestId from its own idempotency key, and a
// retried call returns the EXISTING row (created: false) instead of
// throwing or minting a second one. stampPublishedIssueUrl (#1274 PR ②) is
// the chat-born one-confirm collapse's own write: it stamps the real GitHub
// issue URL a create_issue tool call produced onto its own approved
// approval row, which github_intake.ts's confirmed-brief lookup then
// recognizes to admit the label-webhook redelivery straight to queued.
export {
  getOrCreateJaceSession,
  bindEveSession,
  setJaceSessionStatus,
  getOrCreateIntroJaceSession,
  bindJaceSessionWorkspace,
  resolveConversationWorkspace,
  pinConversationWorkspace,
  getJaceSessionByEveSessionId,
  getJaceSessionById,
  latestTelegramSessionForChatIdentity,
  latestTelegramSessionForWorkspace,
  recordApprovalRequest,
  findApprovalByCallbackToken,
  getApprovalByCallbackToken,
  getApprovalById,
  resolveApproval,
  stampPublishedIssueUrl,
  pendingApprovalsForWorkspace,
  type RecordApprovalRequestInput,
  type RecordApprovalRequestResult,
  type PendingApprovalRow,
  type StampPublishedIssueUrlOutcome,
  type ResolveConversationWorkspaceInput,
  type ResolveConversationWorkspaceResult,
  type PinConversationWorkspaceInput,
  type PinConversationWorkspaceResult,
} from "./jace_sessions.js";

// Chat identities — the identity spine for every inbound chat message (spec
// §4.2, issue #1261; see `schema/chat_identities.ts` for the table shape and
// the WHY behind the design). Maps (platform, platform_user_id) -> at most
// one linked user and one resolved workspace. resolveInboundChatIdentity (PR
// ②) is the composed entry point the shared-bot webhook door (#1262) calls.
// #1264's create_workspace instead resolves through the session ledger
// (getJaceSessionByEveSessionId -> getChatIdentityById, see the
// jace_sessions.js comment above) — never resolveInboundChatIdentity.
// listWorkspacesForChatIdentity (PR ③) is every workspace an identity can
// reach — the input to the multi-workspace disambiguation above.
// consumeChatIdentityLinkToken (issue #1263) is the single-use,
// expiry-checked consume primitive the /connect/[token] bind flow calls
// after `setChatIdentityLinkToken` mints a link.
export {
  insertChatIdentity,
  getChatIdentity,
  getChatIdentityById,
  bindChatIdentityWorkspace,
  bindChatIdentityUser,
  setChatIdentityLinkToken,
  getChatIdentityByLinkToken,
  consumeChatIdentityLinkToken,
  resolveInboundChatIdentity,
  listWorkspacesForChatIdentity,
  type ResolveInboundChatIdentityInput,
  type ResolveInboundChatIdentityResult,
  type ReachableWorkspace,
} from "./chat_identities.js";

// Workspace monthly-budget-ceiling queries (issue #1269 PR ②a; see
// `queries/workspace_budget.ts` for the full WHY behind the design).
// getWorkspaceBudgetState + sumWorkspaceSpendSince are the claim route's read
// path — the SUM only ever runs when the ceiling is non-null.
// markBudgetExhaustedNotified is the atomic compare-and-set that makes the
// once-per-period chat notice race-safe with no advisory lock.
export {
  getWorkspaceBudgetState,
  sumWorkspaceSpendSince,
  markBudgetExhaustedNotified,
  type WorkspaceBudgetState,
} from "./workspace_budget.js";

// Per-workspace cost aggregation reads (issue #1272 PR ①; see
// `queries/workspace_costs.ts` for the honesty caveats these all inherit
// from #1269's budget helpers above). listWorkspaceRunCosts is the per-task
// detail list; workspaceMonthlyCostRollup is the UTC-month trend series
// (zero-filled, including the current partial month) the page's chart reads;
// getWorkspaceCostOverview is the composed read the page opens with (pure
// composition over getWorkspaceBudgetState + sumWorkspaceSpendSince above —
// no new SQL of its own).
export {
  DEFAULT_RUN_COST_LIST_LIMIT,
  listWorkspaceRunCosts,
  type WorkspaceRunCostRow,
  DEFAULT_MONTHLY_ROLLUP_MONTHS,
  workspaceMonthlyCostRollup,
  type WorkspaceMonthlyCostRow,
  getWorkspaceCostOverview,
  type WorkspaceCostOverview,
  type WorkspaceCapStatus,
} from "./workspace_costs.js";

// #1338 PR① — the model-selection learning loop's FUEL (capture only; see
// `queries/run_outcomes.ts` for the full design/timing rationale).
// recordRunOutcome is called by the runner-result route on every terminal
// queue transition; mapTerminalStateToRunOutcome is its pure vocabulary
// mapping (independently unit-testable); getModelOutcomeStats is the
// aggregate read a LATER PR's selector will consume.
export {
  recordRunOutcome,
  mapTerminalStateToRunOutcome,
  getModelOutcomeStats,
  type RunOutcomeValue,
  type ModelOutcomeStatsRow,
} from "./run_outcomes.js";

// Grantable workspace-trust-setting queries (issue #1278; see
// `queries/workspace_grants.ts` for the full WHY). getMergePermission is the
// fresh, uncached read the runner-result route gates a squash-merge on;
// setMergePermission is the console owner-only toggle's transactional
// write (column flip + audit row, one transaction); latestGrantEvent is the
// "who granted / when" display read, joined to the granting user's
// name/email.
export {
  MERGE_PERMISSION_SETTING,
  getMergePermission,
  setMergePermission,
  type SetMergePermissionResult,
  latestGrantEvent,
  type LatestGrantEventRow,
} from "./workspace_grants.js";
