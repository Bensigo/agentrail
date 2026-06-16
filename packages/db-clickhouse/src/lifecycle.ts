import { insertAfkRunEvents } from "./queries";

/**
 * Emit a run LIFECYCLE event to the run-detail timeline.
 *
 * The timeline previously showed only per-turn `agent_activity` — no state
 * transitions. These lifecycle events (run_started, gate_green / gate_red /
 * gate_error, pr_opened) render as labeled dots so the run's progression is
 * visible alongside the agent's activity. `event_type` is `action.type`.
 *
 * Best-effort: a failure here must never break the claim/result flow, so all
 * errors are swallowed. `seq` defaults to epoch-ms; pass distinct values when
 * emitting several events at once so they don't dedupe on (workspace, run, seq).
 */
export async function recordRunLifecycleEvent(
  workspaceId: string,
  runId: string,
  type: string,
  summary: string,
  seq: number = Date.now()
): Promise<void> {
  try {
    await insertAfkRunEvents([
      {
        workspace_id: workspaceId,
        repository_id: "",
        session_id: runId,
        seq,
        ts: new Date().toISOString(),
        kind: "lifecycle",
        action: { type, phase: "lifecycle", summary },
        digest: summary.slice(0, 64),
      },
    ]);
  } catch {
    // non-fatal — the timeline marker is observability, not correctness
  }
}
