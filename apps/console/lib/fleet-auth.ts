import { timingSafeEqual } from "crypto";
import { NextRequest } from "next/server";

export const FLEET_TOKEN_ENV = "FLEET_CONSOLE_TOKEN";

/**
 * Shared-secret auth for the hosted fleet's OWN infrastructure-to-console
 * routes (`/api/v1/fleet/workspace-tokens/sync` and `.../self-heal`) —
 * extracted here (#1267 PR① originally defined this inline in the sync
 * route) once a SECOND route needed the identical check, so the
 * timing-safe/anti-enumeration logic has exactly one implementation instead
 * of two copies that could silently drift apart.
 *
 * Compares `Authorization: Bearer <token>` against `FLEET_CONSOLE_TOKEN`
 * with `timingSafeEqual` (the constant-time, fail-closed idiom
 * `connectors/telegram/webhook`'s `verifySecret` uses for its own
 * shared-bot secret) — NOT `requireBearer` / a per-workspace `api_keys`
 * row: these routes PROVISION those rows, so they cannot themselves be
 * gated by one.
 *
 * A missing env var and a mismatched token both return `false` — the
 * caller must fold both into the SAME 404 `{ error: "Not found" }` (the
 * 404-indistinguishable refusal posture the runner `connect-link` /
 * `approvals` routes use at their own resolution boundaries), because these
 * doors are reachable by anyone who finds the URL: "secret unset" must
 * never look different from "wrong secret," and neither may look different
 * from "route doesn't exist."
 */
export function verifyFleetBearer(req: NextRequest): boolean {
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
