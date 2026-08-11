"use client";

import { useEffect, useMemo, useState } from "react";
import { Skeleton } from "../../../../components/loading-skeleton";
import {
  acceptanceOutcomeMetricsUrl,
  acceptanceOutcomeMetricsWindow,
  formatAcceptanceOutcomeDateRange,
  type AcceptanceOutcomeMetricsData,
} from "./acceptance-outcome-metrics-panel-helpers";

type OutcomeCount = { label: string; value: number; emphasis?: boolean };

export function AcceptanceOutcomeMetricsPanel({ workspaceId }: { workspaceId: string }) {
  const [data, setData] = useState<AcceptanceOutcomeMetricsData | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  // The cutoff is intentionally fixed for a mounted view. A refetch must not
  // silently move the cohort boundary and make an old decision look current.
  const window = useMemo(() => acceptanceOutcomeMetricsWindow(), []);

  useEffect(() => {
    let active = true;
    fetch(acceptanceOutcomeMetricsUrl(workspaceId, window), { cache: "no-store" })
      .then(async (response) => {
        if (!response.ok) {
          const body = (await response.json().catch(() => ({}))) as { error?: string };
          throw new Error(body.error ?? `HTTP ${response.status}`);
        }
        return response.json() as Promise<AcceptanceOutcomeMetricsData>;
      })
      .then((value) => {
        if (active) setData(value);
      })
      .catch((reason: unknown) => {
        if (active) {
          setError(reason instanceof Error ? reason.message : "Failed to load Acceptance outcomes");
        }
      })
      .finally(() => {
        if (active) setLoading(false);
      });
    return () => {
      active = false;
    };
  }, [workspaceId, window]);

  const cohort = data?.cohort ?? window;
  return (
    <section className="flex flex-col gap-3">
      <div>
        <h2 className="text-xs font-normal uppercase tracking-wide text-[var(--gray-09)]">
          Acceptance outcomes
        </h2>
        <p className="mt-1 text-xs text-[var(--gray-09)]">
          Canonical posted Acceptance reviews observed {formatAcceptanceOutcomeDateRange(cohort)}
        </p>
      </div>
      <div className="rounded border border-[var(--gray-05)] bg-[var(--gray-02)] px-4 py-3">
        {loading ? <Skeleton className="h-32 w-full" /> : null}
        {!loading && error ? (
          <p className="font-mono text-xs text-[var(--red-11)]">
            Could not load Acceptance outcomes: {error}
          </p>
        ) : null}
        {!loading && !error && data ? <AcceptanceOutcomeMetricsSummary data={data} /> : null}
      </div>
    </section>
  );
}

export function AcceptanceOutcomeMetricsSummary({ data }: { data: AcceptanceOutcomeMetricsData }) {
  const decisionCounts: OutcomeCount[] = [
    { label: "Eligible sample", value: data.counts.eligible, emphasis: true },
    { label: "Approved", value: data.counts.approved },
    { label: "Approved with exception", value: data.counts.approvedWithException },
    { label: "Changes requested", value: data.counts.changesRequested },
    { label: "Rejected", value: data.counts.rejected },
    { label: "Not recorded", value: data.counts.notRecorded },
    { label: "Unknown / excluded", value: data.counts.excludedUnknown },
  ];
  const lineageCounts: OutcomeCount[] = [
    { label: "Signed merged", value: data.counts.signedMerged },
    { label: "Deployment observed", value: data.counts.deploymentObserved },
    { label: "Incident observed", value: data.counts.incidentObserved },
    { label: "Reverted", value: data.counts.reverted },
  ];
  return (
    <div>
      <p className="text-xs font-medium text-[var(--gray-11)]">Human decision observations</p>
      <dl className="mt-2 grid grid-cols-2 gap-x-4 gap-y-3 sm:grid-cols-4 lg:grid-cols-7">
        {decisionCounts.map((count) => (
          <div key={count.label}>
            <dt className="text-xs text-[var(--gray-09)]">{count.label}</dt>
            <dd className={`font-mono text-sm ${count.emphasis ? "text-[var(--gray-12)]" : "text-[var(--gray-11)]"}`}>
              {count.value}
            </dd>
          </div>
        ))}
      </dl>
      <div className="mt-4 border-t border-[var(--gray-05)] pt-4">
        <p className="text-xs font-medium text-[var(--gray-11)]">Observed lineage</p>
        <dl className="mt-2 grid grid-cols-2 gap-x-4 gap-y-3 sm:grid-cols-4">
          {lineageCounts.map((count) => (
            <div key={count.label}>
              <dt className="text-xs text-[var(--gray-09)]">{count.label}</dt>
              <dd className="font-mono text-sm text-[var(--gray-11)]">{count.value}</dd>
            </div>
          ))}
        </dl>
      </div>
      <p className="mt-4 text-xs text-[var(--gray-09)]">
        Observed through {new Date(data.cohort.observedUntil).toLocaleString("en-US", { timeZone: "UTC" })} UTC.
        {' '}A zero is a recorded count. “Not recorded” means no valid human decision was observed by this cutoff for an eligible review; “Unknown / excluded” is kept separate and is not treated as zero. Observed lineage is factual merge, deployment, incident, and revert custody, not a human decision.
      </p>
    </div>
  );
}
