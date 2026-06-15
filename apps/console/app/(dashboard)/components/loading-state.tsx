import { SkeletonTable } from "../../components/loading-skeleton";

interface LoadingStateProps {
  variant?: "table" | "list";
  columns?: number;
  rows?: number;
}

export function LoadingState({
  variant = "table",
  columns = 5,
  rows = 8,
}: LoadingStateProps) {
  if (variant === "list") {
    return (
      <div className="space-y-px">
        {Array.from({ length: rows }).map((_, i) => (
          <div
            key={i}
            className="h-[34px] animate-pulse rounded bg-[var(--gray-03)]"
          />
        ))}
      </div>
    );
  }

  return <SkeletonTable columns={columns} rows={rows} />;
}
