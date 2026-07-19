import Link from "next/link";
import { notFound } from "next/navigation";
import { getFailureById } from "@agentrail/db-clickhouse";
import {
  getFailureResolution,
  getRepository,
  getGithubToken,
  getConnector,
} from "@agentrail/db-postgres";
import {
  ChevronLeft,
  AlertTriangle,
  Lightbulb,
  ListChecks,
  ShieldAlert,
  MapPin,
} from "lucide-react";
import {
  explainFailure,
  severityMeaning,
  type SeverityMeaning,
} from "./failure-explanations";
import { parseGithubSlug } from "./github-slug";
import { FailureActions } from "./failure-actions";
import { CopyId } from "../../../../../components/copy-id";
import { nameOrShortId } from "../../../../../components/id-display";

const severityBadgeClass: Record<SeverityMeaning["level"], string> = {
  critical: "bg-[var(--red-09)]/20 text-[var(--red-11)] border border-[var(--red-09)]/30",
  high: "bg-[var(--orange-09)]/20 text-[var(--orange-11)] border border-[var(--orange-09)]/30",
  medium: "bg-[var(--yellow-09)]/20 text-[var(--severity-medium-text)] border border-[var(--yellow-09)]/30",
  low: "bg-[var(--gray-04)] text-[var(--gray-10)] border border-[var(--gray-06)]",
};

function SeverityBadge({ level }: { level: SeverityMeaning["level"] }) {
  return (
    <span
      className={`inline-flex items-center px-1.5 py-0.5 rounded-sm text-xs font-medium ${severityBadgeClass[level]}`}
    >
      {level}
    </span>
  );
}

/**
 * Breadcrumb trail back to Failures (this entity's list page) and to Work
 * (#1232 AC2), mirroring the run-detail (#1231) and review-gate-detail
 * patterns: a Back control to the immediate list, plus a full crumb trail.
 * The leaf shows the failure's human title when it has loaded; names over
 * IDs.
 */
function FailureBreadcrumb({
  workspaceId,
  title,
}: {
  workspaceId: string;
  title?: string;
}) {
  return (
    <div className="mb-4 flex items-center gap-2 text-xs text-[var(--gray-09)]">
      <Link
        href={`/dashboard/${workspaceId}/failures`}
        className="flex items-center gap-1 rounded px-1.5 py-1 text-[var(--gray-11)] transition-colors hover:bg-[var(--gray-03)] hover:text-[var(--gray-12)]"
        aria-label="Back to Failures"
      >
        <ChevronLeft className="h-3.5 w-3.5" />
        Back
      </Link>
      <Link
        href={`/dashboard/${workspaceId}/work`}
        className="hover:text-[var(--gray-11)] transition-colors"
      >
        Work
      </Link>
      <span>/</span>
      <Link
        href={`/dashboard/${workspaceId}/failures`}
        className="hover:text-[var(--gray-11)] transition-colors"
      >
        Failures
      </Link>
      {title && (
        <>
          <span>/</span>
          <span className="max-w-[320px] truncate">{title}</span>
        </>
      )}
    </div>
  );
}

function FailureDbError({ workspaceId }: { workspaceId: string }) {
  return (
    <div className="mx-auto max-w-[900px]">
      <FailureBreadcrumb workspaceId={workspaceId} />
      <div className="rounded border border-[var(--red-09)]/30 bg-[var(--red-09)]/10 px-4 py-4 flex flex-col gap-3">
        <div className="flex items-center gap-2">
          <AlertTriangle className="h-4 w-4 text-[var(--red-11)] shrink-0" />
          <span className="text-sm font-medium text-[var(--red-11)]">
            Unable to load failure details — ClickHouse unavailable
          </span>
        </div>
        <p className="text-xs text-[var(--gray-10)] leading-relaxed">
          The failure record could not be retrieved. ClickHouse may be
          temporarily unavailable. Try again or go back to the failures list.
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

  if (process.env.NODE_ENV === "development" && query.simulateDbError === "1") {
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

  const explanation = explainFailure({
    failure_type: failure.failure_type,
    message: failure.message,
    normalized_error: failure.normalized_error,
    phase: failure.phase,
  });
  const severity = severityMeaning(failure.severity);
  const evidenceFormatted = safeParseEvidence(failure.evidence);

  // Resolution + issue-affordance are best-effort: a Postgres / token hiccup
  // must not blank the (ClickHouse-sourced) failure page itself.
  const failureKey =
    failure.fingerprint && failure.fingerprint.trim()
      ? failure.fingerprint
      : failure.event_id;

  let initialStatus: "open" | "fixed" = "open";
  // Which trackers this failure can be filed to. GitHub when the repo resolves
  // to a github slug and a token exists; Linear when its connector is on.
  const issueTargets: ("github" | "linear")[] = [];
  // Default the repo display to a short hash of the raw id — never the full
  // id as visible text — but prefer the human repo name when we can resolve
  // it. "Which repo" should read as a name, not a uuid.
  let repoDisplay: { text: string; title?: string } = failure.repository_id
    ? nameOrShortId(null, failure.repository_id)
    : { text: "—" };
  try {
    const [resolution, repo, token, linear] = await Promise.all([
      getFailureResolution(workspaceId, failureKey),
      failure.repository_id
        ? getRepository(workspaceId, failure.repository_id)
        : Promise.resolve(null),
      getGithubToken(workspaceId),
      getConnector(workspaceId, "linear"),
    ]);
    if (resolution?.status === "fixed") initialStatus = "fixed";
    if (repo?.name && failure.repository_id) {
      repoDisplay = nameOrShortId(repo.name, failure.repository_id);
    }
    if (token && repo && parseGithubSlug(repo.url)) issueTargets.push("github");
    if (linear?.enabled && linear.hasSecret) issueTargets.push("linear");
  } catch {
    // leave defaults; actions degrade gracefully
  }

  return (
    <div className="mx-auto max-w-[900px]">
      <FailureBreadcrumb workspaceId={workspaceId} title={explanation.title} />

      {/* Human title + severity */}
      <div className="flex items-start justify-between gap-4 mb-2">
        <div className="flex items-center gap-2.5">
          <AlertTriangle className="h-5 w-5 text-[var(--red-11)] shrink-0" />
          <h1 className="text-lg font-semibold text-[var(--gray-12)] leading-tight">
            {explanation.title}
          </h1>
        </div>
        <div className="flex items-center gap-2 shrink-0 pt-1">
          <span className="text-xs text-[var(--gray-09)]">
            {explanation.category}
          </span>
          <SeverityBadge level={severity.level} />
        </div>
      </div>
      <p className="text-sm text-[var(--gray-11)] leading-relaxed mb-5">
        {explanation.summary}
      </p>

      {/* Status + actions: decide fixed/open, add to memory, create issue */}
      <div className="mb-6">
        <FailureActions
          workspaceId={workspaceId}
          failureId={failureId}
          initialStatus={initialStatus}
          issueTargets={issueTargets}
        />
      </div>

      {/* Why this happens */}
      <Section icon={<Lightbulb className="h-4 w-4 text-[var(--severity-medium-text)]" />} title="Why this happens">
        <ul className="flex flex-col gap-1.5">
          {explanation.why.map((w, i) => (
            <li key={i} className="flex gap-2 text-sm text-[var(--gray-11)] leading-relaxed">
              <span className="text-[var(--gray-07)] select-none">•</span>
              <span>{w}</span>
            </li>
          ))}
        </ul>
      </Section>

      {/* What to check */}
      <Section icon={<ListChecks className="h-4 w-4 text-[var(--blue-11)]" />} title="What to check next">
        <ol className="flex flex-col gap-1.5">
          {explanation.whatToCheck.map((c, i) => (
            <li key={i} className="flex gap-2 text-sm text-[var(--gray-11)] leading-relaxed">
              <span className="text-[var(--gray-08)] font-mono text-xs pt-0.5 select-none">
                {i + 1}.
              </span>
              <span>{c}</span>
            </li>
          ))}
        </ol>
      </Section>

      {/* Severity meaning */}
      <Section
        icon={<ShieldAlert className="h-4 w-4 text-[var(--orange-11)]" />}
        title="How serious is this?"
      >
        <div className="flex items-start gap-2.5">
          <SeverityBadge level={severity.level} />
          <p className="text-sm text-[var(--gray-11)] leading-relaxed">
            {severity.impact}
          </p>
        </div>
      </Section>

      {/* Where it happened */}
      <Section icon={<MapPin className="h-4 w-4 text-[var(--gray-09)]" />} title="Where it happened">
        <div className="grid grid-cols-2 gap-4 sm:grid-cols-3">
          <Field label="Repository">
            <span
              className="font-mono text-[var(--gray-12)]"
              title={repoDisplay.title}
            >
              {repoDisplay.text}
            </span>
          </Field>
          <Field label="Phase">
            <span className="font-mono">{failure.phase || "—"}</span>
          </Field>
          <Field label="Type">
            <span className="font-mono">{failure.failure_type}</span>
          </Field>
          <Field label="Run">
            <Link
              href={`/dashboard/${workspaceId}/runs/${failure.run_id}`}
              className="font-mono text-[var(--gray-11)] hover:text-[var(--yellow-09)] transition-colors"
            >
              {failure.run_id.slice(0, 12)}
            </Link>
          </Field>
          <Field label="Occurred At">
            <span className="font-mono">{formatOccurredAt(failure.occurred_at)}</span>
          </Field>
          <Field label="Event ID">
            <CopyId id={failure.event_id} />
          </Field>
        </div>
      </Section>

      {/* Raw message + evidence — the verbatim detail, kept last for the curious */}
      <Section title="Raw error & evidence">
        <Field label="Message">
          <p className="mt-1 font-mono text-xs text-[var(--red-11)] leading-relaxed whitespace-pre-wrap break-words">
            {failure.message}
          </p>
        </Field>
        <div className="mt-3">
          <span className="text-xs font-medium uppercase tracking-wide text-[var(--gray-09)]">
            Evidence
          </span>
          <pre className="mt-2 overflow-x-auto rounded bg-[var(--gray-02)] border border-[var(--gray-04)] p-3 text-xs font-mono text-[var(--gray-11)] leading-relaxed whitespace-pre-wrap break-words">
            {evidenceFormatted || "—"}
          </pre>
        </div>
      </Section>
    </div>
  );
}

function Section({
  icon,
  title,
  children,
}: {
  icon?: React.ReactNode;
  title: string;
  children: React.ReactNode;
}) {
  return (
    <section className="mb-5 rounded border border-[var(--gray-05)] bg-[var(--gray-01)] px-4 py-4">
      <div className="flex items-center gap-2 mb-3">
        {icon}
        <h2 className="text-xs font-medium uppercase tracking-wide text-[var(--gray-09)]">
          {title}
        </h2>
      </div>
      {children}
    </section>
  );
}
