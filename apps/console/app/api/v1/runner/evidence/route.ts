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
 * DEGRADATION CONTRACT (Fix Round 1 — REPLACES the original single-shape
 * design): past the outer auth/session-resolution gate (401 for a bad/missing
 * secret, 400 for a missing `eveSessionId`, 404 for an unresolvable session —
 * all ordinary HTTP-layer failures, unrelated to the domain), the verb-query
 * path has TWO response shapes, and which one a caller gets depends on
 * whether the fan-out ever started:
 *
 *   - PRE-FAN-OUT (nothing was asked of any provider yet): a REQUEST-level
 *     problem — malformed `verb`/window params (`bad_request`), no anchored
 *     investigation to attach evidence to (`no_investigation`), or an empty
 *     declared+credentialed provider list for the verb (`no_provider`) —
 *     returns the TOP-LEVEL `EvidenceDegradation` shape,
 *     `{ degraded: true, reason }`, discriminated from the fan-out shape
 *     below by the presence of the singular `degraded` key. `bad_request` is
 *     validated FIRST, before any DB read, so a malformed request never even
 *     reaches the anchor/provider checks. Mirrors `runner/investigations`'
 *     own `mode=anchor` null-collapse (a legitimate "nothing to report" is a
 *     200, not an error status) and `fetch_run_evidence.core.mjs`'s "never
 *     throw" precedent one layer further out.
 *   - ONCE THE FAN-OUT RUNS (at least one provider was actually asked — see
 *     FAN-OUT below): the response is ALWAYS
 *     `{ envelopes: EvidenceEnvelope[], degradations: EvidenceProviderDegradation[] }`
 *     — BOTH arrays always present, either possibly empty, NEVER the
 *     top-level `{ degraded }` shape, no matter how many (including all)
 *     providers failed. `degradations` (plural array field) is a DIFFERENT
 *     thing from `EvidenceDegradation`'s singular `degraded` flag — do not
 *     conflate them; see `types.ts`'s own doc-comment on
 *     `EvidenceProviderDegradation`.
 *
 * A genuine infrastructure failure (the backing store throwing — session/
 * anchor/investigation/connector-row reads) is still a distinct 502
 * `{ error }` in EITHER phase — that is OUR fault, not a fact about the
 * investigation or its providers, and callers must not confuse the two.
 *
 * FAN-OUT: a verb query asks EVERY credentialed provider for that verb (the
 * whole point of the capability layer — the caller asks a QUESTION, not a
 * PROVIDER; "providers never the subject of a sentence" per the spec's
 * capability-voice framing). The fan-out is considered to have STARTED the
 * moment the provider list is non-empty (past the `no_provider` check) —
 * from that point on the response is unconditionally the two-array shape
 * above; there is no longer any "special-case the total-failure outcome back
 * to a top-level degradation" branch (Fix Round 1 DELETES the original
 * first-failure-wins fallback entirely — an all-providers-fail result is
 * `{ envelopes: [], degradations: [...one entry per provider...] }`, not a
 * collapsed top-level reason).
 *
 * Per provider, exactly one of five things lands in `degradations` (or
 * nothing, if it succeeds and lands in `envelopes` instead) — EVERY step in
 * this per-provider pipeline is individually guarded (Fix Round 1 + its
 * coda), on the same principle throughout: one provider's own failure, at
 * ANY point in ITS OWN pipeline, must never take down envelopes already
 * captured from OTHER providers earlier in the same fan-out, nor get
 * conflated with OUR OWN infra failing (the outer 502 below, reserved for
 * failures BEFORE the fan-out even has a provider list to iterate):
 *   1. No adapter registered for a provider the catalog/connector layer says
 *      should exist (a deploy/catalog mismatch) → `config_missing`.
 *   2. Resolving the provider's decrypted credential (`getConnectorSecret`)
 *      THROWS (a DB/decrypt failure) → `unreachable` (Fix Round 1 coda) —
 *      reuses the same reason as case 3 below rather than adding an
 *      eleventh taxonomy entry: "couldn't reach this provider's credential"
 *      and "couldn't reach this provider's upstream" are the same fact from
 *      the caller's side.
 *   3. The adapter's `query()` call THROWS instead of degrading (its own
 *      contract says it never should, but a real network call can) →
 *      `unreachable`.
 *   4. The adapter's `query()` call resolves `{ ok: false, reason }` →
 *      relayed VERBATIM, attributed to that provider.
 *   5. The adapter succeeded (raw evidence retrieved) but `captureEvidence`
 *      (scrub → cap → digest → persist) THREW while turning it into a
 *      durable item → `capture_failed` (Fix Round 1) — same reasoning as
 *      case 2/3, just one step later in the pipeline.
 *
 * 400 — missing/blank `eveSessionId`. 401 — bad/missing shared secret. 404 —
 * no session, or a session with no resolved workspace yet. 502 — the backing
 * store errored. 200 — everything else, including every degradation (both
 * the top-level and the per-provider shapes).
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
// Task 5: registers the `factory` adapter into the shared registry as a side
// effect of this import (registry.ts's own doc-comment: "T5-T7 add `import
// './factory'` ... wherever the route needs them loaded"). This route is the
// ONLY consumer of `adapterFor` at request time, so this is where every
// adapter module must be imported for its self-registration to ever run
// outside a test file that imports the adapter directly. Task 6/7 add their
// own sibling imports here the same way.
import "../../../../../lib/evidence/factory";
// Task 6: same self-registration idiom for the `github` adapter.
import "../../../../../lib/evidence/github";
// Task 7: same self-registration idiom for the `railway` adapter.
import "../../../../../lib/evidence/railway";
import {
  EVIDENCE_VERBS,
  type EvidenceDegradation,
  type EvidenceDegradationReason,
  type EvidenceEnvelope,
  type EvidenceProviderDegradation,
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

    // The fan-out has now STARTED (providers is non-empty) — from this point
    // on the response is UNCONDITIONALLY { envelopes, degradations }, never
    // the top-level { degraded } shape, no matter how many providers fail.
    // See this route's own doc-comment (Fix Round 1 — DELETES the original
    // first-failure-wins fallback entirely).
    const envelopes: EvidenceEnvelope[] = [];
    const degradations: EvidenceProviderDegradation[] = [];

    for (const provider of providers) {
      const adapter = adapterFor(provider);
      if (!adapter) {
        // Declared in the catalog but no adapter registered for it — a
        // deploy/catalog mismatch, not a fact about the investigation.
        // Attributed to THIS provider — a sibling provider with a real
        // adapter still gets its own fair shot below.
        degradations.push({ provider, reason: "config_missing" });
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
      //
      // FIX ROUND 1 CODA: guarded exactly like the adapter/capture calls
      // below — a decrypt/DB throw resolving THIS provider's secret is OUR
      // OWN infra failing, one provider earlier in the pipeline than
      // capture_failed, and must not 502 the whole fan-out or discard
      // envelopes already captured from sibling providers. Reuses
      // `unreachable` rather than adding an eleventh taxonomy entry — from
      // the caller's side, "couldn't reach this provider's credential" and
      // "couldn't reach this provider's upstream" are the same fact (this
      // provider is unreachable right now).
      let secret: string | null;
      try {
        secret = await getConnectorSecret(workspaceId, provider as ConnectorProvider);
      } catch (err) {
        console.error(`[runner/evidence] getConnectorSecret threw for provider '${provider}':`, err);
        degradations.push({ provider, reason: "unreachable" });
        continue;
      }

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

      if (!result.ok) {
        degradations.push({ provider, reason: result.reason });
        continue;
      }

      // FIX 1: guard the persistence call exactly like the adapter call
      // above — a capture failure is OUR OWN infra failing (envelope.ts's
      // scrub/cap/digest/appendEvidenceItem pipeline), NOT the adapter's
      // fault and NOT a reason to 502 the whole request or discard
      // envelopes already captured from other providers in this same
      // fan-out. Attributed to this provider as `capture_failed`.
      try {
        envelopes.push(await captureEvidence(investigationId, provider, q, result.raw));
      } catch (err) {
        console.error(`[runner/evidence] captureEvidence failed for provider '${provider}':`, err);
        degradations.push({ provider, reason: "capture_failed" });
      }
    }

    return NextResponse.json({ envelopes, degradations });
  } catch (err) {
    console.error("[runner/evidence] verb query failed:", err);
    return NextResponse.json({ error: "Upstream storage error" }, { status: 502 });
  }
}
