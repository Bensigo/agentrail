import { SkeletonTable } from "../../../../components/loading-skeleton";

export default function Loading() {
  return (
    <div className="flex flex-col gap-4">
      <div className="flex items-center justify-between">
        <h1 className="text-sm font-semibold text-[var(--gray-12)]">Memory</h1>
        <p className="text-xs text-[var(--gray-09)]">
          Memory is managed via the AgentRail CLI.
        </p>
      </div>
      <SkeletonTable columns={7} rows={8} />
    </div>
  );
}
