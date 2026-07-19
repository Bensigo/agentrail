"use client";

import { useState, useEffect } from "react";
import { buildWaterfall } from "../../../../../../../lib/phase-waterfall";
import type { WaterfallPhase } from "../../../../../../../lib/phase-waterfall";
import type { TimelineEvent } from "./run-timeline";
import { SectionSkeleton, SectionEmpty } from "./section-states";

interface CostRow {
  phase: string;
  tokens: number;
  cost_usd: number;
}

interface CostsResponse {
  rows: CostRow[];
}

interface WaterfallSectionProps {
  workspaceId: string;
  runId: string;
  events: TimelineEvent[];
  runStatus?: string;
}

function fmtMs(ms: number): string {
  if (ms < 1000) return `${ms}ms`;
  if (ms < 60_000) return `${(ms / 1000).toFixed(1)}s`;
  const m = Math.floor(ms / 60_000);
  const s = Math.round((ms % 60_000) / 1000);
  return s > 0 ? `${m}m ${s}s` : `${m}m`;
}

function fmtTokens(n: number): string {
  if (n === 0) return "—";
  return n.toLocaleString("en-US");
}

function fmtUsd(n: number): string {
  if (n === 0) return "—";
  return `$${n.toFixed(4)}`;
}

function BottleneckBadge({ label }: { label: string }) {
  // text-xs (not the ad-hoc 10px): matches the canonical Status Badge scale
  // (rounded-sm px-1.5 py-0.5 text-xs font-medium) this badge otherwise
  // already follows.
  return (
    <span
      className="inline-flex items-center rounded-sm px-1.5 py-0.5 text-xs font-medium"
      style={{
        background: "rgba(255,230,41,0.15)",
        color: "var(--yellow-09)",
        border: "1px solid rgba(255,230,41,0.3)",
      }}
    >
      {label}
    </span>
  );
}

function PhaseBar({ phase }: { phase: WaterfallPhase }) {
  const pct = Math.max(phase.share * 100, 0.3); // at least 0.3% for visibility

  return (
    <div className="space-y-1">
      {/* Phase name row */}
      <div className="flex items-center justify-between gap-2">
        <div className="flex items-center gap-1.5 min-w-0">
          <span className="font-mono text-xs text-[var(--gray-11)] truncate">
            {phase.name}
          </span>
          {phase.isSlowest && phase.isMostExpensive && (
            <BottleneckBadge label="slowest · costliest" />
          )}
          {phase.isSlowest && !phase.isMostExpensive && (
            <BottleneckBadge label="slowest" />
          )}
          {phase.isMostExpensive && !phase.isSlowest && (
            <BottleneckBadge label="costliest" />
          )}
        </div>
        <div className="flex items-center gap-3 shrink-0 text-xs font-mono text-[var(--gray-09)]">
          <span title="Duration">{fmtMs(phase.durationMs)}</span>
          <span title="Tokens">{fmtTokens(phase.tokens)}</span>
          <span title="Cost">{fmtUsd(phase.costUsd)}</span>
        </div>
      </div>

      {/* Bar track */}
      <div
        className="h-2 w-full overflow-hidden rounded-sm"
        style={{ background: "var(--gray-04)" }}
      >
        {/* transform: scaleX, not width — animating width causes layout
            thrash (MO-2: only transform/opacity/color/shadow may animate).
            scaleX + transition-transform gives the same growing-bar effect
            on a compositor-only property; the 0.3%-share floor above still
            keeps very small bars visible. */}
        <div
          className="h-full w-full origin-left rounded-sm transition-transform duration-150 ease-out"
          style={{
            transform: `scaleX(${pct / 100})`,
            background:
              phase.isSlowest || phase.isMostExpensive
                ? "var(--yellow-09)"
                : "var(--gray-08)",
          }}
        />
      </div>
    </div>
  );
}

export function WaterfallSection({
  workspaceId,
  runId,
  events,
  runStatus,
}: WaterfallSectionProps) {
  const [costRows, setCostRows] = useState<CostRow[]>([]);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    async function load() {
      setLoading(true);
      try {
        const res = await fetch(
          `/api/v1/workspaces/${workspaceId}/runs/${runId}/costs`
        );
        if (res.ok) {
          const json = (await res.json()) as CostsResponse;
          setCostRows(json.rows ?? []);
        }
      } catch {
        // non-fatal — waterfall shows without cost data
      } finally {
        setLoading(false);
      }
    }
    load();
  }, [workspaceId, runId]);

  if (loading) {
    return <SectionSkeleton lines={3} />;
  }

  // Derive phases from events + cost rows.
  const phases = buildWaterfall(
    events.map((e) => ({
      event_type: e.event_type,
      phase: e.phase,
      occurred_at: e.occurred_at,
    })),
    costRows
  );

  // Empty state: fewer than 2 phases with data.
  if (phases.length < 2) {
    return (
      <SectionEmpty
        runStatus={runStatus}
        waitingText="Run in progress — the waterfall appears once at least two phases complete."
        emptyText="Not enough phase data to show a waterfall."
      />
    );
  }

  return (
    <div
      className="rounded border border-[var(--gray-05)] bg-[var(--gray-02)] p-4 space-y-3"
    >
      {/* Column headers — functionally the Data Table header pattern
          (text-xs uppercase gray-09 font-medium) even though this is a bar
          chart rather than a <table>; text-xs also matches the data row
          scale directly below instead of running smaller than it. */}
      <div className="flex items-center justify-between text-xs uppercase tracking-wide text-[var(--gray-09)] font-medium">
        <span>Phase</span>
        <div className="flex items-center gap-3">
          <span>Duration</span>
          <span>Tokens</span>
          <span>Cost</span>
        </div>
      </div>

      {/* Phase bars */}
      <div className="space-y-3">
        {phases.map((phase) => (
          <PhaseBar key={phase.name} phase={phase} />
        ))}
      </div>
    </div>
  );
}
