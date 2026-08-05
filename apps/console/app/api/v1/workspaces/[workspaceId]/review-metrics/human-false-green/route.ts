import { NextRequest, NextResponse } from "next/server";
import { auth } from "@agentrail/auth";
import {
  getProductionHumanFalseGreen,
  getWorkspaceMembership,
} from "@agentrail/db-postgres";

const ISO_DATE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,3})?(?:Z|[+-]\d{2}:\d{2})$/;

function parseIsoDate(value: string | null): Date | null {
  if (!value || !ISO_DATE.test(value)) return null;
  const parsed = new Date(value);
  return Number.isNaN(parsed.getTime()) ? null : parsed;
}

/**
 * Dated production human false-green evidence. This endpoint intentionally
 * exposes unknown reasons alongside the rate: no output is treated as an
 * approval merely because no rejection event was found.
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
  const observedUntilValue = request.nextUrl.searchParams.get("observedUntil");
  const observedUntil = observedUntilValue === null ? to : parseIsoDate(observedUntilValue);
  if (!from || !to || !observedUntil || to <= from || observedUntil < to) {
    return NextResponse.json(
      {
        error:
          "from and to must be valid ISO dates with a positive range; observedUntil must be a valid ISO date on or after to",
      },
      { status: 400 }
    );
  }

  const report = await getProductionHumanFalseGreen({
    workspaceId,
    from,
    to,
    observedUntil,
  });
  return NextResponse.json({
    ...report,
    dateRange: {
      from: report.dateRange.from.toISOString(),
      to: report.dateRange.to.toISOString(),
    },
    observedUntil: report.observedUntil.toISOString(),
  });
}
