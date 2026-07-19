import { SkeletonTable } from "../../../../components/loading-skeleton";

export default function Loading() {
  return (
    <div className="mx-auto max-w-[1440px] flex flex-col gap-6">
      <h1 className="text-sm font-bold text-[var(--gray-12)]">Approvals</h1>
      <SkeletonTable columns={3} rows={4} />
      <SkeletonTable columns={3} rows={4} />
      <SkeletonTable columns={5} rows={4} />
    </div>
  );
}
