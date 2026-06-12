import { SkeletonTable } from "../../../../components/loading-skeleton";

export default function Loading() {
  return (
    <div className="mx-auto max-w-[1440px]">
      <h1 className="mb-4 text-sm font-semibold text-[var(--gray-12)]">Agent Scorecard</h1>
      <div className="flex flex-col gap-8">
        <section>
          <div className="mb-2 h-2.5 w-16 animate-pulse rounded bg-[var(--gray-03)]" />
          <SkeletonTable columns={6} rows={4} />
        </section>
        <section>
          <div className="mb-2 h-2.5 w-16 animate-pulse rounded bg-[var(--gray-03)]" />
          <SkeletonTable columns={8} rows={4} />
        </section>
      </div>
    </div>
  );
}
