import { randomBytes } from "node:crypto";
import { NextRequest, NextResponse } from "next/server";
import {
  getJaceSessionByEveSessionId,
  getChatIdentityById,
  createWorkspace,
  pinConversationWorkspace,
} from "@agentrail/db-postgres";
import { requireJaceConsoleSecret } from "../../../../../lib/jace-console-auth";
import { mintSignupLink } from "../../../../../lib/mint-signup-link";

const NAME_MAX = 80;
// Random hex size: 3 bytes -> 6 hex chars. Used both to break a slug
// collision on retry, and as the random part of a generated fallback slug
// (see slugifyWithFallback) when a name has no Latin/digit characters to
// slugify. Short, but each usage only ever has to dodge one prior collision.
const SLUG_SUFFIX_BYTES = 3;

const ALREADY_ATTACHED_MESSAGE =
  "this conversation is already attached to a workspace";
const SLUG_EXHAUSTED_MESSAGE =
  "a workspace with a similar name already exists — try a different name";
// issue #1364 PR②: the message a caller sees when this route redirects an
// UNBOUND sender to sign up instead of creating a workspace. Distinct from
// ALREADY_ATTACHED_MESSAGE (both are 409s, but this one carries `signupUrl`/
// `expiresAt` alongside it — see the POST doc-comment's "Behavior change"
// section).
const SIGNUP_REQUIRED_MESSAGE = "sign up to create a workspace";

interface RawBody {
  eveSessionId: string;
  name: string;
}

function isRawBody(v: unknown): v is RawBody {
  if (!v || typeof v !== "object") return false;
  const o = v as Record<string, unknown>;
  return (
    typeof o.eveSessionId === "string" &&
    o.eveSessionId.length > 0 &&
    typeof o.name === "string"
  );
}

/**
 * lowercase, hyphenate, strip everything else. Mirrors the console's own
 * client-side `toSlug` (app/(dashboard)/setup/page.tsx) idiom exactly — that
 * one is private to a "use client" form component (not an exported/shared
 * helper), so this is a same-idiom copy rather than an import.
 */
function slugify(name: string): string {
  return name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
}

/**
 * A name written entirely in non-Latin script (Chinese, Arabic, Cyrillic,
 * ...) or in punctuation/emoji strips to "" under `slugify` above — that is
 * a fallback, not a rejection: non-Latin names are first-class, and the
 * slug is only an internal handle, never shown as the name (the display
 * `name` itself carries the meaning, unchanged).
 */
function slugifyWithFallback(name: string): string {
  const slug = slugify(name);
  return slug.length > 0
    ? slug
    : `workspace-${randomBytes(SLUG_SUFFIX_BYTES).toString("hex")}`;
}

/**
 * Drizzle can wrap the underlying pg error, so the unique-violation code
 * (23505) may live on err.code or err.cause.code — same detection idiom as
 * the console form's own POST /api/v1/workspaces.
 */
function isUniqueViolation(err: unknown): boolean {
  const e = err as { code?: string; cause?: { code?: string } };
  return e?.code === "23505" || e?.cause?.code === "23505";
}

/**
 * Create the OWNED workspace (a `workspace_memberships` row) for an
 * already-user-linked identity. `POST` below only ever calls this once
 * `identity.userId` is confirmed non-null — the ownerless/owner-elect branch
 * this function used to also cover (issue #1264's `createWorkspaceOwnerElect`)
 * no longer runs from this route as of issue #1364 PR② (see the POST
 * doc-comment's "Behavior change" section); the split-out shape is kept
 * anyway so `createWorkspaceWithSlugRetry` stays a thin generic retry
 * wrapper, unaware of which specific creation function it's retrying.
 */
async function createOwnedWorkspace(input: {
  identity: { userId: string };
  name: string;
  slug: string;
}) {
  const { identity, name, slug } = input;
  return createWorkspace({ name, slug, userId: identity.userId });
}

/**
 * Create the workspace with ONE slug-collision retry: try `baseSlug`, and on
 * a unique-violation only, retry once with a random suffix appended. A
 * second collision is surfaced to the caller as `{ ok: false }` rather than
 * retried again — an honest 409, not an infinite loop. Any non-collision
 * error propagates (thrown), unchanged, to the caller.
 */
async function createWorkspaceWithSlugRetry(input: {
  identity: { userId: string };
  name: string;
  baseSlug: string;
}): Promise<
  | { ok: true; workspace: Awaited<ReturnType<typeof createOwnedWorkspace>> }
  | { ok: false }
> {
  const { identity, name, baseSlug } = input;
  try {
    const workspace = await createOwnedWorkspace({ identity, name, slug: baseSlug });
    return { ok: true, workspace };
  } catch (err) {
    if (!isUniqueViolation(err)) throw err;
  }

  // Guarded, not just interpolated: baseSlug is expected to already be
  // non-empty (callers pass slugifyWithFallback's output), but if it were
  // ever empty this still avoids composing a leading-hyphen slug.
  const retrySuffix = randomBytes(SLUG_SUFFIX_BYTES).toString("hex");
  const retrySlug =
    baseSlug.length > 0 ? `${baseSlug}-${retrySuffix}` : `workspace-${retrySuffix}`;
  try {
    const workspace = await createOwnedWorkspace({ identity, name, slug: retrySlug });
    return { ok: true, workspace };
  } catch (err) {
    if (!isUniqueViolation(err)) throw err;
    return { ok: false };
  }
}

/**
 * POST /api/v1/runner/workspaces
 *
 * Creates a REAL AgentRail workspace on behalf of the CALLING conversation's
 * own chat identity (spec §4.2, issue #1264). Jace's `create_workspace` tool
 * calls this after a human has approved the exact name in-chat (the tool's
 * `approval: always()` gate, same class as `create_issue`) — this route
 * itself performs no further approval; the gate lives entirely Eve-side.
 *
 * Auth + resolution mirror `connect-link/route.ts` EXACTLY: the central
 * Jace-coordinator secret via `requireJaceConsoleSecret` (that helper's own
 * doc-comment covers the auth-model swap from a per-workspace bearer
 * AgentRail API key, `requireBearer`), then `{ eveSessionId }` resolved
 * through the session ledger (`getJaceSessionByEveSessionId` ->
 * `getChatIdentityById`) — never a caller-supplied `(platform,
 * platformUserId)` pair. No session row at all for this `eveSessionId` 404s
 * ("Session not found") — the same indistinguishable-by-design posture
 * connect-link uses for this exact resolution boundary, for the same reason
 * (a distinguishable response would let any valid caller enumerate which
 * sessions exist). UPDATED (Arc B live smoke, 2026-08-02): a session row
 * whose `chat_identity_id` is null no longer 404s ahead of the
 * already-attached check below. Review-job worker sessions (Arc B) are
 * exactly this shape (workspace-anchored, no chat identity), and
 * `jace_sessions`'s own `workspaceOrIdentityCheck` CHECK constraint
 * guarantees such a row always carries a `workspace_id` — so the
 * already-attached check (which now reads `identity?.workspaceId`, not
 * `identity.workspaceId`) catches it via `session.workspaceId` alone,
 * without ever needing an identity. ONLY past that check — both
 * `workspaceId`s null, so per the same CHECK constraint the ONLY way to get
 * here is a session that DOES carry a `chat_identity_id` — does a null
 * `identity` (the lookup came back empty: a broken reference, since a set
 * `chat_identity_id` should always resolve) still 404 as "Chat identity not
 * found", unchanged from before.
 *
 * Past that resolution boundary, this route's refusals are deliberately
 * HONEST 409s, not folded into the indistinguishable 404 the way
 * connect-link folds "already linked" / "wrong tenant" refusals: a human
 * already approved THIS SPECIFIC create_workspace call, in THIS SPECIFIC
 * conversation, before this route ever runs, so there is no scripted-probing
 * surface here to protect by hiding the reason — telling Jace "this
 * conversation already has a workspace" is strictly more useful than a bare
 * 404 it cannot act on. Two such refusals, same message (both mean "there is
 * already a workspace here, nothing to create"):
 *  - `session.workspaceId` non-null — the conversation itself is already
 *    pinned to a workspace.
 *  - `identity.workspaceId` non-null — the identity itself already resolved
 *    to a workspace (independent of this session's own pin; see
 *    `jace_sessions.ts`'s schema comment on the two graduating separately).
 *
 * This route never cross-checks a caller-specific `workspaceId` against
 * anything — there is no existing tenant to protect here (the whole point is
 * creating a brand-new one), so that check would have nothing to compare
 * against even under the old per-workspace-bearer auth model. The same
 * residual connect-link's doc-comment accepts therefore applies here too — a
 * valid caller could invoke this for an arbitrary `eveSessionId` unrelated to
 * its own traffic — with the same compensating controls: `create_workspace`
 * never lets the model choose `eveSessionId` (it reads `ctx.session.id` off
 * ToolContext), and every call is human-approved in the context of one
 * specific conversation. See connect-link/route.ts's doc-comment for the
 * shared resolution pattern; #1295's "is JACE_CONSOLE_TOKEN per-workspace or
 * shared" question is now settled (shared, deployment-wide — see
 * `jace-console-auth.ts`).
 *
 * Validation: `name` must be a non-empty string, trimmed, 1-80 characters,
 * else 400 — checked before any DB call. `slug` is derived from `name`
 * (lowercase, hyphenated, non-alphanumeric stripped) and is NEVER
 * caller-supplied. A unique violation on `workspaces.slug` is retried once
 * with a short random suffix (`createWorkspaceWithSlugRetry`); a second
 * collision is an honest 409, not a 500 or a silent overwrite.
 *
 * ### Sign-up gate (issue #1364 PR②) — BEHAVIOR CHANGE from issue #1264
 *
 * `identity.userId == null` means this sender has no linked account yet
 * (AC2's "unbound sender"). Until this PR, that case fell through to
 * `createWorkspaceOwnerElect` — a REAL workspace, bound to the identity, but
 * with no owner membership until a LATER GitHub connect (issue #1263)
 * completed it. Issue #1364's whole point is that ordering: a first-time
 * sender should sign up FIRST (a magic link — issue #1364 PR①'s
 * `/signup/[token]`), then create a workspace, not the other way around —
 * Jace's own words in the dogfood transcript that opened #1364: "If the
 * user isn't signed up, the system should send a magic link to sign them up
 * first, then help create the workspace." So as of this PR, an unbound
 * sender's `create_workspace` call no longer creates ANYTHING here — it
 * mints a sign-up link (`mintSignupLink`, the SAME mint primitive
 * `POST /api/v1/runner/signup-link` uses, called in-process rather than over
 * HTTP) and returns it in the response body (409, alongside
 * `ALREADY_ATTACHED_MESSAGE`'s existing "honest refusal" posture — see that
 * section above) instead of a 201. `apps/jace/agent/lib/create_workspace.core.mjs`
 * (issue #1364 PR②) reads this shape and returns a structured
 * `{ signupRequired: true, url, expiresAt }` the model relays in-thread —
 * see that module's own doc-comment for the full contract.
 *
 * An ALREADY-known sender (`identity.userId` non-null, AC2) is entirely
 * unaffected by this change: no eligibility check runs, no link is minted,
 * straight through to the existing owned-workspace creation below, exactly
 * as before this PR.
 *
 * This intentionally strands `createWorkspaceOwnerElect` (issue #1264 PR①)
 * as no-longer-called from any route — kept as exported, tested
 * `@agentrail/db-postgres` infra (its own dedicated test suite,
 * `__tests__/create-workspace-owner-elect.test.ts`, is untouched and still
 * green) rather than deleted, since removing tested exported infra is out
 * of this PR's scope; flagged here as a known candidate for a follow-up
 * cleanup, not fixed in this PR.
 *
 * Creation (once past the sign-up gate): `identity.userId` is now guaranteed
 * non-null, so `createWorkspace` runs unconditionally — the workspace is
 * owned immediately via a `workspace_memberships` row.
 *
 * Success is followed by `pinConversationWorkspace`, so the SAME
 * conversation that asked for the workspace is also the one pinned to it
 * (not just the identity) — this is what lets a later turn in this same
 * thread route straight to the workspace without re-asking. A refusal from
 * `pinConversationWorkspace` here should be UNREACHABLE: the refusal checks
 * above already guarantee neither the session nor the identity carries an
 * existing workspace, and the workspace this call just created is
 * immediately reachable from the identity's fresh `workspace_memberships`
 * row (see `listWorkspacesForChatIdentity`). A refusal here means a race or
 * a gap in that invariant, so it is treated as a 500-level inconsistency
 * (thrown, not swallowed into a misleading 201) rather than silently
 * reported as success for a conversation that isn't actually pinned.
 *
 * Response: 201 { workspaceId, name, slug, url }, where `url` is
 * `<request origin>/dashboard/<workspaceId>` — built from the incoming
 * request the same way connect-link builds its own absolute URL (no
 * NEXTAUTH_URL/AUTH_URL/APP_URL env exists in this deploy).
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
      { error: "Body must have eveSessionId (string) and name (string)" },
      { status: 400 }
    );
  }

  const name = body.name.trim();
  if (name.length < 1 || name.length > NAME_MAX) {
    return NextResponse.json(
      { error: `name must be 1-${NAME_MAX} characters` },
      { status: 400 }
    );
  }

  const session = await getJaceSessionByEveSessionId(body.eveSessionId);
  const chatIdentityId = session?.chatIdentityId ?? null;
  const identity = chatIdentityId ? await getChatIdentityById(chatIdentityId) : null;

  if (!session) {
    return NextResponse.json({ error: "Session not found" }, { status: 404 });
  }

  // Already-attached check runs BEFORE the identity-required check below —
  // deliberately reordered (fix wave) so it can run on `identity?.workspaceId`
  // alone, without first requiring identity to be resolved. This is what
  // lets a review-job worker session (Arc B: chatIdentityId null,
  // workspaceId set — the jace_sessions table's own
  // workspaceOrIdentityCheck CHECK constraint guarantees the pairing) reach
  // this refusal via session.workspaceId alone, rather than wrongly 404ing
  // on a chat identity it was never going to have.
  if (session.workspaceId != null || identity?.workspaceId != null) {
    return NextResponse.json({ error: ALREADY_ATTACHED_MESSAGE }, { status: 409 });
  }

  // Past the already-attached check, both workspaceIds are null — every
  // remaining refusal/creation path below needs a real identity row
  // (identity.userId, identity.id), so a null `identity` here — whether
  // chatIdentityId was null to begin with, or was set but the lookup came
  // back empty (a broken reference) — 404s exactly as it always has. This
  // also narrows `identity` for TypeScript for the rest of the function,
  // same idiom `pinResult.ok` uses below.
  if (!identity) {
    return NextResponse.json({ error: "Chat identity not found" }, { status: 404 });
  }

  // Sign-up gate (issue #1364 PR②) — see the POST doc-comment's own section
  // for the full rationale. AC2: an already-linked identity (userId
  // non-null) skips this entirely and falls straight through, unaffected.
  // Captured into its own `const` (rather than re-reading `identity.userId`
  // below) purely so TypeScript narrows it to `string` past this guard —
  // `createWorkspaceWithSlugRetry` below requires a non-null userId.
  const identityUserId = identity.userId;
  if (identityUserId == null) {
    const origin = new URL(request.url).origin;
    const minted = await mintSignupLink(identity.id, origin);
    return NextResponse.json(
      {
        error: SIGNUP_REQUIRED_MESSAGE,
        signupUrl: minted.url,
        expiresAt: minted.expiresAt,
      },
      { status: 409 }
    );
  }

  const created = await createWorkspaceWithSlugRetry({
    identity: { userId: identityUserId },
    name,
    baseSlug: slugifyWithFallback(name),
  });
  if (!created.ok) {
    return NextResponse.json({ error: SLUG_EXHAUSTED_MESSAGE }, { status: 409 });
  }
  const { workspace } = created;

  const pinResult = await pinConversationWorkspace({
    chatIdentityId: identity.id,
    channel: session.channel,
    conversationKey: session.conversationKey,
    workspaceId: workspace.id,
  });
  if (!pinResult.ok) {
    throw new Error(
      `POST /api/v1/runner/workspaces: pinConversationWorkspace refused ` +
        `(${pinResult.reason}) for freshly created workspace ${workspace.id} / ` +
        `chat identity ${identity.id} — this should be impossible right after ` +
        `the empty-workspace checks above.`
    );
  }

  const origin = new URL(request.url).origin;
  return NextResponse.json(
    {
      workspaceId: workspace.id,
      name: workspace.name,
      slug: workspace.slug,
      url: `${origin}/dashboard/${workspace.id}`,
    },
    { status: 201 }
  );
}
