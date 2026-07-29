import { and, desc, eq, inArray, sql } from "drizzle-orm";
import { db } from "../db.js";
import {
  investigations,
  investigationItems,
  investigationLinks,
  investigationIssueLinks,
} from "../schema/investigations.js";
import type {
  Investigation,
  InvestigationItem,
  InvestigationSeverity,
  InvestigationOpenedBy,
  InvestigationVerdict,
  VerdictConfidence,
  InvestigationItemKind,
  HypothesisState,
  InvestigationLinkRole,
  InvestigationIssueRole,
} from "../schema/investigations.js";

/**
 * Investigations queries (debugging design spec:
 * docs/superpowers/specs/2026-07-29-jace-debugging-agent-design.md, spec PR
 * #1501 — see `.superpowers/sdd/spec.md` for the working copy this
 * implementation follows). `investigations`/`investigation_items` follow the
 * shape `briefs.ts` established for a server-durable system of record — this
 * file is that same shape's 1:1 sibling for a production incident instead of
 * a product idea: upsert-by-identity writes (`(workspace_id, slug)`), an FTS
 * search falling back to recency, and a per-item DELTA upsert
 * (`patchInvestigationItems`) that enforces route-level invariants at the
 * store layer rather than as a caller convention — see that function's own
 * doc-comment for the three guards it enforces and why.
 *
 * Three route-enforced invariants run through this whole file (Global
 * Constraints; also documented on `schema/investigations.ts`'s
 * `investigationItems` table):
 *   1. `authority: 'human'` items are never overwritten by
 *      `patchInvestigationItems` (the model-facing save path).
 *   2. `kind: 'evidence'` items are immutable — `appendEvidenceItem` is the
 *      ONLY function in this file allowed to INSERT one; nothing may edit or
 *      delete one except the unrestricted `deleteInvestigationItem` (the
 *      same visible-bypass doctrine `briefs.ts` uses for its own items) —
 *      see `updateInvestigationItemAsHuman`'s doc-comment for why the human
 *      console-edit path is ALSO refused here, not just the model path.
 *   3. A hypothesis may not enter `state: 'supported'` or `'refuted'`
 *      without ≥ 1 entry in `evidence_refs` — checked against the EFFECTIVE
 *      (merged) post-patch value everywhere it applies, exactly like
 *      `patchBriefItems`' unknown-may-never-resolve guard is.
 *
 * Unlike `briefs.ts`, none of these functions take a `db`/`tx` handle as a
 * parameter — they import the module-level `db` directly, exactly like every
 * other file in `queries/` (including `briefs.ts` and `jace_sessions.ts`).
 * Functions needing atomicity (`patchInvestigationItems`, `recordVerdict`)
 * open their own `db.transaction(...)` internally, matching
 * `patchBriefItems`'s shape.
 */

export interface InvestigationWithItems {
  investigation: Investigation;
  items: InvestigationItem[];
}

/** Alias for the brief's own return-type name — same shape as `Investigation`. */
export type InvestigationRow = Investigation;

/** The compact index shape: an investigation row with no items attached (`listInvestigations`/`searchInvestigations`). */
export type InvestigationIndexRow = Investigation;

/** Batch-load every item for an investigation, oldest-first (mirrors `fetchItemsForBriefIds`'s ordering reasoning: a resumed conversation reads items in the order they were settled). */
async function fetchItemsForInvestigation(investigationId: string): Promise<InvestigationItem[]> {
  return db
    .select()
    .from(investigationItems)
    .where(eq(investigationItems.investigationId, investigationId))
    .orderBy(investigationItems.createdAt);
}

/** Map a raw (snake_case) `db.execute` row back to the typed `Investigation` shape — raw `db.execute` bypasses drizzle's column-type mapper, so timestamptz columns come back as strings (mirrors `mapBriefExecRow`). */
function mapInvestigationExecRow(r: Record<string, unknown>): Investigation {
  return {
    id: String(r.id),
    workspaceId: String(r.workspace_id),
    repositoryId: (r.repository_id as string | null) ?? null,
    slug: String(r.slug),
    title: String(r.title),
    status: r.status as Investigation["status"],
    severity: r.severity as InvestigationSeverity,
    openedBy: r.opened_by as InvestigationOpenedBy,
    symptomStatement: String(r.symptom_statement),
    symptomSignature: String(r.symptom_signature),
    affectedSurface: String(r.affected_surface),
    firstSeenAt: r.first_seen_at ? new Date(r.first_seen_at as string | number | Date) : null,
    verdict: (r.verdict as InvestigationVerdict | null) ?? null,
    confidence: (r.confidence as VerdictConfidence | null) ?? null,
    depthBudget: Number(r.depth_budget),
    jaceSessionIds: (r.jace_session_ids as string[] | null) ?? [],
    createdAt: new Date(r.created_at as string | number | Date),
    updatedAt: new Date(r.updated_at as string | number | Date),
  };
}

export interface UpsertInvestigationInput {
  workspaceId: string;
  slug: string;
  title?: string;
  symptomStatement?: string;
  symptomSignature?: string;
  affectedSurface?: string;
  severity?: InvestigationSeverity;
  openedBy?: InvestigationOpenedBy;
  firstSeenAt?: Date | null;
  repositoryId?: string | null;
  /**
   * Append this Jace session id to `jace_session_ids` — NOT a replace, unlike
   * `briefs.jaceSessionIds` — every conversation that has ever touched this
   * investigation accumulates (schema doc-comment: "many sessions, one
   * investigation"). Handled as an append-with-dedup SQL expression on the
   * UPDATE branch (see `upsertInvestigation`'s doc-comment) since it must
   * merge against whatever the row already has, not overwrite it.
   */
  appendSessionId?: string;
}

/**
 * Upsert-by-`(workspace_id, slug)` — the identity an investigation keeps for
 * its entire life, reused across a reopen rather than re-invented (schema
 * doc-comment: re-inventing the slug is exactly what would fork a second row
 * for the same incident). PARTIAL patch on update, mirroring `upsertBrief`
 * exactly: any field omitted from `input` is left untouched on an existing
 * row, only applied as a default on first insert. `status`/`verdict`/
 * `confidence` are deliberately NOT settable here at all — the Global
 * Constraints require the save route to reject a `verdict`/`status` key with
 * 400; those three columns are written only by `recordVerdict`.
 *
 * `title`/`symptomStatement` are NOT NULL with no schema default, yet both
 * are optional on this input (a symptom can be anchored before a title is
 * known) — first insert falls back to `slug` for `title` and `""` for
 * `symptomStatement`/`symptomSignature`/`affectedSurface`, matching how
 * `upsertBrief` defaults its own NOT-NULL text columns.
 *
 * `appendSessionId`'s UPDATE-branch value is a raw SQL `CASE` expression
 * (`jace_session_ids @> id ? existing : existing || [id]`) rather than a
 * plain JS array, because — unlike every other field here — it must MERGE
 * against the row's current value, not replace it; a plain `.values()`
 * array only applies on the INSERT branch, where there is no existing value
 * to merge against.
 */
export async function upsertInvestigation(input: UpsertInvestigationInput): Promise<InvestigationRow> {
  const patch: Record<string, unknown> = { updatedAt: new Date() };
  if (input.title !== undefined) patch.title = input.title;
  if (input.symptomStatement !== undefined) patch.symptomStatement = input.symptomStatement;
  if (input.symptomSignature !== undefined) patch.symptomSignature = input.symptomSignature;
  if (input.affectedSurface !== undefined) patch.affectedSurface = input.affectedSurface;
  if (input.severity !== undefined) patch.severity = input.severity;
  if (input.openedBy !== undefined) patch.openedBy = input.openedBy;
  if (input.firstSeenAt !== undefined) patch.firstSeenAt = input.firstSeenAt;
  if (input.repositoryId !== undefined) patch.repositoryId = input.repositoryId;
  if (input.appendSessionId !== undefined) {
    const idJson = JSON.stringify([input.appendSessionId]);
    patch.jaceSessionIds = sql`CASE WHEN ${investigations.jaceSessionIds} @> ${idJson}::jsonb
      THEN ${investigations.jaceSessionIds}
      ELSE ${investigations.jaceSessionIds} || ${idJson}::jsonb END`;
  }

  const [row] = await db
    .insert(investigations)
    .values({
      workspaceId: input.workspaceId,
      repositoryId: input.repositoryId ?? null,
      slug: input.slug,
      title: input.title ?? input.slug,
      symptomStatement: input.symptomStatement ?? "",
      symptomSignature: input.symptomSignature ?? "",
      affectedSurface: input.affectedSurface ?? "",
      severity: input.severity ?? "medium",
      openedBy: input.openedBy ?? "chat",
      firstSeenAt: input.firstSeenAt ?? null,
      jaceSessionIds: input.appendSessionId ? [input.appendSessionId] : [],
    })
    .onConflictDoUpdate({
      target: [investigations.workspaceId, investigations.slug],
      set: patch,
    })
    .returning();
  return row!;
}

/** Investigation + all its items in one call, keyed by `(workspaceId, slug)` — the shape `fetch_investigations(mode: "get")` needs. Null when no investigation matches. */
export async function getInvestigationBySlug(
  workspaceId: string,
  slug: string
): Promise<InvestigationWithItems | null> {
  const [investigation] = await db
    .select()
    .from(investigations)
    .where(and(eq(investigations.workspaceId, workspaceId), eq(investigations.slug, slug)))
    .limit(1);
  if (!investigation) return null;
  const items = await fetchItemsForInvestigation(investigation.id);
  return { investigation, items };
}

/**
 * Same shape as {@link getInvestigationBySlug}, keyed by `id` alone with NO
 * workspace scope — the lookup the session-anchor read needs
 * (`getSessionInvestigationAnchor` only has an id on hand). `id` is a
 * server-minted uuid, never caller-guessable, so this mirrors
 * `getJaceSessionById`/`getApprovalById`'s own no-workspace-scope rationale
 * (`queries/jace_sessions.ts`: "the id IS the security boundary"). Null when
 * no investigation matches this id.
 */
export async function getInvestigationById(id: string): Promise<InvestigationWithItems | null> {
  const [investigation] = await db.select().from(investigations).where(eq(investigations.id, id)).limit(1);
  if (!investigation) return null;
  const items = await fetchItemsForInvestigation(investigation.id);
  return { investigation, items };
}

/** The compact index — every investigation for a workspace, WITHOUT items, most-recently-touched first. Backs `fetch_investigations(mode: "list")`. An explicit `limit` caps the result; omitted returns every row (mirrors `listBriefs`). */
export async function listInvestigations(
  workspaceId: string,
  limit?: number
): Promise<InvestigationIndexRow[]> {
  const query = db
    .select()
    .from(investigations)
    .where(eq(investigations.workspaceId, workspaceId))
    .orderBy(desc(investigations.updatedAt));
  if (limit !== undefined) {
    return query.limit(limit);
  }
  return query;
}

export const INVESTIGATION_SEARCH_DEFAULT_LIMIT = 5;
export const INVESTIGATION_SEARCH_MAX_LIMIT = 10;

/**
 * FTS over investigation title + symptom signature + item bodies, mirroring
 * `searchBriefs`'s `websearch_to_tsquery`/`ts_rank_cd` shape exactly. Unlike
 * `searchBriefs` (which returns each match WITH its full item set), this
 * returns bare index rows — `InvestigationIndexRow[]`, no items — per the
 * brief's own signature; a caller wanting item detail follows up with
 * `getInvestigationById`.
 *
 * An empty/whitespace query skips the FTS round trip, and a zero-hit FTS
 * query both fall back to the most recently updated investigations — search
 * is a navigation aid (recurrence-candidate shortlisting), never a dead end.
 */
export async function searchInvestigations(
  workspaceId: string,
  query: string,
  limit: number = INVESTIGATION_SEARCH_DEFAULT_LIMIT
): Promise<InvestigationIndexRow[]> {
  const trimmedQuery = query.trim();
  const cappedLimit = Math.min(INVESTIGATION_SEARCH_MAX_LIMIT, Math.max(1, Math.trunc(limit) || 1));

  let rows: Record<string, unknown>[] = [];

  if (trimmedQuery.length > 0) {
    const result = await db.execute(sql`
      SELECT i.id, i.workspace_id, i.repository_id, i.slug, i.title, i.status, i.severity,
             i.opened_by, i.symptom_statement, i.symptom_signature, i.affected_surface,
             i.first_seen_at, i.verdict, i.confidence, i.depth_budget, i.jace_session_ids,
             i.created_at, i.updated_at
      FROM investigations i
      LEFT JOIN (
        SELECT investigation_id, string_agg(body, ' ') AS bodies
        FROM investigation_items
        GROUP BY investigation_id
      ) items_agg ON items_agg.investigation_id = i.id
      WHERE i.workspace_id = ${workspaceId}
        AND to_tsvector('english', i.title || ' ' || i.symptom_signature || ' ' || coalesce(items_agg.bodies, ''))
              @@ websearch_to_tsquery('english', ${trimmedQuery})
      ORDER BY ts_rank_cd(
        to_tsvector('english', i.title || ' ' || i.symptom_signature || ' ' || coalesce(items_agg.bodies, '')),
        websearch_to_tsquery('english', ${trimmedQuery})
      ) DESC
      LIMIT ${cappedLimit}
    `);
    rows = Array.from(result) as Record<string, unknown>[];
  }

  if (rows.length === 0) {
    const recent = await db.execute(sql`
      SELECT id, workspace_id, repository_id, slug, title, status, severity, opened_by,
             symptom_statement, symptom_signature, affected_surface, first_seen_at,
             verdict, confidence, depth_budget, jace_session_ids, created_at, updated_at
      FROM investigations
      WHERE workspace_id = ${workspaceId}
      ORDER BY updated_at DESC
      LIMIT ${cappedLimit}
    `);
    rows = Array.from(recent) as Record<string, unknown>[];
  }

  return rows.map(mapInvestigationExecRow);
}

export interface PatchInvestigationItemInput {
  /** Omitted to insert a new item; supplied to update an existing one. */
  id?: string;
  kind?: InvestigationItemKind;
  body?: string;
  mechanism?: string;
  state?: HypothesisState | null;
  evidenceRefs?: string[];
  data?: Record<string, unknown>;
}

export interface PatchInvestigationItemsResult {
  /** Ids of items actually inserted or updated, in call order. */
  applied: string[];
  /** Ids of existing items whose write was dropped because their `authority` is `'human'`. */
  skippedHumanAuthorityIds: string[];
  /** Ids (or, for a brand-new item with no id yet, its `body`/`"new"`) refused because the touched row is — or would become — `kind: 'evidence'`. `appendEvidenceItem` is the only function allowed to write this kind. */
  skippedEvidenceImmutableIds: string[];
  /** Ids (or body/"new" for a brand-new item) refused because a hypothesis would enter `supported`/`refuted` with an empty EFFECTIVE `evidence_refs`. */
  skippedHypothesisNeedsEvidence: string[];
}

/**
 * DELTA upsert of individual investigation items — never a full-investigation
 * replace, exactly mirroring `patchBriefItems`'s reasoning and transaction
 * shape (one `db.transaction`, one pre-check `SELECT ... WHERE id IN (...)`
 * for every id this batch names, then a per-item guard-and-write loop).
 * `save_investigation` (the model-facing route, Task 3) calls this every
 * turn with only the items that changed; every other item is left exactly as
 * it was, and — for a touched row — every field the caller's patch omits
 * (checked via `"x" in item`, not `!== undefined`) survives untouched too.
 *
 * Three guards are enforced HERE, at the store, not as a caller convention —
 * impossible to bypass short of a raw SQL write (mirrors `patchBriefItems`'s
 * own framing):
 *
 * 1. **Human authority.** An existing item (matched by `id`) whose
 *    `authority` is `'human'` is silently skipped — untouched, id reported in
 *    `skippedHumanAuthorityIds`.
 * 2. **Evidence immutability.** A row whose EXISTING kind is `'evidence'`, or
 *    a brand-new item whose `kind` is `'evidence'`, is refused outright —
 *    `appendEvidenceItem` is the ONLY writer of that kind, for creation AND
 *    mutation.
 * 3. **Hypothesis evidence-gating.** Checked against the EFFECTIVE
 *    (post-patch) `state`/`evidence_refs` — merging this call's fields with
 *    whatever the row already has, exactly like `patchBriefItems`'s
 *    unknown-may-never-resolve check — so a patch that only sends
 *    `state: 'supported'` on a row whose STORED `evidence_refs` is empty is
 *    caught too, not just a patch that names both fields at once.
 */
export async function patchInvestigationItems(
  investigationId: string,
  items: PatchInvestigationItemInput[]
): Promise<PatchInvestigationItemsResult> {
  if (items.length === 0) {
    return {
      applied: [],
      skippedHumanAuthorityIds: [],
      skippedEvidenceImmutableIds: [],
      skippedHypothesisNeedsEvidence: [],
    };
  }

  return db.transaction(async (tx) => {
    const idsToCheck = items
      .filter((i): i is PatchInvestigationItemInput & { id: string } => !!i.id)
      .map((i) => i.id);

    const existingRows =
      idsToCheck.length > 0
        ? await tx
            .select({
              id: investigationItems.id,
              authority: investigationItems.authority,
              kind: investigationItems.kind,
              state: investigationItems.state,
              evidenceRefs: investigationItems.evidenceRefs,
            })
            .from(investigationItems)
            .where(
              and(eq(investigationItems.investigationId, investigationId), inArray(investigationItems.id, idsToCheck))
            )
        : [];
    const byId = new Map(existingRows.map((row) => [row.id, row]));

    const applied: string[] = [];
    const skippedHumanAuthorityIds: string[] = [];
    const skippedEvidenceImmutableIds: string[] = [];
    const skippedHypothesisNeedsEvidence: string[] = [];

    for (const item of items) {
      const existing = item.id ? byId.get(item.id) : undefined;

      if (item.id && existing?.authority === "human") {
        skippedHumanAuthorityIds.push(item.id);
        continue;
      }

      if (existing?.kind === "evidence" || (!existing && item.kind === "evidence")) {
        skippedEvidenceImmutableIds.push(item.id ?? item.body ?? "new");
        continue;
      }

      const effectiveState: HypothesisState | null = "state" in item ? item.state ?? null : existing?.state ?? null;
      const effectiveRefs: string[] =
        "evidenceRefs" in item ? item.evidenceRefs ?? [] : (existing?.evidenceRefs as string[] | undefined) ?? [];
      const isHypothesis = (existing?.kind ?? item.kind) === "hypothesis";
      if (
        isHypothesis &&
        (effectiveState === "supported" || effectiveState === "refuted") &&
        (!Array.isArray(effectiveRefs) || effectiveRefs.length === 0)
      ) {
        skippedHypothesisNeedsEvidence.push(item.id ?? item.body ?? "new");
        continue;
      }

      if (item.id) {
        const set: Record<string, unknown> = { updatedAt: new Date() };
        if ("kind" in item) set.kind = item.kind;
        if ("body" in item) set.body = item.body;
        if ("mechanism" in item) set.mechanism = item.mechanism;
        if ("state" in item) set.state = item.state;
        if ("evidenceRefs" in item) set.evidenceRefs = item.evidenceRefs;
        if ("data" in item) set.data = item.data;

        const [row] = await tx
          .update(investigationItems)
          .set(set)
          .where(and(eq(investigationItems.id, item.id), eq(investigationItems.investigationId, investigationId)))
          .returning();
        if (row) applied.push(row.id);
      } else {
        const [row] = await tx
          .insert(investigationItems)
          .values({
            investigationId,
            kind: item.kind!,
            body: item.body ?? "",
            mechanism: item.mechanism ?? "",
            state: item.state ?? null,
            evidenceRefs: item.evidenceRefs ?? [],
            data: item.data ?? {},
          })
          .returning();
        if (row) applied.push(row.id);
      }
    }

    return { applied, skippedHumanAuthorityIds, skippedEvidenceImmutableIds, skippedHypothesisNeedsEvidence };
  });
}

export interface AppendEvidenceItemInput {
  body: string;
  data: Record<string, unknown>;
}

/**
 * Insert a `kind: 'evidence'` item — the ONLY function in this file allowed
 * to. Called exclusively by the evidence route (Task 4), never by
 * `save_investigation`/`patchInvestigationItems` (which both refuse this
 * kind outright, on create AND mutate — see that function's doc-comment).
 * `authority` stays the schema default (`'jace'`): evidence is captured by
 * Jace's own capability layer, never human-authored.
 */
export async function appendEvidenceItem(
  investigationId: string,
  input: AppendEvidenceItemInput
): Promise<{ id: string }> {
  const [row] = await db
    .insert(investigationItems)
    .values({
      investigationId,
      kind: "evidence",
      body: input.body,
      data: input.data,
    })
    .returning({ id: investigationItems.id });
  return { id: row!.id };
}

/** Pure eligibility computation over an already-fetched item set — shared by the standalone `computeVerdictEligibility` read and `recordVerdict`'s own in-transaction check, so both read the exact same rule from one place. */
function computeEligibilityFromItems(items: InvestigationItem[]): { eligible: boolean; blocking: string[] } {
  const hyps = items.filter((i) => i.kind === "hypothesis");
  const supported = hyps.filter(
    (h) => h.state === "supported" && h.mechanism.trim() !== "" && h.evidenceRefs.length > 0
  );
  const refuted = hyps.filter((h) => h.state === "refuted" && h.evidenceRefs.length > 0);
  const solePlausible = items.some(
    (i) => i.kind === "finding" && (i.data as Record<string, unknown>).solePlausible === true
  );
  const blocking: string[] = [];
  if (supported.length === 0) blocking.push("no supported hypothesis with mechanism and evidence");
  if (refuted.length === 0 && !solePlausible) blocking.push("no refuted rival hypothesis and no solePlausible finding");
  return { eligible: blocking.length === 0, blocking };
}

/**
 * Whether an investigation currently qualifies for a `root_caused` verdict —
 * the server-computed, fail-closed gate `recordVerdict` (and, read-only, the
 * console/`fetch_investigations(mode:"get"/"anchor")`) both rely on. TRUE
 * exactly when: (a) at least one hypothesis is `state: 'supported'` with a
 * non-empty `mechanism` and ≥ 1 `evidence_refs` entry, AND (b) either a
 * refuted rival hypothesis (its own `evidence_refs`) exists, or a `finding`
 * carries `data.solePlausible: true`. Blocking strings are pinned exactly —
 * downstream callers (the console UI, Task 13) render them verbatim.
 */
export async function computeVerdictEligibility(
  investigationId: string
): Promise<{ eligible: boolean; blocking: string[] }> {
  const items = await db
    .select()
    .from(investigationItems)
    .where(eq(investigationItems.investigationId, investigationId));
  return computeEligibilityFromItems(items);
}

export interface RecordVerdictInput {
  verdict: InvestigationVerdict;
  confidence?: VerdictConfidence;
  mechanismSummary?: string;
  missingEvidence?: string[];
}

export type RecordVerdictResult = { ok: true } | { ok: false; blocking: string[] };

/**
 * Record a verdict — APPEND-ONLY (schema doc-comment: "recording a new
 * verdict never edits a prior one, so reopening an investigation never
 * erases history"). Calling this twice always inserts two separate
 * `kind: 'verdict'` items; there is no update path.
 *
 * Fails closed, per the Global Constraints ("Verdicts travel only through
 * .../verdict, which runs computeVerdictEligibility server-side and fails
 * closed"):
 *  - `root_caused` requires BOTH `computeVerdictEligibility` to report
 *    eligible AND a `confidence` value — an eligible-but-confidence-less
 *    call is refused just as hard as an ineligible one.
 *  - `undetermined` requires a non-empty `missingEvidence` — recording "we
 *    don't know" without saying what's missing defeats the point of the
 *    verdict (it must be resumable later, once that evidence exists).
 *
 * The eligibility check and the write both run inside ONE transaction: the
 * check reads a consistent snapshot immediately before the write lands,
 * closing the race window a separate `computeVerdictEligibility(...)` call
 * followed by a second write call would leave open. On success, inserts the
 * verdict item (`body` = `mechanismSummary ?? ""`, `data` = `{ confidence,
 * missingEvidence }`) and denormalizes `investigations.verdict`/`confidence`/
 * `status = 'concluded'` in the same transaction.
 */
export async function recordVerdict(
  investigationId: string,
  input: RecordVerdictInput
): Promise<RecordVerdictResult> {
  return db.transaction(async (tx) => {
    if (input.verdict === "root_caused") {
      const items = await tx
        .select()
        .from(investigationItems)
        .where(eq(investigationItems.investigationId, investigationId));
      const { eligible, blocking } = computeEligibilityFromItems(items);
      if (!eligible) {
        return { ok: false as const, blocking };
      }
      if (!input.confidence) {
        return { ok: false as const, blocking: ["confidence required for root_caused verdict"] };
      }
    } else {
      if (!input.missingEvidence || input.missingEvidence.length === 0) {
        return { ok: false as const, blocking: ["missingEvidence required for undetermined verdict"] };
      }
    }

    await tx
      .insert(investigationItems)
      .values({
        investigationId,
        kind: "verdict",
        body: input.mechanismSummary ?? "",
        data: { confidence: input.confidence ?? null, missingEvidence: input.missingEvidence ?? [] },
      })
      .returning();

    await tx
      .update(investigations)
      .set({
        verdict: input.verdict,
        confidence: input.confidence ?? null,
        status: "concluded",
        updatedAt: new Date(),
      })
      .where(eq(investigations.id, investigationId))
      .returning();

    return { ok: true as const };
  });
}

/** Record an investigation-to-investigation edge (`recurrence_of`/`related`) — see `investigation_links`' schema doc-comment for the reopen-vs-new mechanism this backs. */
export async function linkInvestigations(
  investigationId: string,
  targetInvestigationId: string,
  role: InvestigationLinkRole
): Promise<void> {
  await db.insert(investigationLinks).values({ investigationId, targetInvestigationId, role });
}

/** Record the RESULT of an investigation's handoff — an issue it produced, with its `mitigative`/`preventative` role. Mirrors `linkBriefWork`'s reasoning. */
export async function linkInvestigationIssue(
  investigationId: string,
  repo: string,
  issueNumber: number,
  role: InvestigationIssueRole
): Promise<void> {
  await db.insert(investigationIssueLinks).values({ investigationId, repo, issueNumber, role });
}

export interface UpdateInvestigationItemAsHumanInput {
  kind?: InvestigationItemKind;
  body?: string;
  mechanism?: string;
  state?: HypothesisState | null;
  evidenceRefs?: string[];
  data?: Record<string, unknown>;
}

export interface UpdateInvestigationItemAsHumanResult {
  /** The updated row, or `null` if the item doesn't exist or the write was refused. */
  item: InvestigationItem | null;
  /** True when refused because the touched row's kind is — or would become — `'evidence'`. Evidence stays immutable regardless of who's writing; see this function's doc-comment. */
  refusedEvidenceImmutable: boolean;
  /** True when refused because a hypothesis would enter `supported`/`refuted` with an empty EFFECTIVE `evidence_refs` — the evidence-linkage invariant binds humans too (structure, not authority). */
  refusedHypothesisNeedsEvidence: boolean;
}

/**
 * The console's human-edit write path for an existing item — the counterpart
 * `patchInvestigationItems` does not provide, mirroring `updateBriefItemAsHuman`
 * exactly: it is the ONLY function in this file entitled to assert
 * `authority: 'human'` on an UPDATE, and unlike `patchInvestigationItems` it
 * MAY overwrite a row that is already `authority: 'human'` — overwriting a
 * human item is the entire point of a human re-editing their own prior
 * correction, not a bug to guard against.
 *
 * Two guards still apply, because they are structural, not authority-scoped:
 *
 * - **Evidence immutability.** A row whose EXISTING kind is `'evidence'`, or
 *   whose EFFECTIVE (post-patch) kind would become `'evidence'`, is refused.
 *   `appendEvidenceItem` is the only inserter of this kind system-wide; if a
 *   human console edit could still mutate one afterward, evidence would stop
 *   being a trustworthy, tamper-evident capture — the only escape hatch for a
 *   bad evidence row is outright deletion (`deleteInvestigationItem`, the
 *   same visible-bypass doctrine `briefs.ts` uses), never an edit.
 * - **Hypothesis evidence-gating.** Checked against the EFFECTIVE
 *   `state`/`evidence_refs`, exactly like `patchInvestigationItems`'s own
 *   version of this guard — a human is not exempt from it either: a
 *   hypothesis with no evidence is not "supported" no matter who says so.
 *
 * Partial-patch semantics: `patch` only touches the columns the caller
 * actually supplies (checked via `"x" in patch`, not `!== undefined`, so an
 * explicit `state: null` is still honored as "supplied"); anything omitted
 * is left exactly as stored — the same regression `patchBriefItems`'s own
 * test guards against.
 *
 * Returns `{ item: null, ... }` when `itemId` doesn't resolve to a row.
 */
export async function updateInvestigationItemAsHuman(
  itemId: string,
  patch: UpdateInvestigationItemAsHumanInput
): Promise<UpdateInvestigationItemAsHumanResult> {
  const [existing] = await db
    .select({
      kind: investigationItems.kind,
      state: investigationItems.state,
      evidenceRefs: investigationItems.evidenceRefs,
    })
    .from(investigationItems)
    .where(eq(investigationItems.id, itemId))
    .limit(1);

  if (!existing) {
    return { item: null, refusedEvidenceImmutable: false, refusedHypothesisNeedsEvidence: false };
  }

  const effectiveKind: InvestigationItemKind = "kind" in patch ? patch.kind! : existing.kind;
  if (existing.kind === "evidence" || effectiveKind === "evidence") {
    return { item: null, refusedEvidenceImmutable: true, refusedHypothesisNeedsEvidence: false };
  }

  const effectiveState: HypothesisState | null = "state" in patch ? patch.state ?? null : existing.state;
  const effectiveRefs: string[] =
    "evidenceRefs" in patch ? patch.evidenceRefs ?? [] : (existing.evidenceRefs as string[]);
  if (
    effectiveKind === "hypothesis" &&
    (effectiveState === "supported" || effectiveState === "refuted") &&
    (!Array.isArray(effectiveRefs) || effectiveRefs.length === 0)
  ) {
    return { item: null, refusedEvidenceImmutable: false, refusedHypothesisNeedsEvidence: true };
  }

  const set: Record<string, unknown> = { authority: "human", updatedAt: new Date() };
  if ("kind" in patch) set.kind = patch.kind;
  if ("body" in patch) set.body = patch.body;
  if ("mechanism" in patch) set.mechanism = patch.mechanism;
  if ("state" in patch) set.state = patch.state;
  if ("evidenceRefs" in patch) set.evidenceRefs = patch.evidenceRefs;
  if ("data" in patch) set.data = patch.data;

  const [row] = await db.update(investigationItems).set(set).where(eq(investigationItems.id, itemId)).returning();

  return { item: row ?? null, refusedEvidenceImmutable: false, refusedHypothesisNeedsEvidence: false };
}

export interface CreateInvestigationItemAsHumanInput {
  kind: InvestigationItemKind;
  body: string;
  mechanism?: string;
  state?: HypothesisState | null;
  evidenceRefs?: string[];
  data?: Record<string, unknown>;
}

export interface CreateInvestigationItemAsHumanResult {
  item: InvestigationItem | null;
  refusedEvidenceImmutable: boolean;
  refusedHypothesisNeedsEvidence: boolean;
}

/**
 * Create a brand-new, human-authored item directly from the console — e.g. a
 * human adds a timeline note or a hypothesis Jace never raised. Mirrors
 * `createBriefItemAsHuman`: kept as its own function (not a third mode on
 * `updateInvestigationItemAsHuman`) because an insert has no `existing` row
 * to merge partial-patch semantics against, only the two structural guards
 * (evidence immutability, hypothesis evidence-gating) — both checked against
 * `item` directly rather than an effective-merge, since there is nothing to
 * merge with yet.
 */
export async function createInvestigationItemAsHuman(
  investigationId: string,
  item: CreateInvestigationItemAsHumanInput
): Promise<CreateInvestigationItemAsHumanResult> {
  if (item.kind === "evidence") {
    return { item: null, refusedEvidenceImmutable: true, refusedHypothesisNeedsEvidence: false };
  }

  const state = item.state ?? null;
  const evidenceRefs = item.evidenceRefs ?? [];
  if (item.kind === "hypothesis" && (state === "supported" || state === "refuted") && evidenceRefs.length === 0) {
    return { item: null, refusedEvidenceImmutable: false, refusedHypothesisNeedsEvidence: true };
  }

  const [row] = await db
    .insert(investigationItems)
    .values({
      investigationId,
      kind: item.kind,
      body: item.body,
      mechanism: item.mechanism ?? "",
      state,
      evidenceRefs,
      data: item.data ?? {},
      authority: "human",
    })
    .returning();

  return { item: row ?? null, refusedEvidenceImmutable: false, refusedHypothesisNeedsEvidence: false };
}

/**
 * Delete an investigation item outright — unrestricted, same doctrine as
 * `deleteBriefItem`: the one visible bypass for a row that should never have
 * existed (including a bad `kind: 'evidence'` capture — see
 * `updateInvestigationItemAsHuman`'s doc-comment), deliberately NOT scoped by
 * authority or kind. A human is entitled to delete their own prior
 * human-authored item too; deletion is not a content overwrite, so there is
 * no stale content left behind to protect.
 */
export async function deleteInvestigationItem(itemId: string): Promise<void> {
  await db.delete(investigationItems).where(eq(investigationItems.id, itemId));
}
