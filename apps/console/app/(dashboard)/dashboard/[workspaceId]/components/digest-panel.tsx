"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import Link from "next/link";
import { ArrowUpRight, ChevronLeft, ChevronRight, MessageCircle } from "lucide-react";
import { Skeleton } from "../../../../components/loading-skeleton";
import { EmptyState } from "../../../components/empty-state";
import { messageJaceTarget } from "../../../setup/components/channel-step-helpers";
import { seatsLabel } from "../billing/billing-helpers";
import {
  capacityText,
  capacityUsedText,
  formatNeedsYouBreakdown,
  formatWeekRangeLabel,
  inProgressStateLabel,
  isAtOrPastCurrentWeek,
  seatsInUseText,
  shiftWeek,
  shippedStripText,
  type DigestData,
  type PlanCardData,
} from "./digest-panel-helpers";

interface DigestPanelProps {
  workspaceId: string;
  /**
   * Subscription slice 8 (2026-07-31 owner ruling — display swap goes
   * unconditional): server-computed, undefined = render the dollar-free
   * `PlanCardEmpty` card instead (degraded workspace / no billing account /
   * a swallowed read error — see `loadPlanCardData`'s own doc-comment for
   * the two cases that produce undefined; there is no cost card left to
   * fall back to). This client component never imports `loadPlanCardData`
   * itself — only the (type-erased) shape of the data page.tsx already
   * resolved server-side.
   */
  planCard?: PlanCardData;
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

/**
 * The digest's 4th grid slot whenever plan data is available — unconditional
 * since the 2026-07-31 owner ruling (the subscription-platform display swap
 * built in slice 6/7 behind `BILLING_SUBSCRIPTIONS_ENFORCED` no longer
 * needs the flag; the legacy cost card and `CostBlock` are deleted
 * entirely, not merely hidden): seats, capacity as tasks (never dollars —
 * Global Constraints), and renewal, plus an upgrade CTA cloned from
 * `NeedsYouBlock`'s Link+ArrowUpRight pattern above. Built from the same
 * `DigestCard` shell as every other digest block. When `planCard` is
 * `undefined` (degraded / no billing account / a swallowed read error —
 * see `loadPlanCardData`'s own doc-comment), `PlanCardEmpty` below renders
 * in this slot instead.
 *
 * 2026-08-02 owner ruling — no customer-facing trial: `data.hasPlan` is the
 * ONE thing this component branches on. `false` (an un-subscribed account,
 * internal `plan` enum value `"trial"`) renders the "No plan yet" state —
 * usage-only Seats/Capacity rows (`seatsInUseText`/`capacityUsedText`, never
 * `seatsLabel`/`capacityText`'s "X of Y" — that would claim an entitlement
 * to a plan this account doesn't have), the `data.renewalText` choose-a-plan
 * line, and a "Choose a plan" CTA at the SAME billing href. `true` is
 * byte-identical to the plan card that shipped in slice 6 — unchanged.
 *
 * Exported (despite being consumed only from `DigestPanel` below) so it can
 * be unit-tested by calling it directly and walking the returned element
 * tree — this repo's vitest environment has no DOM/render harness, and
 * `DigestPanel` itself can't be called that way (its own hooks need a real
 * React dispatcher), so a hook-free sub-component is the only piece of
 * this file strict-TDD pinned-string/CTA-href assertions can target.
 */
export function PlanCardBlock({
  data,
  workspaceId,
}: {
  data: PlanCardData;
  workspaceId: string;
}) {
  if (!data.hasPlan) {
    return (
      <DigestCard title="Plan">
        <div className="flex flex-col gap-1">
          <span className="font-mono text-3xl font-bold text-[var(--gray-12)]">
            {data.planLabel}
          </span>
          <span className="text-xs text-[var(--gray-09)]">
            {`Seats · ${seatsInUseText(data.seatsUsed)}`}
          </span>
          <span className="text-xs text-[var(--gray-09)]">
            {`Capacity · ${capacityUsedText(data.capacityUsed)}`}
          </span>
          <span className="text-xs text-[var(--gray-09)]">{data.renewalText}</span>
          <Link
            href={`/dashboard/${workspaceId}/billing`}
            className="mt-1 flex items-center gap-0.5 text-xs text-[var(--blue-11)]"
          >
            Choose a plan <ArrowUpRight className="h-3 w-3" />
          </Link>
        </div>
      </DigestCard>
    );
  }

  return (
    <DigestCard title="Plan">
      <div className="flex flex-col gap-1">
        <span className="font-mono text-3xl font-bold text-[var(--gray-12)]">
          {data.planLabel}
        </span>
        <span className="text-xs text-[var(--gray-09)]">
          {`Seats · ${seatsLabel(data.seatsUsed, data.seatLimit)}`}
        </span>
        <span className="text-xs text-[var(--gray-09)]">
          {`Capacity · ${capacityText(data.capacityUsed, data.capacityTotal)}`}
        </span>
        <span className="text-xs text-[var(--gray-09)]">{data.renewalText}</span>
        <Link
          href={`/dashboard/${workspaceId}/billing`}
          className="mt-1 flex items-center gap-0.5 text-xs text-[var(--blue-11)]"
        >
          Upgrade plan <ArrowUpRight className="h-3 w-3" />
        </Link>
      </div>
    </DigestCard>
  );
}

/**
 * Dollar-free empty state for the digest's 4th grid slot when `planCard` is
 * `undefined` (2026-07-31 owner ruling — the legacy cost card this slot
 * used to fall back to is deleted entirely, so a missing plan read must
 * never show a dollar figure). Same `DigestCard` shell and "Plan" title as
 * `PlanCardBlock` (the slot never visibly relabels itself), one muted line,
 * no CTA — there's no plan data to send anyone to the billing page about.
 *
 * Exported for the same direct-call-testability reason as `PlanCardBlock`
 * above (no hooks, so it's the only way this file's tests can assert on
 * its rendered output without a DOM render harness).
 */
export function PlanCardEmpty() {
  return (
    <DigestCard title="Plan">
      <span className="text-xs text-[var(--gray-09)]">
        Plan details are unavailable right now.
      </span>
    </DigestCard>
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

export function DigestPanel({ workspaceId, planCard }: DigestPanelProps) {
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
          {planCard ? (
            <PlanCardBlock data={planCard} workspaceId={workspaceId} />
          ) : (
            <PlanCardEmpty />
          )}
        </div>
      )}

      {/* All-time-shipped strip (subscription slice 6 plan, Task 3) — only
          alongside the plan card, directly under the grid it belongs to;
          gated on `data` too so it never appears ahead of/without the grid
          during the loading or error states above. This `data && planCard`
          gate has no render-harness test (this repo's vitest environment
          has no DOM harness and DigestPanel's hooks can't be called
          directly) — it's proven by browser verification instead. */}
      {data && planCard && (
        <p className="text-xs text-[var(--gray-09)]">
          {shippedStripText(planCard.shippedAllTime)}
        </p>
      )}
    </section>
  );
}
