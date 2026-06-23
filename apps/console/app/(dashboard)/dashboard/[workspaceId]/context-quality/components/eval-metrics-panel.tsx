"use client";

import { useState, useEffect, useCallback } from "react";
import { AlertTriangle, CheckCircle, Info } from "lucide-react";
import { Skeleton } from "../../../../../components/loading-skeleton";

// The falsifiable eval numbers (issue #942), surfaced from the latest eval run's
// per-arm metrics in Postgres. These REPLACE the always-zero context-quality
// percentages as the page's real, can-come-back-unfavorable signal:
//   - solve-rate (hidden-test verdict, the only unfakeable signal),
//   - dollars-per-solved-task (the headline cost metric),
//   - Objective Gate false-green rate (gate said done, hidden tests disagreed).
// None-vs-0.0 is preserved: a null rate renders "n/a" (undefined denominator),
// NOT "0%" — a never-solved or never-gate-passed arm must not masquerade as clean.

type EvalArm = {
  arm: string;
  repetitions: number;
  solved_count: number;
  failed_count: number;
  solve_rate: number;
  spread: number;
  total_tokens: number;
  total_cost_usd: number;
  dollars_per_solved: number | null;
  gate_passed_count: number;
  false_green_count: number;
  false_green_rate: number | null;
};

type EvalMetricsResult = {
  run: { run_id: string; created_at: string } | null;
  arms: EvalArm[];
};

const C = {
  good: "#1fd8a4",
  warn: "#f5e147",
  bad: "#ff9592",
  neutral: "#8b949e",
} as const;

function fmtPct(v: number): string {
  return `${(v * 100).toFixed(1)}%`;
}

/** Rate formatter that preserves null (undefined denominator) as "n/a", not 0%. */
function fmtRate(v: number | null): string {
  return v === null ? "n/a" : fmtPct(v);
}

function fmtUsd(v: number | null): string {
  return v === null ? "n/a" : `$${v.toFixed(4)}`;
}

function fmtDate(iso: string): string {
  // Show the date and time the eval run was recorded.
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? iso : d.toISOString().replace("T", " ").slice(0, 16);
}

/** Color a false-green rate: any lie is bad, exactly-0 is good, undefined is neutral. */
function falseGreenColor(v: number | null): string {
  if (v === null) return C.neutral;
  if (v > 0) return C.bad;
  return C.good;
}

function ArmRow({ a }: { a: EvalArm }) {
  return (
    <tr className="border-t border-[var(--gray-04)]">
      <td className="py-1.5 pr-3 font-medium text-[var(--gray-12)]">{a.arm}</td>
      <td className="py-1.5 pr-3 text-right font-mono text-[var(--gray-11)]">
        {fmtPct(a.solve_rate)}
      </td>
      <td className="py-1.5 pr-3 text-right font-mono text-[var(--gray-09)]">
        {a.solved_count}/{a.repetitions}
      </td>
      <td className="py-1.5 pr-3 text-right font-mono text-[var(--gray-11)]">
        {fmtUsd(a.dollars_per_solved)}
      </td>
      <td className="py-1.5 pr-3 text-right font-mono">
        <span style={{ color: falseGreenColor(a.false_green_rate) }}>
          {fmtRate(a.false_green_rate)}
        </span>
        {a.false_green_rate !== null && (
          <span className="ml-1 text-[10px] text-[var(--gray-08)]">
            ({a.false_green_count}/{a.gate_passed_count})
          </span>
        )}
      </td>
      <td className="py-1.5 text-right font-mono text-[var(--gray-09)]">
        {fmtUsd(a.total_cost_usd)}
      </td>
    </tr>
  );
}

export function EvalMetricsPanel({ workspaceId }: { workspaceId: string }) {
  const [result, setResult] = useState<EvalMetricsResult | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const fetchMetrics = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const res = await fetch(
        `/api/v1/workspaces/${workspaceId}/eval-metrics`
      );
      if (!res.ok) {
        const body = await res.json().catch(() => ({}));
        throw new Error((body as { error?: string }).error ?? `HTTP ${res.status}`);
      }
      setResult((await res.json()) as EvalMetricsResult);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Failed to load eval metrics");
    } finally {
      setLoading(false);
    }
  }, [workspaceId]);

  useEffect(() => {
    fetchMetrics();
  }, [fetchMetrics]);

  // Headline arm: prefer "full" (the configured harness), else the first arm.
  const headline =
    result?.arms.find((a) => a.arm === "full") ?? result?.arms[0] ?? null;
  // Across all arms in the run: is any gate-passed run a false-green? That's the
  // operational risk this surface exists to expose.
  const anyFalseGreen =
    !!result &&
    result.arms.some((a) => (a.false_green_rate ?? 0) > 0);

  return (
    <div className="rounded border border-[var(--gray-05)] bg-[var(--gray-02)]">
      <div className="flex items-center justify-between border-b border-[var(--gray-04)] px-3 py-2">
        <div className="flex items-center gap-1.5">
          <span className="text-xs font-semibold text-[var(--gray-12)]">
            Eval results
          </span>
          <span
            title="Solve-rate, dollars-per-solved-task, and Objective Gate false-green rate from the latest offline eval run. These are the falsifiable numbers that replace the always-zero context-quality percentages."
            className="cursor-help"
          >
            <Info className="h-3 w-3 text-[var(--gray-08)]" />
          </span>
        </div>
        {result?.run && (
          <span className="font-mono text-[11px] text-[var(--gray-09)]">
            {result.run.run_id} · {fmtDate(result.run.created_at)}
          </span>
        )}
      </div>

      <div className="p-3">
        {/* Error state */}
        {error && (
          <div className="flex items-center gap-2 py-2 text-xs text-[#ff9592]">
            <AlertTriangle className="h-3.5 w-3.5" />
            <span>{error}</span>
          </div>
        )}

        {/* Loading state */}
        {loading && !error && (
          <div className="grid grid-cols-3 gap-3 max-md:grid-cols-1">
            {[0, 1, 2].map((i) => (
              <div key={i}>
                <Skeleton className="mb-2 h-3 w-28" />
                <Skeleton className="h-7 w-20" />
              </div>
            ))}
          </div>
        )}

        {/* Empty state — no eval run ingested yet */}
        {!loading && !error && result && result.run === null && (
          <div className="py-6 text-center">
            <p className="text-sm text-[var(--gray-11)]">No eval run recorded yet.</p>
            <p className="mt-1 text-xs text-[var(--gray-09)]">
              Run the eval harness; its reporter writes per-arm solve-rate,
              dollars-per-solved-task, and false-green rate here.
            </p>
          </div>
        )}

        {/* Populated state */}
        {!loading && !error && result && result.run !== null && headline && (
          <>
            {/* Headline KPI tiles for the primary arm */}
            <div className="mb-4 grid grid-cols-3 gap-3 max-md:grid-cols-1">
              <div
                className="rounded border border-[var(--gray-05)] bg-[var(--gray-01)] p-3"
                style={{ borderLeft: `3px solid ${C.good}` }}
              >
                <div className="text-[11px] text-[var(--gray-09)]">
                  Solve-rate ({headline.arm})
                </div>
                <div className="mt-0.5 text-2xl font-bold tracking-tight text-[var(--gray-12)]">
                  {fmtPct(headline.solve_rate)}
                </div>
                <div className="mt-0.5 font-mono text-[10px] text-[var(--gray-09)]">
                  {headline.solved_count}/{headline.repetitions} reps · spread{" "}
                  {headline.spread.toFixed(3)}
                </div>
              </div>

              <div
                className="rounded border border-[var(--gray-05)] bg-[var(--gray-01)] p-3"
                style={{ borderLeft: `3px solid ${C.warn}` }}
              >
                <div className="text-[11px] text-[var(--gray-09)]">
                  Dollars-per-solved-task
                </div>
                <div className="mt-0.5 text-2xl font-bold tracking-tight text-[var(--gray-12)]">
                  {fmtUsd(headline.dollars_per_solved)}
                </div>
                <div className="mt-0.5 font-mono text-[10px] text-[var(--gray-09)]">
                  total {fmtUsd(headline.total_cost_usd)}
                </div>
              </div>

              <div
                className="rounded border border-[var(--gray-05)] bg-[var(--gray-01)] p-3"
                style={{
                  borderLeft: `3px solid ${falseGreenColor(headline.false_green_rate)}`,
                }}
              >
                <div className="flex items-center gap-1 text-[11px] text-[var(--gray-09)]">
                  False-green rate
                  {headline.false_green_rate === null ? null : headline.false_green_rate >
                    0 ? (
                    <AlertTriangle className="h-3 w-3 text-[#ff9592]" />
                  ) : (
                    <CheckCircle className="h-3 w-3 text-[#1fd8a4]" />
                  )}
                </div>
                <div
                  className="mt-0.5 text-2xl font-bold tracking-tight"
                  style={{ color: falseGreenColor(headline.false_green_rate) }}
                >
                  {fmtRate(headline.false_green_rate)}
                </div>
                <div className="mt-0.5 font-mono text-[10px] text-[var(--gray-09)]">
                  {headline.false_green_rate === null
                    ? "no gate-passed run (undefined)"
                    : `${headline.false_green_count}/${headline.gate_passed_count} gate-passed lied`}
                </div>
              </div>
            </div>

            {anyFalseGreen && (
              <div className="mb-3 flex items-start gap-2 rounded border border-[rgba(255,149,146,0.3)] bg-[rgba(59,15,16,0.5)] px-3 py-2 text-[11px] text-[#ff9592]">
                <AlertTriangle className="mt-0.5 h-3.5 w-3.5 shrink-0" />
                <span>
                  At least one arm has gate-passed runs that failed the hidden
                  tests — the Objective Gate is reporting false greens.
                </span>
              </div>
            )}

            {/* Per-arm table — full drilldown across every arm in the run */}
            <table className="w-full text-xs">
              <thead>
                <tr className="text-left text-[10px] uppercase tracking-wide text-[var(--gray-08)]">
                  <th className="pb-1 pr-3 font-medium">Arm</th>
                  <th className="pb-1 pr-3 text-right font-medium">Solve-rate</th>
                  <th className="pb-1 pr-3 text-right font-medium">Solved</th>
                  <th className="pb-1 pr-3 text-right font-medium">$/solved</th>
                  <th className="pb-1 pr-3 text-right font-medium">False-green</th>
                  <th className="pb-1 text-right font-medium">Total cost</th>
                </tr>
              </thead>
              <tbody>
                {result.arms.map((a) => (
                  <ArmRow key={a.arm} a={a} />
                ))}
              </tbody>
            </table>
          </>
        )}
      </div>
    </div>
  );
}
