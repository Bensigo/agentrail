import { randomBytes } from "node:crypto";
import { NextRequest, NextResponse } from "next/server";
import {
  getJaceSessionByEveSessionId,
  getChatIdentityById,
  setChatIdentityLinkToken,
} from "@agentrail/db-postgres";
import { requireJaceConsoleSecret } from "../../../../../lib/jace-console-auth";

// 24 bytes -> 48 hex chars, comfortably over the 32-char floor. Same
// randomBytes(...).toString("hex") idiom as `recordApprovalRequest`'s
// callbackToken in queries/jace_sessions.ts, just sized for an
// unguessable-over-chat link rather than a short callback_data token.
const LINK_TOKEN_BYTES = 24;
const LINK_TOKEN_TTL_MS = 30 * 60 * 1000;

interface RawBody {
  eveSessionId: string;
}

function isRawBody(v: unknown): v is RawBody {
  if (!v || typeof v !== "object") return false;
  const o = v as Record<string, unknown>;
  return typeof o.eveSessionId === "string" && o.eveSessionId.length > 0;
}

/**
 * POST /api/v1/runner/connect-link
 *
 * Mints a one-time connect-GitHub link for the CALLING conversation's own
 * chat identity (spec §4.2, issue #1263). Jace's `send_connect_link` tool
 * calls this when it decides work needs a repo and the sender isn't bound to
 * a GitHub account yet; the returned URL is what it sends in-chat (the send
 * moment + in-thread confirmation are issue #1263 PR ②, built alongside this
 * route rewrite).
 *
 * AUTH (updated for the central-secret fix, 2026-07-20): the central
 * `JACE_CONSOLE_TOKEN` secret via `requireJaceConsoleSecret` — see that
 * helper's own doc-comment. Pre-fix this was a per-workspace bearer AgentRail
 * API key via `requireBearer`, which exposed the caller's own `workspaceId`
 * and was used to scope who this endpoint would mint a link for (the two
 * `bearerWorkspaceId` comparisons below are gone — see "What remains" below
 * for what replaces that scoping).
 *
 * ### Body: `{ eveSessionId }` — NOT `{ platform, platformUserId }` (#1263
 * PR ① review's accepted residual, closed here)
 *
 * PR ①'s review accepted a residual risk (documented in PR #1305's body):
 * trusting a CALLER-supplied `(platform, platformUserId)` to select which
 * chat identity to mint for was fine only because zero callers existed yet.
 * Once a real caller does (PR ②'s `send_connect_link` tool), the mint-side
 * checks below refuse a DIFFERENT workspace's already-bound identity, but
 * they do NOT refuse an intro (workspace-less) identity — that is the
 * intended cold-start flow. So any valid bearer could ask this endpoint to
 * mint a link for an UNRELATED never-connected identity just by supplying
 * its `(platform, platformUserId)` pair: a cross-conversation mint.
 *
 * This PR removes that input shape entirely. The only input is
 * `eveSessionId`, and `send_connect_link` reads it off `ctx.session.id` —
 * Eve's own session id for the conversation actually invoking the tool,
 * never model-supplied and never caller-chosen (see
 * annex-eve-internals.md / the tool's own doc-comment). Server-side, this
 * route resolves that id through the session ledger
 * (`getJaceSessionByEveSessionId`, issue #1262 PR ②'s dispatcher is what
 * populates it) to `chat_identity_id`, then loads that identity
 * (`getChatIdentityById`). A session row with a null `chat_identity_id`, or
 * no session row at all for this `eveSessionId`, collapses into the exact
 * same 404 as every other refusal below.
 *
 * What this closes, precisely: the GUESSABLE `(platform, platformUserId)`
 * input above — a pair a caller could pick and iterate — is gone;
 * `eveSessionId` is an opaque runtime identifier Eve mints, never a value a
 * caller chooses.
 *
 * What remains, an accepted and — under the central-secret model — WIDENED
 * residual (originally "narrowed" when this route still had a per-workspace
 * bearer to cross-check the resolved identity/session against; that
 * cross-check is gone now for the same reason `runner/approvals/route.ts`
 * dropped its own `crossTenant` check — there is no longer a caller-specific
 * `workspaceId` to compare against, since `JACE_CONSOLE_TOKEN` is ONE shared
 * secret for the whole deployment): a valid caller can mint a link for ANY
 * identity/session this endpoint doesn't otherwise refuse — not just a
 * never-connected "intro" one. Three things keep this from being
 * exploitable: (1) the secret is held only by Jace's own shared coordinator,
 * which legitimately serves every workspace's conversations — the same trust
 * boundary `FLEET_CONSOLE_TOKEN` already accepts for the fleet's own
 * deployment-wide reach; (2) the minted URL is only ever delivered in-thread
 * by Jace's own reply — there is no separate "send to an address" step (see
 * `send_connect_link`'s own doc-comment); (3) the redemption-side
 * `foreign_user` guard from PR ① (`connect-bind-decision.ts`'s
 * `decideConnectIdentityBind`) backstops a stale or otherwise-misdirected
 * link by refusing to rebind an identity already linked to someone else.
 *
 * #1295's "is JACE_CONSOLE_TOKEN per-workspace or one bearer shared across
 * workspaces" question is now settled (shared, deployment-wide — see
 * `jace-console-auth.ts`). How much entropy `eveSessionId` itself carries
 * remains open and unconfirmed, and still bounds how narrow the residual
 * above really is.
 *
 * The PR ① eligibility rule below is otherwise unchanged. Refuses to mint
 * (404, the SAME body as the unknown-identity 404 — never a distinguishable
 * status or message) when:
 *  - the identity already has a linked user (`userId` non-null). Re-linking
 *    an already-bound identity is a deliberate future flow, not this
 *    endpoint's job: minting here would hand out a redeemable token that
 *    silently rebinds someone else's identity to whoever redeems it.
 * This refusal collapses into the same 404 as "identity not found" on
 * purpose: a distinguishable response would let any valid caller enumerate
 * which sessions/identities exist and which user they already belong to,
 * just by reading the status code.
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

  const linkToken = randomBytes(LINK_TOKEN_BYTES).toString("hex");
  const expiresAt = new Date(Date.now() + LINK_TOKEN_TTL_MS);
  await setChatIdentityLinkToken(identity.id, linkToken, expiresAt);

  const origin = new URL(request.url).origin;
  return NextResponse.json(
    { url: `${origin}/connect/${linkToken}`, expiresAt },
    { status: 200 }
  );
}
