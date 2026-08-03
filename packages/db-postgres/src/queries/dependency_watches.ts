import { and, eq, isNotNull, lte, sql } from "drizzle-orm";
import { db } from "../db.js";
import { repositories } from "../schema/repositories.js";
import {
  dependencyWatchObservations,
  dependencyWatches,
} from "../schema/dependency_watches.js";
import type {
  DependencyWatchErrorCode,
  DependencyWatchStatus,
  DependencyWatchTrigger,
} from "../schema/dependency_watches.js";

export class DependencyWatchAuthorizationError extends Error {
  readonly code = "authorization" as const;

  constructor() {
    super("Repository is not connected to this workspace");
    this.name = "DependencyWatchAuthorizationError";
  }
}

export class DependencyWatchValidationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "DependencyWatchValidationError";
  }
}

export type DependencyWatchConfig = {
  workspaceId: string;
  repositoryId: string;
  manifestPath?: string;
  lockfilePath?: string;
  selectedDependencies?: string[];
  cadenceSeconds?: number | null;
};

export type RecordDependencyObservationInput = {
  workspaceId: string;
  watchId: string;
  repositoryId: string;
  trigger: DependencyWatchTrigger;
  baselineSha?: string | null;
  selectedFileHashes: Record<string, string>;
  observationKey: string;
  candidateFingerprint?: string | null;
  status: DependencyWatchStatus;
  candidates?: unknown[];
  errorCode?: DependencyWatchErrorCode | null;
  errorMessage?: string | null;
  observedAt?: Date;
  nextCheckAt?: Date | null;
};

const AUTO_SELECTED_PATHS = new Set([
  "package.json",
  "package-lock.json",
  "npm-shrinkwrap.json",
  "pnpm-lock.yaml",
  "yarn.lock",
  "bun.lock",
  "bun.lockb",
  "pyproject.toml",
  "poetry.lock",
  "uv.lock",
  "Cargo.toml",
  "Cargo.lock",
  "go.mod",
  "go.sum",
  "Gemfile",
  "Gemfile.lock",
  "composer.json",
  "composer.lock",
  "pom.xml",
  "build.gradle",
  "build.gradle.kts",
  "packages.lock.json",
  "mix.exs",
  "mix.lock",
  "pubspec.yaml",
  "pubspec.lock",
  "Package.swift",
  "Package.resolved",
]);

function normalizePath(path: string): string {
  return path.replace(/^\.\//, "");
}

function resolvedPushPaths(watch: {
  manifestPath: string;
  lockfilePath: string;
  selectedFileHashes: Record<string, string>;
}): Set<string> {
  const explicit = [watch.manifestPath, watch.lockfilePath]
    .map(normalizePath)
    .filter((path) => path !== "auto");
  if (explicit.length === 2) {
    return new Set(explicit);
  }
  const selected = Object.keys(watch.selectedFileHashes ?? {})
    .map(normalizePath)
    .filter((path) => path.length > 0);
  if (selected.length > 0) {
    return new Set(selected);
  }
  return AUTO_SELECTED_PATHS;
}

function validateConfig(input: DependencyWatchConfig): void {
  if (!input.workspaceId || !input.repositoryId) {
    throw new DependencyWatchValidationError("workspaceId and repositoryId are required");
  }
  if (input.manifestPath !== undefined && !input.manifestPath.trim()) {
    throw new DependencyWatchValidationError("manifestPath must not be empty");
  }
  if (input.lockfilePath !== undefined && !input.lockfilePath.trim()) {
    throw new DependencyWatchValidationError("lockfilePath must not be empty");
  }
  if (
    input.cadenceSeconds !== undefined &&
    input.cadenceSeconds !== null &&
    (!Number.isInteger(input.cadenceSeconds) || input.cadenceSeconds <= 0)
  ) {
    throw new DependencyWatchValidationError("cadenceSeconds must be a positive integer or null");
  }
  if (input.selectedDependencies?.some((name) => !name.trim())) {
    throw new DependencyWatchValidationError("selectedDependencies must contain non-empty names");
  }
}

/** Configure one watch only after proving the repository belongs to the tenant. */
export async function createDependencyWatch(input: DependencyWatchConfig) {
  validateConfig(input);
  const [repository] = await db
    .select({ id: repositories.id })
    .from(repositories)
    .where(and(eq(repositories.id, input.repositoryId), eq(repositories.workspaceId, input.workspaceId)))
    .limit(1);
  if (!repository) throw new DependencyWatchAuthorizationError();

  const now = new Date();
  const nextCheckAt = input.cadenceSeconds
    ? new Date(now.getTime() + input.cadenceSeconds * 1000)
    : null;
  const [row] = await db
    .insert(dependencyWatches)
    .values({
      workspaceId: input.workspaceId,
      repositoryId: input.repositoryId,
      manifestPath: input.manifestPath ?? "auto",
      lockfilePath: input.lockfilePath ?? "auto",
      selectedDependencies: [...new Set(input.selectedDependencies ?? [])].sort(),
      cadenceSeconds: input.cadenceSeconds ?? null,
      nextCheckAt,
    })
    .onConflictDoUpdate({
      target: [
        dependencyWatches.workspaceId,
        dependencyWatches.repositoryId,
        dependencyWatches.manifestPath,
        dependencyWatches.lockfilePath,
      ],
      set: {
        selectedDependencies: [...new Set(input.selectedDependencies ?? [])].sort(),
        cadenceSeconds: input.cadenceSeconds ?? null,
        nextCheckAt,
        updatedAt: now,
      },
    })
    .returning();
  return row!;
}

export async function listDependencyWatches(workspaceId: string) {
  return db
    .select()
    .from(dependencyWatches)
    .where(eq(dependencyWatches.workspaceId, workspaceId));
}

export async function listDependencyWatchesForRepository(
  workspaceId: string,
  repositoryId: string
) {
  return db
    .select()
    .from(dependencyWatches)
    .where(
      and(
        eq(dependencyWatches.workspaceId, workspaceId),
        eq(dependencyWatches.repositoryId, repositoryId)
      )
    );
}

export async function getDependencyWatch(workspaceId: string, watchId: string) {
  const [row] = await db
    .select()
    .from(dependencyWatches)
    .where(and(eq(dependencyWatches.workspaceId, workspaceId), eq(dependencyWatches.id, watchId)))
    .limit(1);
  return row ?? null;
}

/** Explicit/manual and scheduled trigger seam. This only records intent. */
export async function triggerDependencyWatch(
  workspaceId: string,
  watchId: string,
  trigger: DependencyWatchTrigger,
  now = new Date()
) {
  if (!["manual", "scheduled", "push"].includes(trigger)) {
    throw new DependencyWatchValidationError("trigger must be manual, scheduled, or push");
  }
  const watch = await getDependencyWatch(workspaceId, watchId);
  if (!watch) throw new DependencyWatchAuthorizationError();
  const [row] = await db
    .update(dependencyWatches)
    .set({ lastTrigger: trigger, lastTriggeredAt: now, status: "checking", updatedAt: now })
    .where(and(eq(dependencyWatches.workspaceId, workspaceId), eq(dependencyWatches.id, watchId)))
    .returning();
  return row!;
}

/** Trigger only watches whose selected manifest or lockfile changed. */
export async function triggerDependencyWatchesForPush(
  workspaceId: string,
  repositoryId: string,
  changedPaths: string[],
  now = new Date()
) {
  const watches = await listDependencyWatchesForRepository(workspaceId, repositoryId);
  const changed = new Set(changedPaths.map(normalizePath));
  const triggered: typeof watches = [];
  for (const watch of watches) {
    const pushPaths = resolvedPushPaths(watch as {
      manifestPath: string;
      lockfilePath: string;
      selectedFileHashes: Record<string, string>;
    });
    let matched = false;
    for (const path of pushPaths) {
      if (changed.has(path)) {
        matched = true;
        break;
      }
    }
    if (!matched) continue;
    const [row] = await db
      .update(dependencyWatches)
      .set({
        lastTrigger: "push",
        lastTriggeredAt: now,
        status: "checking",
        updatedAt: now,
      })
      .where(
        and(
          eq(dependencyWatches.workspaceId, workspaceId),
          eq(dependencyWatches.id, watch.id)
        )
      )
      .returning();
    if (row) triggered.push(row);
  }
  return triggered;
}

/** Heartbeat reads only watches in its authorized workspace that are due. */
export async function listDueDependencyWatches(workspaceId: string, now = new Date()) {
  return db
    .select()
    .from(dependencyWatches)
    .where(
      and(
        eq(dependencyWatches.workspaceId, workspaceId),
        isNotNull(dependencyWatches.cadenceSeconds),
        isNotNull(dependencyWatches.nextCheckAt),
        lte(dependencyWatches.nextCheckAt, now)
      )
    );
}

/**
 * Claim due watches atomically. A second heartbeat cannot claim the same row
 * after the first transaction changes its status to `checking`; the returned
 * rows are observation work only and never become queue entries.
 */
export async function claimDueDependencyWatches(
  workspaceId: string,
  now = new Date(),
  limit = 25
) {
  const safeLimit = Math.max(1, Math.min(100, Math.trunc(limit)));
  return db.execute(
    // drizzle's typed update builder cannot express SKIP LOCKED portably;
    // this CTE keeps the lock-and-update atomic at the database boundary.
    sql`WITH due AS (
      SELECT id
      FROM dependency_watches
      WHERE workspace_id = ${workspaceId}
        AND cadence_seconds IS NOT NULL
        AND next_check_at IS NOT NULL
        AND next_check_at <= ${now}
        AND status <> 'checking'
      ORDER BY next_check_at ASC
      FOR UPDATE SKIP LOCKED
      LIMIT ${safeLimit}
    )
    UPDATE dependency_watches AS watch
    SET status = 'checking',
        last_trigger = 'scheduled',
        last_triggered_at = ${now},
        next_check_at = CASE
          WHEN cadence_seconds IS NULL THEN NULL
          ELSE ${now} + (cadence_seconds * interval '1 second')
        END,
        updated_at = ${now}
    FROM due
    WHERE watch.id = due.id
    RETURNING watch.*`
  );
}

/** Persist one observation and atomically make retries idempotent. */
export async function recordDependencyWatchObservation(
  input: RecordDependencyObservationInput
) {
  const watch = await getDependencyWatch(input.workspaceId, input.watchId);
  if (!watch || watch.repositoryId !== input.repositoryId) {
    throw new DependencyWatchAuthorizationError();
  }
  const observedAt = input.observedAt ?? new Date();
  const [observation] = await db
    .insert(dependencyWatchObservations)
    .values({
      workspaceId: input.workspaceId,
      watchId: input.watchId,
      repositoryId: input.repositoryId,
      trigger: input.trigger,
      baselineSha: input.baselineSha ?? null,
      selectedFileHashes: input.selectedFileHashes,
      observationKey: input.observationKey,
      candidateFingerprint: input.candidateFingerprint ?? null,
      status: input.status,
      candidates: input.candidates ?? [],
      errorCode: input.errorCode ?? null,
      errorMessage: input.errorMessage ?? null,
      observedAt,
    })
    .onConflictDoNothing({
      target: [
        dependencyWatchObservations.workspaceId,
        dependencyWatchObservations.repositoryId,
        dependencyWatchObservations.observationKey,
      ],
    })
    .returning();

  const [updatedWatch] = await db
    .update(dependencyWatches)
    .set({
      lastCheckedSha: input.baselineSha ?? null,
      selectedFileHashes: input.selectedFileHashes,
      candidateFingerprint: input.status === "candidates" ? input.candidateFingerprint ?? null : null,
      status: input.status,
      errorCode: input.errorCode ?? null,
      errorMessage: input.errorMessage ?? null,
      lastCheckedAt: observedAt,
      nextCheckAt: input.nextCheckAt ?? null,
      updatedAt: observedAt,
    })
    .where(and(eq(dependencyWatches.workspaceId, input.workspaceId), eq(dependencyWatches.id, input.watchId)))
    .returning();
  return { recorded: !!observation, observation: observation ?? null, watch: updatedWatch! };
}
