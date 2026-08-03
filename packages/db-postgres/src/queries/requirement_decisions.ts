import { and, eq, gte, isNotNull, lt, sql } from "drizzle-orm";
import { db } from "../db.js";
import { jaceApprovals } from "../schema/jace_sessions.js";
import { runOutcomes } from "../schema/run_outcomes.js";

/**
 * Dated requirement-decision reporting for #1583.
 *
 * The denominator is always explicit and date filtering is half-open
 * (`from <= created_at < to`) so adjacent reports cannot double-count a row.
 * A final outcome is known only when the linked queue entry has a terminal
 * `run_outcomes` row. Unknown outcomes stay in the report as nulls instead of
 * being silently treated as success or failure.
 */
export interface RequirementDecisionReport {
  from: string;
  to: string;
  workspaceId: string | null;
  evaluatedDenominator: number;
  refusalCount: number;
  refusalRate: number | null;
  overrideCount: number;
  overrideDenominator: number;
  overrideRate: number | null;
  falseRefusalCount: number;
  falseRefusalDenominator: number;
  falseRefusalRate: number | null;
  falseAcceptCount: number;
  falseAcceptDenominator: number;
  falseAcceptRate: number | null;
  unknownFinalOutcomeCount: number;
  nullTaskFamilyCount: number;
  byTaskFamily: RequirementDecisionReportRow[];
}

export interface RequirementDecisionReportRow {
  taskFamily: string | null;
  evaluatedDenominator: number;
  refusalCount: number;
  refusalRate: number | null;
  overrideCount: number;
  overrideDenominator: number;
  overrideRate: number | null;
  falseRefusalCount: number;
  falseRefusalDenominator: number;
  falseRefusalRate: number | null;
  falseAcceptCount: number;
  falseAcceptDenominator: number;
  falseAcceptRate: number | null;
  unknownFinalOutcomeCount: number;
}

export interface RequirementDecisionReportInput {
  from: Date;
  to: Date;
  workspaceId?: string;
}

type RawRequirementReportRow = {
  taskFamily: string | null;
  evaluatedDenominator: string | number;
  refusalCount: string | number;
  overrideCount: string | number;
  overrideDenominator: string | number;
  falseRefusalCount: string | number;
  falseRefusalDenominator: string | number;
  falseAcceptCount: string | number;
  falseAcceptDenominator: string | number;
  unknownFinalOutcomeCount: string | number;
};

function count(value: string | number): number {
  return Number(value);
}

function rate(numerator: number, denominator: number): number | null {
  return denominator > 0 ? numerator / denominator : null;
}

function mapRow(row: RawRequirementReportRow): RequirementDecisionReportRow {
  const evaluatedDenominator = count(row.evaluatedDenominator);
  const refusalCount = count(row.refusalCount);
  const overrideCount = count(row.overrideCount);
  const overrideDenominator = count(row.overrideDenominator);
  const falseRefusalCount = count(row.falseRefusalCount);
  const falseRefusalDenominator = count(row.falseRefusalDenominator);
  const falseAcceptCount = count(row.falseAcceptCount);
  const falseAcceptDenominator = count(row.falseAcceptDenominator);

  return {
    taskFamily: row.taskFamily,
    evaluatedDenominator,
    refusalCount,
    refusalRate: rate(refusalCount, evaluatedDenominator),
    overrideCount,
    overrideDenominator,
    overrideRate: rate(overrideCount, overrideDenominator),
    falseRefusalCount,
    falseRefusalDenominator,
    falseRefusalRate: rate(falseRefusalCount, falseRefusalDenominator),
    falseAcceptCount,
    falseAcceptDenominator,
    falseAcceptRate: rate(falseAcceptCount, falseAcceptDenominator),
    unknownFinalOutcomeCount: count(row.unknownFinalOutcomeCount),
  };
}

export async function getRequirementDecisionReport(
  input: RequirementDecisionReportInput
): Promise<RequirementDecisionReport> {
  if (input.to.getTime() <= input.from.getTime()) {
    throw new Error("getRequirementDecisionReport: to must be after from");
  }

  const conditions = [
    isNotNull(jaceApprovals.requirementDecision),
    gte(jaceApprovals.createdAt, input.from),
    lt(jaceApprovals.createdAt, input.to),
    ...(input.workspaceId ? [eq(jaceApprovals.workspaceId, input.workspaceId)] : []),
  ];

  const rows = await db
    .select({
      taskFamily: jaceApprovals.requirementTaskFamily,
      evaluatedDenominator: sql<string>`COUNT(*)`,
      refusalCount: sql<string>`COUNT(*) FILTER (WHERE ${jaceApprovals.requirementDecision} = 'refuse')`,
      overrideCount: sql<string>`COUNT(*) FILTER (WHERE ${jaceApprovals.requirementOverride} = true AND ${jaceApprovals.requirementDecision} = 'refuse')`,
      overrideDenominator: sql<string>`COUNT(*) FILTER (WHERE ${jaceApprovals.requirementDecision} = 'refuse')`,
      falseRefusalCount: sql<string>`COUNT(*) FILTER (WHERE ${jaceApprovals.requirementDecision} = 'refuse' AND ${runOutcomes.outcome} = 'success')`,
      falseRefusalDenominator: sql<string>`COUNT(*) FILTER (WHERE ${jaceApprovals.requirementDecision} = 'refuse' AND ${runOutcomes.outcome} IS NOT NULL)`,
      falseAcceptCount: sql<string>`COUNT(*) FILTER (WHERE ${jaceApprovals.requirementDecision} = 'accept' AND ${runOutcomes.outcome} IS NOT NULL AND ${runOutcomes.outcome} <> 'success')`,
      falseAcceptDenominator: sql<string>`COUNT(*) FILTER (WHERE ${jaceApprovals.requirementDecision} = 'accept' AND ${runOutcomes.outcome} IS NOT NULL)`,
      unknownFinalOutcomeCount: sql<string>`COUNT(*) FILTER (WHERE ${runOutcomes.outcome} IS NULL)`,
    })
    .from(jaceApprovals)
    .leftJoin(runOutcomes, eq(jaceApprovals.queueEntryId, runOutcomes.queueEntryId))
    .where(and(...conditions))
    .groupBy(jaceApprovals.requirementTaskFamily);

  const byTaskFamily = rows.map((row) => mapRow(row));
  const totals = byTaskFamily.reduce(
    (acc, row) => ({
      evaluatedDenominator: acc.evaluatedDenominator + row.evaluatedDenominator,
      refusalCount: acc.refusalCount + row.refusalCount,
      overrideCount: acc.overrideCount + row.overrideCount,
      overrideDenominator: acc.overrideDenominator + row.overrideDenominator,
      falseRefusalCount: acc.falseRefusalCount + row.falseRefusalCount,
      falseRefusalDenominator:
        acc.falseRefusalDenominator + row.falseRefusalDenominator,
      falseAcceptCount: acc.falseAcceptCount + row.falseAcceptCount,
      falseAcceptDenominator:
        acc.falseAcceptDenominator + row.falseAcceptDenominator,
      unknownFinalOutcomeCount:
        acc.unknownFinalOutcomeCount + row.unknownFinalOutcomeCount,
      nullTaskFamilyCount:
        acc.nullTaskFamilyCount + (row.taskFamily === null ? row.evaluatedDenominator : 0),
    }),
    {
      evaluatedDenominator: 0,
      refusalCount: 0,
      overrideCount: 0,
      overrideDenominator: 0,
      falseRefusalCount: 0,
      falseRefusalDenominator: 0,
      falseAcceptCount: 0,
      falseAcceptDenominator: 0,
      unknownFinalOutcomeCount: 0,
      nullTaskFamilyCount: 0,
    }
  );

  return {
    from: input.from.toISOString(),
    to: input.to.toISOString(),
    workspaceId: input.workspaceId ?? null,
    evaluatedDenominator: totals.evaluatedDenominator,
    refusalCount: totals.refusalCount,
    refusalRate: rate(totals.refusalCount, totals.evaluatedDenominator),
    overrideCount: totals.overrideCount,
    overrideDenominator: totals.overrideDenominator,
    overrideRate: rate(totals.overrideCount, totals.overrideDenominator),
    falseRefusalCount: totals.falseRefusalCount,
    falseRefusalDenominator: totals.falseRefusalDenominator,
    falseRefusalRate: rate(
      totals.falseRefusalCount,
      totals.falseRefusalDenominator
    ),
    falseAcceptCount: totals.falseAcceptCount,
    falseAcceptDenominator: totals.falseAcceptDenominator,
    falseAcceptRate: rate(
      totals.falseAcceptCount,
      totals.falseAcceptDenominator
    ),
    unknownFinalOutcomeCount: totals.unknownFinalOutcomeCount,
    nullTaskFamilyCount: totals.nullTaskFamilyCount,
    byTaskFamily,
  };
}
