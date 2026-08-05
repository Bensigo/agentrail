import { NextRequest, NextResponse } from "next/server";
import { auth } from "@agentrail/auth";
import { getReviewMetrics, getWorkspaceMembership } from "@agentrail/db-postgres";

const ISO_DATE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,3})?(?:Z|[+-]\d{2}:\d{2})$/;

function parseIsoDate(value: string | null): Date | null {
  if (!value || !ISO_DATE.test(value)) return null;
  const [yearValue, monthValue, dayValue] = value.split("T", 1)[0].split("-").map(Number);
  const leapYear = yearValue % 4 === 0 && (yearValue % 100 !== 0 || yearValue % 400 === 0);
  const daysInMonth = [31, leapYear ? 29 : 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31][monthValue - 1] ?? 0;
  if (monthValue < 1 || monthValue > 12 || dayValue < 1 || dayValue > daysInMonth) return null;
  const parsed = new Date(value);
  return Number.isNaN(parsed.getTime()) ? null : parsed;
}

function serializeMetric(metric: { value: number | null; knownSampleSize: number }) {
  return { value: metric.value, knownSampleSize: metric.knownSampleSize };
}

function serializeMetrics(metrics: Awaited<ReturnType<typeof getReviewMetrics>>) {
  return metrics.map((metric) => ({
    ...metric,
    dateRange: metric.dateRange
      ? { from: metric.dateRange.from.toISOString(), to: metric.dateRange.to.toISOString() }
      : null,
    medianTimeToFirstReviewSeconds: serializeMetric(metric.medianTimeToFirstReviewSeconds),
    averageReviewCycles: serializeMetric(metric.averageReviewCycles),
    medianPrSizeLines: serializeMetric(metric.medianPrSizeLines),
    mergeRate: serializeMetric(metric.mergeRate),
    postMergeReworkEvents: serializeMetric(metric.postMergeReworkEvents),
    humanReviewMinutes: serializeMetric(metric.humanReviewMinutes),
  }));
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

  const fromValue = request.nextUrl.searchParams.get("from");
  const toValue = request.nextUrl.searchParams.get("to");
  const observedUntilValue = request.nextUrl.searchParams.get("observedUntil");
  const from = parseIsoDate(fromValue);
  const to = parseIsoDate(toValue);
  const observedUntil = observedUntilValue === null ? to : parseIsoDate(observedUntilValue);

  if (!from || !to || !observedUntil || to <= from) {
    return NextResponse.json(
      { error: "from and to must be valid ISO dates with a positive range; observedUntil must be valid ISO date" },
      { status: 400 }
    );
  }

  const metrics = await getReviewMetrics({ workspaceId, from, to, observedUntil });
  return NextResponse.json({ cohorts: serializeMetrics(metrics) });
}
