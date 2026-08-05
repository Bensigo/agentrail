"use client";

import { useEffect, useMemo, useState } from "react";
import { Skeleton } from "../../../../components/loading-skeleton";
import {
  formatHumanFalseGreenRange,
  formatHumanFalseGreenRate,
  humanFalseGreenWindow,
  unknownHumanFalseGreenCount,
  type ProductionHumanFalseGreenData,
} from "./human-false-green-panel-helpers";

export function HumanFalseGreenPanel({ workspaceId }: { workspaceId: string }) {
  const [data, setData] = useState<ProductionHumanFalseGreenData | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  // Keep this view's date bounds stable across state changes. Otherwise a
  // rerender would make a different evidence request and hide that fact.
  const window = useMemo(() => humanFalseGreenWindow(), []);

  useEffect(() => {
    let active = true;
    const search = new URLSearchParams(window);
    fetch(`/api/v1/workspaces/${workspaceId}/review-metrics/human-false-green?${search}`)
      .then(async (response) => {
        if (!response.ok) {
          const body = (await response.json().catch(() => ({}))) as { error?: string };
          throw new Error(body.error ?? `HTTP ${response.status}`);
        }
        return response.json() as Promise<ProductionHumanFalseGreenData>;
      })
      .then((value) => {
        if (active) setData(value);
      })
      .catch((reason: unknown) => {
        if (active) {
          setError(
            reason instanceof Error ? reason.message : "Failed to load human false-green evidence"
          );
        }
      })
      .finally(() => {
        if (active) setLoading(false);
      });
    return () => {
      active = false;
    };
  }, [workspaceId, window]);

  return (
    <section className="flex flex-col gap-3">
      <div>
        <h2 className="text-xs font-normal uppercase tracking-wide text-[var(--gray-09)]">
          Production human false-green
        </h2>
        <p className="mt-1 text-xs text-[var(--gray-09)]">
          Explicit human outcomes · {formatHumanFalseGreenRange(window)}
        </p>
      </div>
      <div className="rounded border border-[var(--gray-05)] bg-[var(--gray-02)] px-4 py-3">
        {loading && <Skeleton className="h-28 w-full" />}
        {!loading && error && (
          <p className="font-mono text-xs text-[var(--red-11)]">
            Could not load production human false-green evidence: {error}
          </p>
        )}
        {!loading && !error && data && <HumanFalseGreenEvidence data={data} />}
      </div>
    </section>
  );
}

export function HumanFalseGreenEvidence({ data }: { data: ProductionHumanFalseGreenData }) {
  const unknown = unknownHumanFalseGreenCount(data.unknown);
  return (
    <div className="flex flex-col gap-3">
      <div className="grid grid-cols-1 gap-3 sm:grid-cols-3">
        <EvidenceMetric label="False-green rate" value={formatHumanFalseGreenRate(data.falseGreenRate)} />
        <EvidenceMetric label="Known denominator" value={`${data.knownSampleSize} / ${data.successfulRuns}`} />
        <EvidenceMetric label="False-green outcomes" value={`${data.falseGreenCount}`} />
      </div>
      <p className="text-xs text-[var(--gray-09)]">
        Unknown or excluded: {unknown} · missing repository/PR {data.unknown.missingPrIdentity}; missing produced head {data.unknown.missingPublishedHead}; no matching explicit human outcome {data.unknown.noMatchingHumanOutcome}.
      </p>
      <p className="text-xs text-[var(--gray-09)]">
        Offline hidden-test false-green is a separate evaluation and is not combined with this production human metric.
      </p>
      {data.limitations.length > 0 && (
        <p className="text-xs text-[var(--gray-09)]">
          Limits: {data.limitations.join(" ")}
        </p>
      )}
    </div>
  );
}

function EvidenceMetric({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex flex-col gap-1 border-l-2 border-[var(--gray-06)] pl-3">
      <span className="text-xs font-normal uppercase tracking-wide text-[var(--gray-09)]">
        {label}
      </span>
      <span className="font-mono text-2xl font-bold leading-none text-[var(--gray-12)]">
        {value}
      </span>
    </div>
  );
}
