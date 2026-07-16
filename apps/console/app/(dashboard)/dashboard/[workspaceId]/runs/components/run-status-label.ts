/**
 * Pure run-status label mapping (#1232 AC3), kept in its own `.ts` file
 * (not `.tsx`) so it can be unit-tested without a JSX/React transform —
 * mirrors the sibling convention (`review-gates/blocking-reason.ts`,
 * `runs/[runId]/components/group-timeline-events.ts`).
 *
 * Run status is a different enum from the queue-state vocabulary in
 * `apps/console/lib/work-vocabulary.ts` (queued|running|success|failed here
 * vs queued|parked|running|green|escalated-to-human|blocked there) — this
 * function only relabels the run-status enum, it never maps into queue
 * vocabulary.
 */
export type RunStatus = "queued" | "running" | "success" | "failed";

const RUN_STATUS_LABEL: Record<RunStatus, string> = {
  queued: "Queued",
  running: "Running",
  success: "Succeeded",
  failed: "Failed",
};

/** Plain-English label for a run status. Falls back to the raw status
 * string for anything unknown so it stays total (never throws, never
 * hides an unexpected value). */
export function runStatusLabel(status: string): string {
  return RUN_STATUS_LABEL[status as RunStatus] ?? status;
}
