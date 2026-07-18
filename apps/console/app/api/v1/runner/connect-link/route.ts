import { randomBytes } from "node:crypto";
import { NextRequest, NextResponse } from "next/server";
import { getChatIdentity, setChatIdentityLinkToken } from "@agentrail/db-postgres";
import { requireBearer } from "../../../../../lib/bearer-auth";

// 24 bytes -> 48 hex chars, comfortably over the 32-char floor. Same
// randomBytes(...).toString("hex") idiom as `recordApprovalRequest`'s
// callbackToken in queries/jace_sessions.ts, just sized for an
// unguessable-over-chat link rather than a short callback_data token.
const LINK_TOKEN_BYTES = 24;
const LINK_TOKEN_TTL_MS = 30 * 60 * 1000;

interface RawBody {
  platform: string;
  platformUserId: string;
}

function isRawBody(v: unknown): v is RawBody {
  if (!v || typeof v !== "object") return false;
  const o = v as Record<string, unknown>;
  return (
    typeof o.platform === "string" &&
    o.platform.length > 0 &&
    typeof o.platformUserId === "string" &&
    o.platformUserId.length > 0
  );
}

/**
 * POST /api/v1/runner/connect-link
 *
 * Mints a one-time connect-GitHub link for an EXISTING chat identity (spec
 * §4.2, issue #1263). Jace calls this when it decides work needs a repo and
 * the sender isn't bound to a GitHub account yet; the returned URL is what it
 * sends in-chat (the send moment + in-thread confirmation are PR ②, not
 * built here).
 *
 * Auth mirrors GET /api/v1/runner/workspace-memory exactly: a bearer
 * AgentRail API key via `requireBearer`. The mint is deliberately NOT scoped
 * to the caller's own workspace — the whole point of this flow is binding an
 * identity that may not have a resolved workspace yet, so there is nothing
 * workspace-shaped to check the bearer's workspace against.
 *
 * Body: { platform, platformUserId } — the same natural key
 * `resolveInboundChatIdentity` anchors chat identities on. 404 when no
 * identity exists yet: this endpoint mints only for senders who have
 * actually messaged Jace before; it never inserts one.
 *
 * Re-minting for an identity that already carries an unexpired token simply
 * overwrites it (`setChatIdentityLinkToken` is last-write-wins) — the old
 * link silently stops working the moment a new one is minted. This is
 * intended: at most one live link per identity, and Jace always wants its
 * most recent send to be the one that works.
 *
 * Response: 200 { url, expiresAt } — url is `<request origin>/connect/<token>`,
 * built from the incoming request the same way
 * connectors/github/webhook/route.ts builds its own absolute callback URL
 * (no NEXTAUTH_URL/AUTH_URL/APP_URL env exists in this deploy).
 */
export async function POST(request: NextRequest) {
  const auth = await requireBearer(request);
  if (auth instanceof NextResponse) {
    return auth;
  }

  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON" }, { status: 400 });
  }

  if (!isRawBody(body)) {
    return NextResponse.json(
      { error: "Body must have platform (string) and platformUserId (string)" },
      { status: 400 }
    );
  }

  const identity = await getChatIdentity(body.platform, body.platformUserId);
  if (!identity) {
    return NextResponse.json({ error: "Chat identity not found" }, { status: 404 });
  }

  const linkToken = randomBytes(LINK_TOKEN_BYTES).toString("hex");
  const expiresAt = new Date(Date.now() + LINK_TOKEN_TTL_MS);
  await setChatIdentityLinkToken(identity.id, linkToken, expiresAt);

  const origin = new URL(request.url).origin;
  return NextResponse.json(
    { url: `${origin}/connect/${linkToken}`, expiresAt },
    { status: 200 }
  );
}
