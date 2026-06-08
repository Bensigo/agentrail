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
