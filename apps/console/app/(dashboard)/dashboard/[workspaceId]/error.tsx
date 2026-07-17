"use client";

import { useEffect } from "react";
import Link from "next/link";
import { usePathname } from "next/navigation";

/**
 * Error boundary scoped to the workspace page body.
 *
 * The workspace layout (sidebar, workspace switcher, top bar) lives in the
 * sibling layout.tsx and is NOT wrapped by this boundary — so when a page's
 * data load throws (a store outage on failures/runs/costs/…), only the content
 * area is replaced with this recoverable panel while the nav shell survives.
 * Errors thrown by the layout itself bubble up to the root app/error.tsx.
 */
export default function WorkspaceError({
  error,
  reset,
}: {
  error: Error & { digest?: string };
  reset: () => void;
}) {
  useEffect(() => {
    console.error(error);
  }, [error]);

  // Recover the workspace id from the path so "Back to overview" lands on this
  // workspace rather than a generic home. Falls back to "/" if unparseable.
  const pathname = usePathname();
  const workspaceId = pathname?.match(/\/dashboard\/([^/]+)/)?.[1];
  const overviewHref = workspaceId ? `/dashboard/${workspaceId}` : "/";

  return (
    <div className="mx-auto flex min-h-[50vh] max-w-[1440px] flex-col items-center justify-center text-center">
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
          We couldn&apos;t load this page&apos;s data — the store may be briefly
          unreachable. Your workspace is fine; try again in a moment.
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
            href={overviewHref}
            className="text-xs text-[var(--gray-09)] underline transition-colors hover:text-[var(--gray-12)]"
          >
            Back to overview
          </Link>
        </div>
      </div>
    </div>
  );
}
