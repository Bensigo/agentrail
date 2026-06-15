import type { ReactNode } from "react";

interface SectionHeaderProps {
  title: string;
  action?: ReactNode;
}

export function SectionHeader({ title, action }: SectionHeaderProps) {
  return (
    <div className="mt-6 mb-4 flex items-center justify-between">
      <h2 className="text-xs font-medium uppercase tracking-wide text-[var(--gray-09)]">
        {title}
      </h2>
      {action && <div>{action}</div>}
    </div>
  );
}
