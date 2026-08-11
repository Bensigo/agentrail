import { NextRequest, NextResponse } from "next/server";
import { auth } from "@agentrail/auth";
import {
  getWorkspaceMembership,
  readAcceptanceOutcomeHistory,
} from "@agentrail/db-postgres";

const ISO_DATE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,3})?(?:Z|[+-]\d{2}:\d{2})$/;
const MAX_OBSERVATION_SPAN_MS = 366 * 24 * 60 * 60 * 1_000;

function parseIsoDate(value: string | null): Date | null {
  if (!value || !ISO_DATE.test(value)) return null;
  const [yearValue, monthValue, dayValue] = value.split("T", 1)[0].split("-").map(Number);
  const leapYear = yearValue % 4 === 0 && (yearValue % 100 !== 0 || yearValue % 400 === 0);
  const daysInMonth = [31, leapYear ? 29 : 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31][monthValue - 1] ?? 0;
  if (monthValue < 1 || monthValue > 12 || dayValue < 1 || dayValue > daysInMonth) return null;
  const parsed = new Date(value);
  return Number.isNaN(parsed.getTime()) ? null : parsed;
}

/**
 * Read the canonical historical Acceptance outcome projection. This route is
 * intentionally aggregate-only: it neither records a decision nor claims a
 * historical decision is still current for a later PR head.
 */
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

  const from = parseIsoDate(request.nextUrl.searchParams.get("from"));
  const to = parseIsoDate(request.nextUrl.searchParams.get("to"));
  const observedUntil = parseIsoDate(request.nextUrl.searchParams.get("observedUntil"));
  if (!from || !to || !observedUntil || to <= from || observedUntil < to
    || to.getTime() - from.getTime() > MAX_OBSERVATION_SPAN_MS
    || observedUntil.getTime() - to.getTime() > MAX_OBSERVATION_SPAN_MS) {
    return NextResponse.json(
      { error: "from and to must be valid ISO dates within 366 days; observedUntil must be a valid ISO date no more than 366 days after to" },
      { status: 400 }
    );
  }

  try {
    const projection = await readAcceptanceOutcomeHistory({
      workspaceId,
      from,
      to,
      observedUntil,
    });
    return NextResponse.json({
      cohort: {
        from: projection.cohort.from.toISOString(),
        to: projection.cohort.to.toISOString(),
        observedUntil: projection.cohort.observedUntil.toISOString(),
      },
      counts: projection.counts,
    }, { headers: { "Cache-Control": "no-store" } });
  } catch (error) {
    console.error("[acceptance-outcome-metrics] failed to read projection:", error);
    return NextResponse.json({ error: "Acceptance outcome metrics are temporarily unavailable" }, { status: 503 });
  }
}
