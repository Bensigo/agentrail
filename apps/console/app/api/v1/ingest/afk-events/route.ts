/**
 * POST /api/v1/ingest/afk-events
 *
 * Accepts a single AFK flight-recorder event or an array of up to 100.
 * Each event is a raw events.jsonl line: { v, session, seq, ts, kind, action?, state?, digest }.
 * Authenticates via bearer API key (see lib/bearer-auth.ts).
 * workspace_id comes from the API key context — it CANNOT be overridden by
 * the request body.
 *
 * Returns: 202 { accepted: N, duplicate: N }
 */
import { NextRequest, NextResponse } from "next/server";
import { insertFlightRecorderEvents } from "@agentrail/db-clickhouse";
import { requireBearer } from "../../../../../lib/bearer-auth";

interface RawFlightEvent {
  v: number;
  session: string;
  seq: number;
  ts: string;
  kind: string;
  action?: Record<string, unknown>;
  state?: Record<string, unknown>;
  digest: string;
}

function isRawFlightEvent(v: unknown): v is RawFlightEvent {
  if (!v || typeof v !== "object") return false;
  const o = v as Record<string, unknown>;
  return (
    typeof o.v === "number" &&
    typeof o.session === "string" &&
    typeof o.seq === "number" &&
    typeof o.ts === "string" &&
    typeof o.kind === "string" &&
    typeof o.digest === "string"
  );
}

export async function POST(req: NextRequest) {
  const auth = await requireBearer(req);
  if (auth instanceof NextResponse) return auth;

  const { workspaceId } = auth;

  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON" }, { status: 400 });
  }

  // Normalise to array.
  const raw: unknown[] = Array.isArray(body) ? body : [body];

  if (raw.length === 0 || raw.length > 100) {
    return NextResponse.json(
      { error: "Batch must contain 1–100 events" },
      { status: 400 }
    );
  }

  const valid: RawFlightEvent[] = [];
  for (const item of raw) {
    if (!isRawFlightEvent(item)) {
      return NextResponse.json(
        {
          error:
            "Each event must have v (number), session (string), seq (number), ts (string), kind (string), digest (string)",
        },
        { status: 400 }
      );
    }
    valid.push(item);
  }

  const inputs = valid.map((ev) => ({
    workspace_id: workspaceId,
    v: ev.v,
    session: ev.session,
    seq: ev.seq,
    ts: ev.ts,
    kind: ev.kind,
    action: ev.action,
    state: ev.state,
    digest: ev.digest,
  }));

  let result: { accepted: number; duplicate: number };
  try {
    result = await insertFlightRecorderEvents(inputs);
  } catch (err) {
    console.error("[ingest/afk-events] ClickHouse insert failed:", err);
    return NextResponse.json(
      { error: "Upstream storage error" },
      { status: 502 }
    );
  }

  return NextResponse.json(
    { accepted: result.accepted, duplicate: result.duplicate },
    { status: 202 }
  );
}
