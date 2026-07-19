import { timingSafeEqual } from "crypto";
import { NextRequest, NextResponse } from "next/server";

const JACE_TOKEN_ENV = "JACE_CONSOLE_TOKEN";

/**
 * Central-secret authentication for the Jace-coordinator seam (issue —
 * "central shared secret for the Jace↔console seam", 2026-07-20 prod fix).
 *
 * Root cause this closes: Jace's `consoleGatedApproval` and its sibling
 * `*.core.mjs` callers (`apps/jace/agent/lib`) send
 * `Authorization: Bearer ${JACE_CONSOLE_TOKEN}` to a handful of
 * Jace-coordinator routes. Those routes used to authenticate that bearer via
 * `requireBearer` -> `lookupApiKeyByHash` (the per-workspace `api_keys`
 * table) — but the api_keys console UI was removed as redundant and
 * production carries ZERO api_keys rows, so no bearer Jace could ever
 * present was accepted: every gated action failed closed with "approval
 * service unavailable". This helper replaces that lookup with a single
 * shared secret, EXACTLY mirroring `FLEET_CONSOLE_TOKEN`
 * (`app/api/v1/fleet/workspace-tokens/sync/route.ts`'s `verifyFleetBearer`):
 * read `process.env`, `timingSafeEqual` constant-time compare with a
 * length-guard first (comparing unequal-length buffers throws), fail closed
 * on every branch.
 *
 * Scoping is the SAME open question `fleet/workspace-tokens/sync` already
 * carries for `FLEET_CONSOLE_TOKEN` (tracked on #1295 for this token
 * specifically): ONE shared secret authorizes every Jace-coordinator call in
 * this deployment — there is no per-workspace scoping at the AUTH layer.
 * This is intentional, not a gap: Jace runs as ONE shared coordinator
 * sidecar serving every workspace's conversations (the cloud multi-tenant
 * Jace design), so there is no per-workspace bearer to scope by in the first
 * place. Each route this guards is responsible for resolving the REAL tenant
 * server-side (from `eveSessionId` via the `jace_sessions` ledger, or — for
 * `failure-bundle` — from the run row's own `workspaceId`), never from
 * caller-supplied input. See each route's own doc-comment for its
 * resolution chain; this helper answers only "is the caller Jace", never
 * "which workspace".
 *
 * Unlike the fleet route's 404-indistinguishable posture (chosen there
 * because that endpoint is reachable by anyone who finds the URL), every
 * route this guards already established a 401 contract for a bad/missing
 * bearer before this change (see e.g. workspace-memory's and
 * failure-bundle's own doc-comments: "401 — bad/missing bearer"). Keeping
 * 401 preserves that existing contract for Jace's own callers rather than
 * introducing a new status they'd need to special-case. 401 is
 * byte-identical across every failure branch below (missing header,
 * malformed header, empty token, wrong token, unset env) — no oracle lets a
 * caller distinguish "misconfigured" from "wrong secret" from "no header".
 *
 * The secret itself never appears in a response body, a log line, or a
 * thrown error — only ONE fixed, value-free warning is ever logged (once per
 * process) when the env var is unset, so a misconfigured deploy is loud in
 * the server log without ever printing anything secret-shaped.
 */

// Logged at most once per process — a misconfigured deploy should be loud in
// the server log, not spam it on every request every one of these routes
// receives while unset.
let loggedMissingSecret = false;

function unauthorized(): NextResponse {
  return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
}

/**
 * Guard a Jace-coordinator route. Returns a 401 `NextResponse` to return
 * immediately on any failure, or `null` when the caller presented the valid
 * `JACE_CONSOLE_TOKEN` — mirroring how `requireBearer`'s callers branch
 * (`if (auth instanceof NextResponse) return auth;`), just without a data
 * payload on success: a shared secret carries no per-caller identity to
 * return.
 *
 * FAIL CLOSED: an unset/empty `JACE_CONSOLE_TOKEN` rejects EVERY request
 * (never a default-open bypass) — pinned by a dedicated test.
 */
export function requireJaceConsoleSecret(req: NextRequest): NextResponse | null {
  const expected = process.env[JACE_TOKEN_ENV];
  if (!expected) {
    if (!loggedMissingSecret) {
      loggedMissingSecret = true;
      console.error(
        `[jace-console-auth] ${JACE_TOKEN_ENV} is not configured — every Jace-coordinator route is failing closed (401) until it is set.`
      );
    }
    return unauthorized();
  }

  const authHeader = req.headers.get("authorization");
  if (!authHeader?.startsWith("Bearer ")) {
    return unauthorized();
  }

  const actual = authHeader.slice(7).trim();
  if (!actual) {
    return unauthorized();
  }

  const expectedBuf = Buffer.from(expected);
  const actualBuf = Buffer.from(actual);
  const valid =
    expectedBuf.length === actualBuf.length &&
    timingSafeEqual(expectedBuf, actualBuf);

  if (!valid) {
    return unauthorized();
  }

  return null;
}
