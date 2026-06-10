/**
 * POST /api/v1/ingest/run-events
 *
 * Accepts a single AFK Redux-action event or an array of up to 100.
 * Authenticates via bearer API key (see lib/bearer-auth.ts).
 * workspace_id and repository_id come from the API key context —
 * they CANNOT be overridden by the request body.
 *
 * Returns: 202 { accepted: N }
 */
import { NextRequest, NextResponse } from "next/server";
import { insertAfkRunEvents } from "@agentrail/db-clickhouse";
import { requireBearer } from "../../../../../lib/bearer-auth";

interface RawEvent {
  session_id: string;
  seq: number;
  ts: string;
  kind: string;
  action: Record<string, unknown>;
  digest: string;
}

function isRawEvent(v: unknown): v is RawEvent {
  if (!v || typeof v !== "object") return false;
  const o = v as Record<string, unknown>;
  return (
    typeof o.session_id === "string" &&
    typeof o.seq === "number" &&
    typeof o.ts === "string" &&
    typeof o.kind === "string" &&
    typeof o.action === "object" &&
    o.action !== null &&
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

  const valid: RawEvent[] = [];
  for (const item of raw) {
    if (!isRawEvent(item)) {
      return NextResponse.json(
        {
          error:
            "Each event must have session_id (string), seq (number), ts (string), kind (string), action (object), digest (string)",
        },
        { status: 400 }
      );
    }
    valid.push(item);
  }

  const inputs = valid.map((ev) => ({
    workspace_id: workspaceId,
    repository_id: "", // not available from AFK CLI context in v1
    session_id: ev.session_id,
    seq: ev.seq,
    ts: ev.ts,
    kind: ev.kind,
    action: ev.action,
    digest: ev.digest,
  }));

  let accepted = 0;
  try {
    accepted = await insertAfkRunEvents(inputs);
  } catch (err) {
    console.error("[ingest/run-events] ClickHouse insert failed:", err);
    return NextResponse.json(
      { error: "Upstream storage error" },
      { status: 502 }
    );
  }

  return NextResponse.json({ accepted }, { status: 202 });
}
