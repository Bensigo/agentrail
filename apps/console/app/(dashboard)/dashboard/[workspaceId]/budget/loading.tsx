import { SkeletonCardGrid, SkeletonTable } from "../../../../components/loading-skeleton";

export default function Loading() {
  return (
    <div className="mx-auto max-w-[1440px] flex flex-col gap-6">
      <h1 className="text-sm font-semibold text-[var(--gray-12)]">Budget</h1>
      <SkeletonCardGrid cards={3} />
      <SkeletonTable columns={4} rows={8} />
      <SkeletonTable columns={3} rows={6} />
    </div>
  );
}
