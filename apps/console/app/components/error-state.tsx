import { AlertCircle } from "lucide-react";

/**
 * Inline error state for dashboard sections. Replaces the content of a
 * section when its data source is unavailable. Provides an alert icon,
 * title, and optional descriptive message.
 */
export function ErrorState({
  title,
  message,
}: {
  title: string;
  message?: string;
}) {
  return (
    <div className="flex flex-col items-center justify-center rounded border border-[var(--gray-05)] bg-[var(--gray-02)] py-8 text-center">
      <AlertCircle className="h-5 w-5 text-[var(--red-09)]" />
      <p className="mt-2 text-sm font-medium text-[var(--gray-12)]">{title}</p>
      {message && (
        <p className="mt-1 text-xs text-[var(--gray-09)]">{message}</p>
      )}
    </div>
  );
}
