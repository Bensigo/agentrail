import { NextRequest, NextResponse } from "next/server";
import {
  getApprovalById,
  getJaceSessionByEveSessionId,
  stampPublishedIssueUrl,
  hasInvestigationIssueLink,
  linkInvestigationIssue,
} from "@agentrail/db-postgres";
import type { InvestigationIssueRole } from "@agentrail/db-postgres";
import { requireJaceConsoleSecret } from "../../../../../../../lib/jace-console-auth";

/**
 * POST /api/v1/runner/approvals/[id]/published
 *
 * #1274 PR ② — the chat-born one-confirm collapse's own write: stamps the
 * REAL GitHub issue URL a `create_issue` tool call produced onto its own
 * (already-approved) approval row. This is what lets
 * `enqueueGithubIssue`'s confirmed-brief lookup (`@agentrail/db-postgres`)
 * recognize the SAME issue arriving later via the label webhook and admit
 * it straight to `queued` with the sanctioned budget/model, instead of
 * parking it for a second, redundant alignment confirm (issue #1274 AC2,
 * "exactly one confirm from idea to queued").
 *
 * Called from `apps/jace/agent/lib/create_issue.core.mjs`, BEST-EFFORT,
 * AFTER the CLI has actually created the issue — see that file for the "a
 * failed stamp must never fail the tool result" fail-safe direction. A
 * stamp that never lands just means the label webhook parks the entry for
 * a second confirm later — safe, only redundant.
 *
 * AUTH mirrors POST /api/v1/runner/approvals' own resolution chain (this
 * route's sibling, the ONLY other route in this seam that resolves tenant
 * via an eveSessionId rather than trusting an opaque id alone): the central
 * `JACE_CONSOLE_TOKEN` secret via `requireJaceConsoleSecret` (see that
 * helper's own doc-comment for the auth-model swap from a per-workspace
 * bearer), PLUS the target approval's OWN `eveSessionId` resolved through
 * the `jace_sessions` ledger — collapsed to the SAME indistinguishable 404
 * that route uses (an unknown id, or an id whose owning session has no
 * anchor, read identically to the caller). Pre-central-secret this also
 * cross-checked the bearer's own workspace; that check is gone for the same
 * reason `runner/approvals/route.ts` dropped it (see that route's
 * doc-comment) — there is no longer a caller-specific workspace to compare
 * against. Unlike `GET .../approvals/[id]` (which trusts the opaque uuid
 * ALONE, documented there as sufficient for a READ), this is a WRITE — `id`
 * alone is not treated as a sufficient security boundary here, which is why
 * the session/anchor check below still runs even though the cross-tenant
 * half of it fell away.
 *
 * Body: `{ url }`. `url` MUST match the EXACT shape
 * `githubIssueUrl()` (`@agentrail/db-postgres`) produces —
 * `https://github.com/<owner>/<repo>/issues/<n>` — validated by regex
 * BEFORE any write, never trusted as opaque caller text. This is the
 * "tighten if needed" the #1274 PR② brief calls for: the confirmed-brief
 * lookup this stamp feeds is an EXACT STRING match against
 * `published_issue_url` (see `findConfirmedAlignmentBriefApproval` in
 * `github_intake.ts`) — that lookup was already safe against a
 * title-forged match (it compares a value computed ONLY from
 * repoFullName+number, never from title/body text), but this endpoint adds
 * a second, independent belt-and-suspenders check on the WRITE side: an
 * off-shape `url` can never even be written, regardless of what produced
 * it.
 *
 * ONLY an APPROVED approval can be stamped. Idempotent: re-stamping the
 * SAME value is a no-op 200 (a retried tool-side call, or a network blip
 * after a stamp that actually landed). A DIFFERENT already-stamped value,
 * or an approval that isn't approved, is a 409 conflict, logged loudly —
 * one approval produces at most one issue, so either case is treated as
 * suspicious rather than silently overwritten or silently accepted.
 *
 * ONLY a `create_issue` approval can be stamped at all (#1274 PR ② fix
 * round, finding I1) — see the check below for the posture rationale, and
 * `findConfirmedAlignmentBriefApproval` (`@agentrail/db-postgres`,
 * github_intake.ts) for the read-side half of the same belt-and-braces
 * fix.
 *
 * ACCEPTED RESIDUAL (reviewer-named, documented not fixed): a bearer
 * holder redirecting a GENUINE create_issue approval's stamp to a
 * DIFFERENT issue in the same workspace is inherent to the bearer-trust
 * contract — the console has no independent way to verify which issue the
 * CLI actually created for this approval (the CLI talks straight to
 * GitHub; nothing flows back through the console except this very stamp).
 * The bearer IS the workspace's trusted runner credential; a compromised
 * bearer can already do strictly worse things (claim work, post results).
 */

const GITHUB_ISSUE_URL_RE = /^https:\/\/github\.com\/[^/\s]+\/[^/\s]+\/issues\/\d+$/;

interface RawBody {
  url: string;
}

function isRawBody(value: unknown): value is RawBody {
  if (!value || typeof value !== "object") return false;
  const body = value as Record<string, unknown>;
  return typeof body["url"] === "string" && body["url"].length > 0;
}

// ---------------------------------------------------------------------------
// Task 12 (debugging design spec, spec PR #1501) — investigation issue-link
// stamping, RESULT half. `POST /api/v1/runner/approvals/route.ts` (the
// REQUEST-time half — see that route's own doc-comment) stamps a
// server-computed `_investigation: { id, role }` onto a `create_issue`
// approval's `toolInput` BEFORE the human ever sees it, when the requesting
// session was anchored to an investigation. This is the OTHER half: once
// that approval is actually stamped with the real GitHub issue url (this
// endpoint's own job, above), turn that marker into a durable
// `investigation_issue_links` row — the row that actually records which
// issue an investigation's handoff produced. `brief_work_links` shipped with
// no production caller and stayed permanently dead (see that table's own
// doc-comment) — this seam exists specifically so the investigation twin
// does not repeat that.
// ---------------------------------------------------------------------------

const GITHUB_ISSUE_URL_CAPTURE_RE = /^https:\/\/github\.com\/([^/\s]+)\/([^/\s]+)\/issues\/(\d+)$/;

/**
 * Parse `{owner}/{repo}` + issue number out of a canonical GitHub issue URL
 * — a capturing sibling of this file's own `GITHUB_ISSUE_URL_RE` (same
 * shape, deliberately, not independently maintained). `null` on anything
 * that doesn't match. EXPORTED, breaking from this file's usual
 * unexported-helper convention, purely so the non-matching branch has a
 * direct test: by the time a live request reaches the "stamped" case below,
 * `body.url` has ALREADY passed `GITHUB_ISSUE_URL_RE` (the same shape), so
 * this function can never actually return `null` there — the defensive
 * branch exists for `stampInvestigationIssueLink`'s own robustness (e.g.
 * against a future call site that doesn't pre-validate), not because today's
 * POST handler can produce one.
 */
export function parseGithubIssueUrl(url: string): { repo: string; issueNumber: number } | null {
  const match = url.match(GITHUB_ISSUE_URL_CAPTURE_RE);
  if (!match) return null;
  const [, owner, repoName, numberStr] = match;
  const issueNumber = Number(numberStr);
  if (!owner || !repoName || !Number.isFinite(issueNumber)) return null;
  return { repo: `${owner}/${repoName}`, issueNumber };
}

interface StampedInvestigationLink {
  id: string;
  role: InvestigationIssueRole;
}

/** Shape guard for the `_investigation` marker `runner/approvals/route.ts` stamps — never trusts the JSONB `tool_input` blob's shape blindly. */
function isStampedInvestigationLink(value: unknown): value is StampedInvestigationLink {
  if (!value || typeof value !== "object") return false;
  const v = value as Record<string, unknown>;
  return (
    typeof v["id"] === "string" &&
    v["id"].length > 0 &&
    (v["role"] === "mitigative" || v["role"] === "preventative")
  );
}

/**
 * Write the `investigation_issue_links` row this handoff produced, when the
 * just-stamped approval's `toolInput` carries a server-computed
 * `_investigation` marker (written by `runner/approvals/route.ts`, never by
 * the model — see that route's own INJECTION GUARD). Absent or malformed
 * marker (the overwhelming common case — most issues aren't
 * investigation-linked at all) is a silent no-op: not every create_issue
 * approval carries one, and that is not an error.
 *
 * BEST-EFFORT, same posture as the stamp this runs after (Global Constraints
 * / Task 12 pin 3): the issue is already real by the time this runs, so
 * NOTHING here may ever fail the request — a non-matching url, a store
 * error, anything — all just `console.warn` and return. A missing link is
 * recoverable; a failed create_issue response would not be.
 *
 * IDEMPOTENT: `stampPublishedIssueUrl`'s own `"stamped"` outcome covers BOTH
 * a fresh stamp and a same-value replay (see that function's doc-comment in
 * `queries/jace_sessions.ts`), so this endpoint can genuinely run twice for
 * the same approval. Guarded with `hasInvestigationIssueLink` (Task 12's own
 * tiny addition to `queries/investigations.ts`) rather than assuming
 * `stampPublishedIssueUrl`'s idempotency implies this call only ever
 * happens once — it does not.
 *
 * EXPORTED, breaking from this file's usual unexported-helper convention,
 * so the URL-non-matching branch (defensively unreachable through a live
 * POST — see `parseGithubIssueUrl`'s own doc-comment) has a direct test.
 */
export async function stampInvestigationIssueLink(
  toolInput: Record<string, unknown>,
  url: string
): Promise<void> {
  const marker = toolInput["_investigation"];
  if (!isStampedInvestigationLink(marker)) return;

  const parsed = parseGithubIssueUrl(url);
  if (!parsed) {
    console.warn(
      `[runner/approvals/published] _investigation present (investigation ${marker.id}) but url "${url}" is not a canonical GitHub issue URL; skipping investigation_issue_links write`
    );
    return;
  }

  try {
    const alreadyLinked = await hasInvestigationIssueLink(marker.id, parsed.repo, parsed.issueNumber);
    if (alreadyLinked) return;
    await linkInvestigationIssue(marker.id, parsed.repo, parsed.issueNumber, marker.role);
  } catch (err) {
    console.warn(
      `[runner/approvals/published] failed to write investigation_issue_links for investigation ${marker.id}, ${parsed.repo}#${parsed.issueNumber} — the issue itself was created successfully, only the link is missing:`,
      err
    );
  }
}

export async function POST(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const authError = requireJaceConsoleSecret(request);
  if (authError) {
    return authError;
  }

  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON" }, { status: 400 });
  }
  if (!isRawBody(body)) {
    return NextResponse.json(
      { error: "Body must have url (non-empty string)" },
      { status: 400 }
    );
  }
  if (!GITHUB_ISSUE_URL_RE.test(body.url)) {
    return NextResponse.json(
      {
        error:
          "url must be a canonical GitHub issue URL (https://github.com/<owner>/<repo>/issues/<n>)",
      },
      { status: 400 }
    );
  }

  const { id } = await params;
  const approval = await getApprovalById(id);
  if (!approval) {
    return NextResponse.json({ error: "Approval not found" }, { status: 404 });
  }

  // #1274 PR ② fix round (I1): this endpoint's resource space is
  // create_issue approvals ONLY. Any other tool's approval — an
  // alignment_brief row (whose sanction rides queue_entry_id ->
  // confirmAlignmentBrief, never a URL), create_workspace, create_repo —
  // is treated as NOT FOUND, folded into the same indistinguishable 404 as
  // an unknown id rather than the 409 family: the 409s below are for a row
  // this endpoint COULD stamp in some state (a pending row can still be
  // approved), whereas a wrong-toolName row can NEVER become stampable,
  // and revealing row-type to a bearer probing ids has no legitimate use
  // (same anti-enumeration posture as the tenant check below). Checked
  // BEFORE the session resolution so a non-create_issue id doesn't even
  // exercise that lookup.
  if (approval.toolName !== "create_issue") {
    console.error(
      `[runner/approvals/published] approval ${id} has toolName ${approval.toolName}, not create_issue; refusing to stamp (returned as 404)`
    );
    return NextResponse.json({ error: "Approval not found" }, { status: 404 });
  }

  // Same resolution chain as POST /api/v1/runner/approvals — sourced from
  // the approval's OWN stored eveSessionId (already known once fetched by
  // id) rather than a caller-supplied one.
  //
  // NULL-workspace note (#1274 PR ② fix round, M3 — UPDATED for the
  // central-secret auth model): an approval anchored to an intro
  // (chat-identity-only) session passes this check — `workspaceId` null,
  // `chatIdentityId` present, so `hasNoAnchor` is false. M3 originally
  // accepted this as defacement-grade-only under the OLD per-workspace-bearer
  // model, reasoning that a mismatched bearer could stamp a workspace-less
  // row but never a resolved-workspace one (that case was blocked by a
  // `crossTenant` check compared against the bearer's own `workspaceId`).
  // That `crossTenant` check is gone now — there is no longer a
  // caller-specific workspace to compare against (`JACE_CONSOLE_TOKEN` is
  // ONE shared secret for the whole deployment, same as
  // `runner/approvals/route.ts` — see that route's doc-comment) — so the M3
  // reasoning now extends to EVERY approval, not just workspace-less ones:
  // any valid caller of the shared secret can stamp any create_issue
  // approval's `published_issue_url`, constrained only by the URL-shape
  // regex above. Still safe for the same downstream reason M3 relied on:
  // `findConfirmedAlignmentBriefApproval` requires an EXACT match on
  // `jace_approvals.workspace_id = <the ENQUEUING workspace>` AND the exact
  // stamped URL string, so a stamp on the wrong row can misdirect at most
  // ONE issue's one-confirm collapse to fall back to a redundant (but safe)
  // second alignment confirm — never grant admission for a workspace the
  // stamped approval doesn't itself, genuinely, belong to.
  const session = await getJaceSessionByEveSessionId(approval.eveSessionId);
  const hasNoAnchor =
    !session || (session.workspaceId == null && session.chatIdentityId == null);
  if (hasNoAnchor) {
    return NextResponse.json({ error: "Approval not found" }, { status: 404 });
  }

  const outcome = await stampPublishedIssueUrl(id, body.url);
  switch (outcome) {
    case "stamped":
      // Task 12 — best-effort, never affects this response; see
      // stampInvestigationIssueLink's own doc-comment.
      await stampInvestigationIssueLink(approval.toolInput, body.url);
      return NextResponse.json({ ok: true }, { status: 200 });
    // M4 (#1274 PR ② fix round): neither 409 log echoes row state read
    // BEFORE stampPublishedIssueUrl ran — `approval.status`/`approval.
    // publishedIssueUrl` here are the PRE-UPDATE snapshot, and the outcome
    // was decided on that function's own FRESH post-UPDATE read, so a
    // concurrent flip between the two reads could make a stale echo
    // contradict the outcome it annotates. The outcome string itself is
    // the accurate fact; `incoming` (the request body) is not a row read
    // and stays.
    case "not_approved":
      console.error(
        `[runner/approvals/published] approval ${id} is not approved; refusing to stamp published_issue_url`
      );
      return NextResponse.json({ error: "Approval is not approved" }, { status: 409 });
    case "conflict":
      console.error(
        `[runner/approvals/published] approval ${id} is already stamped with a DIFFERENT published_issue_url (incoming=${body.url}); refusing to overwrite`
      );
      return NextResponse.json(
        { error: "Already stamped with a different url" },
        { status: 409 }
      );
  }
}
