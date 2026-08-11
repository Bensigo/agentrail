import { NextRequest, NextResponse } from "next/server";
import {
  createDraftAcceptanceRecordFromDependencyObservation,
  dependencyObservationDraftErrorCodes,
  type DependencyObservationDraftErrorCode,
} from "@agentrail/db-postgres";
import { requireJaceConsoleSecret } from "../../../../../lib/jace-console-auth";
import {
  parseDependencyObservationDraftLocator,
  readDependencyObservationDraftJson,
} from "../../../../../lib/dependency-observation-draft";

function knownDraftErrorCode(error: unknown): DependencyObservationDraftErrorCode | null {
  if (!error || typeof error !== "object" || Array.isArray(error)) return null;
  const code = (error as Record<string, unknown>)["code"];
  return typeof code === "string"
    && dependencyObservationDraftErrorCodes.includes(code as DependencyObservationDraftErrorCode)
    ? code as DependencyObservationDraftErrorCode
    : null;
}

/**
 * Projects one already-recorded dependency candidate onto the Acceptance
 * spine as a draft only. The request fields are locators; the database
 * re-reads repository, observation, candidate, profile, baseline, paths and
 * hashes before it creates anything.
 *
 * This route never confirms a Contract, requests approval, notifies Telegram,
 * creates an issue/PR/Pack, selects a builder, queues work, edits a dependency,
 * or merges code. All release, runtime, target-lock, security, confirmation,
 * approval and delivery evidence remains unresolved.
 */
export async function POST(request: NextRequest) {
  const unauthorized = requireJaceConsoleSecret(request);
  if (unauthorized) return unauthorized;

  const body = await readDependencyObservationDraftJson(request);
  if (!body.ok) {
    return NextResponse.json(
      { error: "Dependency observation draft locator is invalid" },
      { status: 400 }
    );
  }
  const locator = parseDependencyObservationDraftLocator(body.value);
  if (!locator) {
    return NextResponse.json(
      {
        error:
          "workspaceId and watchId must be canonical UUIDs and candidateFingerprint must be a lowercase sha256 digest; no candidate or evidence fields are accepted",
      },
      { status: 400 }
    );
  }

  try {
    const draft = await createDraftAcceptanceRecordFromDependencyObservation(locator);
    return NextResponse.json(
      {
        record: { id: draft.record.id, repo: draft.record.repo },
        contract: {
          id: draft.contract.id,
          version: draft.contract.version,
          status: "draft",
        },
        profile: draft.profile,
        evidence: {
          status: "unresolved",
          message:
            "This draft records observation-proposal custody only. Release, usage, runtime, target-lock, security, human confirmation, approval, Context Pack, builder handoff, delivery, pull request and merge remain unproven.",
        },
      },
      { status: draft.created ? 201 : 200 }
    );
  } catch (error) {
    const code = knownDraftErrorCode(error);
    if (code === "not_found") {
      return NextResponse.json(
        { error: "Dependency observation not found" },
        { status: 404 }
      );
    }
    if (code === "unsupported_manager") {
      return NextResponse.json(
        {
          error: "Dependency manager has no admitted proposal-observation profile",
          reason: "unsupported_manager",
          capability: "unavailable",
        },
        { status: 409 }
      );
    }
    if (code === "unsafe_custody") {
      return NextResponse.json(
        {
          error: "Dependency observation custody is unsafe for drafting",
          reason: "unsafe_custody",
          capability: "unavailable",
        },
        { status: 409 }
      );
    }
    if (code === "conflict") {
      return NextResponse.json(
        { error: "Dependency observation is already bound to a different draft" },
        { status: 409 }
      );
    }
    console.error("[runner/dependency-upgrade-proposals] draft storage unavailable");
    return NextResponse.json(
      { error: "Dependency observation draft storage is temporarily unavailable" },
      { status: 503 }
    );
  }
}
