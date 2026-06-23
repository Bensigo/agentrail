/**
 * POST /api/v1/ingest/eval-arm-metrics
 *
 * Accepts the eval reporter's per-arm metric rows
 * (agentrail/evals/reporter.py::arm_metric_rows) and persists them to Postgres.
 * Authenticates via bearer API key (see lib/bearer-auth.ts); workspace_id comes
 * from the API key. Idempotent per (workspace, run_id, arm).
 *
 * Body: a single row or an array of up to 100 rows, each shaped like
 *   { run_id, arm, repetitions, solved_count, failed_count, solve_rate, spread,
 *     total_input_tokens, total_output_tokens, total_cache_tokens,
 *     total_cache_creation_tokens, total_tokens, total_cost_usd,
 *     dollars_per_solved (number|null), gate_passed_count, false_green_count,
 *     false_green_rate (number|null), strata: [...] }
 *
 * NULL-vs-0.0 is load-bearing: dollars_per_solved / false_green_rate may be null
 * (undefined denominator) and are persisted as NULL, never coalesced to 0.
 *
 * Returns: 202 { accepted: N }
 */
import { NextRequest, NextResponse } from "next/server";
import { insertEvalArmMetrics, EvalArmMetricInput } from "@agentrail/db-postgres";
import { requireBearer } from "../../../../../lib/bearer-auth";

interface RawEvalArmMetric {
  run_id: string;
  arm: string;
  repetitions: number;
  solved_count: number;
  failed_count: number;
  solve_rate: number;
  spread: number;
  total_input_tokens: number;
  total_output_tokens: number;
  total_cache_tokens: number;
  total_cache_creation_tokens: number;
  total_tokens: number;
  total_cost_usd: number;
  dollars_per_solved: number | null;
  gate_passed_count: number;
  false_green_count: number;
  false_green_rate: number | null;
  strata?: Array<Record<string, unknown>>;
}

function isNum(v: unknown): v is number {
  return typeof v === "number" && Number.isFinite(v);
}

/** A nullable numeric field: a real number OR explicit null (undefined denominator). */
function isNullableNum(v: unknown): v is number | null {
  return v === null || isNum(v);
}

function isRawEvalArmMetric(v: unknown): v is RawEvalArmMetric {
  if (!v || typeof v !== "object") return false;
  const o = v as Record<string, unknown>;
  return (
    typeof o.run_id === "string" &&
    o.run_id.length > 0 &&
    typeof o.arm === "string" &&
    o.arm.length > 0 &&
    isNum(o.repetitions) &&
    isNum(o.solved_count) &&
    isNum(o.failed_count) &&
    isNum(o.solve_rate) &&
    isNum(o.spread) &&
    isNum(o.total_input_tokens) &&
    isNum(o.total_output_tokens) &&
    isNum(o.total_cache_tokens) &&
    isNum(o.total_cache_creation_tokens) &&
    isNum(o.total_tokens) &&
    isNum(o.total_cost_usd) &&
    isNullableNum(o.dollars_per_solved) &&
    isNum(o.gate_passed_count) &&
    isNum(o.false_green_count) &&
    isNullableNum(o.false_green_rate) &&
    (o.strata === undefined || Array.isArray(o.strata))
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

  const raw: unknown[] = Array.isArray(body) ? body : [body];
  if (raw.length === 0 || raw.length > 100) {
    return NextResponse.json(
      { error: "Batch must contain 1–100 rows" },
      { status: 400 }
    );
  }

  const valid: RawEvalArmMetric[] = [];
  for (const item of raw) {
    if (!isRawEvalArmMetric(item)) {
      return NextResponse.json(
        {
          error:
            "Each row must have run_id (string), arm (string), integer/number counts and rates; dollars_per_solved and false_green_rate may be null",
        },
        { status: 400 }
      );
    }
    valid.push(item);
  }

  const rows: EvalArmMetricInput[] = valid.map((r) => ({
    runId: r.run_id,
    arm: r.arm,
    repetitions: r.repetitions,
    solvedCount: r.solved_count,
    failedCount: r.failed_count,
    solveRate: r.solve_rate,
    spread: r.spread,
    totalInputTokens: r.total_input_tokens,
    totalOutputTokens: r.total_output_tokens,
    totalCacheTokens: r.total_cache_tokens,
    totalCacheCreationTokens: r.total_cache_creation_tokens,
    totalTokens: r.total_tokens,
    totalCostUsd: r.total_cost_usd,
    dollarsPerSolved: r.dollars_per_solved,
    gatePassedCount: r.gate_passed_count,
    falseGreenCount: r.false_green_count,
    falseGreenRate: r.false_green_rate,
    strata: r.strata ?? [],
  }));

  let accepted = 0;
  try {
    accepted = await insertEvalArmMetrics({ workspaceId, rows });
  } catch (err) {
    console.error("[ingest/eval-arm-metrics] Postgres insert failed:", err);
    return NextResponse.json({ error: "Upstream storage error" }, { status: 502 });
  }

  return NextResponse.json({ accepted }, { status: 202 });
}
