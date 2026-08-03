import { NextResponse } from "next/server";
import { getJaceSessionByEveSessionId, getChatIdentityById } from "@agentrail/db-postgres";

/**
 * Shared auth/flag/session scaffolding for the boot plane's four console
 * routes (B2b Tasks 3-4, plan docs/superpowers/plans/2026-08-02-b2b-sandbox-boot.md;
 * spec docs/superpowers/specs/2026-08-02-b2-behavioral-evidence-design.md
 * §B2b). Colocated here — a plain sibling of `route.ts` / `[id]/route.ts` /
 * `claim/route.ts` / `report/route.ts`, imported by relative path from each
 * — rather than duplicated four times or hoisted into `apps/console/lib/`.
 * Mirrors `../result/notify.ts`'s own precedent: a shared module living
 * alongside one route in a feature's directory tree, imported cross-directory
 * by that feature's other routes (`review-jobs/complete/route.ts` imports
 * `../../result/notify`).
 *
 * FLAG: `PREVIEW_BOOTS_ENABLED !== "1"` — checked by all four routes,
 * immediately after auth, before anything else. Same fail-closed idiom as
 * `review-evidence/route.ts`'s `REVIEW_EVIDENCE_ENABLED` gate.
 *
 * ENROLLMENT: `PREVIEW_BOOTS_WORKSPACES`, a comma-separated workspaceId
 * allowlist — same idiom as `webhooks/github-app/route.ts`'s own
 * `enrolledWorkspaceIds()` (`REVIEWER_OF_RECORD_WORKSPACES`). Empty/unset
 * disables the feature for EVERY workspace (dogfood-only until the
 * allowlist grows). Used only by the POST (request) route — the GET (poll)
 * route trusts `resolveWorkspaceId`'s own tenant check instead (see that
 * route's own doc-comment), and the two worker-facing routes (claim/report)
 * have no per-workspace concept at all.
 *
 * SESSION CHAIN: `resolveWorkspaceId` is a byte-for-byte copy of
 * `review-evidence/route.ts`'s own helper of the same name (post-#1569
 * identity-less semantics: a workspace-anchored session with no bound chat
 * identity resolves fine off its own `workspaceId` alone, without needing
 * `getChatIdentityById` at all) — used by both Jace-facing routes (POST
 * request, GET poll).
 */

const PREVIEW_BOOTS_ENABLED_VAR = "PREVIEW_BOOTS_ENABLED";
const PREVIEW_BOOTS_WORKSPACES_ENV = "PREVIEW_BOOTS_WORKSPACES";

export function previewBootsDisabled(): boolean {
  return process.env[PREVIEW_BOOTS_ENABLED_VAR] !== "1";
}

export function previewBootsDisabledResponse(): NextResponse {
  return NextResponse.json({ error: "preview boots not enabled" }, { status: 503 });
}

/**
 * Comma-separated, trimmed, empty entries dropped. An empty/unset env
 * disables intake for every workspace — same idiom as
 * `webhooks/github-app/route.ts`'s `enrolledWorkspaceIds()`.
 */
export function previewBootsWorkspaces(): Set<string> {
  const raw = process.env[PREVIEW_BOOTS_WORKSPACES_ENV] ?? "";
  return new Set(
    raw
      .split(",")
      .map((id) => id.trim())
      .filter((id) => id.length > 0)
  );
}

export type WorkspaceResolution =
  | { ok: true; workspaceId: string }
  | { ok: false; response: NextResponse };

/**
 * Session -> workspace resolution, identical in shape and behavior to
 * `review-evidence/route.ts`'s own `resolveWorkspaceId` (see that file's
 * doc-comment for the full post-#1569 rationale). 404 when no
 * `jace_sessions` row is bound to `eveSessionId`; 409 when neither the
 * session nor its (optional) bound chat identity carries a workspaceId.
 */
export async function resolveWorkspaceId(eveSessionId: string): Promise<WorkspaceResolution> {
  const session = await getJaceSessionByEveSessionId(eveSessionId);
  if (!session) {
    return {
      ok: false,
      response: NextResponse.json({ error: "Session not found" }, { status: 404 }),
    };
  }

  // Identity-less (Arc B review-job worker) sessions carry workspaceId
  // directly with no chatIdentityId — getChatIdentityById is only ever
  // called when there is an id to look up.
  const chatIdentityId = session.chatIdentityId ?? null;
  const identity = chatIdentityId ? await getChatIdentityById(chatIdentityId) : null;
  const workspaceId = session.workspaceId ?? identity?.workspaceId ?? null;

  if (!workspaceId) {
    return {
      ok: false,
      response: NextResponse.json(
        { error: "this conversation has no workspace yet — create one first" },
        { status: 409 }
      ),
    };
  }

  return { ok: true, workspaceId };
}
