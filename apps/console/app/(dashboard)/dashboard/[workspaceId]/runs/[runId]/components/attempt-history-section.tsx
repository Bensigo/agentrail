"use client";

import { useState, useEffect } from "react";

/** One persisted attempt (#1389) — matches
 * `packages/db-postgres/src/queries/queue_attempts.ts`'s `QueueAttemptListItem`. */
export interface QueueAttempt {
  id: string;
  tier: number;
  outcome: string;
  errorSummary: string | null;
  createdAt: string;
}

interface AttemptsResponse {
  attempts: QueueAttempt[];
}

/** Engine-room outcome chip colors — mirrors the queue state badge's TASTE.md
 * severity mapping (green=passed, red=failed) rather than inventing a new
 * palette. `running` never lands here (recordRunnerResult never logs an
 * attempt for a heartbeat) but is handled defensively. */
function outcomeChipClassName(outcome: string): string {
  switch (outcome) {
    case "green":
      return "bg-[var(--green-09)]/20 text-[var(--green-11)] border border-[var(--green-09)]/30";
    case "red":
    case "error":
      return "bg-[var(--red-09)]/20 text-[var(--red-11)] border border-[var(--red-09)]/30";
    default:
      return "bg-[var(--gray-04)] text-[var(--gray-10)] border border-[var(--gray-06)]";
  }
}

function formatTimestamp(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "—";
  return d.toLocaleString("en-US", {
    month: "short",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hour12: false,
  });
}

/** cheap (tier 0) / strong (tier 1+) — same labeling as the Issue Queue table. */
function tierLabel(tier: number): string {
  return tier >= 1 ? "strong" : "cheap";
}

interface AttemptHistorySectionProps {
  workspaceId: string;
  /** A queue entry's id equals its run's id (see `claimQueueEntry`'s own
   * doc-comment) — the run-detail page passes `runId` straight through as
   * this attempt log's `queueEntryId`. */
  runId: string;
}

/**
 * #1389 (AC3) — the console engine-room queue-entry view's attempt history:
 * every attempt this entry has made, with tier / outcome / error summary, so
 * an `escalated-to-human` entry explains itself instead of showing a bare red
 * terminal state. Engine-room vocabulary (tier/attempt) is fine here — see
 * CONTEXT.md's Console entry — this section never renders inside the "Your
 * engineer" zone.
 *
 * Empty section is no section (matches `FailuresSection`'s own convention):
 * an entry that's never failed (straight to green on attempt 1, or never
 * claimed yet) has nothing to show here.
 */
export function AttemptHistorySection({ workspaceId, runId }: AttemptHistorySectionProps) {
  const [attempts, setAttempts] = useState<QueueAttempt[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    async function load() {
      setLoading(true);
      setError(null);
      try {
        const res = await fetch(
          `/api/v1/workspaces/${workspaceId}/queue/${runId}/attempts`
        );
        if (!res.ok) {
          const body = await res.json().catch(() => ({}));
          throw new Error(
            (body as { error?: string }).error ?? `HTTP ${res.status}`
          );
        }
        const json = (await res.json()) as AttemptsResponse;
        setAttempts(json.attempts);
      } catch (e) {
        setError(e instanceof Error ? e.message : "Failed to load attempt history");
      } finally {
        setLoading(false);
      }
    }
    load();
  }, [workspaceId, runId]);

  // The whole section (heading included) only appears when there is
  // something to say — an entry that never retried has nothing here.
  if (loading || (!error && attempts.length === 0)) {
    return null;
  }

  return (
    <div className="mt-8">
      <div className="flex items-center justify-between mb-4">
        <h2 className="text-xs font-bold uppercase tracking-wide text-[var(--gray-09)]">
          Attempt history
        </h2>
        {!error && (
          <span className="text-xs text-[var(--gray-09)]">
            {attempts.length} attempt{attempts.length !== 1 ? "s" : ""}
          </span>
        )}
      </div>
      {error ? (
        <p className="text-sm text-[var(--red-11)] py-4">{error}</p>
      ) : (
        <div className="rounded border border-[var(--gray-05)] overflow-hidden">
          <table className="w-full text-sm border-collapse">
            <thead>
              <tr className="border-b border-[var(--gray-05)] bg-[var(--gray-01)]">
                {["#", "Timestamp", "Tier", "Outcome", "Error summary"].map(
                  (h) => (
                    <th
                      key={h}
                      className="px-3 py-2 text-left text-xs font-medium uppercase tracking-wide text-[var(--gray-09)]"
                    >
                      {h}
                    </th>
                  )
                )}
              </tr>
            </thead>
            <tbody>
              {attempts.map((attempt, i) => (
                <tr
                  key={attempt.id}
                  className="border-b border-[var(--gray-04)] last:border-0"
                >
                  <td className="px-3 py-2 font-mono text-xs text-[var(--gray-09)]">
                    {i + 1}
                  </td>
                  <td className="px-3 py-2 font-mono text-xs text-[var(--gray-10)]">
                    {formatTimestamp(attempt.createdAt)}
                  </td>
                  <td className="px-3 py-2 font-mono text-xs text-[var(--gray-11)]">
                    {tierLabel(attempt.tier)}
                  </td>
                  <td className="px-3 py-2">
                    <span
                      className={`inline-flex items-center px-1.5 py-0.5 rounded-sm text-xs font-medium ${outcomeChipClassName(attempt.outcome)}`}
                    >
                      {attempt.outcome}
                    </span>
                  </td>
                  <td className="px-3 py-2 text-xs text-[var(--gray-11)]">
                    {attempt.errorSummary || (
                      <span className="text-[var(--gray-08)]">—</span>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}
