import type { CSSProperties } from "react";

/**
 * Base shimmer block. Use for any single placeholder bar; compose the
 * higher-level helpers below for tables and card grids.
 */
export function Skeleton({
  className = "",
  style,
}: {
  className?: string;
  style?: CSSProperties;
}) {
  return (
    <span
      aria-hidden
      className={`block animate-pulse rounded bg-[var(--gray-03)] ${className}`}
      style={style}
    />
  );
}

// Deterministic-looking cell widths so rows read as text without using
// Math.random (which would mismatch between SSR and hydration).
const CELL_WIDTHS = [72, 88, 54, 66, 80, 60, 76, 48];

function cellWidth(row: number, col: number): number {
  return CELL_WIDTHS[(row * 3 + col) % CELL_WIDTHS.length];
}

/**
 * Skeleton `<tr>` rows for use inside an existing `<tbody>`. Mirrors the row
 * height/padding of the real data tables so swapping in/out doesn't shift layout.
 */
export function SkeletonTableRows({
  columns,
  rows = 8,
}: {
  columns: number;
  rows?: number;
}) {
  return (
    <>
      {Array.from({ length: rows }).map((_, r) => (
        <tr
          key={r}
          className="border-b border-[var(--gray-04)]"
          style={{ height: "34px" }}
        >
          {Array.from({ length: columns }).map((_, c) => (
            <td key={c} className="px-3 py-1.5">
              <Skeleton
                className="h-3.5"
                style={{ width: `${cellWidth(r, c)}%` }}
              />
            </td>
          ))}
        </tr>
      ))}
    </>
  );
}

/**
 * Standalone table skeleton (bordered container + header + rows). Use in route
 * `loading.tsx` files where there's no live table component to borrow.
 */
export function SkeletonTable({
  columns = 5,
  rows = 8,
}: {
  columns?: number;
  rows?: number;
}) {
  return (
    <div className="rounded border border-[var(--gray-05)] overflow-hidden">
      <table className="w-full text-sm border-collapse">
        <thead>
          <tr className="border-b border-[var(--gray-05)] bg-[var(--gray-01)]">
            {Array.from({ length: columns }).map((_, c) => (
              <th key={c} className="px-3 py-2 text-left">
                <Skeleton className="h-2.5 w-16" />
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          <SkeletonTableRows columns={columns} rows={rows} />
        </tbody>
      </table>
    </div>
  );
}

/**
 * Stat header skeleton matching the StatHeader primitive's dimensions.
 * Renders 4 stat cells in the same 2-col/4-col grid layout.
 */
export function SkeletonStatHeader({ items = 4 }: { items?: number }) {
  return (
    <div className="mb-4 grid grid-cols-2 gap-px overflow-hidden rounded border border-[var(--gray-05)] bg-[var(--gray-05)] sm:grid-cols-4">
      {Array.from({ length: items }).map((_, i) => (
        <div key={i} className="bg-[var(--gray-02)] px-4 py-3">
          <Skeleton className="h-2.5 w-14" />
          <Skeleton className="mt-1.5 h-3.5 w-10" />
        </div>
      ))}
    </div>
  );
}

/**
 * Card grid skeleton matching the workspace overview's compact section cards.
 */
export function SkeletonCardGrid({ cards = 6 }: { cards?: number }) {
  return (
    <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
      {Array.from({ length: cards }).map((_, i) => (
        <div
          key={i}
          className="rounded border border-[var(--gray-05)] bg-[var(--gray-02)] px-3 py-3"
        >
          <div className="flex items-center gap-2">
            <Skeleton className="h-3.5 w-3.5 shrink-0 rounded-sm" />
            <Skeleton className="h-2.5 flex-1" />
            <Skeleton className="h-3.5 w-8" />
          </div>
        </div>
      ))}
    </div>
  );
}

export function LoadingSkeleton({ rows = 5 }: { rows?: number }) {
  return (
    <div className="space-y-3">
      {Array.from({ length: rows }).map((_, i) => (
        <div
          key={i}
          className="h-8 animate-pulse rounded bg-[var(--gray-03)]"
          style={{ width: `${100 - i * 8}%` }}
        />
      ))}
    </div>
  );
}
