import { SkeletonTable } from "../../../../components/loading-skeleton";

export default function Loading() {
  return (
    <div className="mx-auto max-w-[1440px]">
      <h1 className="mb-4 text-sm font-bold text-[var(--gray-12)]">Runs</h1>
      <SkeletonTable columns={6} rows={8} />
    </div>
  );
}
