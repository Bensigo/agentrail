import { NextRequest, NextResponse } from "next/server";
import {
  getJaceSessionByEveSessionId,
  getChatIdentityById,
} from "@agentrail/db-postgres";
import { requireJaceConsoleSecret } from "../../../../../lib/jace-console-auth";
import { mintSignupLink } from "../../../../../lib/mint-signup-link";

interface RawBody {
  eveSessionId: string;
}

function isRawBody(v: unknown): v is RawBody {
  if (!v || typeof v !== "object") return false;
  const o = v as Record<string, unknown>;
  return typeof o.eveSessionId === "string" && o.eveSessionId.length > 0;
}

/**
 * POST /api/v1/runner/signup-link
 *
 * Mints a one-time SIGN-UP magic link for the CALLING conversation's own chat
 * identity (issue #1364, PR ①) — the account-creation counterpart to
 * `connect-link/route.ts`'s GitHub-connect link, and DELIBERATELY built by
 * mirroring that route's auth, resolution chain, and eligibility posture
 * line for line (see that file's doc-comment for the fuller rationale each
 * point below only summarizes). `create_workspace`'s route (issue #1364
 * PR ②) calls the mint logic this route wraps directly (in-process, not over
 * HTTP — see `apps/console/lib/mint-signup-link.ts`) when it hits an
 * unbound sender; this HTTP route exists so the SAME capability is also
 * reachable the way `send_connect_link` reaches `connect-link` today, for
 * symmetry and any future caller that wants to mint without going through
 * `create_workspace`.
 *
 * AUTH: the central `JACE_CONSOLE_TOKEN` secret via `requireJaceConsoleSecret`
 * — identical to every other Jace-coordinator route (see that helper's own
 * doc-comment for the fail-closed, byte-identical-401 contract).
 *
 * Body: `{ eveSessionId }` — NOT a caller-supplied `(platform,
 * platformUserId)` pair, for the exact reason connect-link's own doc-comment
 * gives: an opaque runtime session id Eve mints, never a value a caller
 * chooses, closes the guessable-identity-enumeration vector. Resolved via
 * `getJaceSessionByEveSessionId` -> `getChatIdentityById`, the SAME chain
 * connect-link and `runner/workspaces` both use.
 *
 * Eligibility, checked AFTER resolution — refuses to mint (404, SAME body as
 * "identity not found", never distinguishable) when:
 *  - no session row for this `eveSessionId`, or the session's
 *    `chat_identity_id` is null;
 *  - the resolved identity already has a linked user (`userId` non-null) —
 *    nothing to sign up; a bound identity re-mints a CONNECT link
 *    (different flow, different column) if it needs anything further, never
 *    this one.
 * This collapses into ONE indistinguishable 404 for the same reason
 * connect-link's does: a distinguishable response would let any valid caller
 * enumerate which sessions/identities exist and which are already signed up.
 *
 * Re-minting for a still-eligible identity that already carries an
 * unexpired signup token overwrites it (`setChatIdentitySignupToken` is
 * last-write-wins) — same "at most one live link, most recent wins" contract
 * as connect-link.
 *
 * Response: 200 { url, expiresAt } — `url` is `<request origin>/signup/<token>`.
 */
export async function POST(request: NextRequest) {
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
      { error: "Body must have eveSessionId (string)" },
      { status: 400 }
    );
  }

  const session = await getJaceSessionByEveSessionId(body.eveSessionId);
  const chatIdentityId = session?.chatIdentityId ?? null;
  const identity = chatIdentityId
    ? await getChatIdentityById(chatIdentityId)
    : null;

  const ineligible = !identity || identity.userId != null;
  if (ineligible) {
    return NextResponse.json({ error: "Chat identity not found" }, { status: 404 });
  }

  const origin = new URL(request.url).origin;
  const minted = await mintSignupLink(identity.id, origin);
  return NextResponse.json(minted, { status: 200 });
}
