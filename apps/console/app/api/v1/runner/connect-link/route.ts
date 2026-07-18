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
 * Auth mirrors GET /api/v1/runner/workspace-memory: a bearer AgentRail API
 * key via `requireBearer`, which exposes the caller's own `workspaceId` —
 * used below to scope who this endpoint will mint a link for.
 *
 * Body: { platform, platformUserId } — the same natural key
 * `resolveInboundChatIdentity` anchors chat identities on.
 *
 * Refuses to mint (404, the SAME body as the unknown-identity 404 below —
 * never a distinguishable status or message) when EITHER:
 *  - the identity already has a linked user (`userId` non-null). Re-linking
 *    an already-bound identity is a deliberate future flow, not this
 *    endpoint's job: minting here would hand out a redeemable token that
 *    silently rebinds someone else's identity to whoever redeems it.
 *  - the identity has a resolved `workspaceId` that DIFFERS from the
 *    bearer's own `workspaceId` (tenant scoping). A pre-workspace "intro"
 *    identity (`workspaceId` NULL) has no tenant yet, so minting for it
 *    stays allowed for any valid bearer — that's the intended cold-start
 *    flow this endpoint exists for. An identity already resolved to the
 *    SAME workspace as the bearer is allowed through too.
 * Without both checks, any workspace's valid bearer could pass in the
 * (platform, platformUserId) of an identity already bound to a different
 * user/workspace, mint it a valid link, and have an unrelated signed-in
 * GitHub account silently rebind that identity on redemption — a
 * cross-tenant account takeover (the vulnerability this fix closes). The two
 * refusals collapse into the same 404 as "identity not found" on purpose: a
 * distinguishable response would let any valid bearer enumerate which
 * (platform, platformUserId) pairs exist and which tenant/user they already
 * belong to, just by reading the status code.
 *
 * 404 when no identity exists yet, or when refused for either reason above —
 * this endpoint mints only for senders who both messaged Jace before AND are
 * still eligible to be linked by THIS bearer; it never inserts a row.
 *
 * Re-minting for a still-eligible identity that already carries an
 * unexpired token simply overwrites it (`setChatIdentityLinkToken` is
 * last-write-wins) — the old link silently stops working the moment a new
 * one is minted. This is intended: at most one live link per identity, and
 * Jace always wants its most recent send to be the one that works.
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
  const { workspaceId: bearerWorkspaceId } = auth;

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
  const ineligible =
    !identity ||
    identity.userId != null ||
    (identity.workspaceId != null && identity.workspaceId !== bearerWorkspaceId);
  if (ineligible) {
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
