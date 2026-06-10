import { Skeleton, SkeletonCardGrid } from "../../../components/loading-skeleton";

export default function Loading() {
  return (
    <div className="mx-auto max-w-[1440px]">
      <Skeleton className="h-7 w-48" />
      <Skeleton className="mt-2 h-3 w-64" />
      <div className="mt-8">
        <SkeletonCardGrid cards={10} />
      </div>
    </div>
  );
}
