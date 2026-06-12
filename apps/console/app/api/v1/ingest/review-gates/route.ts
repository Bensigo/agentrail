/**
 * POST /api/v1/ingest/review-gates
 *
 * Upserts a review gate record in Postgres. Authenticates via bearer API key
 * (see lib/bearer-auth.ts). workspace_id comes from the API key;
 * repository_id is validated to belong to that workspace.
 *
 * Returns: 202 { ok: true }
 */
import { NextRequest, NextResponse } from "next/server";
import { getRepository, upsertReviewGate } from "@agentrail/db-postgres";
import { requireBearer } from "../../../../../lib/bearer-auth";

const VALID_STATUSES = ["passed", "failed", "pending"] as const;
type GateStatus = (typeof VALID_STATUSES)[number];

interface RawReviewGate {
  id: string;
  repository_id: string;
  run_id: string;
  gate_name: string;
  status: GateStatus;
  conditions?: Record<string, unknown>[];
  blocking_reasons?: Record<string, unknown>[];
  evidence_refs?: Array<{ label: string; url: string }>;
  evaluated_at?: string | null;
}

function isRawReviewGate(v: unknown): v is RawReviewGate {
  if (!v || typeof v !== "object") return false;
  const o = v as Record<string, unknown>;
  return (
    typeof o.id === "string" &&
    typeof o.repository_id === "string" &&
    typeof o.run_id === "string" &&
    typeof o.gate_name === "string" &&
    typeof o.status === "string" &&
    (VALID_STATUSES as readonly string[]).includes(o.status)
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

  if (!isRawReviewGate(body)) {
    return NextResponse.json(
      {
        error:
          "Body must have id (string), repository_id (string), run_id (string), gate_name (string), status (passed|failed|pending)",
      },
      { status: 400 }
    );
  }

  const gate = body;

  const repo = await getRepository(workspaceId, gate.repository_id);
  if (!repo) {
    return NextResponse.json(
      { error: `Repository ${gate.repository_id} not found in this workspace` },
      { status: 404 }
    );
  }

  try {
    await upsertReviewGate({
      id: gate.id,
      workspaceId,
      runId: gate.run_id,
      gateName: gate.gate_name,
      status: gate.status,
      conditions: gate.conditions,
      blockingReasons: gate.blocking_reasons,
      evidenceRefs: gate.evidence_refs,
      evaluatedAt: gate.evaluated_at ?? null,
    });
  } catch (err) {
    console.error("[ingest/review-gates] Postgres upsert failed:", err);
    return NextResponse.json({ error: "Upstream storage error" }, { status: 502 });
  }

  return NextResponse.json({ ok: true }, { status: 202 });
}
