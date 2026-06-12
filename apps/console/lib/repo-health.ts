/**
 * Repo-health derivation — the single source of truth.
 *
 * Health is a function of how fresh a repository's latest index snapshot is.
 * This logic was previously duplicated inline in both the repos API route and
 * the repos page Server Component, which let a timezone-parsing bug live in one
 * copy after the other was fixed. Keep it here; both consumers call it.
 */
import type { IndexSnapshotRecord } from "@agentrail/db-clickhouse";

export type HealthStatus = "healthy" | "stale" | "critical";

/** Seconds since the last snapshot below which a repo is considered healthy. */
export const HEALTHY_MAX_SECONDS = 3600; // 1h
/** Seconds since the last snapshot below which a repo is "stale" (else critical). */
export const STALE_MAX_SECONDS = 86400; // 24h

/**
 * Parse a ClickHouse `DateTime64` value as UTC.
 *
 * ClickHouse returns timestamps as `"YYYY-MM-DD HH:MM:SS.mmm"` — space-separated
 * and with no timezone marker. `new Date(...)` interprets that form as *local*
 * time, which on a non-UTC server inflates staleness by the UTC offset and makes
 * every fresh snapshot read "stale". Normalize to explicit UTC.
 */
export function parseClickhouseUtc(value: string | Date): Date {
  if (value instanceof Date) return value;
  const hasTz = /[zZ]|[+-]\d\d:?\d\d$/.test(value);
  return new Date(hasTz ? value : value.replace(" ", "T") + "Z");
}

export function computeHealth(stalenessSeconds: number | null): HealthStatus {
  if (stalenessSeconds === null) return "critical";
  if (stalenessSeconds < HEALTHY_MAX_SECONDS) return "healthy";
  if (stalenessSeconds < STALE_MAX_SECONDS) return "stale";
  return "critical";
}

export interface RepoHealth {
  last_indexed_at: string | null;
  staleness_seconds: number | null;
  health_status: HealthStatus;
}

/**
 * Derive a repo's health from its latest index snapshot (or `null` if it has
 * never been indexed → critical). `nowMs` defaults to the current time; pass it
 * explicitly to keep a batch of repos consistent.
 */
export function repoHealth(
  snapshot: IndexSnapshotRecord | null | undefined,
  nowMs: number = Date.now()
): RepoHealth {
  if (!snapshot) {
    return { last_indexed_at: null, staleness_seconds: null, health_status: "critical" };
  }
  const indexedDate = parseClickhouseUtc(snapshot.indexed_at);
  const stalenessSeconds = Math.floor((nowMs - indexedDate.getTime()) / 1000);
  return {
    last_indexed_at: indexedDate.toISOString(),
    staleness_seconds: stalenessSeconds,
    health_status: computeHealth(stalenessSeconds),
  };
}
