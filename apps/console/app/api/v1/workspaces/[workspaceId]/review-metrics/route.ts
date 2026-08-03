import { NextRequest, NextResponse } from "next/server";
import { auth } from "@agentrail/auth";
import { getWorkspaceMembership, getReviewMetricsReport } from "@agentrail/db-postgres";

function parseDate(value: string | null): Date | null {
  if (!value) return null;
  const parsed = new Date(value);
  return Number.isNaN(parsed.getTime()) ? null : parsed;
}

function serializeMetric(metric: {
  value: number | null;
  knownSampleSize: number;
}): { value: number | null; knownSampleSize: number } {
  return { value: metric.value, knownSampleSize: metric.knownSampleSize };
}

function serializeReport(report: Awaited<ReturnType<typeof getReviewMetricsReport>>) {
  if (!report) return null;
  return {
    workspaceId: report.workspaceId,
    taskFamily: report.taskFamily,
    current: {
      ...report.current,
      dateRange: report.current.dateRange
        ? {
            from: report.current.dateRange.from.toISOString(),
            to: report.current.dateRange.to.toISOString(),
          }
        : null,
      medianTimeToFirstReviewSeconds: serializeMetric(report.current.medianTimeToFirstReviewSeconds),
      averageReviewCycles: serializeMetric(report.current.averageReviewCycles),
      medianPrSizeLines: serializeMetric(report.current.medianPrSizeLines),
      mergeRate: serializeMetric(report.current.mergeRate),
      postMergeReworkEvents: serializeMetric(report.current.postMergeReworkEvents),
      humanReviewMinutes: serializeMetric(report.current.humanReviewMinutes),
    },
    baseline: report.baseline
      ? {
          ...report.baseline,
          dateRange: report.baseline.dateRange
            ? {
                from: report.baseline.dateRange.from.toISOString(),
                to: report.baseline.dateRange.to.toISOString(),
              }
            : null,
          medianTimeToFirstReviewSeconds: serializeMetric(report.baseline.medianTimeToFirstReviewSeconds),
          averageReviewCycles: serializeMetric(report.baseline.averageReviewCycles),
          medianPrSizeLines: serializeMetric(report.baseline.medianPrSizeLines),
          mergeRate: serializeMetric(report.baseline.mergeRate),
          postMergeReworkEvents: serializeMetric(report.baseline.postMergeReworkEvents),
          humanReviewMinutes: serializeMetric(report.baseline.humanReviewMinutes),
        }
      : null,
    comparison: report.comparison,
  };
}

export async function GET(
  request: NextRequest,
  { params }: { params: Promise<{ workspaceId: string }> }
) {
  const session = await auth();
  if (!session?.user?.id) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const { workspaceId } = await params;
  const membership = await getWorkspaceMembership(session.user.id, workspaceId);
  if (!membership) {
    return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  }

  const from = parseDate(request.nextUrl.searchParams.get("from"));
  const to = parseDate(request.nextUrl.searchParams.get("to"));
  const taskFamily = request.nextUrl.searchParams.get("taskFamily")?.trim() || "";
  if (!from || !to || !taskFamily) {
    return NextResponse.json(
      { error: "from, to, and taskFamily are required valid ISO dates / strings" },
      { status: 400 }
    );
  }

  const baselineFrom = parseDate(request.nextUrl.searchParams.get("baselineFrom"));
  const baselineTo = parseDate(request.nextUrl.searchParams.get("baselineTo"));
  const baselineObservedUntil = parseDate(request.nextUrl.searchParams.get("baselineObservedUntil"));
  if ((baselineFrom && !baselineTo) || (!baselineFrom && baselineTo)) {
    return NextResponse.json(
      { error: "baselineFrom and baselineTo must be provided together" },
      { status: 400 }
    );
  }

  const report = await getReviewMetricsReport({
    workspaceId,
    taskFamily,
    from,
    to,
    observedUntil: parseDate(request.nextUrl.searchParams.get("observedUntil")) ?? undefined,
    baselineFrom: baselineFrom ?? undefined,
    baselineTo: baselineTo ?? undefined,
    baselineObservedUntil: baselineObservedUntil ?? undefined,
  });

  return NextResponse.json({
    report: serializeReport(report),
  });
}
