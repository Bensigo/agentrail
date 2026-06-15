type StatColor = "green" | "red" | "orange" | "yellow" | "gray";

const COLOR_MAP: Record<StatColor, string> = {
  green: "var(--green-11)",
  red: "var(--red-11)",
  orange: "var(--orange-11)",
  yellow: "var(--yellow-11)",
  gray: "var(--gray-09)",
};

interface Stat {
  label: string;
  value: string | number;
  detail?: string;
  color?: StatColor;
}

interface StatHeaderProps {
  stats: Stat[];
}

export function StatHeader({ stats }: StatHeaderProps) {
  return (
    <div className="flex flex-wrap items-start gap-4">
      {stats.map((stat, i) => (
        <div key={i} className="flex flex-col gap-0.5">
          <span className="text-xs uppercase tracking-wide text-[var(--gray-09)]">
            {stat.label}
          </span>
          <span
            className="font-mono text-2xl font-bold"
            style={{ color: stat.color ? COLOR_MAP[stat.color] : "var(--gray-12)" }}
          >
            {stat.value}
          </span>
          {stat.detail && (
            <span className="font-mono text-xs text-[var(--gray-09)]">
              {stat.detail}
            </span>
          )}
        </div>
      ))}
    </div>
  );
}
