import { NextRequest, NextResponse } from "next/server";
import {
  AcceptanceDependencyObservationClaimError,
  AcceptanceDependencyObservationConflictError,
  AcceptanceDependencyObservationInvalidEvidenceError,
  recordAcceptanceDependencyObservation,
} from "@agentrail/db-postgres";
import { requireBearer } from "../../../../../lib/bearer-auth";
import {
  parseAcceptanceDependencyObservationForStorage,
  readBoundedAcceptanceDependencyObservationJson,
} from "../../../../../lib/acceptance-dependency-observation";

/**
 * Record one bounded dependency observation against server-revalidated
 * Acceptance Record, Contract, Context Pack and exact-head custody. The
 * workspace API key supplies the tenant; the database derives and locks all
 * remaining canonical bindings.
 */
export async function POST(request: NextRequest) {
  const auth = await requireBearer(request);
  if (auth instanceof NextResponse) return auth;

  const json = await readBoundedAcceptanceDependencyObservationJson(request);
  if (!json.ok) {
    return NextResponse.json({ error: "Invalid dependency observation" }, { status: 400 });
  }
  const parsed = parseAcceptanceDependencyObservationForStorage(json.value);
  if (!parsed) {
    return NextResponse.json({ error: "Invalid dependency observation" }, { status: 400 });
  }
  if (parsed.input.workspaceId !== auth.workspaceId) {
    return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  }
  const claimToken = request.headers.get("x-agentrail-dependency-claim-token");
  if (!claimToken) {
    return NextResponse.json({ kind: "invalid_claim" }, { status: 409 });
  }

  try {
    const result = await recordAcceptanceDependencyObservation(parsed.input, {
      claimToken,
      ...(parsed.kind === "current" && parsed.sumdbCustody
        ? { goSumdbCustody: parsed.sumdbCustody }
        : {}),
    });
    switch (result.kind) {
      case "recorded":
      case "replayed":
        return NextResponse.json({
          kind: result.kind,
          status: result.observation.status,
          reasons: result.observation.reasons,
          eventId: result.observation.eventId,
          candidateFingerprint: result.observation.candidateFingerprint,
          observedAt: result.observation.observedAt.toISOString(),
        }, { status: result.kind === "recorded" ? 201 : 200 });
      case "not_found":
        return NextResponse.json({ kind: "not_found" }, { status: 404 });
      case "not_current":
        return NextResponse.json({ kind: "not_current" }, { status: 409 });
      case "not_ready":
        return NextResponse.json({ kind: "not_ready", reason: result.reason }, { status: 409 });
    }
  } catch (error) {
    if (error instanceof AcceptanceDependencyObservationInvalidEvidenceError) {
      return NextResponse.json({ error: "Invalid dependency observation" }, { status: 400 });
    }
    if (error instanceof AcceptanceDependencyObservationConflictError) {
      return NextResponse.json({ kind: "conflict" }, { status: 409 });
    }
    if (error instanceof AcceptanceDependencyObservationClaimError) {
      return NextResponse.json({ kind: "invalid_claim" }, { status: 409 });
    }
    console.error("Acceptance dependency observation storage unavailable");
    return NextResponse.json({ error: "Dependency observation unavailable" }, { status: 503 });
  }
}
