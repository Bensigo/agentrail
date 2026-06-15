"use client";

import { Skeleton } from "../../../../../../components/loading-skeleton";

/** Shimmer placeholder shown while a run-detail section is fetching. */
export function SectionSkeleton({ lines = 2 }: { lines?: number }) {
  return (
    <div className="flex flex-col gap-2 py-2" aria-label="Loading">
      {Array.from({ length: lines }, (_, i) => (
        <Skeleton
          key={i}
          className="h-4"
          style={{ width: `${[68, 42, 55, 30][i % 4]}%` }}
        />
      ))}
    </div>
  );
}

/**
 * Empty state that distinguishes "the run is still going — data is on its
 * way" from "the run finished and never produced this data". Rendering the
 * final wording on a live run reads like an error.
 */
export function SectionEmpty({
  runStatus,
  waitingText,
  emptyText,
}: {
  runStatus?: string;
  waitingText: string;
  emptyText: string;
}) {
  const inFlight = runStatus === "running" || runStatus === "queued";
  if (inFlight) {
    return (
      <p className="text-sm text-[var(--gray-09)] py-4 flex items-center gap-2">
        <span className="inline-block h-1.5 w-1.5 rounded-full bg-[var(--orange-11)] animate-pulse" />
        {waitingText}
      </p>
    );
  }
  return <p className="text-sm text-[var(--gray-09)] py-4">{emptyText}</p>;
}
