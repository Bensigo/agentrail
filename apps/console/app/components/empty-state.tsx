import type { LucideIcon } from "lucide-react";

export function EmptyState({
  icon: Icon,
  title,
  description,
}: {
  icon: LucideIcon;
  title: string;
  description: string;
}) {
  return (
    <div className="flex flex-col items-center justify-center py-16 text-center">
      <Icon className="h-10 w-10 text-[var(--gray-07)]" />
      <h3 className="mt-4 text-sm font-medium text-[var(--gray-12)]">
        {title}
      </h3>
      <p className="mt-1 text-xs text-[var(--gray-09)]">{description}</p>
    </div>
  );
}
