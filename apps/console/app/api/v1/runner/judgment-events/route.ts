import { NextRequest, NextResponse } from "next/server";
import {
  appendJudgmentEvent,
  getChatIdentityById,
  getJaceSessionByEveSessionId,
  getRepositoryByName,
} from "@agentrail/db-postgres";
import { requireJaceConsoleSecret } from "../../../../../lib/jace-console-auth";

/**
 * POST /api/v1/runner/judgment-events
 *
 * Jace's producer seam for workspace-scoped ledger rows. The caller supplies
 * only the session/repo and already-derived event payload; tenant resolution
 * and actor/source attribution stay server-owned. This first runner producer
 * is intentionally limited to requirement corrections so refusal capture
 * cannot become an unvalidated generic write surface.
 */

type JudgmentEventBody = {
  eveSessionId: string;
  repo: string;
  eventKey: string;
  type: "requirement_correction";
  refs: Record<string, unknown>;
  payload: Record<string, unknown>;
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return value != null && typeof value === "object" && !Array.isArray(value);
}

function parseBody(raw: unknown): JudgmentEventBody | null {
  if (!isRecord(raw)) return null;
  if (
    typeof raw.eveSessionId !== "string" ||
    typeof raw.repo !== "string" ||
    typeof raw.eventKey !== "string" ||
    raw.type !== "requirement_correction" ||
    !isRecord(raw.refs) ||
    !isRecord(raw.payload)
  ) {
    return null;
  }
  const body = {
    eveSessionId: raw.eveSessionId.trim(),
    repo: raw.repo.trim(),
    eventKey: raw.eventKey.trim(),
    type: raw.type,
    refs: raw.refs,
    payload: raw.payload,
  } satisfies JudgmentEventBody;
  if (!body.eveSessionId || !body.repo || !body.eventKey) return null;
  if (body.eventKey.length > 160 || body.repo.length > 200) return null;
  return body;
}

async function resolveWorkspaceId(eveSessionId: string): Promise<string | null> {
  const session = await getJaceSessionByEveSessionId(eveSessionId);
  const identity = session?.chatIdentityId
    ? await getChatIdentityById(session.chatIdentityId)
    : null;
  return session?.workspaceId ?? identity?.workspaceId ?? null;
}

export async function POST(request: NextRequest) {
  const authError = requireJaceConsoleSecret(request);
  if (authError) return authError;

  const body = parseBody(await request.json().catch(() => null));
  if (!body) {
    return NextResponse.json(
      { error: "eveSessionId, repo, eventKey, requirement_correction type, refs, and payload are required" },
      { status: 400 }
    );
  }

  const workspaceId = await resolveWorkspaceId(body.eveSessionId);
  if (!workspaceId) return NextResponse.json({ error: "Session not found" }, { status: 404 });
  if (!(await getRepositoryByName(workspaceId, body.repo))) {
    return NextResponse.json({ error: "Repository not found" }, { status: 404 });
  }

  try {
    const result = await appendJudgmentEvent({
      workspaceId,
      repo: body.repo,
      eventKey: body.eventKey,
      type: body.type,
      refs: body.refs,
      payload: body.payload,
      actorRef: { kind: "jace" },
      sourceRef: { kind: "create_issue" },
    });
    return NextResponse.json(
      { ok: true, inserted: result.inserted, event: result.event },
      { status: result.inserted ? 201 : 409 }
    );
  } catch (error) {
    console.error("[runner/judgment-events] append failed:", error);
    return NextResponse.json({ error: "Failed to append judgment event" }, { status: 503 });
  }
}
