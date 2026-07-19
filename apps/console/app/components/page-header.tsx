import type { ReactNode } from "react";

interface PageHeaderProps {
  title: string;
  subtitle?: string;
  actions?: ReactNode;
}

/**
 * Shared page-header primitive used at the top of each dashboard page.
 * Title uses `text-sm font-bold text-[var(--gray-12)]`.
 * Subtitle uses `font-mono text-xs text-[var(--gray-09)]`.
 * Optional right-side action slot for buttons/badges.
 */
export function PageHeader({ title, subtitle, actions }: PageHeaderProps) {
  return (
    <div className="mb-6 flex items-start justify-between gap-4">
      <div>
        <h1 className="text-sm font-bold text-[var(--gray-12)]">{title}</h1>
        {subtitle && (
          <p className="mt-0.5 font-mono text-xs text-[var(--gray-09)]">
            {subtitle}
          </p>
        )}
      </div>
      {actions && (
        <div className="flex shrink-0 items-center gap-2">{actions}</div>
      )}
    </div>
  );
}
