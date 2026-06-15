interface EmptyStateProps {
  message: string;
  icon?: React.ReactNode;
  action?: React.ReactNode;
}

export function EmptyState({ message, icon, action }: EmptyStateProps) {
  return (
    <div className="flex flex-col items-center justify-center py-8 text-center gap-2">
      {icon && <div className="text-[var(--gray-07)]">{icon}</div>}
      <p className="text-sm text-[var(--gray-09)]">{message}</p>
      {action && <div className="mt-1">{action}</div>}
    </div>
  );
}
