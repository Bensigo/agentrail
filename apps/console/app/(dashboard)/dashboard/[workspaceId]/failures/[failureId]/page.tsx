import { notFound } from "next/navigation";
import { Suspense } from "react";
import { ArrowLeft, ServerCrash } from "lucide-react";
import Link from "next/link";
import { LoadingSkeleton } from "../../../../../components/loading-skeleton";

type FailureRecord = {
  id: string;
  title: string;
  severity: string;
  occurredAt: string;
  message: string;
};

type FetchResult =
  | { failure: FailureRecord; dbError: false }
  | { failure: null; dbError: false }
  | { failure: null; dbError: true };

/**
 * Stub data-fetching function. When ClickHouse is wired up, replace the body
 * with a real query. The return shape is intentional: dbError must be tracked
 * separately from failure===null so callers can distinguish a DB outage from a
 * genuinely missing record.
 *
 * Dev helper: pass ?simulateDbError=1 in the URL to exercise the error state.
 */
async function getFailureById(
  _workspaceId: string,
  _failureId: string,
  simulateDbError: boolean
): Promise<FetchResult> {
  if (simulateDbError) {
    // Simulates a ClickHouse / network outage for development verification.
    return { failure: null, dbError: true };
  }

  // TODO: replace with real ClickHouse query once client is available.
  // Return { failure: null, dbError: false } for a missing record (→ 404).
  // Return { failure: null, dbError: true } on any caught DB/network error.
  return { failure: null, dbError: false };
}

export default async function FailureDetailPage({
  params,
  searchParams,
}: {
  params: Promise<{ workspaceId: string; failureId: string }>;
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const { workspaceId, failureId } = await params;
  const resolvedSearch = await searchParams;
  const simulateDbError = resolvedSearch["simulateDbError"] === "1";

  return (
    <div>
      <div className="mb-4 flex items-center gap-2">
        <Link
          href={`/dashboard/${workspaceId}/failures`}
          className="flex items-center gap-1 text-xs text-[var(--gray-09)] transition-colors duration-150 hover:text-[var(--gray-12)]"
        >
          <ArrowLeft className="h-3 w-3" />
          Failures
        </Link>
        <span className="text-xs text-[var(--gray-07)]">/</span>
        <span className="font-mono text-xs text-[var(--gray-09)]">{failureId}</span>
      </div>

      <Suspense fallback={<LoadingSkeleton />}>
        <FailureDetailContent
          workspaceId={workspaceId}
          failureId={failureId}
          simulateDbError={simulateDbError}
        />
      </Suspense>
    </div>
  );
}

async function FailureDetailContent({
  workspaceId,
  failureId,
  simulateDbError,
}: {
  workspaceId: string;
  failureId: string;
  simulateDbError: boolean;
}) {
  const result = await getFailureById(workspaceId, failureId, simulateDbError);

  if (result.dbError) {
    return <FailureDbError workspaceId={workspaceId} />;
  }

  if (result.failure === null) {
    notFound();
  }

  return <FailureDetail failure={result.failure} />;
}

function FailureDbError({ workspaceId }: { workspaceId: string }) {
  return (
    <div
      className="flex flex-col gap-3 rounded border border-[#e5484d]/40 bg-[#e5484d]/5 p-4"
      role="alert"
    >
      <div className="flex items-center gap-2">
        <ServerCrash className="h-4 w-4 shrink-0 text-[#e5484d]" />
        <span className="text-sm font-medium text-[#ff9592]">
          Unable to load failure details — ClickHouse unavailable
        </span>
      </div>
      <p className="text-xs text-[var(--gray-09)]">
        The failure record could not be retrieved because the ClickHouse data
        store is currently unreachable. This is a temporary infrastructure
        issue, not a missing record.
      </p>
      <div className="flex gap-2">
        <a
          href="?"
          className="rounded bg-[var(--gray-03)] px-3 py-1.5 text-xs font-medium text-[var(--gray-12)] transition-colors duration-150 hover:bg-[var(--gray-04)]"
        >
          Retry
        </a>
        <Link
          href={`/dashboard/${workspaceId}/failures`}
          className="rounded bg-[var(--gray-03)] px-3 py-1.5 text-xs font-medium text-[var(--gray-12)] transition-colors duration-150 hover:bg-[var(--gray-04)]"
        >
          Back to failures
        </Link>
      </div>
    </div>
  );
}

function FailureDetail({ failure }: { failure: FailureRecord }) {
  return (
    <div className="space-y-4">
      <div className="rounded border border-[var(--gray-05)] bg-[var(--gray-02)] p-4">
        <div className="mb-3 flex items-start justify-between gap-4">
          <h1 className="text-sm font-semibold text-[var(--gray-12)]">
            {failure.title}
          </h1>
          <SeverityBadge severity={failure.severity} />
        </div>
        <dl className="grid grid-cols-2 gap-x-4 gap-y-2 text-xs">
          <div>
            <dt className="text-[var(--gray-09)]">Failure ID</dt>
            <dd className="font-mono text-[var(--gray-11)]">{failure.id}</dd>
          </div>
          <div>
            <dt className="text-[var(--gray-09)]">Occurred at</dt>
            <dd className="font-mono text-[var(--gray-11)]">
              {failure.occurredAt}
            </dd>
          </div>
        </dl>
      </div>

      <div className="rounded border border-[var(--gray-05)] bg-[var(--gray-02)] p-4">
        <h2 className="mb-2 text-xs font-medium uppercase tracking-wide text-[var(--gray-09)]">
          Error message
        </h2>
        <pre className="whitespace-pre-wrap font-mono text-xs text-[var(--gray-11)]">
          {failure.message}
        </pre>
      </div>
    </div>
  );
}

function SeverityBadge({ severity }: { severity: string }) {
  const s = severity.toUpperCase();
  let colorClass = "bg-[var(--gray-04)] text-[var(--gray-11)]";
  if (s === "CRITICAL" || s === "P0")
    colorClass = "bg-[#e5484d]/20 text-[#ff9592]";
  else if (s === "HIGH" || s === "P1")
    colorClass = "bg-[#f76b15]/20 text-[#ffa057]";
  else if (s === "MEDIUM" || s === "P2")
    colorClass = "bg-[#ffe629]/20 text-[#f5e147]";

  return (
    <span
      className={`rounded-sm px-1.5 py-0.5 text-xs font-medium ${colorClass}`}
    >
      {s}
    </span>
  );
}
