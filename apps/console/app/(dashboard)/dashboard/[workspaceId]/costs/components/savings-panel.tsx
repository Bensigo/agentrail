"use client";

import { useEffect, useState } from "react";
import { Skeleton } from "../../../../../components/loading-skeleton";
import type { TimeRange } from "./cost-filters";
import {
  EMPTY_STATE_COPY,
  buildSavingsUrl,
  formatEstimateMarker,
  formatSavingsUsd,
  resolveSavingsState,
  type SavingsData,
} from "./savings-panel-helpers";

interface SavingsPanelProps {
  workspaceId: string;
  timeRange: TimeRange;
}

export function SavingsPanel({ workspaceId, timeRange }: SavingsPanelProps) {
  const [savings, setSavings] = useState<SavingsData | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let active = true;

    async function load() {
      setLoading(true);
      setError(null);
      try {
        const res = await fetch(
          buildSavingsUrl({
            workspaceId,
            timeRange,
            origin: window.location.origin,
          })
        );
        if (!res.ok) {
          const body = await res.json().catch(() => ({}));
          throw new Error(
            (body as { error?: string }).error ?? `HTTP ${res.status}`
          );
        }
        const json = (await res.json()) as { savings: SavingsData };
        if (active) setSavings(json.savings);
      } catch (e) {
        if (active) {
          setSavings(null);
          setError(
            e instanceof Error ? e.message : "Failed to load savings data"
          );
        }
      } finally {
        if (active) setLoading(false);
      }
    }

    load();
    return () => {
      active = false;
    };
  }, [workspaceId, timeRange]);

  const state = resolveSavingsState({ loading, error, savings });

  return (
    <section className="flex flex-col gap-3">
      <div className="flex items-center justify-between">
        <h2 className="text-xs font-medium uppercase tracking-wide text-[var(--gray-09)]">
          Context-pack savings
        </h2>
      </div>

      <div className="rounded border border-[var(--gray-05)] bg-[var(--gray-02)] px-4 py-3">
        {state === "loading" && (
          <div className="flex flex-col gap-2">
            <Skeleton className="h-4 w-28" />
            <Skeleton className="h-3 w-48" />
          </div>
        )}

        {state === "error" && (
          <p className="font-mono text-xs text-[#ff9592]">{error}</p>
        )}

        {state === "empty" && (
          <p className="font-mono text-xs text-[var(--gray-09)]">
            {EMPTY_STATE_COPY}
          </p>
        )}

        {state === "data" && savings && (
          <div className="flex flex-wrap items-center gap-3">
            <span
              className="font-mono text-xs font-medium text-[#ffe629]"
              title={formatEstimateMarker(savings.model, savings.ratePerMtok)}
            >
              {formatSavingsUsd(savings.dollarsSaved, savings.estimateFlag)}
            </span>
            <span
              className="font-mono text-xs text-[var(--gray-09)]"
              title="Estimated using model pricing for cached tokens"
            >
              est. · {formatEstimateMarker(savings.model, savings.ratePerMtok)}
            </span>
          </div>
        )}
      </div>
    </section>
  );
}
