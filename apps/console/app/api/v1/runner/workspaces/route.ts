import { randomBytes } from "node:crypto";
import { NextRequest, NextResponse } from "next/server";
import {
  getJaceSessionByEveSessionId,
  getChatIdentityById,
  createWorkspace,
  createWorkspaceOwnerElect,
  pinConversationWorkspace,
} from "@agentrail/db-postgres";
import { requireJaceConsoleSecret } from "../../../../../lib/jace-console-auth";

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
 * Create the workspace itself on the branch its chat identity qualifies for:
 * immediately owned (a workspace_memberships row) when the identity already
 * carries a linked user, owner-elect (bound identity, no membership) when it
 * does not. Both branches still need `pinConversationWorkspace` afterwards —
 * that step is common to both and lives in `POST` below, not here.
 */
async function createWorkspaceForIdentity(input: {
  identity: { id: string; userId: string | null };
  name: string;
  slug: string;
}) {
  const { identity, name, slug } = input;
  if (identity.userId != null) {
    return createWorkspace({ name, slug, userId: identity.userId });
  }
  return createWorkspaceOwnerElect({ name, slug, chatIdentityId: identity.id });
}

/**
 * Create the workspace with ONE slug-collision retry: try `baseSlug`, and on
 * a unique-violation only, retry once with a random suffix appended. A
 * second collision is surfaced to the caller as `{ ok: false }` rather than
 * retried again — an honest 409, not an infinite loop. Any non-collision
 * error propagates (thrown), unchanged, to the caller.
 */
async function createWorkspaceWithSlugRetry(input: {
  identity: { id: string; userId: string | null };
  name: string;
  baseSlug: string;
}): Promise<
  | { ok: true; workspace: Awaited<ReturnType<typeof createWorkspaceForIdentity>> }
  | { ok: false }
> {
  const { identity, name, baseSlug } = input;
  try {
    const workspace = await createWorkspaceForIdentity({ identity, name, slug: baseSlug });
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
    const workspace = await createWorkspaceForIdentity({ identity, name, slug: retrySlug });
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
 * platformUserId)` pair. A session row with a null `chat_identity_id`, or no
 * session row at all for this `eveSessionId`, collapses into the SAME 404 as
 * "chat identity not found" — the same indistinguishable-by-design posture
 * connect-link uses for this exact resolution boundary, for the same reason
 * (a distinguishable response would let any valid caller enumerate which
 * sessions exist).
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
 * Creation branches on the resolved identity: `identity.userId` non-null
 * means it is already linked to a real (GitHub-bound) user, so the existing
 * `createWorkspace` runs — the workspace is owned immediately via a
 * `workspace_memberships` row. `identity.userId` null means no linked user
 * yet, so `createWorkspaceOwnerElect` runs instead — the workspace exists
 * and the identity is bound to it, but ownership completes only once the
 * identity finishes a GitHub bind (issue #1263's connect flow) and issue
 * #1264 PR ② promotes it to an owner membership.
 *
 * Either branch is followed by `pinConversationWorkspace`, so the SAME
 * conversation that asked for the workspace is also the one pinned to it
 * (not just the identity) — this is what lets a later turn in this same
 * thread route straight to the workspace without re-asking. A refusal from
 * `pinConversationWorkspace` here should be UNREACHABLE: the refusal checks
 * above already guarantee neither the session nor the identity carries an
 * existing workspace, and the workspace this call just created is
 * immediately reachable from the identity (via its own `workspace_id` for
 * the owner-elect branch, or via the fresh `workspace_memberships` row for
 * the owned branch — see `listWorkspacesForChatIdentity`). A refusal here
 * means a race or a gap in that invariant, so it is treated as a 500-level
 * inconsistency (thrown, not swallowed into a misleading 201) rather than
 * silently reported as success for a conversation that isn't actually
 * pinned.
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

  if (!session || !identity) {
    return NextResponse.json({ error: "Chat identity not found" }, { status: 404 });
  }

  if (session.workspaceId != null || identity.workspaceId != null) {
    return NextResponse.json({ error: ALREADY_ATTACHED_MESSAGE }, { status: 409 });
  }

  const created = await createWorkspaceWithSlugRetry({
    identity,
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
