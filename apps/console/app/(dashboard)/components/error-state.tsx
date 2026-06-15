interface ErrorStateProps {
  message: string;
  onRetry?: () => void;
}

export function ErrorState({ message, onRetry }: ErrorStateProps) {
  return (
    <div className="flex flex-col items-center justify-center py-8 text-center gap-2">
      <p className="text-sm text-[var(--red-11)]">{message}</p>
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
