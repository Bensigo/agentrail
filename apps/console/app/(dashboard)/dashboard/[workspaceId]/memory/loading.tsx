import { SkeletonTable } from "../../../../components/loading-skeleton";

export default function Loading() {
  return (
    <div className="flex flex-col gap-4">
      <h1 className="text-sm font-semibold text-[var(--gray-12)]">Memory</h1>
      <SkeletonTable columns={7} rows={8} />
    </div>
  );
}
