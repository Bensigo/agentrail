import Link from "next/link";
import { notFound } from "next/navigation";
import { getFailureById } from "@agentrail/db-clickhouse";
import { ChevronLeft, AlertTriangle } from "lucide-react";

type Severity = "critical" | "high" | "medium" | "low";

const severityConfig: Record<Severity, { label: string; className: string }> = {
  critical: {
    label: "critical",
    className: "bg-[#e5484d]/20 text-[#ff9592] border border-[#e5484d]/30",
  },
  high: {
    label: "high",
    className: "bg-[#f76b15]/20 text-[#ffa057] border border-[#f76b15]/30",
  },
  medium: {
    label: "medium",
    className: "bg-[#ffe629]/20 text-[#f5d90a] border border-[#ffe629]/30",
  },
  low: {
    label: "low",
    className:
      "bg-[var(--gray-04)] text-[var(--gray-10)] border border-[var(--gray-06)]",
  },
};

function SeverityBadge({ severity }: { severity: string }) {
  const config = severityConfig[severity as Severity] ?? {
    label: severity,
    className:
      "bg-[var(--gray-04)] text-[var(--gray-10)] border border-[var(--gray-06)]",
  };
  return (
    <span
      className={`inline-flex items-center px-1.5 py-0.5 rounded-sm text-xs font-medium ${config.className}`}
    >
      {config.label}
    </span>
  );
}

function FailureDbError({ workspaceId }: { workspaceId: string }) {
  return (
    <div className="mx-auto max-w-[900px]">
      <div className="mb-4 flex items-center gap-2">
        <Link
          href={`/dashboard/${workspaceId}/failures`}
          className="flex items-center gap-1 text-xs text-[var(--gray-09)] hover:text-[var(--gray-12)] transition-colors"
        >
          <ChevronLeft className="h-3 w-3" />
          Failures
        </Link>
      </div>
      <div className="rounded border border-[#e5484d]/30 bg-[#e5484d]/10 px-4 py-4 flex flex-col gap-3">
        <div className="flex items-center gap-2">
          <AlertTriangle className="h-4 w-4 text-[#ff9592] shrink-0" />
          <span className="text-sm font-medium text-[#ff9592]">
            Unable to load failure details — ClickHouse unavailable
          </span>
        </div>
        <p className="text-xs text-[var(--gray-10)] leading-relaxed">
          The failure record could not be retrieved. ClickHouse may be temporarily unavailable. Try again or go back to the failures list.
        </p>
        <div className="flex items-center gap-2">
          <a
            href=""
            className="inline-flex items-center px-3 py-1.5 rounded text-xs font-medium bg-[var(--gray-03)] border border-[var(--gray-06)] text-[var(--gray-12)] hover:bg-[var(--gray-04)] transition-colors"
          >
            Retry
          </a>
          <Link
            href={`/dashboard/${workspaceId}/failures`}
            className="inline-flex items-center px-3 py-1.5 rounded text-xs font-medium text-[var(--gray-11)] hover:text-[var(--gray-12)] transition-colors"
          >
            Back to Failures
          </Link>
        </div>
      </div>
    </div>
  );
}

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="flex flex-col gap-1">
      <span className="text-xs font-medium uppercase tracking-wide text-[var(--gray-09)]">
        {label}
      </span>
      <div className="text-sm text-[var(--gray-12)]">{children}</div>
    </div>
  );
}

function formatOccurredAt(value: unknown): string {
  if (!value) return "—";
  const d = value instanceof Date ? value : new Date(String(value));
  return d.toLocaleString("en-US", {
    year: "numeric",
    month: "short",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hour12: false,
  });
}

function safeParseEvidence(raw: string): string {
  try {
    const parsed = JSON.parse(raw);
    return JSON.stringify(parsed, null, 2);
  } catch {
    return raw;
  }
}

export default async function FailureDetailPage({
  params,
  searchParams,
}: {
  params: Promise<{ workspaceId: string; failureId: string }>;
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const { workspaceId, failureId } = await params;
  const query = await searchParams;

  let failure = null;
  let dbError = false;

  if (
    process.env.NODE_ENV === "development" &&
    query.simulateDbError === "1"
  ) {
    dbError = true;
  } else {
    try {
      failure = await getFailureById(workspaceId, failureId);
    } catch {
      dbError = true;
    }
  }

  if (dbError) {
    return <FailureDbError workspaceId={workspaceId} />;
  }

  if (!failure) {
    notFound();
  }

  const evidenceFormatted = safeParseEvidence(failure.evidence);

  return (
    <div className="mx-auto max-w-[900px]">
      <div className="mb-4 flex items-center gap-2">
        <Link
          href={`/dashboard/${workspaceId}/failures`}
          className="flex items-center gap-1 text-xs text-[var(--gray-09)] hover:text-[var(--gray-12)] transition-colors"
        >
          <ChevronLeft className="h-3 w-3" />
          Failures
        </Link>
      </div>

      <div className="flex items-center justify-between mb-6">
        <h1 className="text-sm font-semibold text-[var(--gray-12)]">
          Failure Detail
        </h1>
        <SeverityBadge severity={failure.severity} />
      </div>

      <div className="rounded border border-[var(--gray-05)] divide-y divide-[var(--gray-05)]">
        {/* Meta fields */}
        <div className="grid grid-cols-2 gap-4 px-4 py-3 sm:grid-cols-3">
          <Field label="Type">
            <span className="font-mono">{failure.failure_type}</span>
          </Field>
          <Field label="Phase">
            <span className="font-mono">{failure.phase}</span>
          </Field>
          <Field label="Occurred At">
            <span className="font-mono">{formatOccurredAt(failure.occurred_at)}</span>
          </Field>
          <Field label="Run">
            <Link
              href={`/dashboard/${workspaceId}/failures?run_id=${failure.run_id}`}
              className="font-mono text-[var(--gray-11)] hover:text-[#ffe629] transition-colors"
            >
              {failure.run_id}
            </Link>
          </Field>
          <Field label="Repository">
            <span className="font-mono">{failure.repository_id}</span>
          </Field>
          <Field label="Event ID">
            <span className="font-mono text-xs text-[var(--gray-10)]">
              {failure.event_id}
            </span>
          </Field>
        </div>

        {/* Message */}
        <div className="px-4 py-3">
          <Field label="Message">
            <p className="mt-1 text-[var(--gray-12)] leading-relaxed">
              {failure.message}
            </p>
          </Field>
        </div>

        {/* Evidence / stack trace */}
        <div className="px-4 py-3">
          <span className="text-xs font-medium uppercase tracking-wide text-[var(--gray-09)]">
            Evidence
          </span>
          <pre className="mt-2 overflow-x-auto rounded bg-[var(--gray-02)] border border-[var(--gray-04)] p-3 text-xs font-mono text-[#ff9592] leading-relaxed whitespace-pre-wrap break-words">
            {evidenceFormatted}
          </pre>
        </div>
      </div>
    </div>
  );
}
