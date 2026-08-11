import Link from "next/link";
import type { ReactNode } from "react";
import type {
  AcceptanceRecordSummary,
  AcceptanceRecordSummaryUnknownReason,
} from "@agentrail/db-postgres";

const UNKNOWN_REASON_LABELS: Record<AcceptanceRecordSummaryUnknownReason, string> = {
  requested_work_not_confirmed: "Requested work is not confirmed",
  invalid_contract_custody: "Contract custody is invalid",
  head_occurrence_not_authoritative: "The PR head occurrence is not authoritative",
  invalid_head_custody: "PR head custody is invalid",
  context_not_recorded: "Supplied context is not recorded",
  ambiguous_context_custody: "Supplied-context custody is ambiguous",
  invalid_context_custody: "Supplied-context custody is invalid",
  proof_not_recorded: "Review proof is not recorded",
  invalid_review_custody: "Review custody is invalid",
  decision_not_recorded: "The human decision is not recorded",
  invalid_decision_custody: "Human-decision custody is invalid",
  outcome_not_recorded: "The outcome is not recorded",
  invalid_merge_custody: "Signed-merge custody is invalid",
  invalid_post_merge_custody: "Post-merge custody is invalid",
  summary_custody_limit: "The bounded summary custody limit was reached",
};

type Decision = "approved" | "changes_requested" | "rejected" | "approved_with_exception";
type ReviewVerdict = "proven" | "failed" | "not_proven" | "not_testable";
const SAFE_REPO = /^[A-Za-z0-9._-]+\/[A-Za-z0-9._-]+$/;

export type AcceptanceRecordRepoFilter =
  | { kind: "absent" }
  | { kind: "valid"; repo: string }
  | { kind: "invalid" };

/** Canonicalizes the member-supplied list filter before it reaches the exact DB input. */
export function parseAcceptanceRecordRepoFilter(
  value: unknown,
): AcceptanceRecordRepoFilter {
  if (value == null) return { kind: "absent" };
  if (typeof value !== "string") return { kind: "invalid" };
  const repo = value.trim();
  if (!repo) return { kind: "absent" };
  if (!SAFE_REPO.test(repo) || repo.split("/").some((segment) => segment === "." || segment === "..")) {
    return { kind: "invalid" };
  }
  return { kind: "valid", repo };
}

function decisionLabel(decision: Decision): string {
  switch (decision) {
    case "approved": return "Approve";
    case "changes_requested": return "Request changes";
    case "rejected": return "Reject";
    case "approved_with_exception": return "Approve with exception";
  }
}

function verdictLabel(verdict: ReviewVerdict): string {
  switch (verdict) {
    case "proven": return "Proven";
    case "failed": return "Failed";
    case "not_proven": return "Not proven";
    case "not_testable": return "Not testable";
  }
}

function formatDate(value: Date): string {
  return value.toISOString().replace("T", " ").replace(".000Z", " UTC");
}

function requestedWorkText(summary: AcceptanceRecordSummary): string {
  return summary.requestedWork.kind === "confirmed"
    ? `${summary.requestedWork.originalRequest} Confirmed by Contract ${summary.requestedWork.acceptanceContract.id} v${summary.requestedWork.acceptanceContract.version} (${summary.requestedWork.acceptanceContract.sha256}).`
    : "Unknown — no confirmed requested work is recorded.";
}

function suppliedContextText(summary: AcceptanceRecordSummary): string {
  const context = summary.suppliedContext;
  if (context.kind === "unknown") {
    return "Unknown — supplied context is not recorded.";
  }
  const source = `source snapshot ${context.sourceSnapshot.id} at exact head ${context.sourceSnapshot.headSha}`;
  if (context.kind === "compiled") {
    return `Compiled Context Pack ${context.compiledPack.id} (${context.compiledPack.sha256}) from ${source}.`;
  }
  if (context.kind === "admitted") {
    return `Admitted ${source}; a compiled Context Pack is not recorded.`;
  }
  return `Not proven — ${source} was recorded, but its context custody was not admitted.`;
}

function pullRequestText(summary: AcceptanceRecordSummary): string {
  const pullRequest = summary.pullRequest;
  if (pullRequest.kind === "not_attached") {
    return "Not attached — no pull request is recorded.";
  }
  if (pullRequest.head.kind === "unknown") {
    return `PR #${pullRequest.prNumber} · exact head unknown.`;
  }
  return `PR #${pullRequest.prNumber} · ${pullRequest.head.kind} exact head ${pullRequest.head.sha} · cycle ${pullRequest.head.headCycleId} · authority generation ${pullRequest.head.authorityGeneration}.`;
}

function proofText(summary: AcceptanceRecordSummary): string {
  return summary.proof.kind === "recorded"
    ? `${verdictLabel(summary.proof.verdict)} · review job ${summary.proof.reviewJobId} · attestation event ${summary.proof.postedAttestationEventId}.`
    : "Unknown — no canonical review proof is recorded.";
}

function unknownsText(summary: AcceptanceRecordSummary): string {
  return summary.unknownReasons.length === 0
    ? "None in this bounded server summary."
    : summary.unknownReasons.map((reason) => UNKNOWN_REASON_LABELS[reason]).join("; ");
}

function neededDecisionText(summary: AcceptanceRecordSummary): string {
  const needed = summary.neededDecision;
  if (needed.kind === "required") {
    return `Required — ${needed.choices.map(decisionLabel).join(", ")}.`;
  }
  if (needed.kind === "recorded") {
    return `Recorded — ${decisionLabel(needed.decision)} at ${formatDate(needed.decidedAt)}.`;
  }
  if (needed.kind === "unknown") {
    return "Unknown — decision readiness could not be proven.";
  }
  switch (needed.reason) {
    case "pr_not_attached": return "Not required yet — no pull request is attached.";
    case "merged": return "Not required — the signed merge is already recorded.";
    case "reverted": return "Not required — the recorded merge was reverted.";
  }
}

function outcomeText(summary: AcceptanceRecordSummary): string {
  const outcome = summary.outcome;
  if (outcome.kind === "unknown") {
    return "Unknown — outcome custody could not be validated.";
  }
  if (outcome.kind === "not_recorded") {
    return "Not recorded — no canonical outcome receipt was observed; this is not a known negative.";
  }
  const postMerge = outcome.postMerge;
  const receiptLabel = (value: "recorded" | "not_recorded") => value === "recorded" ? "recorded" : "not recorded";
  return `Signed merge ${outcome.mergeSha} at ${formatDate(outcome.mergedAt)} · decision alignment ${outcome.decisionAlignment} · post-merge receipts: deployment ${receiptLabel(postMerge.deployment)}, incident ${receiptLabel(postMerge.incident)}, revert ${receiptLabel(postMerge.revert)}. “Not recorded” means no canonical receipt was observed; it does not establish that an event did not happen.`;
}

function SummaryDatum({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div>
      <dt className="text-xs font-medium text-[var(--gray-09)]">{label}</dt>
      <dd className="mt-1 break-words text-xs leading-relaxed text-[var(--gray-12)]">{children}</dd>
    </div>
  );
}

export function AcceptanceRecordSummaryList({
  workspaceId,
  records,
  compact = false,
}: {
  workspaceId: string;
  records: AcceptanceRecordSummary[];
  compact?: boolean;
}) {
  const visibleRecords = compact ? records.slice(0, 5) : records;
  return (
    <section className="flex flex-col gap-3">
      <div className="flex flex-wrap items-end justify-between gap-2">
        <div>
          <h2 className="text-xs font-normal uppercase tracking-wide text-[var(--gray-09)]">
            {compact ? "Acceptance summary" : "Acceptance Records"}
          </h2>
          <p className="mt-1 text-xs text-[var(--gray-09)]">
            Requested work, supplied context, exact-head proof, unknowns, decisions, and outcomes from server-custodied Records.
          </p>
        </div>
        {compact ? (
          <Link
            href={`/dashboard/${workspaceId}/changes`}
            className="text-xs text-[var(--blue-11)] hover:underline"
          >
            View all Changes
          </Link>
        ) : null}
      </div>

      {visibleRecords.length === 0 ? (
        <div className="rounded border border-[var(--gray-05)] bg-[var(--gray-02)] p-4">
          <p className="text-sm text-[var(--gray-09)]">
            No Acceptance Records are recorded for this view.
          </p>
        </div>
      ) : (
        <ol className="flex flex-col gap-3">
          {visibleRecords.map((summary) => (
            <li key={summary.recordId}>
              <article className="rounded border border-[var(--gray-05)] bg-[var(--gray-02)] p-4">
                <div className="flex flex-wrap items-start justify-between gap-3">
                  <div>
                    <Link
                      href={`/dashboard/${workspaceId}/changes/${summary.recordId}`}
                      className="font-mono text-sm font-medium text-[var(--blue-11)] hover:underline"
                    >
                      {summary.repo}
                    </Link>
                    <p className="mt-1 text-xs text-[var(--gray-09)]">
                      {summary.issueNumber === null ? "Issue not attached" : `Issue #${summary.issueNumber}`}
                    </p>
                  </div>
                  <time dateTime={summary.updatedAt.toISOString()} className="text-xs text-[var(--gray-09)]">
                    Updated {formatDate(summary.updatedAt)}
                  </time>
                </div>

                <dl className="mt-4 grid gap-x-6 gap-y-4 md:grid-cols-2">
                  <SummaryDatum label="Requested work">{requestedWorkText(summary)}</SummaryDatum>
                  <SummaryDatum label="Supplied context">{suppliedContextText(summary)}</SummaryDatum>
                  <SummaryDatum label="Pull request / exact head">{pullRequestText(summary)}</SummaryDatum>
                  <SummaryDatum label="Proof">
                    {proofText(summary)}{" "}
                    {summary.proof.kind === "recorded" ? (
                      <a
                        href={summary.proof.postedReviewUrl}
                        target="_blank"
                        rel="noreferrer"
                        className="text-[var(--blue-11)] hover:underline"
                      >
                        Open attested review
                      </a>
                    ) : null}
                  </SummaryDatum>
                  <SummaryDatum label="Unknowns">{unknownsText(summary)}</SummaryDatum>
                  <SummaryDatum label="Needed decision">{neededDecisionText(summary)}</SummaryDatum>
                  <SummaryDatum label="Outcome">{outcomeText(summary)}</SummaryDatum>
                </dl>
              </article>
            </li>
          ))}
        </ol>
      )}
    </section>
  );
}
