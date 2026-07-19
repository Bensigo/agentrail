"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import Link from "next/link";
import { ArrowUpRight, ChevronLeft, ChevronRight, MessageCircle } from "lucide-react";
import { Skeleton } from "../../../../components/loading-skeleton";
import { EmptyState } from "../../../components/empty-state";
import { messageJaceTarget } from "../../../setup/components/channel-step-helpers";
import {
  formatCostUsd,
  formatNeedsYouBreakdown,
  formatTrendPct,
  formatWeekRangeLabel,
  inProgressStateLabel,
  isAtOrPastCurrentWeek,
  shiftWeek,
  type DigestData,
} from "./digest-panel-helpers";

interface DigestPanelProps {
  workspaceId: string;
}

/** Shared card shell for the four digest blocks (TASTE.md: Cards/Panels). */
function DigestCard({
  title,
  action,
  children,
}: {
  title: string;
  action?: React.ReactNode;
  children: React.ReactNode;
}) {
  return (
    <section className="flex flex-col gap-3 rounded border border-[var(--gray-05)] bg-[var(--gray-02)] p-4">
      <div className="flex items-center justify-between gap-2">
        {/* font-normal, not the guide's Data Table header exception: a bare
            card-title label — matches StatHeader's clean text-xs/uppercase/
            gray-09 "label" idiom (no weight override), not a true heading. */}
        <h2 className="text-xs font-normal uppercase tracking-wide text-[var(--gray-09)]">
          {title}
        </h2>
        {action}
      </div>
      {children}
    </section>
  );
}

function ShippedBlock({ items }: { items: DigestData["shipped"] }) {
  if (items.length === 0) {
    return (
      <EmptyState message="Nothing shipped yet this week." />
    );
  }
  return (
    <ul className="flex flex-col gap-1">
      {items.map((item) => (
        <li
          key={item.id}
          className="flex items-center justify-between gap-3 border-b border-[var(--gray-04)] py-1.5 last:border-b-0"
        >
          <span className="truncate text-sm text-[var(--gray-12)]">{item.title}</span>
          {item.prUrl ? (
            <a
              href={item.prUrl}
              target="_blank"
              rel="noopener noreferrer"
              className="flex shrink-0 items-center gap-0.5 text-xs text-[var(--blue-11)] hover:underline"
            >
              PR <ArrowUpRight className="h-3 w-3" />
            </a>
          ) : (
            <span className="shrink-0 text-xs text-[var(--gray-08)]">No PR</span>
          )}
        </li>
      ))}
    </ul>
  );
}

function InProgressBlock({ items }: { items: DigestData["inProgress"] }) {
  if (items.length === 0) {
    return <EmptyState message="Nothing in progress right now." />;
  }
  return (
    <ul className="flex flex-col gap-1">
      {items.map((item) => (
        <li
          key={item.id}
          className="flex items-center justify-between gap-3 border-b border-[var(--gray-04)] py-1.5 last:border-b-0"
        >
          <span className="truncate text-sm text-[var(--gray-12)]">{item.title}</span>
          <span
            className={`shrink-0 rounded-sm px-1.5 py-0.5 text-xs font-medium ${
              item.state === "running"
                ? "bg-[var(--orange-09)]/20 text-[var(--orange-11)]"
                : "bg-[var(--gray-04)] text-[var(--gray-10)]"
            }`}
          >
            {inProgressStateLabel(item.state)}
          </span>
        </li>
      ))}
    </ul>
  );
}

function NeedsYouBlock({
  needsYou,
  workspaceId,
}: {
  needsYou: DigestData["needsYou"];
  workspaceId: string;
}) {
  if (needsYou.count === 0) {
    return <EmptyState message="Nothing needs you this week." />;
  }
  return (
    <Link
      href={`/dashboard/${workspaceId}/queue`}
      className="flex flex-col gap-1 rounded transition-colors hover:opacity-90"
    >
      <span className="font-mono text-3xl font-bold text-[var(--red-11)]">
        {needsYou.count}
      </span>
      <span className="text-xs text-[var(--gray-09)]">
        {formatNeedsYouBreakdown(needsYou.breakdown)}
      </span>
      <span className="mt-1 flex items-center gap-0.5 text-xs text-[var(--blue-11)]">
        Review in Queue <ArrowUpRight className="h-3 w-3" />
      </span>
    </Link>
  );
}

function CostBlock({ cost }: { cost: DigestData["cost"] }) {
  if (cost.thisWeekUsd === null) {
    return <EmptyState message="Cost data unavailable right now." />;
  }
  return (
    <div className="flex flex-col gap-1">
      <span className="font-mono text-3xl font-bold text-[var(--gray-12)]">
        {formatCostUsd(cost.thisWeekUsd)}
      </span>
      <span className="text-xs text-[var(--gray-09)]">
        {formatTrendPct(cost.trendPct)}
      </span>
    </div>
  );
}

/**
 * "Give Jace a task" (#1281 AC2 — Home dead-end copy dies): one persistent
 * affordance in the digest area, always visible (not gated on the digest
 * having anything to show), pointing the same way as Work's empty-state
 * "Message Jace" action (`messageJaceTarget`, shared helper).
 */
function GiveJaceATaskCard({ workspaceId }: { workspaceId: string }) {
  const target = messageJaceTarget(
    process.env.NEXT_PUBLIC_TELEGRAM_BOT_USERNAME,
    workspaceId
  );
  return (
    <section className="flex items-center justify-between gap-3 rounded border border-[var(--gray-05)] bg-[var(--gray-02)] px-4 py-3">
      <div className="flex items-center gap-2.5">
        <MessageCircle className="h-4 w-4 shrink-0 text-[var(--gray-09)]" />
        <div className="flex flex-col gap-0.5">
          {/* font-bold: this titles the card (heading role), matching the
              text-sm + gray-12 recipe used for real headings elsewhere
              (PageHeader's h1, work/page.tsx's h1). */}
          <span className="text-sm font-bold text-[var(--gray-12)]">
            Give Jace a task
          </span>
          <span className="text-xs text-[var(--gray-09)]">
            {target.external
              ? "Message Jace on Telegram — describe what you need done."
              : "Connect a channel to message Jace directly."}
          </span>
        </div>
      </div>
      {/* font-bold: primary CTA (colored fill), the emphasis case — matches
          Approve/Create-workspace-style filled buttons across the scope. */}
      <a
        href={target.href}
        target={target.external ? "_blank" : undefined}
        rel={target.external ? "noreferrer" : undefined}
        className="inline-flex h-8 shrink-0 items-center rounded bg-[var(--brand-accent)] px-3 text-xs font-bold text-black transition-colors hover:opacity-90"
      >
        Message Jace
      </a>
    </section>
  );
}

export function DigestPanel({ workspaceId }: DigestPanelProps) {
  const [weekParam, setWeekParam] = useState<string | null>(null);
  const [data, setData] = useState<DigestData | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const search = weekParam ? `?week=${weekParam}` : "";
      const res = await fetch(`/api/v1/workspaces/${workspaceId}/digest${search}`);
      if (!res.ok) {
        const body = await res.json().catch(() => ({}));
        throw new Error((body as { error?: string }).error ?? `HTTP ${res.status}`);
      }
      const json = (await res.json()) as DigestData;
      setData(json);
    } catch (e) {
      setData(null);
      setError(e instanceof Error ? e.message : "Failed to load this week's digest");
    } finally {
      setLoading(false);
    }
  }, [workspaceId, weekParam]);

  useEffect(() => {
    load();
  }, [load]);

  const atCurrentWeek = useMemo(
    () => (data ? isAtOrPastCurrentWeek(data.week, new Date()) : true),
    [data]
  );

  return (
    <section className="flex flex-col gap-3">
      <GiveJaceATaskCard workspaceId={workspaceId} />

      <div className="flex items-center justify-between gap-4">
        {/* font-normal: same card-title label idiom as DigestCard above. */}
        <h2 className="text-xs font-normal uppercase tracking-wide text-[var(--gray-09)]">
          This week from Jace
        </h2>
        <div className="flex items-center gap-2">
          <span className="font-mono text-xs text-[var(--gray-09)]">
            {data ? formatWeekRangeLabel(data.week) : ""}
          </span>
          <div className="flex items-center gap-1">
            <button
              type="button"
              aria-label="Previous week"
              onClick={() =>
                setWeekParam(shiftWeek(data?.week.start ?? new Date().toISOString(), -1))
              }
              disabled={loading}
              className="rounded border border-[var(--gray-05)] p-1 text-[var(--gray-10)] transition-colors hover:bg-[var(--gray-03)] disabled:opacity-40"
            >
              <ChevronLeft className="h-3.5 w-3.5" />
            </button>
            <button
              type="button"
              onClick={() => setWeekParam(null)}
              disabled={loading || (weekParam === null && atCurrentWeek)}
              className="rounded border border-[var(--gray-05)] px-2 py-1 text-xs text-[var(--gray-10)] transition-colors hover:bg-[var(--gray-03)] disabled:opacity-40"
            >
              This week
            </button>
            <button
              type="button"
              aria-label="Next week"
              onClick={() =>
                data && setWeekParam(shiftWeek(data.week.start, 1))
              }
              disabled={loading || atCurrentWeek}
              className="rounded border border-[var(--gray-05)] p-1 text-[var(--gray-10)] transition-colors hover:bg-[var(--gray-03)] disabled:opacity-40"
            >
              <ChevronRight className="h-3.5 w-3.5" />
            </button>
          </div>
        </div>
      </div>

      {loading && !data && (
        <div className="grid gap-4 sm:grid-cols-2">
          {Array.from({ length: 4 }).map((_, i) => (
            <div
              key={i}
              className="rounded border border-[var(--gray-05)] bg-[var(--gray-02)] p-4"
            >
              <Skeleton className="h-3 w-24" />
              <Skeleton className="mt-3 h-7 w-20" />
            </div>
          ))}
        </div>
      )}

      {error && (
        <div className="rounded border border-[var(--gray-05)] bg-[var(--gray-02)] px-4 py-3">
          <p className="font-mono text-xs text-[var(--red-11)]">{error}</p>
        </div>
      )}

      {data && (
        <div className="grid gap-4 sm:grid-cols-2">
          <DigestCard title="Shipped">
            <ShippedBlock items={data.shipped} />
          </DigestCard>
          <DigestCard title="In progress">
            <InProgressBlock items={data.inProgress} />
          </DigestCard>
          <DigestCard title="Needs you">
            <NeedsYouBlock needsYou={data.needsYou} workspaceId={workspaceId} />
          </DigestCard>
          <DigestCard title="Cost this week">
            <CostBlock cost={data.cost} />
          </DigestCard>
        </div>
      )}
    </section>
  );
}
