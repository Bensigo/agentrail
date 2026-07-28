/**
 * GET|POST /api/v1/runner/briefs
 *
 * Jace's read/write seam for briefs — the durable, server-side understanding
 * of ONE product idea, keyed `(workspace_id, slug)` (design spec:
 * docs/superpowers/specs/2026-07-28-jace-briefs-durable-idea-understanding-design.md,
 * spec PR #1487; store slice PR #1489). This exists because `grill-me` used
 * to be told to persist the requirements interview by writing `CONTEXT.md`
 * into the repo — impossible in the hosted deployment, which by design has
 * no git checkout (`apps/jace/Dockerfile` installs no git, clones nothing).
 * A real production session (2026-07-27, "i want to add a blog our app", 9
 * turns) ran the whole grill and persisted nothing: no server-durable home,
 * so the next turn re-asked what the human had already answered. Briefs are
 * that durable home for ELICITED knowledge, mirroring the durable home
 * `wiki_pages` already is for COMPILED knowledge.
 *
 * AUTH + TENANT: identical resolution chain to `runner/workspace-memory` and
 * `runner/repo-wiki` (see either route's own doc-comment for the full
 * rationale) — copied here deliberately rather than re-derived, because this
 * is the one tenancy posture every Jace-coordinator route must share. The
 * central `JACE_CONSOLE_TOKEN` secret via `requireJaceConsoleSecret` gates
 * WHO may call this route; it carries no per-caller `workspaceId`. WHICH
 * workspace is resolved server-side from the caller-supplied `eveSessionId`
 * through the `jace_sessions` ledger (`getJaceSessionByEveSessionId`) —
 * never trusted as a caller-supplied `workspaceId` directly, and never
 * guessable (`eveSessionId` is Eve's own opaque session id, read server-side
 * by the tool wrapper, never model-supplied). A session with no anchor at
 * all, or an intro session with no `workspaceId` yet, both collapse into the
 * same 404 — matching this seam's anti-enumeration posture elsewhere
 * (`runner/approvals`, `runner/workspace-memory`, `runner/repo-wiki`,
 * `connect-link`).
 *
 * GET's first three modes mirror `runner/repo-wiki`'s three-mode shape, so
 * there is one idiom to learn across both `fetch_*` tools; `anchor` is a
 * fourth mode specific to this route (repo-wiki has no session-level anchor
 * concept to expose):
 *   list   — every brief for the workspace, no items (the compact index).
 *   get    — one brief by `slug` (required), with its full item set. A
 *            brief is meant to be read WHOLE — nothing is ever ranked or
 *            trimmed inside one (design spec, "Retrieval — the whole
 *            mismatch surface").
 *   search — FTS over brief title + item statements (`query`, required —
 *            unlike repo-wiki's search this route treats a missing query as
 *            a 400 rather than a navigational default, since `fetch_briefs`
 *            has `list` for that job already), falling back to the most
 *            recently touched briefs on zero hits.
 *   anchor — the conversation→brief anchor this SESSION currently carries
 *            (design spec, "Retrieval — the whole mismatch surface", step 3;
 *            see `schema/jace_sessions.ts`'s doc-comment for how this anchor
 *            differs from the table's own workspace/chat-identity anchor
 *            pair). Needs no extra param: `getJaceSessionByEveSessionId`
 *            already returns the full session row, so its
 *            `anchoredBriefId` column is read directly off the SAME lookup
 *            every other mode already performs to resolve `workspaceId` —
 *            no second query. `{ anchor: null }` means this conversation has
 *            no brief anchored yet (the common case — most sessions never
 *            touch briefs), never an error.
 *
 * POST resolves the workspace, then `upsertBrief`s the brief-level fields,
 * then `patchBriefItems` for any `items` in the same call — the per-turn
 * autosave `save_brief` performs. `title` is required to CREATE a brief but
 * may be omitted on a later call that only touches items or `openQuestion`:
 * omitting it is not "clear the title", it is "leave it as it is", so this
 * route reads the existing brief's title forward when the caller doesn't
 * supply one, and 400s only if there is neither a supplied title nor an
 * existing brief to inherit one from.
 *
 * **`anchor` (optional boolean) sets or clears this SESSION's brief anchor as
 * a follow-on to the SAME call's `upsertBrief`** — the write behind "confirm
 * before the first write, then don't re-ask" (design spec step 2→3): once the
 * human has confirmed which brief this conversation is about, the caller
 * anchors to it in the very call that (creates or) touches it, never as a
 * separate slug-less request. `anchor: true` anchors to THIS call's brief
 * (`brief.id`, the row `upsertBrief` just returned); `anchor: false` clears
 * any existing anchor outright; omitted (the default) leaves the anchor
 * completely untouched — a caller with nothing to say about the anchor never
 * has to think about it. Deliberately NOT a caller-supplied brief id or a
 * second `anchorSlug` field: **the only brief this route can ever anchor a
 * session to is one it just resolved through the SAME workspace-scoped
 * `slug` this call already validated** (`upsertBrief` upserts strictly within
 * `(workspaceId, slug)` — it can create a new row or touch an existing one,
 * but never in a workspace other than the caller's own resolved one). That
 * is the tenancy boundary the design spec calls out ("a brief slug that does
 * not resolve in the caller's workspace must not be anchorable") enforced
 * structurally rather than as a runtime check bolted on afterward — there is
 * no code path here that ever accepts a raw, caller-chosen brief id at all.
 * `brief.workspaceId !== workspaceId` is asserted anyway immediately before
 * anchoring (belt-and-suspenders, mirroring `repinConversationWorkspace`'s
 * own re-verified-even-though-structurally-guaranteed authority check) —
 * defense in depth against a hypothetical future store-layer bug, not a
 * check this route's own logic can actually fail today.
 *
 * **`status` is rejected outright, not silently dropped.** The design spec's
 * pinned v1 contract listed `status?` on `save_brief`'s payload — that line
 * was wrong (see the one-line correction made to the spec alongside this
 * route). The same spec is explicit that `status` (`draft|ready`) is a HUMAN
 * label toggled in the console, and that implementation-readiness is
 * computed separately (`computeBriefReadiness`) precisely so "ready" can
 * never become a flag the model sets on itself to unblock its own work.
 * Accepting `status` here would hand the model exactly that flag. A caller
 * that sends it gets a 400 naming the field, not a request that quietly
 * ignores it — a silently dropped field teaches the caller nothing, and a
 * caller that thinks it flipped a brief to `ready` when it did not is the
 * same failure class this whole feature exists to remove.
 *
 * **Secret scan on write covers every free-text field this route persists,
 * not only items** — mirroring `ingest/memory-items`'s own reasoning
 * ("Memory content is injected verbatim into agent prompts, so a credential
 * persisted here can be exfiltrated to any run in the workspace"), which is
 * about the READ-BACK path and applies regardless of which column the text
 * sits in. Scanned: `title`, `openQuestion` (the question in flight,
 * composed by the model from what the human just said — the most likely
 * place a pasted key gets echoed back and then replayed on every future
 * resume), every item's `statement`/`evidence`, and — deliberately, even
 * though lower-risk — `grounding`'s string fields (see the scan's own
 * inline comment for why identifiers get scanned too, not exempted). ALL of
 * it is scanned in one batch before anything is written; ANY finding rejects
 * the WHOLE batch (422) — never a partially-scanned write, and never
 * silently redacted.
 *
 * **Both store-level refusals are relayed honestly, never swallowed.**
 * `patchBriefItems` reports `skippedHumanAuthorityIds` (writes dropped
 * because the item is human-locked) and `skippedUnknownResolvedIds` (writes
 * dropped because an `unknown`-kind item can't resolve without first being
 * re-kinded). Both arrays are always present in a 200 body, even when empty
 * — a caller that cannot see its write was dropped will confidently tell a
 * human something was recorded when it wasn't.
 *
 * 400 — missing/blank `eveSessionId`, invalid `mode` (GET), a `get` with no
 * `slug` or a `search` with no `query` (GET), invalid JSON or a malformed
 * body (POST), `status` present in the POST body, or a POST with no title
 * and no existing brief to inherit one from. 401 — bad/missing shared
 * secret. 404 — no session, a session with no resolved workspace yet, (GET
 * mode=get) no brief at that slug, or (POST `anchor: true`) the resolved
 * brief does not belong to the caller's own workspace (see the `anchor`
 * paragraph above — unreachable through this route's own logic today, kept
 * as defense in depth). 422 — a credential-shaped value in `title`,
 * `openQuestion`, `grounding`, or an item's `statement`/`evidence`. 502 —
 * the backing store errored.
 */
import { NextRequest, NextResponse } from "next/server";
import {
  getJaceSessionByEveSessionId,
  getBriefBySlug,
  listBriefs,
  searchBriefs,
  upsertBrief,
  patchBriefItems,
  setSessionBriefAnchor,
  clearSessionBriefAnchor,
} from "@agentrail/db-postgres";
import type {
  BriefArea,
  BriefGrounding,
  BriefItemKind,
  BriefItemResolution,
  BriefItemState,
  PatchBriefItemInput,
} from "@agentrail/db-postgres";
import { requireJaceConsoleSecret } from "../../../../../lib/jace-console-auth";
import { scanForSecrets, summarizeFindings } from "../../../../../lib/secret-scan";

const MODES = ["list", "get", "search", "anchor"] as const;
type Mode = (typeof MODES)[number];

const BRIEF_AREAS: readonly BriefArea[] = [
  "problem",
  "users",
  "constraints",
  "scope",
  "success-signal",
];
const BRIEF_ITEM_KINDS: readonly BriefItemKind[] = [
  "required",
  "optional",
  "unknown",
  "out-of-scope",
];
const BRIEF_ITEM_STATES: readonly BriefItemState[] = ["open", "resolved"];
const BRIEF_ITEM_RESOLUTIONS: readonly BriefItemResolution[] = [
  "implemented",
  "deferred",
  "rejected",
  "satisfied-elsewhere",
];

// ---- POST body validation (hand-rolled edge validators, mirroring
// ingest/memory-items' isRawBody/isRawMemoryItem — this codebase validates
// request bodies at the edge with explicit type-guard functions, not a
// schema library). ----

interface RawBriefItem {
  id?: string;
  area: string;
  statement: string;
  evidence?: string;
  kind: string;
  state?: string;
  resolution?: string | null;
}

interface RawPostBody {
  eveSessionId: string;
  slug: string;
  title?: string;
  openQuestion?: string;
  grounding?: BriefGrounding;
  items?: RawBriefItem[];
  // Conversation→brief anchor (see this route's own doc-comment for the full
  // "anchor" paragraph): true anchors this session to THIS call's brief,
  // false clears any existing anchor, omitted leaves it untouched.
  anchor?: boolean;
}

function isBriefGrounding(v: unknown): v is BriefGrounding {
  if (!v || typeof v !== "object") return false;
  const o = v as Record<string, unknown>;
  return (
    Array.isArray(o.wikiPageSlugs) &&
    (o.wikiPageSlugs as unknown[]).every((s) => typeof s === "string") &&
    Array.isArray(o.memoryItemIds) &&
    (o.memoryItemIds as unknown[]).every((s) => typeof s === "string") &&
    (o.commitSha === null || typeof o.commitSha === "string")
  );
}

function isRawBriefItem(v: unknown): v is RawBriefItem {
  if (!v || typeof v !== "object") return false;
  const o = v as Record<string, unknown>;
  if (o.id !== undefined && typeof o.id !== "string") return false;
  if (typeof o.area !== "string" || !(BRIEF_AREAS as readonly string[]).includes(o.area)) {
    return false;
  }
  if (typeof o.statement !== "string" || o.statement.trim().length === 0) return false;
  if (o.evidence !== undefined && typeof o.evidence !== "string") return false;
  if (
    typeof o.kind !== "string" ||
    !(BRIEF_ITEM_KINDS as readonly string[]).includes(o.kind)
  ) {
    return false;
  }
  if (
    o.state !== undefined &&
    (typeof o.state !== "string" || !(BRIEF_ITEM_STATES as readonly string[]).includes(o.state))
  ) {
    return false;
  }
  if (
    o.resolution !== undefined &&
    o.resolution !== null &&
    (typeof o.resolution !== "string" ||
      !(BRIEF_ITEM_RESOLUTIONS as readonly string[]).includes(o.resolution))
  ) {
    return false;
  }
  return true;
}

function isRawPostBody(v: unknown): v is RawPostBody {
  if (!v || typeof v !== "object") return false;
  const o = v as Record<string, unknown>;
  if (typeof o.eveSessionId !== "string") return false;
  if (typeof o.slug !== "string" || o.slug.trim().length === 0) return false;
  if (o.title !== undefined && typeof o.title !== "string") return false;
  if (o.openQuestion !== undefined && typeof o.openQuestion !== "string") return false;
  if (o.grounding !== undefined && !isBriefGrounding(o.grounding)) return false;
  if (
    o.items !== undefined &&
    (!Array.isArray(o.items) || !(o.items as unknown[]).every(isRawBriefItem))
  ) {
    return false;
  }
  if (o.anchor !== undefined && typeof o.anchor !== "boolean") return false;
  return true;
}

function toPatchInput(item: RawBriefItem): PatchBriefItemInput {
  const input: PatchBriefItemInput = {
    area: item.area as BriefArea,
    statement: item.statement,
    kind: item.kind as BriefItemKind,
  };
  if (item.id !== undefined) input.id = item.id;
  if (item.evidence !== undefined) input.evidence = item.evidence;
  if (item.state !== undefined) input.state = item.state as BriefItemState;
  if (item.resolution !== undefined) {
    input.resolution = item.resolution as BriefItemResolution | null;
  }
  return input;
}

export async function GET(request: NextRequest) {
  const authError = requireJaceConsoleSecret(request);
  if (authError) return authError;

  const eveSessionId = request.nextUrl.searchParams.get("eveSessionId")?.trim() ?? "";
  if (!eveSessionId) {
    return NextResponse.json({ error: "eveSessionId is required" }, { status: 400 });
  }

  const session = await getJaceSessionByEveSessionId(eveSessionId);
  if (!session || !session.workspaceId) {
    return NextResponse.json({ error: "Session not found" }, { status: 404 });
  }
  const workspaceId = session.workspaceId;

  const modeParam = request.nextUrl.searchParams.get("mode") ?? "";
  if (!(MODES as readonly string[]).includes(modeParam)) {
    return NextResponse.json(
      { error: "mode must be one of list, get, search, anchor" },
      { status: 400 }
    );
  }
  const mode = modeParam as Mode;

  if (mode === "anchor") {
    // Read straight off the session row already fetched above —
    // `anchoredBriefId` lives on `jace_sessions` itself, so resolving
    // `workspaceId` and reading the anchor are the SAME lookup, not two.
    return NextResponse.json({
      schemaVersion: 1,
      mode,
      anchor: session.anchoredBriefId ? { briefId: session.anchoredBriefId } : null,
    });
  }

  try {
    if (mode === "get") {
      const slug = request.nextUrl.searchParams.get("slug")?.trim() ?? "";
      if (!slug) {
        return NextResponse.json({ error: "slug is required for mode=get" }, { status: 400 });
      }
      const brief = await getBriefBySlug(workspaceId, slug);
      if (!brief) {
        return NextResponse.json({ error: `Brief ${slug} not found` }, { status: 404 });
      }
      return NextResponse.json({ schemaVersion: 1, mode, brief });
    }

    if (mode === "search") {
      const query = request.nextUrl.searchParams.get("query")?.trim() ?? "";
      if (!query) {
        return NextResponse.json(
          { error: "query is required for mode=search" },
          { status: 400 }
        );
      }
      const briefs = await searchBriefs(workspaceId, query);
      return NextResponse.json({ schemaVersion: 1, mode, briefs });
    }

    // mode === "list"
    const briefs = await listBriefs(workspaceId);
    return NextResponse.json({ schemaVersion: 1, mode, briefs });
  } catch (err) {
    console.error("[runner/briefs] read failed:", err);
    return NextResponse.json({ error: "Upstream storage error" }, { status: 502 });
  }
}

export async function POST(request: NextRequest) {
  const authError = requireJaceConsoleSecret(request);
  if (authError) return authError;

  let raw: unknown;
  try {
    raw = await request.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON" }, { status: 400 });
  }

  // Rejected outright, ahead of the general shape check, so the caller gets
  // a message naming exactly why — see this route's doc-comment ("`status`
  // is rejected outright, not silently dropped").
  if (raw && typeof raw === "object" && "status" in (raw as Record<string, unknown>)) {
    return NextResponse.json(
      {
        error:
          "status is not accepted on this route — it is a human-only label toggled in the console, never set by Jace. Implementation-readiness is computed separately (computeBriefReadiness).",
      },
      { status: 400 }
    );
  }

  if (!isRawPostBody(raw)) {
    return NextResponse.json(
      {
        error:
          "Body must have eveSessionId (string), slug (non-empty string), and optional title/openQuestion (string), grounding ({wikiPageSlugs[], memoryItemIds[], commitSha}), items (array of {id?, area, statement, evidence?, kind, state?, resolution?}), anchor (boolean)",
      },
      { status: 400 }
    );
  }

  const eveSessionId = raw.eveSessionId.trim();
  if (!eveSessionId) {
    return NextResponse.json({ error: "eveSessionId is required" }, { status: 400 });
  }

  const session = await getJaceSessionByEveSessionId(eveSessionId);
  if (!session || !session.workspaceId) {
    return NextResponse.json({ error: "Session not found" }, { status: 404 });
  }
  const workspaceId = session.workspaceId;

  const slug = raw.slug.trim();
  const items = raw.items ?? [];

  // Write-side secret scan (mirrors ingest/memory-items, issue #1032): "Memory
  // content is injected verbatim into agent prompts, so a credential
  // persisted here can be exfiltrated to any run in the workspace" — that
  // reasoning is about the READ-BACK path, not about which column the text
  // happens to live in, and every free-text field this route durably writes
  // is read back into Jace's context on resume. So this scans ALL of them,
  // not just items:
  //   - `statement` / `evidence` — grilled text is user-typed prose relayed
  //     through a model and can carry a pasted credential (the original
  //     motivating case).
  //   - `openQuestion` — the MOST likely place for this to actually happen:
  //     it stores the question in flight when a conversation stops, composed
  //     by the model from what the human JUST said. A human pastes a key
  //     mid-grill and Jace's next question echoes it back
  //     ("you mentioned sk-live-… — is that the one to use?") — that string
  //     would otherwise persist unscanned and get replayed into every future
  //     resume.
  //   - `title` — also free text, same read-back path, lower likelihood but
  //     no reason to carve out an exception.
  //   - `grounding.wikiPageSlugs` / `grounding.memoryItemIds` / `commitSha` —
  //     scanned too, deliberately, even though these are meant to be
  //     identifiers (slugs/UUIDs/commit shas) rather than human prose and the
  //     content they POINT AT already passed its own scan at ITS write time
  //     (memory items through ingest/memory-items; wiki pages are compiled
  //     from repo source, not user paste). Nothing at the type level stops a
  //     caller putting arbitrary strings in these fields, and the cost of
  //     scanning a handful of short strings is negligible — so rather than
  //     rely on "it's probably safe because it's structured," this route
  //     scans it like everything else. If this ever proves too aggressive
  //     (a legitimate slug/sha matching a pattern), narrow the scan here,
  //     don't skip it.
  //
  // Every field is scanned in ONE batch and the whole write is rejected on
  // any finding — fail closed, before any write, never a partially-scanned
  // batch (a title/openQuestion write must not land while only the items are
  // held back, or vice versa).
  const groundingStrings: string[] = raw.grounding
    ? [
        ...raw.grounding.wikiPageSlugs,
        ...raw.grounding.memoryItemIds,
        ...(raw.grounding.commitSha ? [raw.grounding.commitSha] : []),
      ]
    : [];

  const secretFindings = [
    ...(raw.title ? scanForSecrets(raw.title).findings : []),
    ...(raw.openQuestion ? scanForSecrets(raw.openQuestion).findings : []),
    ...groundingStrings.flatMap((s) => scanForSecrets(s).findings),
    ...items.flatMap((item) => [
      ...scanForSecrets(item.statement).findings,
      ...(item.evidence ? scanForSecrets(item.evidence).findings : []),
    ]),
  ];
  if (secretFindings.length > 0) {
    const reason = summarizeFindings(secretFindings);
    console.warn(`[runner/briefs] rejected batch for brief ${slug}: ${reason}`);
    return NextResponse.json(
      { error: "Brief content rejected: credential-shaped value detected", reason },
      { status: 422 }
    );
  }

  try {
    // `title` is required to CREATE a brief but omittable on a later call
    // that only touches items/openQuestion — inherit the existing title
    // rather than treating "omitted" as "clear it".
    let title = raw.title;
    if (title === undefined) {
      const existing = await getBriefBySlug(workspaceId, slug);
      if (!existing) {
        return NextResponse.json(
          { error: "title is required to create a new brief" },
          { status: 400 }
        );
      }
      title = existing.title;
    }

    const brief = await upsertBrief({
      workspaceId,
      slug,
      title,
      openQuestion: raw.openQuestion,
      grounding: raw.grounding,
    });

    const { upserted, skippedHumanAuthorityIds, skippedUnknownResolvedIds } =
      await patchBriefItems(brief.id, items.map(toPatchInput));

    // Conversation→brief anchor (see this route's doc-comment's "anchor"
    // paragraph): a follow-on to the SAME call's upsertBrief, never a
    // separate caller-supplied brief id.
    let anchor: { briefId: string } | null | undefined;
    if (raw.anchor === true) {
      // Defense in depth only — structurally unreachable today, since
      // `brief` was just upserted strictly within `workspaceId` above (see
      // the doc-comment). Never anchor a session to a brief outside its own
      // resolved workspace, even if a future store-layer change made this
      // reachable.
      if (brief.workspaceId !== workspaceId) {
        return NextResponse.json(
          { error: "Brief does not belong to this workspace" },
          { status: 404 }
        );
      }
      await setSessionBriefAnchor(session.id, brief.id);
      anchor = { briefId: brief.id };
    } else if (raw.anchor === false) {
      await clearSessionBriefAnchor(session.id);
      anchor = null;
    }

    return NextResponse.json(
      {
        brief,
        items: upserted,
        skippedHumanAuthorityIds,
        skippedUnknownResolvedIds,
        ...(anchor !== undefined ? { anchor } : {}),
      },
      { status: 200 }
    );
  } catch (err) {
    console.error("[runner/briefs] write failed:", err);
    return NextResponse.json({ error: "Upstream storage error" }, { status: 502 });
  }
}
