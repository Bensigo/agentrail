interface ErrorStateProps {
  message: string;
  onRetry?: () => void;
}

export function ErrorState({ message, onRetry }: ErrorStateProps) {
  return (
    <div className="flex flex-col items-center justify-center py-8 text-center gap-2">
      {/* font-mono: matches the sitewide fetch-error treatment (digest-panel,
          health-rates-panel, data-table.tsx's own internal error branch). */}
      <p className="font-mono text-sm text-[var(--red-11)]">{message}</p>
      {onRetry && (
        <button
          onClick={onRetry}
          className="text-xs text-[var(--gray-09)] hover:text-[var(--gray-12)] underline transition-colors"
        >
          Retry
        </button>
      )}
    </div>
  );
}
