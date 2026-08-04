"use client";

import { useEffect, useState } from "react";
import { SectionSkeleton } from "./section-states";

type PrResolution =
  | { state: "resolved"; repo: string; number: number }
  | { state: "no_pr" | "unknown"; repo: null; number: null };

type ReviewJob = {
  id: string;
  state: string;
  verdict: string | null;
  postedReviewUrl: string | null;
  createdAt: string;
};

type ReviewEvent = {
  id: string;
  eventType: string;
  occurredAt: string;
  reviewState: string | null;
  humanReviewMinutes: number | null;
  humanReviewSource: "human_input" | "timer" | null;
};

type AlignmentBrief =
  | { state: "linked"; id: string }
  | { state: "absent" | "unknown"; id: null };

type ReviewChainResponse = {
  run: { queueEntryId: string | null; prUrl: string | null };
  prResolution: PrResolution;
  reviewJobs: ReviewJob[];
  reviewEvents: ReviewEvent[];
  alignmentBrief?: AlignmentBrief;
};

function formatTime(value: string): string {
  const parsed = new Date(value);
  if (Number.isNaN(parsed.getTime())) return value;
  return parsed.toLocaleString("en-US", {
    month: "short",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  });
}

function label(value: string): string {
  return value.replaceAll("_", " ");
}

function jobTone(state: string): string {
  if (state === "posted") return "text-[var(--green-11)]";
  if (state === "failed" || state === "skipped") return "text-[var(--red-11)]";
  if (state === "running") return "text-[var(--orange-11)]";
  return "text-[var(--gray-10)]";
}

function renderAlignmentBrief(alignmentBrief: AlignmentBrief | undefined): string {
  if (!alignmentBrief || alignmentBrief.state === "unknown") {
    return "Alignment brief lineage unavailable (legacy)";
  }
  if (alignmentBrief.state === "absent") {
    return "No queue-backed alignment brief";
  }
  // The response still carries the durable ID for API consumers, but a UUID is
  // not useful primary console copy. The evidence room should state the
  // relationship honestly without making an implementation identifier the UI.
  return "Alignment brief linked";
}

export function ReviewChainContent({ data }: { data: ReviewChainResponse }) {
  if (data.prResolution.state === "no_pr") {
    return (
      <div className="py-4 text-sm text-[var(--gray-09)]">
        <p>
          This run did not open a pull request, so there is no review outcome to report.
        </p>
        <p className="mt-1">{renderAlignmentBrief(data.alignmentBrief)}</p>
      </div>
    );
  }

  if (data.prResolution.state === "unknown") {
    return (
      <div className="py-4 text-sm text-[var(--gray-09)]">
        <p>
          The recorded PR link is not a GitHub pull request. Review evidence is unavailable rather than inferred.
        </p>
        <p className="mt-1">{renderAlignmentBrief(data.alignmentBrief)}</p>
      </div>
    );
  }

  const latestJob = data.reviewJobs.at(-1) ?? null;
  const explicitMinutes = data.reviewEvents
    .filter((event) => event.eventType === "human_review_time")
    .reduce((total, event) => total + (event.humanReviewMinutes ?? 0), 0);
  const hasKnownMinutes = data.reviewEvents.some(
    (event) => event.eventType === "human_review_time" && event.humanReviewMinutes !== null
  );

  return (
    <div className="overflow-hidden rounded border border-[var(--gray-05)] bg-[var(--gray-02)]">
      <div className="flex flex-col gap-2 border-b border-[var(--gray-04)] px-4 py-3 text-xs sm:flex-row sm:items-center sm:justify-between">
        <div className="min-w-0">
          <a href={data.run.prUrl ?? undefined} className="font-bold text-[var(--blue-11)] hover:underline">
            {data.prResolution.repo} #{data.prResolution.number}
          </a>
          {data.run.queueEntryId ? (
            <p className="mt-1 font-mono text-[var(--gray-09)]">Queue entry {data.run.queueEntryId.slice(0, 8)}</p>
          ) : (
            <p className="mt-1 text-[var(--gray-09)]">Queue entry unknown</p>
          )}
          <p className="mt-1 text-[var(--gray-09)]">
            {renderAlignmentBrief(data.alignmentBrief)}
          </p>
        </div>
        <div className="text-[var(--gray-09)]">
          Human review time: {hasKnownMinutes ? `${explicitMinutes.toFixed(0)} min` : "unknown"}
        </div>
      </div>

      <div className="grid divide-y divide-[var(--gray-04)] md:grid-cols-2 md:divide-x md:divide-y-0">
        <div className="p-4">
          <p className="mb-2 text-xs font-bold uppercase tracking-wide text-[var(--gray-09)]">Reviewer of record</p>
          {latestJob ? (
            <div className="space-y-1 text-xs">
              <p className={`font-bold ${jobTone(latestJob.state)}`}>{label(latestJob.state)}</p>
              <p className="text-[var(--gray-10)]">{latestJob.verdict ?? "Verdict not recorded"}</p>
              {latestJob.postedReviewUrl ? (
                <a className="text-[var(--blue-11)] hover:underline" href={latestJob.postedReviewUrl}>Open posted review →</a>
              ) : null}
            </div>
          ) : (
            <p className="text-xs text-[var(--gray-09)]">No reviewer-of-record job has been recorded.</p>
          )}
        </div>

        <div className="p-4">
          <p className="mb-2 text-xs font-bold uppercase tracking-wide text-[var(--gray-09)]">Outcome evidence</p>
          {data.reviewEvents.length === 0 ? (
            <p className="text-xs text-[var(--gray-09)]">No human review, merge, rework, or revert event has been recorded.</p>
          ) : (
            <ol className="space-y-2">
              {data.reviewEvents.map((event) => (
                <li key={event.id} className="flex gap-2 text-xs">
                  <span className="mt-1 h-1.5 w-1.5 shrink-0 rounded-full bg-[var(--teal-09)]" />
                  <div className="min-w-0">
                    <span className="font-bold text-[var(--gray-12)]">{label(event.eventType)}</span>
                    {event.reviewState ? <span className="text-[var(--gray-10)]"> · {label(event.reviewState)}</span> : null}
                    {event.humanReviewMinutes !== null ? <span className="text-[var(--gray-10)]"> · {event.humanReviewMinutes} min ({event.humanReviewSource})</span> : null}
                    <p className="font-mono text-[var(--gray-09)]">{formatTime(event.occurredAt)}</p>
                  </div>
                </li>
              ))}
            </ol>
          )}
        </div>
      </div>
    </div>
  );
}

export function ReviewChainSection({
  workspaceId,
  runId,
}: {
  workspaceId: string;
  runId: string;
}) {
  const [data, setData] = useState<ReviewChainResponse | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    async function load() {
      try {
        const response = await fetch(
          `/api/v1/workspaces/${workspaceId}/runs/${runId}/review-chain`
        );
        if (!response.ok) throw new Error(`HTTP ${response.status}`);
        const result = (await response.json()) as ReviewChainResponse;
        if (!cancelled) setData(result);
      } catch (cause) {
        if (!cancelled) {
          setError(cause instanceof Error ? cause.message : "Unable to load review evidence");
        }
      }
    }
    load();
    return () => {
      cancelled = true;
    };
  }, [workspaceId, runId]);

  if (!data && !error) return <SectionSkeleton lines={3} />;
  if (error) return <p className="py-4 text-sm text-[var(--red-11)]">Review evidence unavailable: {error}</p>;
  if (!data) return null;

  return <ReviewChainContent data={data} />;
}
