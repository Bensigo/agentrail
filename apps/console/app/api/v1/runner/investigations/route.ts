/**
 * GET|POST /api/v1/runner/investigations
 *
 * Jace's read/write seam for investigations — the durable, server-side
 * record of ONE production incident (debugging design spec:
 * docs/superpowers/specs/2026-07-29-jace-debugging-agent-design.md, spec PR
 * #1501; `.superpowers/sdd/spec.md` is the working copy this implementation
 * follows). `investigations`/`investigation_items` mirror the shape
 * `apps/console/app/api/v1/runner/briefs/route.ts` established for a
 * server-durable system of record — this file is that same shape's sibling
 * for a production incident instead of a product idea. See
 * `packages/db-postgres/src/queries/investigations.ts`'s own doc-comment for
 * the store-layer invariants this route inherits (human-authority items are
 * never overwritten, `kind: 'evidence'` items are immutable, a hypothesis may
 * not enter `supported`/`refuted` without evidence) — those are enforced by
 * `patchInvestigationItems` itself; this route does not re-implement them.
 *
 * AUTH + TENANT: identical resolution chain to `runner/briefs` — copied
 * deliberately rather than re-derived (see that route's own doc-comment for
 * the full rationale). `requireJaceConsoleSecret` gates WHO may call this
 * route; WHICH workspace is resolved server-side from the caller-supplied
 * `eveSessionId` through `jace_sessions` (`getJaceSessionByEveSessionId`) —
 * never a caller-supplied `workspaceId`. A session with no anchor at all, or
 * an intro session with no `workspaceId` yet, both collapse into the same 404
 * (anti-enumeration posture shared with every other runner route).
 *
 * GET modes (`list`, `get`, `search`, `anchor`) mirror `runner/briefs`'
 * four-mode shape, but the response is FLATTER than briefs' `{ brief }`
 * wrapper: `getInvestigationBySlug`/`getInvestigationById` already return
 * `{ investigation, items }` as two sibling keys (Task 2's own shape), so
 * `get`/`anchor` spread those straight onto the response alongside a THIRD
 * top-level key, `eligibility` — computed HERE, server-side, via
 * `computeVerdictEligibility`, for the exact same reason `runner/briefs`
 * computes `readiness` server-side rather than leaving it for the caller to
 * derive by scanning items itself (see that route's "Readiness" doc-comment
 * paragraph — the reasoning is identical: a model judging its own evidence
 * sufficiency is exactly the failure mode the verdict gate exists to close).
 * `list`/`search` deliberately do NOT attach `eligibility` per investigation,
 * for the same N-fanout reason `briefs`' `list`/`search` skip `readiness`.
 *
 *   list   — every investigation for the workspace, no items (compact index).
 *   get    — one investigation by `slug` (required), with its full item set
 *            and `eligibility`. 404 when no investigation matches the slug —
 *            Jace's `fetch_investigations` core renders that as "none yet",
 *            not an error.
 *   search — FTS over title + symptom signature + item bodies (`query`,
 *            required), falling back to the most recently touched
 *            investigations on zero hits (`searchInvestigations`, Task 2).
 *   anchor — the conversation's currently anchored investigation
 *            (`jace_sessions.anchored_investigation_id`, read straight off
 *            the SAME session row `getJaceSessionByEveSessionId` already
 *            fetched — no second query to find out whether an anchor
 *            exists). No anchor, or an anchor whose target no longer
 *            resolves, both collapse to `{ investigation: null }` — never an
 *            error (mirrors `runner/briefs`' anchor-mode null-collapse
 *            exactly). **Load-bearing difference from `getBriefById`:**
 *            `getInvestigationById` is NOT workspace-scoped (Task 2's own
 *            doc-comment: "the id IS the security boundary", matching
 *            `getJaceSessionById`/`getApprovalById` precedent) — so unlike
 *            briefs' anchor mode, this route re-checks
 *            `investigation.workspaceId === workspaceId` itself after the
 *            fetch, and treats a mismatch the same as "no longer resolves".
 *            This is NOT defense-in-depth today (an anchor is only ever set
 *            by THIS route's own `anchor: true` branch below, which already
 *            verifies workspace ownership before anchoring) — it is the
 *            ONLY tenant check standing between a stale/foreign anchor and a
 *            cross-workspace leak, since the query itself provides none.
 *
 * POST resolves the workspace, `upsertInvestigation`s the investigation-level
 * fields, `patchInvestigationItems` for any `items`, resolves `links` (Self-
 * Review S1), then applies `anchor`. Unlike `runner/briefs`, there is no
 * "title required to create" business rule here to replicate — Task 2's
 * `upsertInvestigation` already defaults `title` to `slug` on first insert
 * when omitted (its own doc-comment), so this route passes `title` straight
 * through undefined-or-not and lets the store layer decide.
 *
 * **`verdict`/`status` are rejected outright, ahead of every other check**
 * (Global Constraints: "The save route rejects verdict and status fields
 * with 400. Verdicts travel only through
 * `POST /api/v1/runner/investigations/verdict`, which runs
 * `computeVerdictEligibility` server-side and fails closed."). Accepting
 * either here would hand the model a self-assessed flag for exactly the
 * judgment call the verdict route exists to gate — see `runner/briefs`' own
 * `status`-rejection paragraph for the identical reasoning applied to a
 * sibling field.
 *
 * **Secret scan on write covers every free-text field this route persists**
 * — `title`, `symptomStatement`, `symptomSignature`, `affectedSurface`, each
 * item's `body`/`mechanism`/`evidenceRefs` entries, and each link's
 * `targetSlug` — mirroring `runner/briefs`' own batch exactly (see that
 * route's doc-comment for why identifiers get scanned too, not exempted:
 * "rather than rely on 'it's probably safe because it's structured,' this
 * route scans it like everything else"). Deliberately NOT scanned: item
 * `data` — kind-specific structured metadata (e.g. `{ solePlausible: true }`,
 * `{ confidence, missingEvidence }`), not model-composed prose. ALL free-text
 * fields are scanned in ONE batch before anything is written; ANY finding
 * 422s the WHOLE write.
 *
 * **Every array `patchInvestigationItems` returns is relayed, always
 * present, even when empty** — `applied`, `skippedHumanAuthorityIds`,
 * `skippedEvidenceImmutableIds`, `skippedHypothesisNeedsEvidence`,
 * `skippedKindChangeIds`, `unmatchedIds`. A caller that cannot see its write
 * was dropped will confidently tell a human something was recorded when it
 * wasn't — the same reasoning `runner/briefs` gives for its own two skip
 * arrays, extended to all six Task 2 now reports.
 *
 * **`links` (Self-Review S1) resolves each `{ targetSlug, role }` to an
 * investigation id WITHIN THE CALLER'S OWN WORKSPACE** (`getInvestigationBySlug`
 * is already workspace-scoped, so this reuses the exact same tenancy
 * boundary every other lookup on this route does) and calls
 * `linkInvestigations`. An unresolvable `targetSlug` is never a hard
 * failure — the whole write still lands, and the slug is reported back in
 * `skippedLinks` (always present, like the six patch arrays) so the caller
 * knows the edge did not record.
 *
 * **`anchor` (optional boolean) sets or clears this SESSION's investigation
 * anchor**, exactly mirroring `runner/briefs`' own `anchor` semantics (see
 * that route's doc-comment for the full "why" — confirm-once, re-anchor-only-
 * to-what-this-call-just-resolved, defense-in-depth workspace re-check
 * before anchoring): `anchor: true` anchors to THIS call's investigation
 * (`setSessionInvestigationAnchor`); omitted leaves the anchor untouched;
 * `anchor: false` clears it (`clearSessionInvestigationAnchor`) — clearing
 * happens BEFORE the upsert, and when `anchor: false` arrives with no `slug`
 * at all (nothing else to write yet), the route returns immediately after
 * the clear without ever calling `upsertInvestigation`/`patchInvestigationItems`.
 * Content fields sent without a `slug` are rejected (400), not silently
 * dropped — there is no investigation for them to attach to.
 *
 * 400 — missing/blank `eveSessionId`, invalid `mode` (GET), a `get` with no
 * `slug` or a `search` with no `query` (GET), invalid JSON or a malformed
 * body (POST), `verdict`/`status` present in the POST body, an invalid
 * `severity`/item `kind`/item `state`/link `role`, an invalid `firstSeenAt`,
 * a POST with no `slug` at all (unless a pure `anchor: false` clear), or
 * content fields without a `slug`. 401 — bad/missing shared secret. 404 — no
 * session, a session with no resolved workspace yet, (GET mode=get) no
 * investigation at that slug, or (POST `anchor: true`) the resolved
 * investigation does not belong to the caller's own workspace (defense in
 * depth, unreachable through this route's own logic today — mirrors
 * `runner/briefs`' identical check). 422 — a credential-shaped value in any
 * scanned field. 502 — the backing store errored.
 */
import { NextRequest, NextResponse } from "next/server";
import {
  appendChangeRecordEvent,
  findOrCreateChangeRecord,
  getJaceSessionByEveSessionId,
  getInvestigationBySlug,
  getInvestigationById,
  getRepositoryByName,
  listInvestigations,
  searchInvestigations,
  upsertInvestigation,
  patchInvestigationItems,
  computeVerdictEligibility,
  linkInvestigations,
  setSessionInvestigationAnchor,
  clearSessionInvestigationAnchor,
} from "@agentrail/db-postgres";
import type {
  InvestigationSeverity,
  InvestigationItemKind,
  HypothesisState,
  InvestigationLinkRole,
  PatchInvestigationItemInput,
} from "@agentrail/db-postgres";
import { requireJaceConsoleSecret } from "../../../../../lib/jace-console-auth";
import { scanForSecrets, summarizeFindings } from "../../../../../lib/secret-scan";

const MODES = ["list", "get", "search", "anchor"] as const;
type Mode = (typeof MODES)[number];

const INVESTIGATION_SEVERITIES: readonly InvestigationSeverity[] = [
  "low",
  "medium",
  "high",
  "critical",
];
const INVESTIGATION_ITEM_KINDS: readonly InvestigationItemKind[] = [
  "timeline_event",
  "evidence",
  "hypothesis",
  "finding",
  "verdict",
  "lesson_candidate",
];
const HYPOTHESIS_STATES: readonly HypothesisState[] = [
  "open",
  "supported",
  "refuted",
  "inconclusive",
];
const INVESTIGATION_LINK_ROLES: readonly InvestigationLinkRole[] = ["recurrence_of", "related"];

// ---- POST body validation (hand-rolled edge validators, mirroring
// runner/briefs' own isRawBody/isRawBriefItem — this codebase validates
// request bodies at the edge with explicit type-guard functions, not a
// schema library). ----

interface RawInvestigationItem {
  id?: string;
  kind: string;
  body?: string;
  mechanism?: string;
  state?: string | null;
  evidenceRefs?: string[];
  data?: Record<string, unknown>;
}

interface RawInvestigationLink {
  targetSlug: string;
  role: string;
}

interface RawChangeRecordAnchor {
  repo: string;
  issueNumber?: number | null;
  prNumber?: number | null;
  headShas?: string[];
}

interface RawPostBody {
  eveSessionId: string;
  // Optional ONLY for a pure `anchor: false` clear with no content fields —
  // see this route's own "anchor" doc-comment paragraph. Every other call
  // still requires it; enforced in the handler (business logic), not here.
  slug?: string;
  title?: string;
  symptomStatement?: string;
  symptomSignature?: string;
  affectedSurface?: string;
  severity?: string;
  // `null` explicitly clears a previously-set firstSeenAt; omitted leaves it
  // untouched (see upsertInvestigation's own `!== undefined` partial-patch
  // semantics).
  firstSeenAt?: string | null;
  items?: RawInvestigationItem[];
  // Conversation -> investigation anchor: true anchors this session to THIS
  // call's investigation, false clears any existing anchor, omitted leaves
  // it untouched.
  anchor?: boolean;
  links?: RawInvestigationLink[];
  changeRecord?: RawChangeRecordAnchor;
}

function isRawInvestigationItem(v: unknown): v is RawInvestigationItem {
  if (!v || typeof v !== "object") return false;
  const o = v as Record<string, unknown>;
  if (o.id !== undefined && typeof o.id !== "string") return false;
  if (typeof o.kind !== "string" || !(INVESTIGATION_ITEM_KINDS as readonly string[]).includes(o.kind)) {
    return false;
  }
  if (o.body !== undefined && typeof o.body !== "string") return false;
  if (o.mechanism !== undefined && typeof o.mechanism !== "string") return false;
  if (
    o.state !== undefined &&
    o.state !== null &&
    (typeof o.state !== "string" || !(HYPOTHESIS_STATES as readonly string[]).includes(o.state))
  ) {
    return false;
  }
  if (
    o.evidenceRefs !== undefined &&
    (!Array.isArray(o.evidenceRefs) || !(o.evidenceRefs as unknown[]).every((s) => typeof s === "string"))
  ) {
    return false;
  }
  if (o.data !== undefined && (typeof o.data !== "object" || o.data === null || Array.isArray(o.data))) {
    return false;
  }
  return true;
}

function isRawInvestigationLink(v: unknown): v is RawInvestigationLink {
  if (!v || typeof v !== "object") return false;
  const o = v as Record<string, unknown>;
  if (typeof o.targetSlug !== "string" || o.targetSlug.trim().length === 0) return false;
  if (typeof o.role !== "string" || !(INVESTIGATION_LINK_ROLES as readonly string[]).includes(o.role)) {
    return false;
  }
  return true;
}

function isPositiveInteger(v: unknown): v is number {
  return typeof v === "number" && Number.isInteger(v) && v > 0;
}

function isRawChangeRecordAnchor(v: unknown): v is RawChangeRecordAnchor {
  if (!v || typeof v !== "object") return false;
  const o = v as Record<string, unknown>;
  if (typeof o.repo !== "string" || o.repo.trim().length === 0) return false;
  const issueNumber = o.issueNumber === undefined ? null : o.issueNumber;
  const prNumber = o.prNumber === undefined ? null : o.prNumber;
  if (issueNumber !== null && !isPositiveInteger(issueNumber)) return false;
  if (prNumber !== null && !isPositiveInteger(prNumber)) return false;
  if (issueNumber === null && prNumber === null) return false;
  if (
    o.headShas !== undefined &&
    (!Array.isArray(o.headShas) || !(o.headShas as unknown[]).every((s) => typeof s === "string" && s.trim().length > 0))
  ) {
    return false;
  }
  return true;
}

function isRawPostBody(v: unknown): v is RawPostBody {
  if (!v || typeof v !== "object") return false;
  const o = v as Record<string, unknown>;
  if (typeof o.eveSessionId !== "string") return false;
  if (o.slug !== undefined && (typeof o.slug !== "string" || o.slug.trim().length === 0)) return false;
  if (o.title !== undefined && typeof o.title !== "string") return false;
  if (o.symptomStatement !== undefined && typeof o.symptomStatement !== "string") return false;
  if (o.symptomSignature !== undefined && typeof o.symptomSignature !== "string") return false;
  if (o.affectedSurface !== undefined && typeof o.affectedSurface !== "string") return false;
  if (
    o.severity !== undefined &&
    (typeof o.severity !== "string" || !(INVESTIGATION_SEVERITIES as readonly string[]).includes(o.severity))
  ) {
    return false;
  }
  if (o.firstSeenAt !== undefined && o.firstSeenAt !== null && typeof o.firstSeenAt !== "string") {
    return false;
  }
  if (
    o.items !== undefined &&
    (!Array.isArray(o.items) || !(o.items as unknown[]).every(isRawInvestigationItem))
  ) {
    return false;
  }
  if (o.anchor !== undefined && typeof o.anchor !== "boolean") return false;
  if (
    o.links !== undefined &&
    (!Array.isArray(o.links) || !(o.links as unknown[]).every(isRawInvestigationLink))
  ) {
    return false;
  }
  if (o.changeRecord !== undefined && !isRawChangeRecordAnchor(o.changeRecord)) return false;
  return true;
}

function toPatchInput(item: RawInvestigationItem): PatchInvestigationItemInput {
  const input: PatchInvestigationItemInput = { kind: item.kind as InvestigationItemKind };
  if (item.id !== undefined) input.id = item.id;
  if (item.body !== undefined) input.body = item.body;
  if (item.mechanism !== undefined) input.mechanism = item.mechanism;
  if (item.state !== undefined) input.state = item.state as HypothesisState | null;
  if (item.evidenceRefs !== undefined) input.evidenceRefs = item.evidenceRefs;
  if (item.data !== undefined) input.data = item.data;
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

  try {
    if (mode === "anchor") {
      if (!session.anchoredInvestigationId) {
        return NextResponse.json({ schemaVersion: 1, mode, investigation: null });
      }
      const anchored = await getInvestigationById(session.anchoredInvestigationId);
      // `getInvestigationById` is NOT workspace-scoped (Task 2's own
      // doc-comment: "the id IS the security boundary") — this re-check is
      // the ONLY thing standing between a foreign-workspace investigation
      // and a leak here. See this route's own doc-comment ("Load-bearing
      // difference from getBriefById").
      if (!anchored || anchored.investigation.workspaceId !== workspaceId) {
        return NextResponse.json({ schemaVersion: 1, mode, investigation: null });
      }
      const eligibility = await computeVerdictEligibility(anchored.investigation.id);
      return NextResponse.json({
        schemaVersion: 1,
        mode,
        investigation: anchored.investigation,
        items: anchored.items,
        eligibility,
      });
    }

    if (mode === "get") {
      const slug = request.nextUrl.searchParams.get("slug")?.trim() ?? "";
      if (!slug) {
        return NextResponse.json({ error: "slug is required for mode=get" }, { status: 400 });
      }
      const found = await getInvestigationBySlug(workspaceId, slug);
      if (!found) {
        return NextResponse.json({ error: `Investigation ${slug} not found` }, { status: 404 });
      }
      // Eligibility is computed HERE, server-side, from
      // computeVerdictEligibility — never left for the caller to derive by
      // scanning items itself. See this route's doc-comment ("GET modes").
      const eligibility = await computeVerdictEligibility(found.investigation.id);
      return NextResponse.json({
        schemaVersion: 1,
        mode,
        investigation: found.investigation,
        items: found.items,
        eligibility,
      });
    }

    if (mode === "search") {
      const query = request.nextUrl.searchParams.get("query")?.trim() ?? "";
      if (!query) {
        return NextResponse.json(
          { error: "query is required for mode=search" },
          { status: 400 }
        );
      }
      // Deliberately NO eligibility here — search is the one-time
      // disambiguation step ("which investigation"), never the point where
      // the verdict gate fires (that happens against a single already-
      // resolved investigation, via get/anchor). See this route's doc-comment.
      const investigations = await searchInvestigations(workspaceId, query);
      return NextResponse.json({ schemaVersion: 1, mode, investigations });
    }

    // mode === "list" — deliberately no per-investigation eligibility, same
    // N-fanout reasoning as runner/briefs' own list mode.
    const investigations = await listInvestigations(workspaceId);
    return NextResponse.json({ schemaVersion: 1, mode, investigations });
  } catch (err) {
    console.error("[runner/investigations] read failed:", err);
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
  // a message naming exactly why — Global Constraints: "The save route
  // rejects verdict and status fields with 400." See this route's
  // doc-comment.
  if (raw && typeof raw === "object") {
    const o = raw as Record<string, unknown>;
    if ("verdict" in o || "status" in o) {
      return NextResponse.json(
        {
          error:
            "verdict and status never travel through save — use /investigations/verdict; status is derived",
        },
        { status: 400 }
      );
    }
  }

  if (!isRawPostBody(raw)) {
    return NextResponse.json(
      {
        error:
          "Body must have eveSessionId (string), and optional slug (non-empty string — required unless this is a pure anchor: false clear), title/symptomStatement/symptomSignature/affectedSurface (string), severity (low|medium|high|critical), firstSeenAt (ISO date string or null), items (array of {id?, kind, body?, mechanism?, state?, evidenceRefs?, data?}), anchor (boolean), links (array of {targetSlug, role}), changeRecord ({repo, issueNumber? or prNumber?, headShas?})",
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

  const slugRaw = raw.slug?.trim() ?? "";
  const items = raw.items ?? [];
  const links = raw.links ?? [];
  const changeRecordAnchor = raw.changeRecord;

  // Pure anchor-clear — mirrors runner/briefs' own "anchor: false with no
  // slug" branch exactly (see this route's doc-comment): fires when Jace has
  // NOTHING to write yet. Gating the clear behind a successful investigation
  // write would force the caller to invent one just to unanchor.
  if (raw.anchor === false && !slugRaw) {
    if (
      raw.title !== undefined ||
      raw.symptomStatement !== undefined ||
      raw.symptomSignature !== undefined ||
      raw.affectedSurface !== undefined ||
      raw.severity !== undefined ||
      raw.firstSeenAt !== undefined ||
      items.length > 0 ||
      links.length > 0 ||
      changeRecordAnchor !== undefined
    ) {
      return NextResponse.json(
        {
          error:
            "slug is required to write investigation content — omit title/symptomStatement/symptomSignature/affectedSurface/severity/firstSeenAt/items/links to only clear the anchor",
        },
        { status: 400 }
      );
    }
    try {
      await clearSessionInvestigationAnchor(session.id);
    } catch (err) {
      console.error("[runner/investigations] anchor clear failed:", err);
      return NextResponse.json({ error: "Upstream storage error" }, { status: 502 });
    }
    return NextResponse.json({ anchor: null }, { status: 200 });
  }

  if (!slugRaw) {
    return NextResponse.json({ error: "slug is required" }, { status: 400 });
  }
  const slug = slugRaw;

  if (changeRecordAnchor) {
    const connectedRepo = await getRepositoryByName(workspaceId, changeRecordAnchor.repo.trim());
    if (!connectedRepo) {
      return NextResponse.json(
        { error: "changeRecord.repo is not connected to this workspace" },
        { status: 404 }
      );
    }
  }

  let firstSeenAt: Date | null | undefined;
  if (raw.firstSeenAt !== undefined) {
    if (raw.firstSeenAt === null) {
      firstSeenAt = null;
    } else {
      const parsed = new Date(raw.firstSeenAt);
      if (Number.isNaN(parsed.getTime())) {
        return NextResponse.json(
          { error: "firstSeenAt must be a valid ISO date string" },
          { status: 400 }
        );
      }
      firstSeenAt = parsed;
    }
  }

  // Write-side secret scan — every free-text field this route persists. See
  // this route's own doc-comment for the full field list and why identifiers
  // (evidenceRefs, link targetSlugs) are scanned too, not exempted.
  const secretFindings = [
    ...(raw.title ? scanForSecrets(raw.title).findings : []),
    ...(raw.symptomStatement ? scanForSecrets(raw.symptomStatement).findings : []),
    ...(raw.symptomSignature ? scanForSecrets(raw.symptomSignature).findings : []),
    ...(raw.affectedSurface ? scanForSecrets(raw.affectedSurface).findings : []),
    ...items.flatMap((item) => [
      ...(item.body ? scanForSecrets(item.body).findings : []),
      ...(item.mechanism ? scanForSecrets(item.mechanism).findings : []),
      ...(item.evidenceRefs ?? []).flatMap((ref) => scanForSecrets(ref).findings),
    ]),
    ...links.flatMap((link) => scanForSecrets(link.targetSlug).findings),
  ];
  if (secretFindings.length > 0) {
    const reason = summarizeFindings(secretFindings);
    console.warn(`[runner/investigations] rejected batch for investigation ${slug}: ${reason}`);
    return NextResponse.json(
      { error: "Investigation content rejected: credential-shaped value detected", reason },
      { status: 422 }
    );
  }

  try {
    // `anchor: false` clears BEFORE the upsert below, same ordering as the
    // pure slug-less clear path above — this branch is reached only when
    // `slug` IS present (the slug-less case already returned above), i.e.
    // "clear the anchor while ALSO writing to some other investigation this
    // turn."
    if (raw.anchor === false) {
      await clearSessionInvestigationAnchor(session.id);
    }

    // No "title required to create" check here — unlike runner/briefs,
    // upsertInvestigation itself defaults title to slug on first insert when
    // omitted (Task 2's own doc-comment). appendSessionId is passed on every
    // call: `jace_session_ids` accumulates every conversation that has ever
    // touched this investigation (schema doc-comment, "many sessions, one
    // investigation") — this route is the only writer, so it is the only
    // place this can be wired up.
    const investigation = await upsertInvestigation({
      workspaceId,
      slug,
      title: raw.title,
      symptomStatement: raw.symptomStatement,
      symptomSignature: raw.symptomSignature,
      affectedSurface: raw.affectedSurface,
      severity: raw.severity as InvestigationSeverity | undefined,
      firstSeenAt,
      appendSessionId: session.id,
    });

    const {
      applied,
      skippedHumanAuthorityIds,
      skippedEvidenceImmutableIds,
      skippedHypothesisNeedsEvidence,
      skippedKindChangeIds,
      unmatchedIds,
    } = await patchInvestigationItems(investigation.id, items.map(toPatchInput));

    // Links (Self-Review S1): resolve targetSlug -> id WITHIN the caller's
    // own workspace (getInvestigationBySlug is already workspace-scoped).
    // An unresolvable slug is reported, never a hard failure — see this
    // route's own doc-comment.
    const skippedLinks: string[] = [];
    for (const link of links) {
      const target = await getInvestigationBySlug(workspaceId, link.targetSlug);
      if (!target) {
        skippedLinks.push(link.targetSlug);
        continue;
      }
      await linkInvestigations(
        investigation.id,
        target.investigation.id,
        link.role as InvestigationLinkRole
      );
    }

    // Conversation -> investigation anchor: a follow-on to THIS SAME call's
    // upsertInvestigation, never a separate caller-supplied investigation id
    // — see this route's doc-comment.
    let anchor: { investigationId: string } | null | undefined;
    if (raw.anchor === true) {
      // Defense in depth only — structurally unreachable today, since
      // `investigation` was just upserted strictly within `workspaceId`
      // above. Mirrors runner/briefs' identical re-verified-even-though-
      // structurally-guaranteed check.
      if (investigation.workspaceId !== workspaceId) {
        return NextResponse.json(
          { error: "Investigation does not belong to this workspace" },
          { status: 404 }
        );
      }
      await setSessionInvestigationAnchor(session.id, investigation.id);
      anchor = { investigationId: investigation.id };
    } else if (raw.anchor === false) {
      anchor = null; // already cleared above, before the upsert
    }

    let changeRecord:
      | { id: string; eventKey: string; inserted: boolean }
      | undefined;
    if (changeRecordAnchor) {
      const issueNumber = changeRecordAnchor.issueNumber ?? null;
      const prNumber = changeRecordAnchor.prNumber ?? null;
      const record = await findOrCreateChangeRecord({
        workspaceId,
        repo: changeRecordAnchor.repo.trim(),
        issueNumber,
        prNumber,
        headShas: changeRecordAnchor.headShas?.map((sha) => sha.trim()),
      });
      const eventKey = `incident:investigation:${investigation.id}`;
      const { inserted } = await appendChangeRecordEvent({
        recordId: record.id,
        eventKey,
        stage: "incident",
        actor: "jace-investigator",
        payloadRef: {
          kind: "investigation",
          investigationId: investigation.id,
          slug: investigation.slug,
          severity: investigation.severity,
          verdict: investigation.verdict,
          confidence: investigation.confidence,
        },
      });
      changeRecord = { id: record.id, eventKey, inserted };
    }

    return NextResponse.json(
      {
        investigation,
        applied,
        skippedHumanAuthorityIds,
        skippedEvidenceImmutableIds,
        skippedHypothesisNeedsEvidence,
        skippedKindChangeIds,
        unmatchedIds,
        skippedLinks,
        ...(anchor !== undefined ? { anchor } : {}),
        ...(changeRecord !== undefined ? { changeRecord } : {}),
      },
      { status: 200 }
    );
  } catch (err) {
    console.error("[runner/investigations] write failed:", err);
    return NextResponse.json({ error: "Upstream storage error" }, { status: 502 });
  }
}
