import { NextRequest, NextResponse } from "next/server";
import { auth } from "@agentrail/auth";
import {
  JUDGMENT_EVENT_TYPES,
  appendJudgmentEvent,
  getRepositoryByName,
  getWorkspaceMembership,
  listJudgmentEvents,
  type JudgmentEventRef,
  type JudgmentEventRefs,
  type JudgmentEventRow,
  type JudgmentEventType,
} from "@agentrail/db-postgres";

type RouteResponse = ReturnType<typeof NextResponse.json>;
type WorkspaceMemberResult =
  | { response: RouteResponse }
  | { userId: string };

const EVENT_TYPES = new Set<string>(JUDGMENT_EVENT_TYPES);
const DEFAULT_LIMIT = 100;
const MAX_LIMIT = 100;

type RawBody = {
  repo?: unknown;
  eventKey?: unknown;
  type?: unknown;
  references?: unknown;
  refs?: unknown;
  actor?: unknown;
  source?: unknown;
  payload?: unknown;
  occurredAt?: unknown;
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function normalizeObject(value: unknown): Record<string, unknown> | null {
  return isRecord(value) ? value : null;
}

function parseEventType(value: unknown): JudgmentEventType | null {
  return typeof value === "string" && EVENT_TYPES.has(value)
    ? (value as JudgmentEventType)
    : null;
}

function parseLimit(value: string | null): number {
  if (value == null) return DEFAULT_LIMIT;
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed < 1) return DEFAULT_LIMIT;
  return Math.min(parsed, MAX_LIMIT);
}

function serializeEvent(event: JudgmentEventRow) {
  return {
    id: event.id,
    workspaceId: event.workspaceId,
    repo: event.repo,
    eventKey: event.eventKey,
    type: event.type,
    references: event.refs,
    actor: event.actorRef,
    source: event.sourceRef,
    payload: event.payload,
    occurredAt: event.occurredAt.toISOString(),
    createdAt: event.createdAt.toISOString(),
  };
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

export async function GET(
  request: NextRequest,
  { params }: { params: Promise<{ workspaceId: string }> }
): Promise<RouteResponse> {
  const { workspaceId } = await params;
  const member = await requireWorkspaceMember(workspaceId);
  if ("response" in member) return member.response;

  const searchParams = request.nextUrl.searchParams;
  const repo = searchParams.get("repo")?.trim();
  const typeParam = searchParams.get("type");
  const type =
    typeParam == null ? undefined : (parseEventType(typeParam) ?? undefined);
  const orderParam = searchParams.get("order");
  const order = orderParam === "desc" ? "desc" : "asc";
  const limit = parseLimit(searchParams.get("limit"));

  const errors: Record<string, string> = {};
  if (!repo) errors.repo = "repo is required";
  if (typeParam != null && type == null) {
    errors.type = `type must be one of: ${JUDGMENT_EVENT_TYPES.join(", ")}`;
  }
  if (orderParam != null && orderParam !== "asc" && orderParam !== "desc") {
    errors.order = "order must be asc or desc";
  }

  if (Object.keys(errors).length > 0) {
    return NextResponse.json({ errors }, { status: 400 });
  }

  try {
    if (!(await getRepositoryByName(workspaceId, repo!))) {
      return NextResponse.json({ error: "Repository not found" }, { status: 404 });
    }

    const events = await listJudgmentEvents({
      workspaceId,
      repo: repo!,
      type,
      order,
      limit,
    });
    return NextResponse.json({ events: events.map(serializeEvent) });
  } catch (err) {
    console.error("[judgment-events] failed to list events:", err);
    return NextResponse.json(
      { error: "Failed to load judgment events" },
      { status: 500 }
    );
  }
}

export async function POST(
  request: NextRequest,
  { params }: { params: Promise<{ workspaceId: string }> }
): Promise<RouteResponse> {
  const { workspaceId } = await params;
  const member = await requireWorkspaceMember(workspaceId);
  if ("response" in member) return member.response;

  const body = (await request.json().catch(() => ({}))) as RawBody;
  const errors: Record<string, string> = {};

  const repo = typeof body.repo === "string" ? body.repo.trim() : "";
  const eventKey =
    typeof body.eventKey === "string" ? body.eventKey.trim() : "";
  const type = parseEventType(body.type);
  const references = normalizeObject(body.references ?? body.refs);
  const actor = normalizeObject(body.actor);
  const source = normalizeObject(body.source);
  const payload = normalizeObject(body.payload);
  const occurredAt =
    typeof body.occurredAt === "string" && !Number.isNaN(Date.parse(body.occurredAt))
      ? new Date(body.occurredAt)
      : undefined;

  if (!repo) errors.repo = "repo is required";
  if (!eventKey) errors.eventKey = "eventKey is required";
  if (type == null) {
    errors.type = `type must be one of: ${JUDGMENT_EVENT_TYPES.join(", ")}`;
  }
  if (!references) errors.references = "references is required";
  if (!actor) errors.actor = "actor is required";
  if (!source) errors.source = "source is required";
  if (!payload) errors.payload = "payload is required";
  if (body.occurredAt !== undefined && occurredAt == null) {
    errors.occurredAt = "occurredAt must be an ISO timestamp";
  }

  if (Object.keys(errors).length > 0) {
    return NextResponse.json({ errors }, { status: 400 });
  }

  try {
    if (!(await getRepositoryByName(workspaceId, repo))) {
      return NextResponse.json({ error: "Repository not found" }, { status: 404 });
    }

    const result = await appendJudgmentEvent({
      workspaceId,
      repo,
      eventKey,
      type: type!,
      refs: references as JudgmentEventRefs,
      actorRef: actor as JudgmentEventRef,
      sourceRef: source as JudgmentEventRef,
      payload: payload!,
      occurredAt,
    });

    return NextResponse.json(
      { event: serializeEvent(result.event), inserted: result.inserted },
      { status: result.inserted ? 201 : 409 }
    );
  } catch (err) {
    console.error("[judgment-events] failed to append event:", err);
    return NextResponse.json(
      { error: "Failed to append judgment event" },
      { status: 500 }
    );
  }
}
