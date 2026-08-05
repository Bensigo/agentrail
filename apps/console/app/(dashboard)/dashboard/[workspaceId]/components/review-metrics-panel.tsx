"use client";

import { useEffect, useMemo, useState } from "react";
import { Skeleton } from "../../../../components/loading-skeleton";
import {
  formatKnownSampleSize,
  reviewMetricsCohortUrl,
  formatReviewDateRange,
  formatReviewMetric,
  reviewMetricsWindow,
  type ReviewMetricsCohort,
  type ReviewMetricsData,
} from "./review-metrics-panel-helpers";

export function ReviewMetricsPanel({ workspaceId }: { workspaceId: string }) {
  const [data, setData] = useState<ReviewMetricsData | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  // Keep the evidence window fixed for this mounted view. Recomputing it on
  // every state update would continuously change the request URL and refetch.
  const dateWindow = useMemo(() => reviewMetricsWindow(), []);

  useEffect(() => {
    let active = true;
    fetch(reviewMetricsCohortUrl(workspaceId, dateWindow))
      .then(async (response) => {
        if (!response.ok) {
          const body = (await response.json().catch(() => ({}))) as { error?: string };
          throw new Error(body.error ?? `HTTP ${response.status}`);
        }
        return response.json() as Promise<ReviewMetricsData>;
      })
      .then((value) => {
        if (active) setData(value);
      })
      .catch((reason: unknown) => {
        if (active) {
          setError(reason instanceof Error ? reason.message : "Failed to load review metrics");
        }
      })
      .finally(() => {
        if (active) setLoading(false);
      });
    return () => {
      active = false;
    };
  }, [workspaceId, dateWindow]);

  return (
    <section className="flex flex-col gap-3">
      <div>
        <h2 className="text-xs font-normal uppercase tracking-wide text-[var(--gray-09)]">Review outcomes</h2>
        <p className="mt-1 text-xs text-[var(--gray-09)]">
          Explicit evidence by task family · {formatReviewDateRange(dateWindow)}
        </p>
      </div>
      <div className="rounded border border-[var(--gray-05)] bg-[var(--gray-02)] px-4 py-3">
        {loading && <Skeleton className="h-28 w-full" />}
        {!loading && error && <p className="font-mono text-xs text-[var(--red-11)]">Could not load review outcomes: {error}</p>}
        {!loading && !error && data?.cohorts.length === 0 && <p className="text-sm text-[var(--gray-09)]">No review evidence was recorded in this window.</p>}
        {!loading && !error && data && data.cohorts.length > 0 && <div className="flex flex-col gap-4">
          {data.cohorts.map((cohort: ReviewMetricsCohort) => (
            <ReviewMetricsCohortRow key={cohort.taskFamily} cohort={cohort} />
          ))}
        </div>}
      </div>
    </section>
  );
}

export function ReviewMetricsCohortRow({ cohort }: { cohort: ReviewMetricsCohort }) {
  const metric = (label: string, value: { value: number | null; knownSampleSize: number }, kind: "minutes" | "seconds" | "cycles" | "percent" | "count") => <div><dt className="text-xs text-[var(--gray-09)]">{label}</dt><dd className="font-mono text-sm text-[var(--gray-12)]">{formatReviewMetric(value.value, kind)} <span className="text-xs text-[var(--gray-09)]">({formatKnownSampleSize(value)})</span></dd></div>;
  return <div className="border-b border-[var(--gray-04)] pb-3 last:border-0 last:pb-0">
    <div className="mb-2 flex items-baseline justify-between gap-3"><h3 className="text-sm font-medium text-[var(--gray-12)]">{cohort.taskFamily}</h3><span className="font-mono text-xs text-[var(--gray-09)]">{cohort.denominator.openedPullRequests} opened · {cohort.denominator.terminalPullRequests} terminal · merge n={cohort.denominator.mergeRate}</span></div>
    <dl className="grid grid-cols-2 gap-x-4 gap-y-3 sm:grid-cols-5">{metric("Human review", cohort.humanReviewMinutes, "minutes")}{metric("First review", cohort.medianTimeToFirstReviewSeconds, "seconds")}{metric("Review cycles", cohort.averageReviewCycles, "cycles")}{metric("Merge rate", cohort.mergeRate, "percent")}{metric("Rework / revert", cohort.postMergeReworkEvents, "count")}</dl>
    {(cohort.exclusions.length > 0 || cohort.limitations.length > 0) && <p className="mt-2 text-xs text-[var(--gray-09)]">Excluded or limited: {[...cohort.exclusions, ...cohort.limitations].join("; ")}</p>}
  </div>;
}
