type StatTone = "default" | "error" | "warning" | "success";

const TONE_CLASSES: Record<StatTone, string> = {
  default: "text-[var(--gray-12)]",
  error: "text-[var(--red-11)]",
  warning: "text-[var(--orange-11)]",
  success: "text-[var(--green-11)]",
};

export interface StatItem {
  label: string;
  value: string;
  tone?: StatTone;
}

/**
 * Primary stat row for operational dashboards. Renders a horizontal bar of
 * labeled values with optional tone (error = red, warning = orange, etc.).
 * Splits into 2 columns on mobile, 4 on sm+.
 */
export function StatHeader({ stats }: { stats: StatItem[] }) {
  return (
    <div className="mb-4 grid grid-cols-2 gap-px overflow-hidden rounded border border-[var(--gray-05)] bg-[var(--gray-05)] sm:grid-cols-4">
      {stats.map(({ label, value, tone = "default" }) => (
        <div key={label} className="bg-[var(--gray-02)] px-4 py-3">
          <p className="text-xs text-[var(--gray-09)]">{label}</p>
          <p className={`mt-0.5 font-mono text-sm font-medium ${TONE_CLASSES[tone]}`}>
            {value}
          </p>
        </div>
      ))}
    </div>
  );
}
