import { linkInvestigationIssue } from "@agentrail/db-postgres";
import type { InvestigationIssueRole } from "@agentrail/db-postgres";

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
 * that doesn't match.
 *
 * EXPORTED from this NON-ROUTE sibling module (hotfix 2026-07-31: these two
 * helpers originally lived in `route.ts` itself, justified by "the App
 * Router ignores extra route exports" — TRUE at runtime, FALSE at build
 * time: `next build`'s generated route-type validation rejects any
 * non-handler export from a `route.ts`, which broke the production Docker
 * build while every local suite and CI job stayed green, because none of
 * them run `next build`. Helpers that want exporting live beside the
 * route, never in it). Original rationale, still valid: by the time a live request reaches the "stamped"
 * case below, `body.url` has ALREADY passed `GITHUB_ISSUE_URL_RE` (the
 * identical shape), so this function can never actually return `null`
 * there in practice — the defensive branch exists for
 * `stampInvestigationIssueLink`'s own robustness (e.g. against a future
 * call site that doesn't pre-validate), not because today's POST handler
 * can produce one. A small, pure, side-effect-free helper is the cheapest
 * way to give that branch a direct, real test without contriving a route-
 * level scenario that cannot actually occur.
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
 * IDEMPOTENT AT THE DATABASE LEVEL (Task 12 fix round 1 — review finding):
 * `stampPublishedIssueUrl`'s own `"stamped"` outcome covers BOTH a fresh
 * stamp and a same-value replay (see that function's doc-comment in
 * `queries/jace_sessions.ts`), so this endpoint can genuinely run twice for
 * the same approval, calling `linkInvestigationIssue` with the identical
 * `(investigationId, repo, issueNumber)` triple both times. The true
 * guarantee lives ONE LAYER DOWN, in `linkInvestigationIssue` itself
 * (`queries/investigations.ts`): `ON CONFLICT DO NOTHING` against the
 * `investigation_issue_links_unique` index (migration 0063) — the SAME
 * mechanism `stampPublishedIssueUrl` relies on for its own sibling
 * guarantee. This function calls it UNCONDITIONALLY, with no read-check of
 * its own beforehand — a prior fix-round revision guarded this with a
 * SELECT-then-INSERT check (`hasInvestigationIssueLink`, since removed);
 * that shape is NOT concurrent-safe (a TOCTOU race window between the read
 * and the write), unlike the unique index, which Postgres enforces
 * atomically at commit time regardless of how many callers race it.
 *
 * EXPORTED for the same reason `parseGithubIssueUrl` above is: a small,
 * pure-enough (mocked-DB) helper exported for direct unit coverage of the
 * URL-non-matching branch, which a live POST cannot exercise (see that
 * function's own doc-comment and this module's header for why exports live
 * HERE and never in `route.ts`).
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
    await linkInvestigationIssue(marker.id, parsed.repo, parsed.issueNumber, marker.role);
  } catch (err) {
    console.warn(
      `[runner/approvals/published] failed to write investigation_issue_links for investigation ${marker.id}, ${parsed.repo}#${parsed.issueNumber} — the issue itself was created successfully, only the link is missing:`,
      err
    );
  }
}
