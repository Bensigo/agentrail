/**
 * GET /api/v1/runner/evidence
 *
 * Jace's read seam for the evidence capability layer (debugging design spec:
 * docs/superpowers/specs/2026-07-29-jace-debugging-agent-design.md, spec PR
 * #1501; `.superpowers/sdd/spec.md` is the working copy this implementation
 * follows). Two independent jobs live behind ONE route because they share
 * the exact same auth/tenant preamble and both answer "what can this
 * investigation learn from the outside world right now":
 *
 *   - `mode=capabilities` — a pure catalog∩connector-row projection
 *     (`evidenceCapabilities`, `lib/evidence/registry.ts`): which providers
 *     can answer which {@link EvidenceVerb}, for THIS workspace, right now.
 *     Needs a valid session but explicitly NO anchored investigation — a
 *     capability check is "what could I look at", asked before any
 *     investigation necessarily exists yet.
 *   - a verb query (`verb=&windowStart=&windowEnd=&scope=&query=&limit=`,
 *     `mode` absent) — fans out to every credentialed provider for that verb,
 *     captures each successful raw result through `captureEvidence`
 *     (`lib/evidence/envelope.ts` — scrub → cap → digest → persist), and
 *     returns the resulting envelopes. REQUIRES an anchored investigation:
 *     evidence may not be captured off-artifact (Global Constraints: the
 *     evidence route is the only writer of `kind: 'evidence'` items, and
 *     every one of those items belongs to exactly one investigation).
 *
 * AUTH + TENANT: identical resolution chain to `runner/investigations` —
 * `requireJaceConsoleSecret` gates WHO may call this route;
 * `getJaceSessionByEveSessionId` resolves WHICH workspace, server-side, from
 * the caller-supplied `eveSessionId` — never a caller-supplied `workspaceId`.
 * A session with no anchor at all, or an intro session with no `workspaceId`
 * yet, both collapse into the same 404 (anti-enumeration posture shared with
 * every other runner route).
 *
 * The anchored-investigation re-check for the verb-query path mirrors
 * `runner/investigations`' own `mode=anchor` branch EXACTLY (see that
 * route's doc-comment, "Load-bearing difference from getBriefById"):
 * `getInvestigationById` is NOT workspace-scoped (Task 2's own doc-comment:
 * "the id IS the security boundary"), so this route re-checks
 * `investigation.workspaceId === workspaceId` itself after the fetch, and
 * treats ANY mismatch — or a dangling/never-set anchor — identically, as
 * `no_investigation`. There is deliberately no separate "wrong workspace"
 * reason in the closed degradation taxonomy: from the caller's side, a
 * foreign-workspace anchor and no anchor at all are the same fact ("nothing
 * here to attach evidence to").
 *
 * DEGRADATION CONTRACT: past the outer auth/session-resolution gate (401 for
 * a bad/missing secret, 400 for a missing `eveSessionId`, 404 for an
 * unresolvable session — all ordinary HTTP-layer failures, unrelated to the
 * domain), every other outcome of the verb-query path is a 200 whose BODY
 * discriminates success (`{ envelopes: EvidenceEnvelope[] }`) from failure
 * (`EvidenceDegradation`, i.e. `{ degraded: true, reason }`) by the presence
 * of the `degraded` key alone — mirroring `runner/investigations`' own
 * `mode=anchor` null-collapse (a legitimate "nothing to report" is a 200, not
 * an error status) and `apps/jace/agent/subagents/triage/lib/
 * fetch_run_evidence.core.mjs`'s "never throw" precedent one layer further
 * out. `bad_request` (missing/invalid `verb`, missing/invalid
 * `windowStart`/`windowEnd`) is validated FIRST, before any DB read, so a
 * malformed request never even reaches the anchor/provider checks. A genuine
 * infrastructure failure (the backing store throwing) is still a distinct
 * 502 `{ error }` — that is OUR fault, not a fact about the investigation or
 * its providers, and callers must not confuse the two.
 *
 * FAN-OUT: a verb query asks EVERY credentialed provider for that verb (the
 * whole point of the capability layer — the caller asks a QUESTION, not a
 * PROVIDER; "providers never the subject of a sentence" per the spec's
 * capability-voice framing). Each provider that succeeds contributes one
 * envelope; a provider with no registered adapter (a catalog/deploy mismatch
 * — declared but never wired up) degrades that PROVIDER as `config_missing`.
 * When at least one provider succeeds, ALL successes are returned — a
 * partial fan-out is still useful evidence, never discarded because a
 * sibling provider had a bad day. Only when EVERY attempted provider fails
 * does the route degrade the whole response, using the FIRST failure
 * encountered (providers are attempted in `evidenceCapabilities`' own
 * (catalog) order, so this is deterministic) — the closed reason set has no
 * "multiple providers failed for different reasons" shape, and Task 4 ships
 * with at most one real provider in play (the rest arrive in Tasks 5-7), so
 * this is a documented v1 choice rather than a load-bearing contract; revisit
 * if a later task's fan-out needs finer-grained per-provider reporting.
 *
 * 400 — missing/blank `eveSessionId`. 401 — bad/missing shared secret. 404 —
 * no session, or a session with no resolved workspace yet. 502 — the backing
 * store errored. 200 — everything else, including every degradation.
 */
import { NextRequest, NextResponse } from "next/server";
import {
  getJaceSessionByEveSessionId,
  getSessionInvestigationAnchor,
  getInvestigationById,
  getConnectors,
  getConnectorSecret,
  type ConnectorProvider,
} from "@agentrail/db-postgres";
import { requireJaceConsoleSecret } from "../../../../../lib/jace-console-auth";
import { CONNECTOR_CATALOG } from "../../../../(dashboard)/dashboard/[workspaceId]/connectors/components/connector-helpers";
import { adapterFor, evidenceCapabilities } from "../../../../../lib/evidence/registry";
import { captureEvidence } from "../../../../../lib/evidence/envelope";
import {
  EVIDENCE_VERBS,
  type EvidenceDegradation,
  type EvidenceDegradationReason,
  type EvidenceEnvelope,
  type EvidenceQuery,
  type EvidenceVerb,
} from "../../../../../lib/evidence/types";

function degradedResponse(reason: EvidenceDegradationReason): NextResponse {
  const body: EvidenceDegradation = { degraded: true, reason };
  return NextResponse.json(body, { status: 200 });
}

function isValidIsoDate(value: string): boolean {
  if (!value) return false;
  return !Number.isNaN(new Date(value).getTime());
}

export async function GET(request: NextRequest) {
  const authError = requireJaceConsoleSecret(request);
  if (authError) return authError;

  const eveSessionId = request.nextUrl.searchParams.get("eveSessionId")?.trim() ?? "";
  if (!eveSessionId) {
    return NextResponse.json({ error: "eveSessionId is required" }, { status: 400 });
  }

  const session = await getJaceSessionByEveSessionId(eveSessionId);
  if (!session || !session.workspaceId) {
    return NextResponse.json({ error: "Session not found" }, { status: 404 });
  }
  const workspaceId = session.workspaceId;

  const mode = request.nextUrl.searchParams.get("mode") ?? "";

  if (mode === "capabilities") {
    try {
      const connectorRows = await getConnectors(workspaceId);
      const evidence = evidenceCapabilities(CONNECTOR_CATALOG, connectorRows);
      return NextResponse.json({ evidence });
    } catch (err) {
      console.error("[runner/evidence] capabilities read failed:", err);
      return NextResponse.json({ error: "Upstream storage error" }, { status: 502 });
    }
  }

  // --- verb query path ---------------------------------------------------

  const verbParam = request.nextUrl.searchParams.get("verb") ?? "";
  if (!(EVIDENCE_VERBS as readonly string[]).includes(verbParam)) {
    return degradedResponse("bad_request");
  }
  const verb = verbParam as EvidenceVerb;

  const windowStart = request.nextUrl.searchParams.get("windowStart") ?? "";
  const windowEnd = request.nextUrl.searchParams.get("windowEnd") ?? "";
  if (!isValidIsoDate(windowStart) || !isValidIsoDate(windowEnd)) {
    return degradedResponse("bad_request");
  }

  const scope = request.nextUrl.searchParams.get("scope");
  const queryText = request.nextUrl.searchParams.get("query");
  const limitParam = request.nextUrl.searchParams.get("limit");
  const limit =
    limitParam !== null && limitParam.trim() !== "" && Number.isFinite(Number(limitParam))
      ? Number(limitParam)
      : undefined;

  const q: EvidenceQuery = {
    verb,
    windowStart,
    windowEnd,
    ...(scope !== null ? { scope } : {}),
    ...(queryText !== null ? { query: queryText } : {}),
    ...(limit !== undefined ? { limit } : {}),
  };

  try {
    // No anchored investigation on the session -> no_investigation (evidence
    // may not be captured off-artifact). See this route's doc-comment.
    const anchorId = await getSessionInvestigationAnchor(session.id);
    if (!anchorId) {
      return degradedResponse("no_investigation");
    }
    const anchored = await getInvestigationById(anchorId);
    if (!anchored || anchored.investigation.workspaceId !== workspaceId) {
      return degradedResponse("no_investigation");
    }
    const investigationId = anchored.investigation.id;

    const connectorRows = await getConnectors(workspaceId);
    const providers = evidenceCapabilities(CONNECTOR_CATALOG, connectorRows)[verb];
    if (!providers || providers.length === 0) {
      return degradedResponse("no_provider");
    }

    const envelopes: EvidenceEnvelope[] = [];
    let firstFailureReason: EvidenceDegradationReason | null = null;

    for (const provider of providers) {
      const adapter = adapterFor(provider);
      if (!adapter) {
        // Declared in the catalog but no adapter registered for it — a
        // deploy/catalog mismatch, not a fact about the investigation.
        if (!firstFailureReason) firstFailureReason = "config_missing";
        continue;
      }

      // `getConnectorSecret`'s own type still requires the closed
      // `ConnectorProvider` union, but the underlying `connectors.provider`
      // column is free TEXT specifically so a new provider (evidence or
      // otherwise) never needs an enum migration (see
      // `packages/db-postgres/src/schema/connectors.ts`'s own doc-comment).
      // `evidenceCapabilities`'s provider strings are deliberately decoupled
      // from that enum for the same reason (`registry.ts`'s doc-comment) — a
      // future evidence-only provider (e.g. Task 5's `factory`) will never be
      // a member of `ConnectorProvider` at all. This cast is the one place
      // that decoupling meets a still-narrow, pre-existing signature; it is
      // safe because the query underneath is a plain string comparison.
      const secret = await getConnectorSecret(workspaceId, provider as ConnectorProvider);

      // `EvidenceAdapter.query`'s contract is "never throw, degrade instead"
      // (its own return type has no throw case) — same discipline as
      // `fetch_run_evidence.core.mjs`'s transport call. This still guards
      // against a misbehaving adapter (a real network call CAN throw): one
      // provider's bug must not take down envelopes already captured from
      // OTHER providers earlier in this same fan-out, nor get conflated with
      // OUR OWN infra failing (the outer catch below, which is 502 — a
      // provider misbehaving is never our fault).
      let result: Awaited<ReturnType<typeof adapter.query>>;
      try {
        result = await adapter.query(workspaceId, q, secret);
      } catch (err) {
        console.error(`[runner/evidence] adapter '${provider}' threw instead of degrading:`, err);
        result = { ok: false, reason: "unreachable" };
      }

      if (result.ok) {
        envelopes.push(await captureEvidence(investigationId, provider, q, result.raw));
      } else if (!firstFailureReason) {
        firstFailureReason = result.reason;
      }
    }

    if (envelopes.length > 0) {
      return NextResponse.json({ envelopes });
    }
    return degradedResponse(firstFailureReason ?? "upstream_error");
  } catch (err) {
    console.error("[runner/evidence] verb query failed:", err);
    return NextResponse.json({ error: "Upstream storage error" }, { status: 502 });
  }
}
