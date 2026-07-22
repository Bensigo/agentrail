/**
 * One leash counter (issues or spend) as a label/value line plus a thin
 * fill bar — same `h-1.5 rounded-full bg-[var(--gray-04)]` track/fill recipe
 * as `budget/components/overview-strip.tsx`'s own spend-ratio bar, so an
 * active goal's leash progress reads as the same visual language as the
 * workspace Budget page's ceiling bar.
 */
export function LeashMeter({
  label,
  display,
  ratio,
}: {
  label: string;
  display: string;
  ratio: number;
}) {
  return (
    <div className="flex flex-col gap-1">
      <div className="flex items-center justify-between gap-2 text-xs">
        <span className="text-[var(--gray-09)]">{label}</span>
        <span className="font-mono text-[var(--gray-11)]">{display}</span>
      </div>
      <div className="h-1.5 w-full overflow-hidden rounded-full bg-[var(--gray-04)]">
        <div
          className={`h-full rounded-full ${ratio >= 1 ? "bg-[var(--red-09)]" : "bg-[var(--green-09)]"}`}
          style={{ width: `${Math.round(ratio * 100)}%` }}
        />
      </div>
    </div>
  );
}
