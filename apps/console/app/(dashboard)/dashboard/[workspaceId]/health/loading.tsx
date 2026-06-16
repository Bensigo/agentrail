import { Skeleton } from "../../../../components/loading-skeleton";

export default function Loading() {
  return (
    <div className="mx-auto max-w-[1440px]">
      <h1 className="mb-4 text-sm font-semibold text-[var(--gray-12)]">Health</h1>
      <div className="flex flex-col gap-3">
        <Skeleton className="h-3 w-24" />
        <Skeleton className="h-24 w-full" />
      </div>
    </div>
  );
}
