"use client";

import { useEffect } from "react";
import Link from "next/link";

/**
 * Route-segment error boundary for the console.
 *
 * When a server component's data load throws (a Postgres / ClickHouse outage,
 * a "fatal load query", a failed fetch), Next.js renders this in place of the
 * default full-page crash so the view stays recoverable. We log the real error
 * for diagnostics but never surface the raw stack / message to the user.
 */
export default function Error({
  error,
  reset,
}: {
  error: Error & { digest?: string };
  reset: () => void;
}) {
  useEffect(() => {
    // Diagnostics only — goes to the browser/server console, not the user.
    console.error(error);
  }, [error]);

  return (
    <div className="flex min-h-[60vh] flex-col items-center justify-center px-6 text-center">
      <div className="flex max-w-sm flex-col items-center gap-3">
        <span
          aria-hidden
          className="flex h-9 w-9 items-center justify-center rounded-full bg-[var(--gray-03)] text-[var(--red-11)]"
        >
          <svg
            width="16"
            height="16"
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            strokeWidth="2"
            strokeLinecap="round"
            strokeLinejoin="round"
          >
            <path d="M12 9v4" />
            <path d="M12 17h.01" />
            <path d="M10.29 3.86 1.82 18a2 2 0 0 0 1.71 3h16.94a2 2 0 0 0 1.71-3L13.71 3.86a2 2 0 0 0-3.42 0Z" />
          </svg>
        </span>
        <h1 className="text-sm font-semibold text-[var(--gray-12)]">
          Something went wrong loading this view.
        </h1>
        <p className="text-xs text-[var(--gray-09)]">
          The data store may be briefly unreachable. This is usually temporary —
          try again in a moment.
        </p>
        {error.digest && (
          <p className="font-mono text-[10px] text-[var(--gray-08)]">
            Reference: {error.digest}
          </p>
        )}
        <div className="mt-2 flex items-center gap-4">
          <button
            onClick={reset}
            className="h-8 rounded bg-[var(--brand-accent)] px-3 text-xs font-medium text-black transition-colors hover:opacity-90"
          >
            Try again
          </button>
          <Link
            href="/"
            className="text-xs text-[var(--gray-09)] underline transition-colors hover:text-[var(--gray-12)]"
          >
            Back to home
          </Link>
        </div>
      </div>
    </div>
  );
}
