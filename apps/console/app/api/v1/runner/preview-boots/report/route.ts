import { NextRequest, NextResponse } from "next/server";
import { reportPreviewBoot, setPreviewBootLogKey } from "@agentrail/db-postgres";
import { requireJaceConsoleSecret } from "../../../../../../lib/jace-console-auth";
import {
  bootLogArtifactKey,
  putArtifact,
  storageConfigured,
} from "../../../../../../lib/artifacts/store";
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
 * BODY: `{ id, workerId, status, url?, port?, reason?, bootLog? }`. `id`/`workerId`
 * (non-empty strings) and `status` (one of the four legal values) are
 * required — 400 otherwise, before any db call. `url`/`port`/`reason` are
 * optional pass-through fields `reportPreviewBoot` itself only writes on the
 * relevant branch (`ready` for url/port, `failed`/`torn_down` for reason —
 * see that function's own doc-comment); a PRESENT-but-wrong-typed value for
 * any of the three is also a 400 (never a silent ignore), same posture
 * `review-jobs/complete/route.ts` uses for its own optional `evidenceKeys`.
 * `port` specifically requires `Number.isInteger` (Fix round 1, review
 * Finding 2, Minor), not just `typeof === "number"` — the column is a
 * Postgres `integer`, and `typeof x === "number"` is true for `NaN`,
 * `Infinity`, and non-integers like `1.5`, none of which that column
 * accepts; letting one through this gate would previously reach
 * `reportPreviewBoot`'s raw `sql` template uncaught and surface as a 500
 * instead of this route's normal 400 contract.
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
 * `bootLog` is a bounded, best-effort text/plain tail. It is uploaded only
 * after the guarded transition succeeds; storage failure never changes the
 * lifecycle response. The resulting key is returned by the poll route.
 *
 * RESPONSE: `null` -> 409 `{error:"boot not found or not owned"}`; otherwise
 * 200 `{ok:true, status:row.status}` — the row's OWN post-transition status
 * (matters for the `ready`->`ready` idempotent liveness re-report branch,
 * where the response status always reflects what's actually stored, not
 * just an echo of the request body).
 */

const STATUSES = new Set(["booting", "ready", "failed", "torn_down"]);
type Status = "booting" | "ready" | "failed" | "torn_down";
const MAX_BOOT_LOG_BYTES = 256 * 1024;

interface ReportBody {
  id: string;
  workerId: string;
  status: Status;
  url?: string;
  port?: number;
  reason?: string;
  bootLog?: string;
}

const REQUIRED_FIELDS_MESSAGE =
  "id, workerId, and status ('booting'|'ready'|'failed'|'torn_down') are required";

function isNonEmptyString(v: unknown): v is string {
  return typeof v === "string" && v.trim().length > 0;
}

function isStatus(v: unknown): v is Status {
  return typeof v === "string" && STATUSES.has(v);
}

type ParseResult =
  | { ok: true; body: ReportBody }
  | { ok: false; status: number; error: string };

function parseReportBody(raw: unknown): ParseResult {
  if (!raw || typeof raw !== "object") {
    return { ok: false, status: 400, error: REQUIRED_FIELDS_MESSAGE };
  }
  const o = raw as Record<string, unknown>;

  if (!isNonEmptyString(o.id)) {
    return { ok: false, status: 400, error: REQUIRED_FIELDS_MESSAGE };
  }
  if (!isNonEmptyString(o.workerId)) {
    return { ok: false, status: 400, error: REQUIRED_FIELDS_MESSAGE };
  }
  if (!isStatus(o.status)) {
    return { ok: false, status: 400, error: REQUIRED_FIELDS_MESSAGE };
  }

  // Present-but-malformed optional fields are a 400, same posture
  // review-jobs/complete/route.ts uses for its own evidenceKeys — never a
  // silent ignore of a caller's mistake.
  if (o.url !== undefined && typeof o.url !== "string") {
    return { ok: false, status: 400, error: REQUIRED_FIELDS_MESSAGE };
  }
  // Number.isInteger, not typeof === "number" (Fix round 1, Finding 2): the
  // column is a Postgres `integer` — NaN/Infinity/1.5 must 400 here, not
  // reach the DB layer uncaught. See this file's own doc-comment.
  if (o.port !== undefined && !Number.isInteger(o.port)) {
    return { ok: false, status: 400, error: REQUIRED_FIELDS_MESSAGE };
  }
  if (o.reason !== undefined && typeof o.reason !== "string") {
    return { ok: false, status: 400, error: REQUIRED_FIELDS_MESSAGE };
  }
  if (o.bootLog !== undefined && typeof o.bootLog !== "string") {
    return { ok: false, status: 400, error: "bootLog must be a string when provided" };
  }
  if (
    typeof o.bootLog === "string" &&
    Buffer.byteLength(o.bootLog, "utf8") > MAX_BOOT_LOG_BYTES
  ) {
    return {
      ok: false,
      status: 413,
      error: `bootLog exceeds ${MAX_BOOT_LOG_BYTES} bytes`,
    };
  }

  return {
    ok: true,
    body: {
      id: o.id,
      workerId: o.workerId,
      status: o.status,
      url: typeof o.url === "string" ? o.url : undefined,
      port: typeof o.port === "number" ? o.port : undefined,
      reason: typeof o.reason === "string" ? o.reason : undefined,
      bootLog: typeof o.bootLog === "string" ? o.bootLog : undefined,
    },
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
  if (!body.ok) {
    return NextResponse.json({ error: body.error }, { status: body.status });
  }

  const row = await reportPreviewBoot({
    id: body.body.id,
    workerId: body.body.workerId,
    status: body.body.status,
    url: body.body.url,
    port: body.body.port,
    reason: body.body.reason,
  });

  if (!row) {
    return NextResponse.json({ error: "boot not found or not owned" }, { status: 409 });
  }

  if (body.body.bootLog !== undefined) {
    await storeBootLogBestEffort({
      id: row.id,
      workerId: body.body.workerId,
      workspaceId: row.workspaceId,
      repo: row.repo,
      prNumber: row.prNumber,
      headSha: row.headSha,
      bootLog: body.body.bootLog,
    });
  }

  return NextResponse.json({ ok: true, status: row.status }, { status: 200 });
}

async function storeBootLogBestEffort(input: {
  id: string;
  workerId: string;
  workspaceId: string;
  repo: string;
  prNumber: number;
  headSha: string;
  bootLog: string;
}): Promise<void> {
  if (!storageConfigured(process.env)) return;

  try {
    const key = bootLogArtifactKey({
      workspaceId: input.workspaceId,
      repo: input.repo,
      prNumber: input.prNumber,
      headSha: input.headSha,
    });
    await putArtifact(key, Buffer.from(input.bootLog, "utf8"), "text/plain");
    await setPreviewBootLogKey({
      id: input.id,
      workerId: input.workerId,
      bootLogKey: key,
    });
  } catch (err) {
    console.error("[preview-boots/report] boot log storage failed:", err);
  }
}
