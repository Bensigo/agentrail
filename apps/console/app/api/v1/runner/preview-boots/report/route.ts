import { NextRequest, NextResponse } from "next/server";
import { reportPreviewBoot } from "@agentrail/db-postgres";
import { requireJaceConsoleSecret } from "../../../../../../lib/jace-console-auth";
import { previewBootsDisabled, previewBootsDisabledResponse } from "../shared";

/**
 * POST /api/v1/runner/preview-boots/report
 *
 * B2b Task 4 (plan docs/superpowers/plans/2026-08-02-b2b-sandbox-boot.md;
 * spec docs/superpowers/specs/2026-08-02-b2-behavioral-evidence-design.md
 * §B2b §4-5). The boot plane worker's progress-report seam: resolve one
 * guarded status transition on a claimed `preview_boots` row
 * (`reportPreviewBoot`, `@agentrail/db-postgres` — one UPDATE per
 * target-status branch, each scoped `WHERE id = $ AND worker_id = $ AND
 * <status is a legal FROM state>`; see that query's own doc-comment for the
 * full per-target-state-machine rationale). Mirrors
 * `review-jobs/complete/route.ts`'s own worker-facing completion shape:
 * central-secret auth, a single required-fields 400, and a guarded-UPDATE
 * `null` result mapped to 409.
 *
 * AUTH: `requireJaceConsoleSecret` — the worker IS Jace, the same central
 * `JACE_CONSOLE_TOKEN` guard every other Jace-coordinator route uses.
 *
 * FLAG (immediately after auth): `PREVIEW_BOOTS_ENABLED !== "1"` — 503
 * (`../shared.ts`).
 *
 * BODY: `{ id, workerId, status, url?, port?, reason? }`. `id`/`workerId`
 * (non-empty strings) and `status` (one of the four legal values) are
 * required — 400 otherwise, before any db call. `url`/`port`/`reason` are
 * optional pass-through fields `reportPreviewBoot` itself only writes on the
 * relevant branch (`ready` for url/port, `failed`/`torn_down` for reason —
 * see that function's own doc-comment); a PRESENT-but-wrong-typed value for
 * any of the three is also a 400 (never a silent ignore), same posture
 * `review-jobs/complete/route.ts` uses for its own optional `evidenceKeys`.
 *
 * OWNERSHIP + STATE GUARD: entirely `reportPreviewBoot`'s own job — every
 * UPDATE it runs is scoped to BOTH the row id AND the calling `workerId`, so
 * a worker that is not the row's current claimant, or a status transition
 * that isn't legal from the row's current state (see that function's own
 * per-branch doc-comment: no going backwards from `ready` to `booting`,
 * nothing reportable once already `failed`/`torn_down`, etc.), both collapse
 * into the SAME `null` return this route maps to 409. This route does not
 * — and cannot, without duplicating that state machine — distinguish "wrong
 * worker" from "illegal transition" from "unknown id"; all three read as
 * "boot not found or not owned" to the caller.
 *
 * RESPONSE: `null` -> 409 `{error:"boot not found or not owned"}`; otherwise
 * 200 `{ok:true, status:row.status}` — the row's OWN post-transition status
 * (matters for the `ready`->`ready` idempotent liveness re-report branch,
 * where the response status always reflects what's actually stored, not
 * just an echo of the request body).
 */

const STATUSES = new Set(["booting", "ready", "failed", "torn_down"]);
type Status = "booting" | "ready" | "failed" | "torn_down";

interface ReportBody {
  id: string;
  workerId: string;
  status: Status;
  url?: string;
  port?: number;
  reason?: string;
}

const REQUIRED_FIELDS_MESSAGE =
  "id, workerId, and status ('booting'|'ready'|'failed'|'torn_down') are required";

function isNonEmptyString(v: unknown): v is string {
  return typeof v === "string" && v.trim().length > 0;
}

function isStatus(v: unknown): v is Status {
  return typeof v === "string" && STATUSES.has(v);
}

function parseReportBody(raw: unknown): ReportBody | null {
  if (!raw || typeof raw !== "object") return null;
  const o = raw as Record<string, unknown>;

  if (!isNonEmptyString(o.id)) return null;
  if (!isNonEmptyString(o.workerId)) return null;
  if (!isStatus(o.status)) return null;

  // Present-but-malformed optional fields are a 400, same posture
  // review-jobs/complete/route.ts uses for its own evidenceKeys — never a
  // silent ignore of a caller's mistake.
  if (o.url !== undefined && typeof o.url !== "string") return null;
  if (o.port !== undefined && typeof o.port !== "number") return null;
  if (o.reason !== undefined && typeof o.reason !== "string") return null;

  return {
    id: o.id,
    workerId: o.workerId,
    status: o.status,
    url: typeof o.url === "string" ? o.url : undefined,
    port: typeof o.port === "number" ? o.port : undefined,
    reason: typeof o.reason === "string" ? o.reason : undefined,
  };
}

export async function POST(request: NextRequest) {
  const authError = requireJaceConsoleSecret(request);
  if (authError) return authError;

  if (previewBootsDisabled()) {
    return previewBootsDisabledResponse();
  }

  let raw: unknown;
  try {
    raw = await request.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON" }, { status: 400 });
  }

  const body = parseReportBody(raw);
  if (!body) {
    return NextResponse.json({ error: REQUIRED_FIELDS_MESSAGE }, { status: 400 });
  }

  const row = await reportPreviewBoot({
    id: body.id,
    workerId: body.workerId,
    status: body.status,
    url: body.url,
    port: body.port,
    reason: body.reason,
  });

  if (!row) {
    return NextResponse.json({ error: "boot not found or not owned" }, { status: 409 });
  }

  return NextResponse.json({ ok: true, status: row.status }, { status: 200 });
}
