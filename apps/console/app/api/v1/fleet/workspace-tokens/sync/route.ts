import { timingSafeEqual } from "crypto";
import { NextRequest, NextResponse } from "next/server";
import {
  listFleetProvisionState,
  mintApiKey,
  revokeApiKey,
} from "@agentrail/db-postgres";

const FLEET_TOKEN_ENV = "FLEET_CONSOLE_TOKEN";
const FLEET_KEY_NAME = "Hosted fleet";

/**
 * POST /api/v1/fleet/workspace-tokens/sync
 *
 * The hosted fleet's (PR ②, the Python worker — not this PR) ONLY provisioning
 * path (issue #1267 PR ①, Locked-4): no human clicks through `/activate` for a
 * fleet-served workspace. The fleet calls this on its own schedule and reads
 * off `{ minted, active, revoked }` to keep its per-workspace token set (one
 * ordinary `api_keys` bearer per hosted workspace — Locked-1, NOT a
 * fleet-scoped token) in sync with `workspaces.hosted_execution`.
 *
 * Auth: a single shared secret, `FLEET_CONSOLE_TOKEN`, presented as an
 * ordinary `Authorization: Bearer <token>` header and compared with
 * `timingSafeEqual` (the constant-time idiom `connectors/telegram/webhook`
 * uses for its own shared-bot secret) — NOT `requireBearer` / a per-workspace
 * `api_keys` row: this route provisions those rows, so it cannot itself be
 * gated by one. A missing env var or a mismatched token both collapse into
 * the SAME 404 `{ error: "Not found" }` (house anti-enumeration posture,
 * matching `api-keys/[keyId]/route.ts` and friends) — this door is reachable
 * by anyone who finds the URL, so "secret unset" must never look different
 * from "wrong secret", and neither may look different from "route doesn't
 * exist".
 *
 * Scoping (open, tracked on #1295, same as `JACE_CONSOLE_TOKEN`'s own
 * unresolved question): ONE shared secret authorizes syncing EVERY
 * hosted-eligible workspace in this deployment — there is no per-workspace or
 * per-fleet-deployment scoping in v1. Acceptable only because this token is
 * held by the fleet operator's own infrastructure, never handed to a tenant.
 *
 * Per workspace (`listFleetProvisionState`, scoped to NONE — every workspace
 * in the deployment is considered on every sync):
 *  - `hosted_execution = true` AND no active fleet key -> mint one
 *    (`kind: 'fleet'`, name "Hosted fleet") and return the RAW token. This is
 *    the ONLY response that will ever carry that token: `api_keys.key_hash`
 *    is the only thing persisted, so a token the fleet's own volume loses is
 *    gone for good — the operator's recovery path is to revoke the (now
 *    orphaned) key and let the next sync mint a fresh one, not to re-fetch it
 *    here. NEVER logged, and never allowed into an error message.
 *  - `hosted_execution = true` AND already has an active fleet key -> no
 *    token to (re-)issue (hash-only storage); reported in `active` so the
 *    fleet can tell "still fine, nothing changed" from "I never had this
 *    workspace" and reconcile a token IT lost by revoking + waiting for the
 *    next sync's mint.
 *  - `hosted_execution = false` AND has an active fleet key -> revoke it.
 *  - `hosted_execution = false` AND no active fleet key -> nothing to do;
 *    absent from every bucket.
 *
 * A unique-violation on mint (`api_keys_one_active_fleet_key_idx`, migration
 * 0033) — two overlapping syncs racing the SAME workspace — is treated as
 * "already active", not a 500: the workspace ends up with exactly one active
 * fleet key either way, and that's this endpoint's only invariant.
 *
 * Response 200: `{ minted: [{workspaceId, slug, token}], active: [workspaceId,
 * ...], revoked: [workspaceId, ...] }`.
 */

function verifyFleetBearer(req: NextRequest): boolean {
  const expected = process.env[FLEET_TOKEN_ENV];
  if (!expected) return false;

  const authHeader = req.headers.get("authorization");
  if (!authHeader?.startsWith("Bearer ")) return false;
  const actual = authHeader.slice(7).trim();
  if (!actual) return false;

  const expectedBuf = Buffer.from(expected);
  const actualBuf = Buffer.from(actual);
  return (
    expectedBuf.length === actualBuf.length &&
    timingSafeEqual(expectedBuf, actualBuf)
  );
}

/**
 * Drizzle can wrap the underlying pg error, so the unique-violation code
 * (23505) may live on err.code or err.cause.code — same detection idiom as
 * `runner/workspaces/route.ts`'s own `isUniqueViolation`.
 */
function isUniqueViolation(err: unknown): boolean {
  const e = err as { code?: string; cause?: { code?: string } };
  return e?.code === "23505" || e?.cause?.code === "23505";
}

interface MintedFleetToken {
  workspaceId: string;
  slug: string;
  token: string;
}

export async function POST(request: NextRequest) {
  if (!verifyFleetBearer(request)) {
    return NextResponse.json({ error: "Not found" }, { status: 404 });
  }

  const state = await listFleetProvisionState();

  const minted: MintedFleetToken[] = [];
  const active: string[] = [];
  const revoked: string[] = [];

  for (const row of state) {
    if (row.hostedExecution && !row.hasActiveFleetKey) {
      try {
        const key = await mintApiKey({
          workspaceId: row.workspaceId,
          name: FLEET_KEY_NAME,
          kind: "fleet",
        });
        minted.push({ workspaceId: row.workspaceId, slug: row.slug, token: key.rawKey });
      } catch (err) {
        if (!isUniqueViolation(err)) throw err;
        // Lost the race to a concurrent sync's mint for this same workspace —
        // it has an active fleet key either way, so report it as such.
        active.push(row.workspaceId);
      }
    } else if (row.hostedExecution && row.hasActiveFleetKey) {
      active.push(row.workspaceId);
    } else if (!row.hostedExecution && row.hasActiveFleetKey && row.fleetKeyId) {
      await revokeApiKey(row.workspaceId, row.fleetKeyId);
      revoked.push(row.workspaceId);
    }
    // hostedExecution=false && !hasActiveFleetKey -> nothing to do, omitted
    // from every bucket.
  }

  return NextResponse.json({ minted, active, revoked });
}
