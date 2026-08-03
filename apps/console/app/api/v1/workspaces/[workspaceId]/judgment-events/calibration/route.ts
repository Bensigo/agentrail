import { NextRequest, NextResponse } from "next/server";
import { auth } from "@agentrail/auth";
import {
  getJudgmentCalibrationSummary,
  getRepositoryByName,
  getWorkspaceMembership,
} from "@agentrail/db-postgres";

type RouteResponse = ReturnType<typeof NextResponse.json>;
type WorkspaceMemberResult =
  | { response: RouteResponse }
  | { userId: string };

function parseIsoDate(value: string | null): Date | null | undefined {
  if (value == null) return null;
  const trimmed = value.trim();
  if (!trimmed) return undefined;
  const time = Date.parse(trimmed);
  if (Number.isNaN(time)) return undefined;
  return new Date(trimmed);
}

async function requireWorkspaceMember(
  workspaceId: string
): Promise<WorkspaceMemberResult> {
  const session = await auth();
  if (!session?.user?.id) {
    return {
      response: NextResponse.json({ error: "Unauthorized" }, { status: 401 }),
    };
  }

  const membership = await getWorkspaceMembership(session.user.id, workspaceId);
  if (!membership) {
    return {
      response: NextResponse.json({ error: "Forbidden" }, { status: 403 }),
    };
  }

  return { userId: session.user.id };
}

/**
 * Read-only Arc E calibration summary for Judgment Ledger events.
 *
 * The window is half-open: occurredAt >= from and occurredAt < to. Missing
 * bounds are explicit nulls in the response so consumers can distinguish
 * "unbounded" from a supplied empty range.
 */
export async function GET(
  request: NextRequest,
  { params }: { params: Promise<{ workspaceId: string }> }
): Promise<RouteResponse> {
  const { workspaceId } = await params;
  const member = await requireWorkspaceMember(workspaceId);
  if ("response" in member) return member.response;

  const searchParams = request.nextUrl.searchParams;
  const repo = searchParams.get("repo")?.trim();
  const from = parseIsoDate(searchParams.get("from"));
  const to = parseIsoDate(searchParams.get("to"));

  const errors: Record<string, string> = {};
  if (!repo) errors.repo = "repo is required";
  if (from === undefined) errors.from = "from must be an ISO timestamp";
  if (to === undefined) errors.to = "to must be an ISO timestamp";
  if (from instanceof Date && to instanceof Date && from.getTime() > to.getTime()) {
    errors.range = "from must be before or equal to to";
  }

  if (Object.keys(errors).length > 0) {
    return NextResponse.json({ errors }, { status: 400 });
  }

  try {
    if (!(await getRepositoryByName(workspaceId, repo!))) {
      return NextResponse.json({ error: "Repository not found" }, { status: 404 });
    }

    const summary = await getJudgmentCalibrationSummary({
      workspaceId,
      repo: repo!,
      from,
      to,
    });
    return NextResponse.json({ summary });
  } catch (err) {
    console.error("[judgment-events-calibration] failed to load summary:", err);
    return NextResponse.json(
      { error: "Failed to load judgment calibration summary" },
      { status: 500 }
    );
  }
}
