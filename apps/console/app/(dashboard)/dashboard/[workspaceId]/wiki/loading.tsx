import { SkeletonTable } from "../../../../components/loading-skeleton";

export default function Loading() {
  return (
    <div className="mx-auto flex max-w-[1440px] flex-col gap-4">
      <div>
        <h1 className="text-sm font-semibold text-[var(--gray-12)]">Wiki</h1>
        <p className="mt-1 text-xs text-[var(--gray-09)]">
          What Jace has compiled about your codebase — module responsibilities,
          relationships, and where to look, cited back to source.
        </p>
      </div>
      <SkeletonTable columns={3} rows={6} />
    </div>
  );
}
