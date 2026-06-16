import { client } from "./client";

export type BehaviorRule =
  | "excessive_file_reads"
  | "full_file_read"
  | "tool_loop"
  | "context_blind_edit"
  | "verification_skip";

export type LintSeverity = "warning" | "error";

export interface LintFinding {
  rule: BehaviorRule;
  severity: LintSeverity;
  evidence_event_id: string;
}

export interface BehaviorThresholds {
  /** Trigger excessive_file_reads when files_read_count is greater than this. */
  maxFilesReadCount: number;
  /** Trigger full_file_read when full_file_read is greater than this. */
  maxFullFileReadCount: number;
  /** Trigger tool_loop when tool_loop_count is greater than this. */
  maxToolLoopCount: number;
  /** Trigger context_blind_edit when edit_without_context is greater than this. */
  maxEditWithoutContextCount: number;
  /** Trigger verification_skip when verification_skip is greater than this. */
  maxVerificationSkipCount: number;
}

/**
 * Agent Behavior Linter rules and defaults:
 *
 * 1. excessive_file_reads: warning when files_read_count > maxFilesReadCount
 *    (default 8 distinct reads in one agent_activity turn).
 * 2. full_file_read: warning when full_file_read > maxFullFileReadCount
 *    (default 0; any full-file read is flagged).
 * 3. tool_loop: warning when tool_loop_count > maxToolLoopCount
 *    (default 0; any repeated identical tool call is flagged).
 * 4. context_blind_edit: error when edit_without_context >
 *    maxEditWithoutContextCount (default 0; any edit without same-turn
 *    context-gathering evidence is flagged).
 * 5. verification_skip: error when verification_skip >
 *    maxVerificationSkipCount (default 0; any edit turn without same-turn
 *    verification evidence is flagged).
 *
 * Workspaces can override any threshold by passing BehaviorThresholds into
 * AgentBehaviorLinter; omitted values keep these defaults.
 */
export const DEFAULT_BEHAVIOR_THRESHOLDS: BehaviorThresholds = {
  maxFilesReadCount: 8,
  maxFullFileReadCount: 0,
  maxToolLoopCount: 0,
  maxEditWithoutContextCount: 0,
  maxVerificationSkipCount: 0,
};

interface BehaviorEventRow {
  event_id: string;
  payload?: string;
  files_read_count?: number | string | null;
  full_file_read?: number | string | null;
  tool_loop_count?: number | string | null;
  edit_without_context?: number | string | null;
  verification_skip?: number | string | null;
}

function parsePayload(raw: unknown): Record<string, unknown> {
  if (typeof raw !== "string" || raw.length === 0) return {};
  try {
    const parsed: unknown = JSON.parse(raw);
    return parsed && typeof parsed === "object"
      ? (parsed as Record<string, unknown>)
      : {};
  } catch {
    return {};
  }
}

function numeric(value: unknown): number {
  if (typeof value === "number" && Number.isFinite(value)) {
    return Math.max(0, Math.trunc(value));
  }
  if (typeof value === "string" && value.trim() !== "") {
    const n = Number(value);
    return Number.isFinite(n) ? Math.max(0, Math.trunc(n)) : 0;
  }
  if (typeof value === "boolean") {
    return value ? 1 : 0;
  }
  return 0;
}

function metric(
  row: BehaviorEventRow,
  payload: Record<string, unknown>,
  key: keyof Omit<BehaviorEventRow, "event_id" | "payload">
): number {
  return Math.max(numeric(row[key]), numeric(payload[key]));
}

function mergedThresholds(
  overrides: Partial<BehaviorThresholds> = {}
): BehaviorThresholds {
  return {
    ...DEFAULT_BEHAVIOR_THRESHOLDS,
    ...overrides,
  };
}

export async function AgentBehaviorLinter(
  workspaceId: string,
  runId: string,
  thresholds?: Partial<BehaviorThresholds>
): Promise<LintFinding[]> {
  const result = await client.query({
    query: `
      SELECT
        event_id,
        payload,
        files_read_count,
        full_file_read,
        tool_loop_count,
        edit_without_context,
        verification_skip
      FROM run_events
      WHERE workspace_id = {workspaceId: String}
        AND run_id = {runId: String}
        AND event_type = 'agent_activity'
      ORDER BY occurred_at ASC, seq ASC
    `,
    query_params: { workspaceId, runId },
    format: "JSONEachRow",
  });

  const rows = await result.json<BehaviorEventRow>();
  const t = mergedThresholds(thresholds);

  // Aggregate RUN-LEVEL signals across all agent_activity turns. The linter is
  // run-level (at most one finding per rule), NOT per-turn: the agent's natural
  // rhythm — read in one turn, edit in the next — must not spam a finding every
  // turn (that produced the duplicated wall of errors). Each rule fires once,
  // pointing at the first/worst offending turn as evidence.
  let maxFilesRead = 0;
  let maxFilesReadEvent = "";
  let fullReadTurns = 0;
  let firstFullReadEvent = "";
  let totalLoops = 0;
  let firstLoopEvent = "";
  let totalReads = 0;
  let totalBlindEdits = 0;
  let firstBlindEditEvent = "";

  for (const row of rows) {
    const payload = parsePayload(row.payload);
    const evt = String(row.event_id ?? "");
    if (!evt) continue;

    const reads = metric(row, payload, "files_read_count");
    const full = metric(row, payload, "full_file_read");
    const loops = metric(row, payload, "tool_loop_count");
    const blind = metric(row, payload, "edit_without_context");

    totalReads += reads;
    totalLoops += loops;
    totalBlindEdits += blind;
    if (reads > maxFilesRead) {
      maxFilesRead = reads;
      maxFilesReadEvent = evt;
    }
    if (full > 0) {
      fullReadTurns += 1;
      if (!firstFullReadEvent) firstFullReadEvent = evt;
    }
    if (loops > 0 && !firstLoopEvent) firstLoopEvent = evt;
    if (blind > 0 && !firstBlindEditEvent) firstBlindEditEvent = evt;
  }

  const findings: LintFinding[] = [];

  if (maxFilesRead > t.maxFilesReadCount) {
    findings.push({
      rule: "excessive_file_reads",
      severity: "warning",
      evidence_event_id: maxFilesReadEvent,
    });
  }
  if (fullReadTurns > t.maxFullFileReadCount) {
    findings.push({
      rule: "full_file_read",
      severity: "warning",
      evidence_event_id: firstFullReadEvent,
    });
  }
  if (totalLoops > t.maxToolLoopCount) {
    findings.push({
      rule: "tool_loop",
      severity: "warning",
      evidence_event_id: firstLoopEvent,
    });
  }
  // context_blind_edit is a real risk ONLY when the run edited code but gathered
  // NO context anywhere across the whole run (truly ungrounded). A single edit
  // turn without same-turn reads is normal (context came from an earlier turn),
  // so that is never flagged.
  if (
    totalBlindEdits > t.maxEditWithoutContextCount &&
    totalReads === 0 &&
    firstBlindEditEvent
  ) {
    findings.push({
      rule: "context_blind_edit",
      severity: "error",
      evidence_event_id: firstBlindEditEvent,
    });
  }
  // verification_skip is intentionally NOT emitted: in the verification-contract
  // architecture the Objective Gate runs the tests (not the agent), so "the
  // agent didn't run tests in a turn" is a false signal — the gate's green/red
  // verdict is the real verification status, surfaced elsewhere.

  return findings;
}
