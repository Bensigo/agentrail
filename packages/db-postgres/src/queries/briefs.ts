import { and, desc, eq, inArray, sql } from "drizzle-orm";
import { db } from "../db.js";
import {
  briefs,
  briefItems,
  briefWorkLinks,
  BRIEF_GROUNDING_DEFAULT,
  BRIEF_STATUS_DEFAULT,
} from "../schema/briefs.js";
import type {
  Brief,
  BriefArea,
  BriefAuthority,
  BriefGrounding,
  BriefItem,
  BriefItemKind,
  BriefItemResolution,
  BriefItemState,
  BriefStatus,
  BriefWorkLink,
  BriefWorkLinkRole,
} from "../schema/briefs.js";

/**
 * Briefs queries (design spec:
 * docs/superpowers/specs/2026-07-28-jace-briefs-durable-idea-understanding-design.md,
 * spec PR #1487). `briefs`/`brief_items` follow the shape `wiki_pages`
 * already established for a server-durable system of record:
 * upsert-by-identity writes (`(workspace_id, slug)`, mirroring
 * `replaceMemoryItemsByWriter`'s "a re-run replaces its own prior state, not
 * a fresh append" idempotency) and an FTS search mirroring `retrieveMemory`'s
 * step-1 prefilter / `searchWikiPages` — `websearch_to_tsquery` over a GIN
 * index via raw `db.execute(sql\`…\`)`, falling back to recency on zero hits.
 *
 * `patchBriefItems` is the one function here that is NOT a mirror of an
 * existing shape: it is a per-item DELTA upsert (never a full-brief replace
 * — a full-replace write would cost a full regurgitation of the brief on
 * every turn and let the model silently drop earlier content), and it
 * enforces the human-authority invariant at the store layer, not as a
 * caller convention. See that function's doc-comment for the enforcement.
 */

/** Map a raw (snake_case) `db.execute` row back to the typed `Brief` shape. See `mapWikiPageExecRow` for why `new Date(...)` (not an `as Date` cast) is required here: raw `db.execute` bypasses drizzle's column-type mapper, so a real Postgres hands back timestamptz columns as plain strings. */
function mapBriefExecRow(r: Record<string, unknown>): Brief {
  return {
    id: String(r.id),
    workspaceId: String(r.workspace_id),
    repositoryId: (r.repository_id as string | null) ?? null,
    slug: String(r.slug),
    title: String(r.title),
    status: r.status as BriefStatus,
    openQuestion: String(r.open_question),
    grounding: (r.grounding as BriefGrounding | null) ?? { ...BRIEF_GROUNDING_DEFAULT },
    jaceSessionIds: (r.jace_session_ids as string[] | null) ?? [],
    createdAt: new Date(r.created_at as string | number | Date),
    updatedAt: new Date(r.updated_at as string | number | Date),
  };
}

export interface BriefWithItems extends Brief {
  items: BriefItem[];
}

/** Batch-load every item for a set of brief ids, grouped by `briefId`, ordered oldest-first within each brief so a resumed conversation reads items in the order they were settled. Shared by `getBriefBySlug` (one brief) and `searchBriefs` (a page of briefs) so both honor "get returns the whole brief; nothing is ever ranked or trimmed INSIDE one" (design spec, "Retrieval — the whole mismatch surface") the same way. */
async function fetchItemsForBriefIds(briefIds: string[]): Promise<Map<string, BriefItem[]>> {
  const map = new Map<string, BriefItem[]>();
  if (briefIds.length === 0) return map;
  const rows = await db
    .select()
    .from(briefItems)
    .where(inArray(briefItems.briefId, briefIds))
    .orderBy(briefItems.createdAt);
  for (const row of rows) {
    const bucket = map.get(row.briefId);
    if (bucket) bucket.push(row);
    else map.set(row.briefId, [row]);
  }
  return map;
}

export interface UpsertBriefInput {
  workspaceId: string;
  /** Nullable/omittable — a brief can exist before a repo is connected. */
  repositoryId?: string | null;
  slug: string;
  title: string;
  status?: BriefStatus;
  openQuestion?: string;
  grounding?: BriefGrounding;
  jaceSessionIds?: string[];
}

/**
 * Upsert-by-`(workspace_id, slug)` — the identity a brief keeps for its
 * entire life (design spec: "keyed `(workspace_id, slug)` — upsert-by-
 * identity, mirroring `wiki_pages`'"). This is the write path `save_brief`
 * calls every turn a grill session settles something, so it is a PARTIAL
 * patch, not a full replace: any field omitted from `input` is left
 * untouched on an existing row (only applied as a default on first insert).
 * Getting this wrong — e.g. defaulting `openQuestion` to `""` on every
 * update — would silently erase the in-flight question the moment a caller
 * patches only the title, defeating the "resume, don't restart" guarantee
 * this table exists for.
 */
export async function upsertBrief(input: UpsertBriefInput): Promise<Brief> {
  const patch: Record<string, unknown> = { title: input.title, updatedAt: new Date() };
  if (input.repositoryId !== undefined) patch.repositoryId = input.repositoryId;
  if (input.status !== undefined) patch.status = input.status;
  if (input.openQuestion !== undefined) patch.openQuestion = input.openQuestion;
  if (input.grounding !== undefined) patch.grounding = input.grounding;
  if (input.jaceSessionIds !== undefined) patch.jaceSessionIds = input.jaceSessionIds;

  const [row] = await db
    .insert(briefs)
    .values({
      workspaceId: input.workspaceId,
      repositoryId: input.repositoryId ?? null,
      slug: input.slug,
      title: input.title,
      status: input.status ?? BRIEF_STATUS_DEFAULT,
      openQuestion: input.openQuestion ?? "",
      grounding: input.grounding ?? BRIEF_GROUNDING_DEFAULT,
      jaceSessionIds: input.jaceSessionIds ?? [],
    })
    .onConflictDoUpdate({
      target: [briefs.workspaceId, briefs.slug],
      set: patch,
    })
    .returning();
  return row!;
}

/**
 * Brief + all its items in one call — the shape `get_brief`/`fetch_briefs(mode: "get")`
 * needs, since a brief is meant to be read whole (see `fetchItemsForBriefIds`'s
 * doc-comment). Null when no brief matches this `(workspaceId, slug)`.
 */
export async function getBriefBySlug(
  workspaceId: string,
  slug: string
): Promise<BriefWithItems | null> {
  const [brief] = await db
    .select()
    .from(briefs)
    .where(and(eq(briefs.workspaceId, workspaceId), eq(briefs.slug, slug)))
    .limit(1);
  if (!brief) return null;
  const itemsByBriefId = await fetchItemsForBriefIds([brief.id]);
  return { ...brief, items: itemsByBriefId.get(brief.id) ?? [] };
}

/**
 * Same shape as {@link getBriefBySlug}, keyed by `id` instead of `slug` — the
 * lookup `runner/briefs`' `mode=anchor` needs: `jace_sessions.anchoredBriefId`
 * stores a brief ID (not a slug, since it's set from an already-resolved
 * `Brief` row, not caller input — see `schema/jace_sessions.ts`'s anchor
 * doc-comment), so resuming a conversation from its anchor has no slug to
 * look up BY. Scoped to `(workspaceId, id)`, same tenancy posture as every
 * other lookup in this file, even though in practice an anchor can only ever
 * have been set to a brief already resolved within that same workspace (see
 * `runner/briefs` route's own doc-comment on the anchor's tenancy boundary) —
 * this scope is what makes that guarantee enforceable at the read site too,
 * not just assumed from how the write path behaves. Null when no brief
 * matches this `(workspaceId, id)` pair, e.g. the anchored brief was deleted
 * out from under a stale anchor read racing the cascade, or `id` belongs to
 * a different workspace entirely.
 */
export async function getBriefById(
  workspaceId: string,
  id: string
): Promise<BriefWithItems | null> {
  const [brief] = await db
    .select()
    .from(briefs)
    .where(and(eq(briefs.workspaceId, workspaceId), eq(briefs.id, id)))
    .limit(1);
  if (!brief) return null;
  const itemsByBriefId = await fetchItemsForBriefIds([brief.id]);
  return { ...brief, items: itemsByBriefId.get(brief.id) ?? [] };
}

/**
 * The compact index — every brief for a workspace, WITHOUT items, ordered
 * most-recently-touched first. Backs `fetch_briefs(mode: "list")` and any
 * console index view; deliberately excludes items so listing a workspace's
 * briefs never pulls a full N-brief × M-item join for a view that never
 * shows item detail.
 */
export async function listBriefs(workspaceId: string): Promise<Brief[]> {
  return db
    .select()
    .from(briefs)
    .where(eq(briefs.workspaceId, workspaceId))
    .orderBy(desc(briefs.updatedAt));
}

export const BRIEF_SEARCH_DEFAULT_LIMIT = 5;
export const BRIEF_SEARCH_MAX_LIMIT = 10;

/**
 * FTS over brief title + item statements, mirroring `searchWikiPages`'
 * `websearch_to_tsquery` / `ts_rank_cd` shape (itself mirroring
 * `retrieveMemory`'s step-1 prefilter). This is the ONLY disambiguation
 * step in the whole brief lifecycle (design spec, "Retrieval — the whole
 * mismatch surface"): a false match here merges two ideas into one brief
 * with no close to bound the damage, and a false miss forks a second brief
 * for the same idea and splits its context. Both failure modes are
 * confined to "which brief", never "which part" — nothing is ranked or
 * trimmed inside a returned brief, every match comes back with its full
 * item set.
 *
 * Item statements are pre-aggregated per brief (`string_agg`) so a single
 * `to_tsvector` covers `title || ' ' || <all statements>` — a match on a
 * word that appears only in one item's `statement` (not the title) must
 * still surface the brief, since that is the whole point of searching
 * "over brief title + item statements" rather than titles alone. An
 * empty/whitespace query skips the FTS round trip, and a zero-hit FTS query
 * both fall back to the most recently touched briefs — search is a
 * navigation aid here, never a dead end.
 */
export async function searchBriefs(
  workspaceId: string,
  query: string,
  limit: number = BRIEF_SEARCH_DEFAULT_LIMIT
): Promise<BriefWithItems[]> {
  const trimmedQuery = query.trim();
  const cappedLimit = Math.min(BRIEF_SEARCH_MAX_LIMIT, Math.max(1, Math.trunc(limit) || 1));

  let rows: Record<string, unknown>[] = [];

  if (trimmedQuery.length > 0) {
    const result = await db.execute(sql`
      SELECT b.id, b.workspace_id, b.repository_id, b.slug, b.title, b.status,
             b.open_question, b.grounding, b.jace_session_ids, b.created_at, b.updated_at
      FROM briefs b
      LEFT JOIN (
        SELECT brief_id, string_agg(statement, ' ') AS statements
        FROM brief_items
        GROUP BY brief_id
      ) items_agg ON items_agg.brief_id = b.id
      WHERE b.workspace_id = ${workspaceId}
        AND to_tsvector('english', b.title || ' ' || coalesce(items_agg.statements, ''))
              @@ websearch_to_tsquery('english', ${trimmedQuery})
      ORDER BY ts_rank_cd(
        to_tsvector('english', b.title || ' ' || coalesce(items_agg.statements, '')),
        websearch_to_tsquery('english', ${trimmedQuery})
      ) DESC
      LIMIT ${cappedLimit}
    `);
    rows = Array.from(result) as Record<string, unknown>[];
  }

  if (rows.length === 0) {
    const recent = await db.execute(sql`
      SELECT id, workspace_id, repository_id, slug, title, status,
             open_question, grounding, jace_session_ids, created_at, updated_at
      FROM briefs
      WHERE workspace_id = ${workspaceId}
      ORDER BY updated_at DESC
      LIMIT ${cappedLimit}
    `);
    rows = Array.from(recent) as Record<string, unknown>[];
  }

  const mappedBriefs = rows.map(mapBriefExecRow);
  const itemsByBriefId = await fetchItemsForBriefIds(mappedBriefs.map((b) => b.id));
  return mappedBriefs.map((b) => ({ ...b, items: itemsByBriefId.get(b.id) ?? [] }));
}

export interface PatchBriefItemInput {
  /** Omitted to insert a new item; supplied to update an existing one. */
  id?: string;
  area: BriefArea;
  statement: string;
  evidence?: string;
  kind: BriefItemKind;
  state?: BriefItemState;
  resolution?: BriefItemResolution | null;
}

export interface PatchBriefItemsResult {
  /** Items actually inserted or updated, in call order. */
  upserted: BriefItem[];
  /** Ids of existing items whose write was dropped because their `authority` is `'human'`. */
  skippedHumanAuthorityIds: string[];
  /**
   * Items refused because they would land as `kind: 'unknown'` while
   * `state: 'resolved'` (with any resolution, or none) — see this
   * function's doc-comment. Existing items report their `id`; a brand-new
   * item (no `id` yet to report) reports its `statement` instead.
   */
  skippedUnknownResolvedIds: string[];
}

/**
 * DELTA upsert of individual items — never a full-brief replace. `save_brief`
 * calls this once per turn with only the items that changed; every other
 * item on the brief is left exactly as it was — at the ITEM level (no other
 * row is touched) and, within a touched row, at the FIELD level too: any
 * field a caller omits from `PatchBriefItemInput` (`evidence`, `state`,
 * `resolution`) must carry its stored value forward unchanged, never reset
 * to a default. Getting this wrong would mean a caller fixing a typo in an
 * already-`resolved`/`implemented` item's wording — sending only
 * `{id, area, statement, kind}` — silently flips it back to `state: 'open'`
 * and wipes its `resolution` and `evidence`. Delivered work would resurrect
 * into the current phase, an `unknown`-kind item would silently re-block
 * `computeBriefReadiness`, and `evidence` — which exists specifically so
 * understanding survives a context compaction with its reasoning intact —
 * would be erased by an edit that never touched it. A full-replace write
 * would also force a full regurgitation of the brief's entire item set on
 * every turn (expensive, and every regurgitation is a chance for the model
 * to silently drop something it forgot to re-send); the delta-at-both-levels
 * shape is what makes autosave-per-resolved-item affordable AND safe.
 *
 * **Human-authority invariant, enforced HERE, not by caller convention**: any
 * existing item (matched by `id`) whose `authority` is `'human'` is silently
 * skipped — its row is left completely untouched and its id is reported back
 * in `skippedHumanAuthorityIds` so a caller CAN explain the refusal, but
 * nothing requires it to. This mirrors the design spec's own framing
 * ("Human edits win, enforced at the route... this is route enforcement,
 * not a prompt instruction — 'please don't overwrite' fails the first time
 * the model feels confident, and a human whose correction is silently
 * reverted stops correcting"). Putting the check in a prompt or in the
 * caller would mean every future caller of this store has to remember to
 * re-implement it; putting it here means it is impossible to bypass short
 * of a raw SQL write.
 *
 * **An `unknown` item may never be `resolved`, enforced HERE alongside its
 * human-authority twin above** — not split across this store and the
 * console route, which would leave one invariant unbypassable and the other
 * a caller convention that degrades the moment a caller forgets it. The
 * rule is deliberately total, not a list of forbidden resolutions: an
 * `unknown` is not a requirement yet, so there is nothing to RESOLVE —
 * resolving one is only ever possible by first changing its `kind`. Every
 * specific case collapses under that lens rather than needing its own
 * carve-out — you cannot mark something `implemented` you never answered;
 * if it turned out to be `satisfied-elsewhere` then you learned the answer,
 * so the `kind` should have changed to `required`/`optional` before it
 * resolved; `rejected` is `out-of-scope` wearing a different hat. The only
 * two legitimate exits for an `unknown` are answering it (which re-kinds it
 * `required`/`optional`, after which it can resolve normally) or marking it
 * `out-of-scope` (which needs no resolution at all). Phrasing the guard as
 * "kind = unknown forbids state = resolved", not "kind = unknown forbids
 * resolution = X", also means a future sixth resolution value is covered
 * for free — nobody has to remember to add it to a forbidden list.
 *
 * This applies regardless of who is writing — including a human console
 * edit — so it is checked against the EFFECTIVE post-patch value (merging
 * any field this call omits with the item's existing stored value), not
 * just the fields this particular call happens to mention: a patch that
 * only changes `kind` to `unknown` on a row already `resolved` from an
 * earlier write must be caught too.
 *
 * Items without an `id` are always inserted (there is nothing existing to
 * protect), and always land with `authority: 'jace'` — the schema default —
 * since only a human console edit is ever entitled to assert `'human'`.
 */
export async function patchBriefItems(
  briefId: string,
  items: PatchBriefItemInput[]
): Promise<PatchBriefItemsResult> {
  if (items.length === 0)
    return { upserted: [], skippedHumanAuthorityIds: [], skippedUnknownResolvedIds: [] };

  return db.transaction(async (tx) => {
    const idsToCheck = items.filter((i): i is PatchBriefItemInput & { id: string } => !!i.id).map((i) => i.id);

    const existingRows =
      idsToCheck.length > 0
        ? await tx
            .select({
              id: briefItems.id,
              authority: briefItems.authority,
              state: briefItems.state,
            })
            .from(briefItems)
            .where(and(eq(briefItems.briefId, briefId), inArray(briefItems.id, idsToCheck)))
        : [];
    const existingById = new Map(existingRows.map((row) => [row.id, row]));

    const upserted: BriefItem[] = [];
    const skippedHumanAuthorityIds: string[] = [];
    const skippedUnknownResolvedIds: string[] = [];

    for (const item of items) {
      const existing = item.id ? existingById.get(item.id) : undefined;

      if (item.id && existing?.authority === ("human" as BriefAuthority)) {
        skippedHumanAuthorityIds.push(item.id);
        continue;
      }

      // Effective post-patch state: whatever this call supplies, else
      // whatever the row already has (else the schema default, for a
      // brand-new item) — see the doc-comment above for why this must be
      // the MERGED value, not just what this call happens to mention. The
      // rule is total over `state`, not keyed to any particular
      // `resolution` — an `unknown` has nothing to resolve, full stop.
      const effectiveState: BriefItemState = "state" in item ? item.state! : existing?.state ?? "open";
      if (item.kind === "unknown" && effectiveState === "resolved") {
        skippedUnknownResolvedIds.push(item.id ?? item.statement);
        continue;
      }

      if (item.id) {
        const set: Record<string, unknown> = {
          area: item.area,
          statement: item.statement,
          kind: item.kind,
          updatedAt: new Date(),
        };
        // Only touch a field this call actually supplied — an omitted
        // `evidence`/`state`/`resolution` must survive untouched.
        if ("evidence" in item) set.evidence = item.evidence;
        if ("state" in item) set.state = item.state;
        if ("resolution" in item) set.resolution = item.resolution;

        const [row] = await tx
          .update(briefItems)
          .set(set)
          .where(and(eq(briefItems.id, item.id), eq(briefItems.briefId, briefId)))
          .returning();
        if (row) upserted.push(row);
      } else {
        const [row] = await tx
          .insert(briefItems)
          .values({
            briefId,
            area: item.area,
            statement: item.statement,
            evidence: item.evidence ?? "",
            kind: item.kind,
            state: item.state ?? "open",
            resolution: item.resolution ?? null,
          })
          .returning();
        if (row) upserted.push(row);
      }
    }

    return { upserted, skippedHumanAuthorityIds, skippedUnknownResolvedIds };
  });
}

/**
 * `status` is a HUMAN label toggled in the console (design spec, "`status`
 * is `draft | ready` and is a HUMAN label... Implementation-readiness is
 * computed separately from the items"). This setter exists precisely so
 * nothing else writes this column directly — `to-issues` must gate on
 * `computeBriefReadiness`, never on this flag, or "ready" degenerates into
 * something the model can set on itself to unblock its own work.
 */
export async function setBriefStatus(briefId: string, status: BriefStatus): Promise<Brief | null> {
  const [row] = await db
    .update(briefs)
    .set({ status, updatedAt: new Date() })
    .where(eq(briefs.id, briefId))
    .returning();
  return row ?? null;
}

export interface LinkBriefWorkInput {
  briefId: string;
  /** Omitted for an epic-parent issue, which represents the whole brief rather than one item. */
  briefItemId?: string | null;
  repo: string;
  issueNumber: number;
  role: BriefWorkLinkRole;
}

/**
 * Records the RESULT of turning a brief into work (design spec, "Brief →
 * Work (not Brief → Issue)"): a brief may produce no work yet, one issue,
 * several issues, or an epic that expands into issues, and that shape is
 * decided at planning time, never stored on the brief itself. Without this
 * link, nothing can ever flip a brief item to `resolved / implemented`, and
 * "what shipped for this idea" has no answer six months later when the same
 * brief reopens. `to-issues` already publishes an epic-parent issue first
 * and points its slices at it as GitHub `Parent` — this function only
 * records that same shape via `role`, it does not decide it.
 */
export async function linkBriefWork(input: LinkBriefWorkInput): Promise<BriefWorkLink> {
  const [row] = await db
    .insert(briefWorkLinks)
    .values({
      briefId: input.briefId,
      briefItemId: input.briefItemId ?? null,
      repo: input.repo,
      issueNumber: input.issueNumber,
      role: input.role,
    })
    .returning();
  return row!;
}

export interface UpdateBriefItemAsHumanInput {
  area?: BriefArea;
  statement?: string;
  evidence?: string;
  kind?: BriefItemKind;
  state?: BriefItemState;
  resolution?: BriefItemResolution | null;
}

export interface UpdateBriefItemAsHumanResult {
  /** The updated row, or `null` if the item doesn't exist under this brief, or the write was refused. */
  item: BriefItem | null;
  /** True when this call was refused because the EFFECTIVE post-patch value (merging this call's fields with whatever the row already has) would land as `kind: 'unknown'` while `state: 'resolved'` — see `patchBriefItems`' doc-comment for why that combination is never legal, for anyone. */
  refusedUnknownResolved: boolean;
}

/**
 * The console's human-edit write path — the counterpart `patchBriefItems`
 * does not provide (design spec, "Human edits win, enforced at the route":
 * an `authority: 'human'` item is locked against `patchBriefItems`, which is
 * correct for Jace's write path, but it also means, read literally, there is
 * no way for a HUMAN to edit that same item a second time — the first
 * console edit sets `authority: 'human'`, and `patchBriefItems` skips every
 * write to it forever after, including the human's own next correction).
 * This function is that missing second write path: it is the ONLY function
 * in this file entitled to assert `authority: 'human'`, and unlike
 * `patchBriefItems` it is allowed to overwrite a row that is ALREADY
 * `authority: 'human'` — overwriting a human item is the entire point of a
 * human re-editing their own prior correction, not a bug to guard against.
 *
 * Two things are copied verbatim from `patchBriefItems`' update branch, on
 * purpose, not reinvented:
 *
 * - **Partial-patch semantics.** `fields` only touches the columns the
 *   caller actually supplies (checked via `"x" in fields`, not `!==
 *   undefined`, so an explicit `resolution: null` is still honored as
 *   "supplied"); anything omitted is left exactly as stored. Getting this
 *   wrong here would be the identical bug `patchBriefItems`' own regression
 *   test guards against: a human fixing a typo in `statement` alone must not
 *   silently reset `state`/`resolution`/`evidence` to defaults.
 * - **The unknown-may-never-resolve invariant.** A human is not exempt from
 *   it — an `unknown` item is not a requirement yet, so there is nothing for
 *   ANYONE to resolve, human included; the only legitimate way to clear an
 *   `unknown` is to re-kind it first. This is checked against the EFFECTIVE
 *   post-patch value (`fields.kind ?? existing.kind` combined with
 *   `fields.state ?? existing.state`), exactly like `patchBriefItems`, so a
 *   patch that only changes `kind` to `'unknown'` on a row already
 *   `state: 'resolved'` is caught too, not just a patch that names both
 *   fields at once.
 *
 * Returns `{ item: null, refusedUnknownResolved: false }` when `itemId`
 * doesn't resolve to a row under `briefId` (wrong id, or an id from a
 * different brief — the caller, the console route, is expected to have
 * already resolved `briefId` from a workspace-scoped slug lookup, but this
 * function re-checks the (`id`, `briefId`) pair itself rather than trusting
 * the caller, the same defensive posture `patchBriefItems` takes with its
 * own `and(eq(id), eq(briefId))` predicate).
 */
export async function updateBriefItemAsHuman(
  briefId: string,
  itemId: string,
  fields: UpdateBriefItemAsHumanInput
): Promise<UpdateBriefItemAsHumanResult> {
  const [existing] = await db
    .select({ kind: briefItems.kind, state: briefItems.state })
    .from(briefItems)
    .where(and(eq(briefItems.id, itemId), eq(briefItems.briefId, briefId)))
    .limit(1);

  if (!existing) return { item: null, refusedUnknownResolved: false };

  // Effective post-patch value — see doc-comment above for why this must be
  // the MERGED value, not just whatever this particular call happens to name.
  const effectiveKind: BriefItemKind = "kind" in fields ? fields.kind! : existing.kind;
  const effectiveState: BriefItemState = "state" in fields ? fields.state! : existing.state;
  if (effectiveKind === "unknown" && effectiveState === "resolved") {
    return { item: null, refusedUnknownResolved: true };
  }

  const set: Record<string, unknown> = { authority: "human", updatedAt: new Date() };
  if ("area" in fields) set.area = fields.area;
  if ("statement" in fields) set.statement = fields.statement;
  if ("evidence" in fields) set.evidence = fields.evidence;
  if ("kind" in fields) set.kind = fields.kind;
  if ("state" in fields) set.state = fields.state;
  if ("resolution" in fields) set.resolution = fields.resolution;

  const [row] = await db
    .update(briefItems)
    .set(set)
    .where(and(eq(briefItems.id, itemId), eq(briefItems.briefId, briefId)))
    .returning();

  return { item: row ?? null, refusedUnknownResolved: false };
}

export interface CreateBriefItemAsHumanInput {
  area: BriefArea;
  statement: string;
  evidence?: string;
  kind: BriefItemKind;
  state?: BriefItemState;
  resolution?: BriefItemResolution | null;
}

export interface CreateBriefItemAsHumanResult {
  item: BriefItem | null;
  /** See `updateBriefItemAsHuman`'s twin field — a brand-new item can land
   * as `kind: 'unknown'` + `state: 'resolved'` just as easily as an edited
   * one, and the invariant is total: there is nothing to resolve on an item
   * nobody has answered yet, whether it's new or old. */
  refusedUnknownResolved: boolean;
}

/**
 * Create a brand-new, human-authored item directly from the console — e.g.
 * a human adds a constraint Jace never asked about, rather than correcting
 * one Jace already wrote. Kept as its own function (not a third mode bolted
 * onto `updateBriefItemAsHuman`) because "insert" and "update-in-place" have
 * no shared row to merge against — an insert has no `existing` to check
 * partial-patch semantics against, only the unknown-may-never-resolve gate,
 * which is why this function's version of that check is a plain `input.kind
 * === "unknown" && (input.state ?? "open") === "resolved"` rather than the
 * merge `updateBriefItemAsHuman` needs.
 */
export async function createBriefItemAsHuman(
  briefId: string,
  input: CreateBriefItemAsHumanInput
): Promise<CreateBriefItemAsHumanResult> {
  const state: BriefItemState = input.state ?? "open";
  if (input.kind === "unknown" && state === "resolved") {
    return { item: null, refusedUnknownResolved: true };
  }

  const [row] = await db
    .insert(briefItems)
    .values({
      briefId,
      area: input.area,
      statement: input.statement,
      evidence: input.evidence ?? "",
      kind: input.kind,
      state,
      resolution: input.resolution ?? null,
      authority: "human",
    })
    .returning();

  return { item: row ?? null, refusedUnknownResolved: false };
}

/**
 * Delete a brief item outright — the one bypass the design spec names
 * explicitly for the readiness gate ("Deleting the item is the only bypass,
 * and it is visible", design spec "Readiness gate") and, more generally, how
 * a human removes an item Jace was simply wrong to add in the first place
 * (as opposed to `kind: 'out-of-scope'`, which keeps the item as a visible
 * decision). Deliberately NOT restricted to `authority: 'jace'` rows: a
 * human is entitled to delete their own prior human-authored item too (e.g.
 * they added a duplicate), and restricting deletion by authority would just
 * invite the same "human correction gets silently blocked" complaint this
 * whole file exists to avoid — deletion is not a content overwrite, there is
 * no stale content left behind to protect. Scoped to `(id, briefId)`, same
 * defensive pair as every other item write in this file, so a caller can
 * never delete an item belonging to a different brief.
 */
export async function deleteBriefItem(briefId: string, itemId: string): Promise<boolean> {
  const rows = await db
    .delete(briefItems)
    .where(and(eq(briefItems.id, itemId), eq(briefItems.briefId, briefId)))
    .returning({ id: briefItems.id });
  return rows.length > 0;
}

export interface BriefReadiness {
  ready: boolean;
  /** The `open` + `unknown` items causing `ready: false` — so a caller (`to-issues`) can explain the refusal by naming the actual gaps, not just say "not ready". */
  blockingItems: BriefItem[];
}

/**
 * Implementation-readiness (design spec, "Readiness gate"): TRUE exactly
 * when no `open` item has `kind: 'unknown'`. An `unknown` that reaches an
 * issue becomes an acceptance criterion the builder invents — that is where
 * hallucination enters the factory, so this is the one check `to-issues`
 * must never skip. Deliberately scoped to `state = 'open'` only: a
 * long-lived brief's `resolved` items (including `deferred` ones seeding a
 * later phase) must never re-block a phase that already passed this gate
 * once — see `briefItemResolutionEnum`'s doc-comment in the schema for the
 * full `state`/`resolution` split this depends on.
 */
export async function computeBriefReadiness(briefId: string): Promise<BriefReadiness> {
  const blockingItems = await db
    .select()
    .from(briefItems)
    .where(
      and(eq(briefItems.briefId, briefId), eq(briefItems.state, "open"), eq(briefItems.kind, "unknown"))
    );
  return { ready: blockingItems.length === 0, blockingItems };
}
