/**
 * POST /api/v1/runner/investigations/verdict
 *
 * The ONLY seam that ever sets an investigation's verdict — Global
 * Constraints: "The save route rejects verdict and status fields with 400.
 * Verdicts travel only through POST /api/v1/runner/investigations/verdict,
 * which runs computeVerdictEligibility server-side and fails closed." This
 * route is deliberately thin: it resolves auth/tenancy/slug, then hands the
 * decision entirely to `recordVerdict` (`packages/db-postgres/src/queries/investigations.ts`)
 * and relays exactly what it returns. No eligibility logic is duplicated
 * here — `recordVerdict` already runs its own transactional
 * `computeVerdictEligibility` check for `root_caused` and its own
 * `missingEvidence` check for `undetermined`; re-deriving either here would
 * be the same "model/route judges its own evidence" failure mode the gate
 * exists to close, just moved one layer over.
 *
 * AUTH + TENANT: identical resolution chain to `runner/investigations` (see
 * that route's own doc-comment for the full rationale) —
 * `requireJaceConsoleSecret` gates WHO may call this route;
 * `getJaceSessionByEveSessionId(eveSessionId)` resolves WHICH workspace,
 * never a caller-supplied `workspaceId`.
 *
 * `slug` resolves to an investigation id via `getInvestigationBySlug`
 * (already workspace-scoped) BEFORE `recordVerdict` is ever called, since
 * `recordVerdict` takes an id, not a slug. An unresolvable slug is a
 * routing-level 404 (the same "no investigation at that slug" 404
 * `runner/investigations`' own `mode=get` returns) — distinct from the 409 a
 * resolved-but-currently-ineligible investigation gets. `recordVerdict`
 * itself performs its own existence check too (defense in depth against the
 * rare TOCTOU where the investigation is deleted between this route's lookup
 * and the write); if that ever fires, its `{ ok: false, blocking:
 * ["investigation not found"] }` is relayed as a 409 like any other refusal
 * — a race, not a routing error, at that point.
 *
 * **Secret scan on `mechanismSummary` (Fix round 1)** — mirrors
 * `runner/investigations`' own save-route batch scan, narrowed to the one
 * free-text field this route persists. `mechanismSummary` becomes the
 * `kind: 'verdict'` item's `body` column (`recordVerdict`, Task 2), and
 * `GET /api/v1/runner/investigations` (`mode=get`/`mode=anchor`) re-serves
 * every item's `body` into model context on every future resume of this
 * investigation — the exact same read-back-path risk `runner/investigations`'
 * own doc-comment cites for scanning every prose field it writes ("a
 * credential persisted here can be exfiltrated to any run in the
 * workspace"). Scanned and rejected (422) BEFORE `getInvestigationBySlug` is
 * even called, same fail-fast-before-any-DB-round-trip posture the save
 * route uses. `missingEvidence` is deliberately NOT scanned: it lands in the
 * verdict item's `data` column — structured metadata, not model-composed
 * prose — the same "data is not free text" exemption the save route applies
 * to item `data`.
 *
 * Response: 200 `{ ok: true }` once `recordVerdict` accepts the verdict; 409
 * `{ ok: false, blocking: [...] }` for every refusal `recordVerdict` reports
 * — ineligible for `root_caused` (with the exact blocking reasons
 * `computeVerdictEligibility` produces), `root_caused` missing `confidence`,
 * or `undetermined` with an empty `missingEvidence`. **Fail closed**: there
 * is no code path here that can produce a 200 without `recordVerdict` itself
 * having said `ok: true`.
 *
 * 400 — missing/blank `eveSessionId`, invalid JSON, or a malformed body
 * (missing `slug`, missing/invalid `verdict`, invalid `confidence`, or a
 * non-string-array `missingEvidence`). 401 — bad/missing shared secret. 404 —
 * no session, a session with no resolved workspace yet, or no investigation
 * at `slug` in the caller's own workspace. 409 — `recordVerdict` refused
 * (fail closed). 422 — a credential-shaped value in `mechanismSummary`. 502 —
 * the backing store errored.
 */
import { NextRequest, NextResponse } from "next/server";
import { getJaceSessionByEveSessionId, getInvestigationBySlug, recordVerdict } from "@agentrail/db-postgres";
import type { InvestigationVerdict, VerdictConfidence } from "@agentrail/db-postgres";
import { requireJaceConsoleSecret } from "../../../../../../lib/jace-console-auth";
import { scanForSecrets, summarizeFindings } from "../../../../../../lib/secret-scan";

const INVESTIGATION_VERDICTS: readonly InvestigationVerdict[] = ["root_caused", "undetermined"];
const VERDICT_CONFIDENCES: readonly VerdictConfidence[] = ["confirmed", "probable", "circumstantial"];

interface RawVerdictBody {
  eveSessionId: string;
  slug: string;
  verdict: string;
  confidence?: string;
  mechanismSummary?: string;
  missingEvidence?: string[];
}

function isRawVerdictBody(v: unknown): v is RawVerdictBody {
  if (!v || typeof v !== "object") return false;
  const o = v as Record<string, unknown>;
  if (typeof o.eveSessionId !== "string") return false;
  if (typeof o.slug !== "string" || o.slug.trim().length === 0) return false;
  if (typeof o.verdict !== "string" || !(INVESTIGATION_VERDICTS as readonly string[]).includes(o.verdict)) {
    return false;
  }
  if (
    o.confidence !== undefined &&
    (typeof o.confidence !== "string" || !(VERDICT_CONFIDENCES as readonly string[]).includes(o.confidence))
  ) {
    return false;
  }
  if (o.mechanismSummary !== undefined && typeof o.mechanismSummary !== "string") return false;
  if (
    o.missingEvidence !== undefined &&
    (!Array.isArray(o.missingEvidence) || !(o.missingEvidence as unknown[]).every((s) => typeof s === "string"))
  ) {
    return false;
  }
  return true;
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

  if (!isRawVerdictBody(raw)) {
    return NextResponse.json(
      {
        error:
          "Body must have eveSessionId (string), slug (non-empty string), verdict (root_caused|undetermined), and optional confidence (confirmed|probable|circumstantial), mechanismSummary (string), missingEvidence (string[])",
      },
      { status: 400 }
    );
  }

  const eveSessionId = raw.eveSessionId.trim();
  if (!eveSessionId) {
    return NextResponse.json({ error: "eveSessionId is required" }, { status: 400 });
  }

  const session = await getJaceSessionByEveSessionId(eveSessionId);
  if (!session || !session.workspaceId) {
    return NextResponse.json({ error: "Session not found" }, { status: 404 });
  }
  const workspaceId = session.workspaceId;
  const slug = raw.slug.trim();

  // Secret scan on mechanismSummary — see this route's own doc-comment
  // ("Secret scan on mechanismSummary") for the read-back-path rationale.
  // Checked before any DB round trip, same fail-fast posture the save
  // route's own batch scan uses.
  if (raw.mechanismSummary) {
    const { findings } = scanForSecrets(raw.mechanismSummary);
    if (findings.length > 0) {
      const reason = summarizeFindings(findings);
      console.warn(`[runner/investigations/verdict] rejected for investigation ${slug}: ${reason}`);
      return NextResponse.json(
        { error: "Investigation content rejected: credential-shaped value detected", reason },
        { status: 422 }
      );
    }
  }

  try {
    const found = await getInvestigationBySlug(workspaceId, slug);
    if (!found) {
      return NextResponse.json({ error: `Investigation ${slug} not found` }, { status: 404 });
    }

    const result = await recordVerdict(found.investigation.id, {
      verdict: raw.verdict as InvestigationVerdict,
      confidence: raw.confidence as VerdictConfidence | undefined,
      mechanismSummary: raw.mechanismSummary,
      missingEvidence: raw.missingEvidence,
    });

    if (!result.ok) {
      return NextResponse.json({ ok: false, blocking: result.blocking }, { status: 409 });
    }
    return NextResponse.json({ ok: true }, { status: 200 });
  } catch (err) {
    console.error("[runner/investigations/verdict] write failed:", err);
    return NextResponse.json({ error: "Upstream storage error" }, { status: 502 });
  }
}
