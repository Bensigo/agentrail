import { Skeleton } from "../../../../components/loading-skeleton";

// Mirrors the actual post-load shape (compact repo header band, then
// nav-tree + content) rather than a table skeleton — a table-shaped
// placeholder would recreate, even for a flash, exactly the "repo table
// leads the page" hierarchy this view moved away from.
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
      <div className="flex flex-col gap-4">
        <div className="flex items-center justify-between gap-3 border-b border-[var(--gray-05)] pb-3">
          <div className="flex items-center gap-3">
            <Skeleton className="h-4 w-32" />
            <Skeleton className="h-3 w-16" />
            <Skeleton className="h-3 w-24" />
          </div>
          <Skeleton className="h-3 w-20" />
        </div>
        <div className="grid grid-cols-1 gap-6 lg:grid-cols-[220px_1fr]">
          <div className="flex flex-col gap-2 lg:border-r lg:border-[var(--gray-05)] lg:pr-4">
            {Array.from({ length: 6 }).map((_, i) => (
              <Skeleton key={i} className="h-6 w-full" />
            ))}
          </div>
          <Skeleton className="h-64 w-full" />
        </div>
      </div>
    </div>
  );
}
