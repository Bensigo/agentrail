"use client";

import { useState, useEffect } from "react";
import Link from "next/link";
import { Info } from "lucide-react";
import { Skeleton, SkeletonTableRows } from "../../../../../components/loading-skeleton";
import {
  severityColor,
  formatStaleness,
  contributorHref,
  contributorTypeLabel,
  badgeColors,
} from "./rot-score-card-helpers";

interface ContributorRow {
  type: "memory_item" | "index_snapshot" | "hash_churn";
  id: string;
  label: string;
  staleness_days: number;
  score_contribution: number;
}

interface RotScoreResult {
  rot_score: number;
  contributors: ContributorRow[];
}

interface RotScoreCardProps {
  workspaceId: string;
  repositoryId: string;
}

export function RotScoreCard({ workspaceId, repositoryId }: RotScoreCardProps) {
  const [result, setResult] = useState<RotScoreResult | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    setError(null);

    const url = new URL(
      `/api/v1/workspaces/${workspaceId}/context-quality/rot-score`,
      window.location.origin
    );
    if (repositoryId) url.searchParams.set("repositoryId", repositoryId);

    fetch(url.toString())
      .then(async (res) => {
        if (!res.ok) {
          const body = await res.json().catch(() => ({}));
          throw new Error(
            (body as { error?: string }).error ?? `HTTP ${res.status}`
          );
        }
        return res.json() as Promise<RotScoreResult>;
      })
      .then((data) => {
        if (!cancelled) {
          setResult(data);
          setLoading(false);
        }
      })
      .catch((e) => {
        if (!cancelled) {
          setError(e instanceof Error ? e.message : "Failed to load rot score");
          setLoading(false);
        }
      });

    return () => {
      cancelled = true;
    };
  }, [workspaceId, repositoryId]);

  return (
    <div className="rounded border border-[var(--gray-05)] bg-[var(--gray-02)] p-4">
      {/* Card header */}
      <div className="mb-3 flex items-center gap-1.5">
        <span className="text-xs font-semibold text-[var(--gray-12)]">
          Context Rot Score
        </span>
        <span title="Composite staleness score (0–100) derived from memory item age, index snapshot freshness, and source hash churn.">
          <Info className="h-3.5 w-3.5 text-[var(--gray-08)]" />
        </span>
      </div>

      {/* Loading skeleton */}
      {loading && (
        <>
          <div className="mb-4 flex items-end gap-2">
            <Skeleton className="h-10 w-12" />
            <Skeleton className="mb-1 h-3 w-16" />
          </div>
          <div className="overflow-hidden rounded border border-[var(--gray-05)]">
            <table className="w-full border-collapse text-sm">
              <thead>
                <tr className="border-b border-[var(--gray-05)] bg-[var(--gray-01)]">
                  {["Type", "Name", "Staleness", "Contribution"].map(
                    (h) => (
                      <th
                        key={h}
                        className="px-3 py-2 text-left text-xs font-medium uppercase text-[var(--gray-09)]"
                      >
                        {h}
                      </th>
                    )
                  )}
                </tr>
              </thead>
              <tbody>
                <SkeletonTableRows columns={4} rows={4} />
              </tbody>
            </table>
          </div>
        </>
      )}

      {/* Error */}
      {!loading && error && (
        <p className="py-4 text-center text-sm text-[var(--red-11)]">{error}</p>
      )}

      {/* Loaded state */}
      {!loading && !error && result && (
        <>
          {/* Score display */}
          <div className="mb-4 flex items-end gap-2">
            <span
              className="text-4xl font-bold leading-none tracking-tight"
              style={{ color: severityColor(result.rot_score) }}
            >
              {result.rot_score}
            </span>
            <span className="mb-0.5 text-xs text-[var(--gray-09)]">
              Risk score
            </span>
          </div>

          {/* Contributor table or empty state */}
          {result.contributors.length === 0 ? (
            <div className="rounded border border-[var(--gray-05)] px-4 py-6 text-center">
              <p className="text-sm text-[var(--gray-09)]">
                No stale contributors found
              </p>
            </div>
          ) : (
            <div className="overflow-x-auto rounded border border-[var(--gray-05)]">
              <table className="w-full border-collapse text-sm">
                <thead>
                  <tr className="border-b border-[var(--gray-05)] bg-[var(--gray-01)]">
                    {["Type", "Name", "Staleness", "Contribution"].map(
                      (h) => (
                        <th
                          key={h}
                          className="px-3 py-2 text-left text-xs font-medium uppercase text-[var(--gray-09)]"
                        >
                          {h}
                        </th>
                      )
                    )}
                  </tr>
                </thead>
                <tbody>
                  {result.contributors.map((row, i) => {
                    const colors = badgeColors(row.type);
                    const href = contributorHref(row.type, workspaceId);
                    return (
                      <tr
                        key={i}
                        className="border-b border-[var(--gray-04)] last:border-b-0"
                        style={{ height: "32px" }}
                      >
                        {/* Type badge */}
                        <td className="px-3 py-1">
                          <span
                            className="inline-block rounded-sm px-1.5 py-0.5 text-xs font-medium"
                            style={{
                              background: colors.bg,
                              color: colors.text,
                            }}
                          >
                            {contributorTypeLabel(row.type)}
                          </span>
                        </td>
                        {/* Name — the human-readable label, linked. The raw
                            UUID is intentionally not shown (meaningless to users). */}
                        <td className="px-3 py-1 text-xs text-[var(--gray-11)]">
                          <Link
                            href={href}
                            className="text-[var(--blue-11,var(--blue-11))] hover:underline"
                          >
                            {row.label}
                          </Link>
                        </td>
                        {/* Staleness */}
                        <td className="px-3 py-1 font-mono text-xs text-[var(--gray-11)]">
                          {row.type === "hash_churn"
                            ? "—"
                            : formatStaleness(row.staleness_days)}
                        </td>
                        {/* Contribution */}
                        <td className="px-3 py-1 font-mono text-xs text-[var(--gray-11)]">
                          {row.score_contribution.toFixed(1)} pts
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          )}
        </>
      )}
    </div>
  );
}
