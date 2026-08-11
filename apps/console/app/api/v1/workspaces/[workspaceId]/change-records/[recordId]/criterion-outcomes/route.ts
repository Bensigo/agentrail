import { NextRequest, NextResponse } from "next/server";
import { auth } from "@agentrail/auth";
import {
  getWorkspaceMembership,
  readCurrentAcceptanceCriterionOutcomeBundle,
} from "@agentrail/db-postgres";

function json(body: Record<string, unknown>, status = 200): NextResponse {
  return NextResponse.json(body, {
    status,
    headers: { "Cache-Control": "private, no-store" },
  });
}

function serializeDates(value: unknown): unknown {
  if (value instanceof Date) return value.toISOString();
  if (Array.isArray(value)) return value.map(serializeDates);
  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value).map(([key, nested]) => [key, serializeDates(nested)]),
    );
  }
  return value;
}

/** Read one server-derived current-head criterion outcome bundle. */
export async function GET(
  request: NextRequest,
  { params }: { params: Promise<{ workspaceId: string; recordId: string }> },
) {
  const session = await auth();
  if (!session?.user?.id) return json({ error: "Unauthorized" }, 401);

  const { workspaceId, recordId } = await params;
  if (!(await getWorkspaceMembership(session.user.id, workspaceId))) {
    return json({ error: "Forbidden" }, 403);
  }
  if ([...request.nextUrl.searchParams].length !== 0) {
    return json({ error: "Criterion outcome query parameters are not accepted" }, 400);
  }

  try {
    const result = await readCurrentAcceptanceCriterionOutcomeBundle({
      workspaceId,
      recordId,
    });
    if (result.kind === "not_found") return json(result, 404);
    if (result.kind === "not_current" || result.kind === "not_ready") {
      return json(result, 409);
    }
    return json(serializeDates(result) as Record<string, unknown>);
  } catch (error) {
    console.error("[criterion-outcomes] failed to read current bundle:", error);
    return json({ error: "Criterion outcomes unavailable" }, 503);
  }
}
