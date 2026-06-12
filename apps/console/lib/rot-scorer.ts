/**
 * Context Rot Scorer — pure compute core + thin async fetch wrapper.
 *
 * Computes a rot_score (0–100) and a ranked list of stale contributors from
 * three signals:
 *   - Memory item staleness  (Postgres `memory_items.last_used_at`, 40% weight)
 *   - Index snapshot staleness (ClickHouse `index_snapshots.indexed_at`,  40% weight)
 *   - Source hash churn       (ClickHouse `context_packs.source_hash_list`, 20% weight)
 *
 * Decay function: linear, Math.min(staleness_days / thresholdDays, 1.0).
 * Null `last_used_at` is treated as maximally stale (decay = 1.0).
 * Hash churn decay: (distinct_lists - 1) / max(run_count - 1, 1), capped at 1.0.
 * Source hash churn is a secondary signal — the 20% weight prevents it from
 * dominating the score (per CONTEXT.md).
 * Context Memory is advisory; this scorer must never outrank current code or docs.
 *
 * The pure `computeRotScore` function accepts plain data rows and has no
 * infrastructure dependencies, making it fully unit-testable with fixtures.
 */

import { parseClickhouseUtc } from "./repo-health";

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

export interface ContributorRow {
  type: "memory_item" | "index_snapshot" | "hash_churn";
  /** Memory item UUID, repository_id, or "hash_churn". */
  id: string;
  /** Human-readable: item source path, repo name, or "Source hash churn". */
  label: string;
  staleness_days: number;
  /** This contributor's share of the final rot_score (0–100). */
  score_contribution: number;
}

export interface RotScoreResult {
  rot_score: number;
  contributors: ContributorRow[];
}

export interface RotScorerParams {
  workspaceId: string;
  repositoryId?: string;
  asOf: Date;
  /** Defaults to 30. Items older than this are fully stale (decay = 1.0). */
  thresholdDays?: number;
}

// ---------------------------------------------------------------------------
// Input signal types (pure data — no DB dependencies)
// ---------------------------------------------------------------------------

export interface MemorySignalRow {
  id: string;
  source: string;
  lastUsedAt: Date | null;
}

export interface SnapshotSignal {
  repositoryId: string;
  /** Human-readable name shown in contributor label. Falls back to repositoryId. */
  repositoryName?: string;
  /** Accepts a ClickHouse DateTime64 string or a JS Date. */
  indexedAt: Date | string;
}

export interface ChurnSignal {
  distinctLists: number;
  runCount: number;
}

export interface RotScorerSignals {
  memoryRows: MemorySignalRow[];
  snapshot: SnapshotSignal | null;
  churn: ChurnSignal;
}

// ---------------------------------------------------------------------------
// Pure compute core
// ---------------------------------------------------------------------------

const MS_PER_DAY = 86_400_000;

function stalenessDay(lastUsedAt: Date | null, asOf: Date, thresholdDays: number): number {
  if (lastUsedAt === null) return thresholdDays;
  return Math.max(0, (asOf.getTime() - lastUsedAt.getTime()) / MS_PER_DAY);
}

/**
 * Pure rot-score computation. No DB calls — all inputs are plain data rows.
 *
 * @param signals  - Pre-fetched memory rows, latest index snapshot, churn counts.
 * @param opts     - `asOf` reference date; optional `thresholdDays` (default 30).
 * @returns        - `rot_score` (0–100) and `contributors` sorted desc by score_contribution.
 */
export function computeRotScore(
  signals: RotScorerSignals,
  opts: { asOf: Date; thresholdDays?: number }
): RotScoreResult {
  const { asOf } = opts;
  const thresholdDays = opts.thresholdDays ?? 30;

  // --- Memory item component (40% weight) ---
  // Per item: decay = min(staleness_days / thresholdDays, 1.0).
  // Component = mean of item decays (0 when no items).
  // Per-item score_contribution = decay_i / n * 40.
  const n = signals.memoryRows.length;
  const memoryContributors: ContributorRow[] = [];
  let memoryComponent = 0;

  if (n > 0) {
    const items = signals.memoryRows.map((row) => {
      const days = stalenessDay(row.lastUsedAt, asOf, thresholdDays);
      const decay = Math.min(days / thresholdDays, 1.0);
      return { row, days, decay };
    });
    memoryComponent = items.reduce((sum, i) => sum + i.decay, 0) / n;

    for (const { row, days, decay } of items) {
      const contribution = (decay / n) * 40;
      if (contribution > 0) {
        memoryContributors.push({
          type: "memory_item",
          id: row.id,
          label: row.source,
          staleness_days: days,
          score_contribution: contribution,
        });
      }
    }
  }

  // --- Index snapshot component (40% weight) ---
  // Decay = min(staleness_days / thresholdDays, 1.0); 0 when absent.
  // score_contribution = decay * 40.
  let snapshotComponent = 0;
  const snapshotContributors: ContributorRow[] = [];

  if (signals.snapshot) {
    const indexedAt =
      signals.snapshot.indexedAt instanceof Date
        ? signals.snapshot.indexedAt
        : parseClickhouseUtc(signals.snapshot.indexedAt);
    const days = Math.max(0, (asOf.getTime() - indexedAt.getTime()) / MS_PER_DAY);
    const decay = Math.min(days / thresholdDays, 1.0);
    snapshotComponent = decay;

    if (decay > 0) {
      snapshotContributors.push({
        type: "index_snapshot",
        id: signals.snapshot.repositoryId,
        label: signals.snapshot.repositoryName ?? signals.snapshot.repositoryId,
        staleness_days: days,
        score_contribution: decay * 40,
      });
    }
  }

  // --- Hash churn component (20% weight) ---
  // Churn decay = (distinct_lists - 1) / max(run_count - 1, 1), capped at 1.0.
  // This bounded ratio keeps churn from dominating (per CONTEXT.md).
  let churnComponent = 0;
  const churnContributors: ContributorRow[] = [];

  if (signals.churn.distinctLists > 1) {
    churnComponent = Math.min(
      (signals.churn.distinctLists - 1) / Math.max(signals.churn.runCount - 1, 1),
      1.0
    );
    const contribution = churnComponent * 20;
    if (contribution > 0) {
      churnContributors.push({
        type: "hash_churn",
        id: "hash_churn",
        label: "Source hash churn",
        staleness_days: 0,
        score_contribution: contribution,
      });
    }
  }

  const rot_score = Math.round(
    (0.4 * memoryComponent + 0.4 * snapshotComponent + 0.2 * churnComponent) * 100
  );

  // Sort descending by score_contribution; tie-break by staleness_days desc then id asc.
  const contributors = [
    ...memoryContributors,
    ...snapshotContributors,
    ...churnContributors,
  ].sort((a, b) => {
    const diff = b.score_contribution - a.score_contribution;
    if (diff !== 0) return diff;
    const daysDiff = b.staleness_days - a.staleness_days;
    if (daysDiff !== 0) return daysDiff;
    return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
  });

  return { rot_score, contributors };
}

// ---------------------------------------------------------------------------
// Async fetch wrapper (not unit-tested; delegates to DB query functions)
// ---------------------------------------------------------------------------

/**
 * Fetch all three rot signals from the DB and compute the rot score.
 * For multi-repo workspaces without a repositoryId, uses the stalest snapshot.
 */
export async function getRotScore(params: RotScorerParams): Promise<RotScoreResult> {
  const { workspaceId, repositoryId, asOf } = params;
  const thresholdDays = params.thresholdDays ?? 30;
  const thresholdDate = new Date(asOf.getTime() - thresholdDays * MS_PER_DAY);

  // Dynamic imports keep DB connection code out of the module's import-time
  // execution path, so unit tests that import this file won't trigger DB init.
  const [
    { getStaleMemoryItems, listWorkspaceRepositories },
    { getLatestIndexSnapshotsForWorkspace, countDistinctSourceHashLists },
  ] = await Promise.all([
    import("@agentrail/db-postgres"),
    import("@agentrail/db-clickhouse"),
  ]);

  const repoIds: string[] = repositoryId
    ? [repositoryId]
    : await listWorkspaceRepositories(workspaceId).then((rows) => rows.map((r) => r.id));

  const [memoryRows, snapshots, churnResult] = await Promise.all([
    getStaleMemoryItems(workspaceId, thresholdDate, repositoryId),
    repoIds.length > 0
      ? getLatestIndexSnapshotsForWorkspace(workspaceId, repoIds)
      : Promise.resolve([]),
    countDistinctSourceHashLists(workspaceId, thresholdDate, asOf, repositoryId),
  ]);

  let snapshot: SnapshotSignal | null = null;
  if (snapshots.length > 0) {
    const target = repositoryId
      ? snapshots.find((s) => s.repository_id === repositoryId)
      : snapshots.reduce((worst, s) =>
          parseClickhouseUtc(s.indexed_at) < parseClickhouseUtc(worst.indexed_at) ? s : worst
        );
    if (target) {
      snapshot = {
        repositoryId: target.repository_id,
        indexedAt: target.indexed_at,
      };
    }
  }

  return computeRotScore(
    {
      memoryRows: memoryRows.map((r) => ({
        id: r.id,
        source: r.source,
        lastUsedAt: r.lastUsedAt,
      })),
      snapshot,
      churn: {
        distinctLists: churnResult.distinct_lists,
        runCount: churnResult.run_count,
      },
    },
    { asOf, thresholdDays }
  );
}
