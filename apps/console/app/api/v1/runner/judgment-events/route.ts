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
 * Jace's chat/grilling producer seam for workspace-scoped ledger rows. The
 * caller supplies only the session/repo and already-derived event payload;
 * tenant resolution and actor/source attribution stay server-owned. This
 * producer is intentionally limited to chat-originated requirement corrections
 * and rejected approaches; trusted review_outcome/false_green/missed_check
 * producers stay on their existing dedicated routes.
 */

const CHAT_EVENT_TYPES = ["requirement_correction", "rejected_approach"] as const;
const MAX_REASON_LEN = 1200;
const MAX_BLOCKED_TERMS = 20;
const MAX_BLOCKED_TERM_LEN = 160;

type ChatJudgmentEventType = (typeof CHAT_EVENT_TYPES)[number];

type JudgmentEventBody = {
  eveSessionId: string;
  repo: string;
  eventKey: string;
  type: ChatJudgmentEventType;
  refs: Record<string, unknown>;
  payload: Record<string, unknown>;
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return value != null && typeof value === "object" && !Array.isArray(value);
}

function boundedNonemptyString(value: unknown, maxLen: number): value is string {
  return typeof value === "string" && value.trim().length > 0 && value.trim().length <= maxLen;
}

function validRejectedApproachPayload(payload: Record<string, unknown>): boolean {
  if (!boundedNonemptyString(payload.reason, MAX_REASON_LEN)) return false;
  if (!Array.isArray(payload.blockedTerms)) return false;
  if (payload.blockedTerms.length < 1 || payload.blockedTerms.length > MAX_BLOCKED_TERMS) return false;
  return payload.blockedTerms.every((term) => boundedNonemptyString(term, MAX_BLOCKED_TERM_LEN));
}

function validRequirementCorrectionPayload(payload: Record<string, unknown>): boolean {
  if (Object.keys(payload).length === 0) return false;
  const reason = payload.reason;
  return reason === undefined || boundedNonemptyString(reason, MAX_REASON_LEN);
}

function validPayload(type: ChatJudgmentEventType, payload: Record<string, unknown>): boolean {
  if (type === "rejected_approach") return validRejectedApproachPayload(payload);
  return validRequirementCorrectionPayload(payload);
}

function isChatJudgmentEventType(value: unknown): value is ChatJudgmentEventType {
  return CHAT_EVENT_TYPES.includes(value as ChatJudgmentEventType);
}

function parseBody(raw: unknown): JudgmentEventBody | null {
  if (!isRecord(raw)) return null;
  if (
    typeof raw.eveSessionId !== "string" ||
    typeof raw.repo !== "string" ||
    typeof raw.eventKey !== "string" ||
    !isChatJudgmentEventType(raw.type) ||
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
  if (!validPayload(body.type, body.payload)) return null;
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
      {
        error:
          "eveSessionId, repo, eventKey, chat judgment type, refs, and a valid bounded payload are required",
      },
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
      sourceRef: { kind: "chat" },
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
