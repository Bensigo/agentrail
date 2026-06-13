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
  const findings: LintFinding[] = [];

  for (const row of rows) {
    const payload = parsePayload(row.payload);
    const evidence_event_id = String(row.event_id ?? "");
    if (!evidence_event_id) continue;

    if (metric(row, payload, "files_read_count") > t.maxFilesReadCount) {
      findings.push({
        rule: "excessive_file_reads",
        severity: "warning",
        evidence_event_id,
      });
    }

    if (metric(row, payload, "full_file_read") > t.maxFullFileReadCount) {
      findings.push({
        rule: "full_file_read",
        severity: "warning",
        evidence_event_id,
      });
    }

    if (metric(row, payload, "tool_loop_count") > t.maxToolLoopCount) {
      findings.push({
        rule: "tool_loop",
        severity: "warning",
        evidence_event_id,
      });
    }

    if (
      metric(row, payload, "edit_without_context") >
      t.maxEditWithoutContextCount
    ) {
      findings.push({
        rule: "context_blind_edit",
        severity: "error",
        evidence_event_id,
      });
    }

    if (metric(row, payload, "verification_skip") > t.maxVerificationSkipCount) {
      findings.push({
        rule: "verification_skip",
        severity: "error",
        evidence_event_id,
      });
    }
  }

  return findings;
}
