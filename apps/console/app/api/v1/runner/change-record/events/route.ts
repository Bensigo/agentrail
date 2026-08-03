import { NextRequest, NextResponse } from "next/server";
import {
  appendChangeRecordEvent,
  findOrCreateChangeRecord,
  getChatIdentityById,
  getJaceSessionByEveSessionId,
  getRepositoryByName,
} from "@agentrail/db-postgres";
import { requireJaceConsoleSecret } from "../../../../../../lib/jace-console-auth";

/**
 * POST /api/v1/runner/change-record/events
 *
 * Arc D append seam. Producers attach already-created evidence to the
 * canonical Change Record by workspace-scoped anchors only:
 * `eveSessionId -> workspace`, `repo` must be connected to that workspace,
 * and the caller supplies `issueNumber` and/or `prNumber`. The route never
 * accepts a record id from the wire, so callers cannot write across tenants
 * by guessing durable ids.
 */

const MAX_EVENT_KEY_LENGTH = 160;
const MAX_STAGE_LENGTH = 48;
const MAX_ACTOR_LENGTH = 96;
const MAX_PAYLOAD_REF_BYTES = 8 * 1024;
const REPO_SEGMENT_PATTERN = /^[A-Za-z0-9][A-Za-z0-9_.-]*$/;
const SIMPLE_TOKEN_PATTERN = /^[A-Za-z0-9][A-Za-z0-9_.:/@-]*$/;

interface ChangeRecordEventBody {
  eveSessionId: string;
  repo: string;
  issueNumber?: number | null;
  prNumber?: number | null;
  eventKey: string;
  stage: string;
  actor: string;
  payloadRef: Record<string, unknown>;
  headShas?: string[];
  mergedSha?: string | null;
  state?: string;
  at?: Date;
}

type WorkspaceResolution =
  | { ok: true; workspaceId: string }
  | { ok: false; response: NextResponse };

function isNonEmptyString(v: unknown): v is string {
  return typeof v === "string" && v.trim().length > 0;
}

function isPositiveInteger(v: unknown): v is number {
  return typeof v === "number" && Number.isInteger(v) && v > 0;
}

function isPlainObject(v: unknown): v is Record<string, unknown> {
  return (
    v != null &&
    typeof v === "object" &&
    !Array.isArray(v) &&
    Object.getPrototypeOf(v) === Object.prototype
  );
}

function jsonByteLength(value: unknown): number | null {
  try {
    return Buffer.byteLength(JSON.stringify(value), "utf8");
  } catch {
    return null;
  }
}

function parseOptionalStringArray(v: unknown): string[] | undefined | null {
  if (v === undefined) return undefined;
  if (!Array.isArray(v)) return null;
  const trimmed = v
    .map((item) => (typeof item === "string" ? item.trim() : ""))
    .filter(Boolean);
  if (trimmed.length !== v.length) return null;
  return Array.from(new Set(trimmed)).slice(0, 16);
}

function parseOptionalIsoDate(v: unknown): Date | undefined | null {
  if (v === undefined) return undefined;
  if (!isNonEmptyString(v)) return null;
  const date = new Date(v);
  return Number.isNaN(date.getTime()) ? null : date;
}

function parseChangeRecordEventBody(raw: unknown): ChangeRecordEventBody | null {
  if (!raw || typeof raw !== "object") return null;
  const o = raw as Record<string, unknown>;

  if (!isNonEmptyString(o.eveSessionId)) return null;
  if (!isNonEmptyString(o.repo)) return null;
  if (!isNonEmptyString(o.eventKey)) return null;
  if (!isNonEmptyString(o.stage)) return null;
  if (!isNonEmptyString(o.actor)) return null;
  if (!isPlainObject(o.payloadRef)) return null;

  const rawIssueNumber =
    o.issueNumber === undefined || o.issueNumber === null ? null : o.issueNumber;
  const rawPrNumber = o.prNumber === undefined || o.prNumber === null ? null : o.prNumber;
  if (rawIssueNumber === null && rawPrNumber === null) return null;
  if (rawIssueNumber !== null && !isPositiveInteger(rawIssueNumber)) return null;
  if (rawPrNumber !== null && !isPositiveInteger(rawPrNumber)) return null;
  const issueNumber = rawIssueNumber as number | null;
  const prNumber = rawPrNumber as number | null;

  const headShas = parseOptionalStringArray(o.headShas);
  if (headShas === null) return null;

  const at = parseOptionalIsoDate(o.at);
  if (at === null) return null;

  return {
    eveSessionId: o.eveSessionId.trim(),
    repo: o.repo.trim(),
    issueNumber,
    prNumber,
    eventKey: o.eventKey.trim(),
    stage: o.stage.trim(),
    actor: o.actor.trim(),
    payloadRef: o.payloadRef,
    headShas,
    mergedSha: isNonEmptyString(o.mergedSha) ? o.mergedSha.trim() : null,
    state: isNonEmptyString(o.state) ? o.state.trim() : undefined,
    at,
  };
}

function validateBoundedFields(body: ChangeRecordEventBody): NextResponse | null {
  const [owner, name, extra] = body.repo.split("/");
  if (
    extra !== undefined ||
    !owner ||
    !name ||
    !REPO_SEGMENT_PATTERN.test(owner) ||
    !REPO_SEGMENT_PATTERN.test(name)
  ) {
    return NextResponse.json({ error: "repo must be owner/name" }, { status: 400 });
  }
  if (
    body.eventKey.length > MAX_EVENT_KEY_LENGTH ||
    !SIMPLE_TOKEN_PATTERN.test(body.eventKey)
  ) {
    return NextResponse.json({ error: "eventKey is invalid" }, { status: 400 });
  }
  if (body.stage.length > MAX_STAGE_LENGTH || !SIMPLE_TOKEN_PATTERN.test(body.stage)) {
    return NextResponse.json({ error: "stage is invalid" }, { status: 400 });
  }
  if (body.actor.length > MAX_ACTOR_LENGTH || !SIMPLE_TOKEN_PATTERN.test(body.actor)) {
    return NextResponse.json({ error: "actor is invalid" }, { status: 400 });
  }
  if (body.state && (body.state.length > 32 || !SIMPLE_TOKEN_PATTERN.test(body.state))) {
    return NextResponse.json({ error: "state is invalid" }, { status: 400 });
  }

  const payloadBytes = jsonByteLength(body.payloadRef);
  if (payloadBytes == null) {
    return NextResponse.json({ error: "payloadRef must be JSON serializable" }, { status: 400 });
  }
  if (payloadBytes > MAX_PAYLOAD_REF_BYTES) {
    return NextResponse.json({ error: "payloadRef exceeds the 8KB size cap" }, { status: 413 });
  }
  return null;
}

async function resolveWorkspaceId(eveSessionId: string): Promise<WorkspaceResolution> {
  const session = await getJaceSessionByEveSessionId(eveSessionId);
  if (!session) {
    return {
      ok: false,
      response: NextResponse.json({ error: "Session not found" }, { status: 404 }),
    };
  }

  const chatIdentityId = session.chatIdentityId ?? null;
  const identity = chatIdentityId ? await getChatIdentityById(chatIdentityId) : null;
  const workspaceId = session.workspaceId ?? identity?.workspaceId ?? null;

  if (!workspaceId) {
    return {
      ok: false,
      response: NextResponse.json(
        { error: "this conversation has no workspace yet - create one first" },
        { status: 409 }
      ),
    };
  }

  return { ok: true, workspaceId };
}

export async function POST(request: NextRequest) {
  const authError = requireJaceConsoleSecret(request);
  if (authError) return authError;

  let raw: unknown;
  try {
    raw = await request.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON" }, { status: 400 });
  }

  const body = parseChangeRecordEventBody(raw);
  if (!body) {
    return NextResponse.json(
      {
        error:
          "eveSessionId, repo, issueNumber or prNumber, eventKey, stage, actor, and payloadRef are required",
      },
      { status: 400 }
    );
  }

  const invalid = validateBoundedFields(body);
  if (invalid) return invalid;

  const resolved = await resolveWorkspaceId(body.eveSessionId);
  if (!resolved.ok) return resolved.response;
  const { workspaceId } = resolved;

  const connectedRepo = await getRepositoryByName(workspaceId, body.repo);
  if (!connectedRepo) {
    return NextResponse.json({ error: "repo not connected to this workspace" }, { status: 404 });
  }

  try {
    const record = await findOrCreateChangeRecord({
      workspaceId,
      repo: body.repo,
      issueNumber: body.issueNumber,
      prNumber: body.prNumber,
      headShas: body.headShas,
      mergedSha: body.mergedSha,
      state: body.state,
    });
    const { event, inserted } = await appendChangeRecordEvent({
      recordId: record.id,
      eventKey: body.eventKey,
      stage: body.stage,
      actor: body.actor,
      payloadRef: body.payloadRef,
      at: body.at,
    });

    return NextResponse.json(
      {
        ok: true,
        record: {
          id: record.id,
          workspaceId: record.workspaceId,
          repo: record.repo,
          issueNumber: record.issueNumber,
          prNumber: record.prNumber,
          state: record.state,
        },
        event: {
          id: event.id,
          recordId: event.recordId,
          eventKey: event.eventKey,
          stage: event.stage,
          actor: event.actor,
          payloadRef: event.payloadRef,
          at: event.at.toISOString(),
        },
        inserted,
      },
      { status: 200 }
    );
  } catch (err) {
    console.error("[runner/change-record/events] append failed:", err);
    return NextResponse.json(
      { error: "failed to append change record event" },
      { status: 503 }
    );
  }
}
