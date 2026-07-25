import { NextRequest, NextResponse } from "next/server";
import { selfHealFleetKey } from "@agentrail/db-postgres";
import { verifyFleetBearer } from "../../../../../../lib/fleet-auth";

/**
 * POST /api/v1/fleet/workspace-tokens/self-heal
 *
 * The fleet's SELF-HEAL provisioning path — a sibling to
 * `.../workspace-tokens/sync` (#1267 PR ①), added because the ordinary sync
 * route refuses to help here BY DESIGN: it only mints a fresh `kind:
 * 'fleet'` key when the workspace has NONE active. Every Railway redeploy —
 * and a bare container restart with no deploy at all — starts the fleet
 * process with an EMPTY on-disk token store while the console still reports
 * an active key for every previously-served workspace, so the ordinary sync
 * sees `hasActiveFleetKey: true` and does nothing, logging only:
 *
 *   "fleet: the console reports an active fleet key for workspace(s) <id>
 *   but this instance holds no token for them ... Recovery: revoke the
 *   orphaned key ..."
 *
 * That message used to be the END of the story — a human had to go revoke
 * the key by hand, and the queue sat silently un-drained until someone
 * noticed (observed: up to four days, once, with zero alerting). This route
 * is what `agentrail/runner/fleet_sync.py` now calls automatically the
 * moment it detects that exact "drift" condition, instead of only logging
 * it: the fleet asks for a REPLACEMENT, this route mints one server-side,
 * and the fleet keeps serving without a human ever being paged.
 *
 * Auth: the SAME shared-secret `verifyFleetBearer` check as the sync route
 * (see `lib/fleet-auth.ts`) — this door provisions credentials, so it
 * cannot itself be gated by one, and a missing/wrong secret both collapse
 * into the same anti-enumeration 404.
 *
 * Request body: `{ workspaceId: string, fleetInstanceId: string }`.
 * `fleetInstanceId` is a per-process identity the fleet mints once at boot
 * (`<hostname>-<uuid12>`, the same shape `fleet_leases.holder` uses) —
 * recorded on the rotation audit row (`fleet_key_rotations`) for "who
 * rotated this," never used to grant a same-instance exemption from the
 * cooldown below (see `selfHealFleetKey`'s doc-comment for why: hash-only
 * token storage means even the requesting instance's own retry cannot be
 * handed the same raw token back, so there is no safe special case here).
 *
 * All the real decision logic lives in `selfHealFleetKey`
 * (`@agentrail/db-postgres`): workspace lookup, the `hosted_execution`
 * guard, the cooldown guard (env-tunable via `FLEET_SELF_HEAL_COOLDOWN_SECONDS`,
 * default 60s — see that function's doc-comment for the full anti-ping-pong
 * design), and the atomic revoke-old+mint-new transaction. This route is
 * thin: parse the body, call it, map the result onto the wire.
 *
 * Response is ALWAYS 200 once past auth (mirrors the sync route's own
 * "discriminate in the body, not the status code" convention for its
 * `failed` bucket) — a cooldown/not_hosted/not_found refusal is an ordinary,
 * expected outcome for a fleet client polling opportunistically, not a
 * server error:
 *   - success:  `{ ok: true, workspaceId, slug, token }` — the RAW token,
 *     the ONLY time it is ever available (hash-only storage, same as the
 *     sync route's own `minted` bucket). NEVER logged.
 *   - refusal:  `{ ok: false, reason: "not_found" | "not_hosted" | "cooldown",
 *     retryAfterSeconds? }`.
 *   - malformed request body (missing/non-string fields): `400
 *     { ok: false, reason: "invalid_request" }` — a client bug, not a
 *     workspace-state refusal, so it gets its own status code rather than
 *     folding into the 200-with-discriminant convention above.
 */

interface SelfHealRequestBody {
  workspaceId?: unknown;
  fleetInstanceId?: unknown;
}

const COOLDOWN_ENV = "FLEET_SELF_HEAL_COOLDOWN_SECONDS";
const COOLDOWN_DEFAULT_SECONDS = 60;

/**
 * How long a workspace must wait between rotations (the anti-ping-pong
 * guard). Env-tunable, same parse/validate/fallback shape
 * `pushMinIntervalSeconds` (the wiki push-recompile debounce) uses: an
 * absent, non-numeric, or non-positive value falls back to the default
 * rather than disabling the guard (a 0-second "cooldown" would defeat its
 * own purpose).
 */
function selfHealCooldownSeconds(): number {
  const raw = process.env[COOLDOWN_ENV];
  if (raw) {
    const val = Number.parseInt(raw, 10);
    if (Number.isFinite(val) && val > 0) return val;
  }
  return COOLDOWN_DEFAULT_SECONDS;
}

export async function POST(request: NextRequest) {
  if (!verifyFleetBearer(request)) {
    return NextResponse.json({ error: "Not found" }, { status: 404 });
  }

  let body: SelfHealRequestBody;
  try {
    body = (await request.json()) as SelfHealRequestBody;
  } catch {
    return NextResponse.json(
      { ok: false, reason: "invalid_request" },
      { status: 400 }
    );
  }

  const workspaceId =
    typeof body.workspaceId === "string" ? body.workspaceId.trim() : "";
  const fleetInstanceId =
    typeof body.fleetInstanceId === "string" ? body.fleetInstanceId.trim() : "";
  if (!workspaceId || !fleetInstanceId) {
    return NextResponse.json(
      { ok: false, reason: "invalid_request" },
      { status: 400 }
    );
  }

  const result = await selfHealFleetKey({
    workspaceId,
    fleetInstanceId,
    cooldownSeconds: selfHealCooldownSeconds(),
  });

  return NextResponse.json(result);
}
