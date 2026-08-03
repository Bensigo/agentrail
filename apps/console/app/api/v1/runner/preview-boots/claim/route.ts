import { NextRequest, NextResponse } from "next/server";
import { claimPreviewBoot, getInstallationToken } from "@agentrail/db-postgres";
import { requireJaceConsoleSecret } from "../../../../../../lib/jace-console-auth";
import { previewBootsDisabled, previewBootsDisabledResponse } from "../shared";

/**
 * POST /api/v1/runner/preview-boots/claim
 *
 * B2b Task 4 (plan docs/superpowers/plans/2026-08-02-b2b-sandbox-boot.md;
 * spec docs/superpowers/specs/2026-08-02-b2-behavioral-evidence-design.md
 * §B2b §4-5). The boot plane's out-of-process worker's claim seam:
 * atomically claim the oldest eligible `preview_boots` row
 * (`claimPreviewBoot`, `@agentrail/db-postgres` — SKIP LOCKED, TTL seed; see
 * that query's own doc-comment) and hand the worker everything it needs to
 * clone, boot, and authenticate as the workspace's GitHub App installation,
 * with NO further round-trip. Mirrors `review-jobs/claim/route.ts`'s own
 * claim shape (worker-facing, `{workerId}` body, 204-when-empty) plus the
 * generic `runner/claim/route.ts`'s installation-token-minting idiom.
 *
 * AUTH: `requireJaceConsoleSecret` — the worker IS Jace, the same central
 * `JACE_CONSOLE_TOKEN` guard every other Jace-coordinator route uses.
 *
 * FLAG (immediately after auth): `PREVIEW_BOOTS_ENABLED !== "1"` — 503
 * (`../shared.ts`).
 *
 * BODY: `{ workerId }`, a required non-empty string — 400 otherwise, before
 * any claim is attempted.
 *
 * NO ELIGIBLE BOOT: 204 with an empty body — mirrors
 * `review-jobs/claim/route.ts`'s own `new NextResponse(null, {status:204})`
 * convention. Not an error, just nothing to do right now.
 *
 * TTL: `previewTtlSeconds()` reads `PREVIEW_BOOT_TTL_SECONDS`, default `720`
 * — the exact numeric-env idiom `review-jobs/claim/route.ts`'s own
 * `resolveDailyBudget()` uses (unset/blank/non-finite/negative all fall back
 * to the default). The SAME resolved value is both passed into
 * `claimPreviewBoot` (so the row's `expires_at` matches) and echoed back in
 * the response's own `ttlSeconds` — the row itself stores `expires_at`, not
 * a bare TTL, so this is the one place that number is reconstructed from.
 *
 * TOKEN MINT: `getInstallationToken(row.workspaceId)` — never throws (its
 * own doc-comment: wraps its own try/catch, returns `null` for ANY failure
 * reason), so `?? ""` alone is sufficient here; no extra try/catch needed on
 * this side (contrast `runner/claim/route.ts`'s belt-and-suspenders wrapper,
 * which predates that guarantee being load-bearing documentation). `""`
 * means "no usable GitHub credential right now" — the worker's own concern,
 * not this route's, to decide how to degrade.
 *
 * REPO URL: `repoSlugToUrl` below is a deliberate, byte-for-byte duplicate
 * of `queries/runner.ts`'s own private (unexported) helper of the same
 * name/behavior — see that file for the canonical version the generic claim
 * route uses. Not imported: it is neither exported from that module nor
 * re-exported through the `@agentrail/db-postgres` barrel, and this task's
 * scope is restricted to `apps/console/` only. Same "mirror the mechanism,
 * stay independent of the source module" rationale
 * `queries/preview_boots.ts`'s own doc-comment gives for duplicating
 * `review_jobs.ts`'s `uuid5Url` rather than importing it.
 *
 * RESPONSE (claimed): 200 `{ id, workspaceId, repo, repoUrl, prNumber,
 * headSha, ref, githubToken, ttlSeconds }`.
 */

const TTL_ENV = "PREVIEW_BOOT_TTL_SECONDS";
const DEFAULT_TTL_SECONDS = 720;

/** PREVIEW_BOOT_TTL_SECONDS, default 720 when unset, blank, or not a finite
 *  non-negative number — same idiom as review-jobs/claim/route.ts's own
 *  resolveDailyBudget(). */
function previewTtlSeconds(): number {
  const raw = process.env[TTL_ENV];
  if (raw === undefined || raw.trim() === "") return DEFAULT_TTL_SECONDS;
  const n = Number(raw);
  return Number.isFinite(n) && n >= 0 ? n : DEFAULT_TTL_SECONDS;
}

/** `owner/name` -> `https://github.com/owner/name`; pass through full URLs.
 *  See this file's own doc-comment ("REPO URL") for why this is a
 *  deliberate duplicate of queries/runner.ts's private helper of the same
 *  name, not an import. */
function repoSlugToUrl(slug: string): string {
  const trimmed = slug.trim();
  if (/^https?:\/\//i.test(trimmed)) return trimmed;
  return `https://github.com/${trimmed}`;
}

interface ClaimBody {
  workerId: string;
}

function isNonEmptyString(v: unknown): v is string {
  return typeof v === "string" && v.trim().length > 0;
}

function parseClaimBody(raw: unknown): ClaimBody | null {
  if (!raw || typeof raw !== "object") return null;
  const o = raw as Record<string, unknown>;
  if (!isNonEmptyString(o.workerId)) return null;
  return { workerId: o.workerId };
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

  const body = parseClaimBody(raw);
  if (!body) {
    return NextResponse.json({ error: "workerId is required" }, { status: 400 });
  }

  const ttlSeconds = previewTtlSeconds();
  const row = await claimPreviewBoot({ workerId: body.workerId, ttlSeconds });
  if (!row) {
    return new NextResponse(null, { status: 204 });
  }

  const githubToken = (await getInstallationToken(row.workspaceId)) ?? "";

  return NextResponse.json({
    id: row.id,
    workspaceId: row.workspaceId,
    repo: row.repo,
    repoUrl: repoSlugToUrl(row.repo),
    prNumber: row.prNumber,
    headSha: row.headSha,
    ref: row.ref,
    githubToken,
    ttlSeconds,
  });
}
