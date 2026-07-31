# Jace Debugging Agent (v1) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Ship v1 of the spec `docs/superpowers/specs/2026-07-29-jace-debugging-agent-design.md` — the triage subagent becomes Jace's debugging specialist with a durable investigation artifact, an evidence capability layer (github/railway/factory), nested change/anomaly mission investigators, a server-computed verdict gate, and a console surface with the human confirmation/promotion loop.

**Architecture:** Store-first: Postgres artifact tables + guarded queries (briefs pattern), then console runner routes (investigations + evidence with envelope-at-seam persistence), then provider adapters behind a catalog-derived capability registry, then the Jace side (root tools → debugger identity with mode-discriminated schema → nested investigators → debug skill), and finally the console UI. Root stays the only model-side artifact writer; the evidence route is the only writer of `evidence` items; every gate lives in a route, never a prompt.

**Tech Stack:** Drizzle/Postgres (`packages/db-postgres`), Next.js App Router routes (`apps/console`), Eve 0.19.x agent (`apps/jace` — standalone npm, plain-JS `.core.mjs` cores, JSON-Schema output contracts), Langfuse scores via plain `fetch`.

## Global Constraints

Copied from the spec + house rules. Every task's requirements implicitly include these:

- Migration slots are pre-assigned: **0058_investigations** and **0059_jace_sessions_investigation_anchor**. Both MUST be registered in `packages/db-postgres/drizzle/migrations/meta/_journal.json` — a migration absent from the journal is silently skipped.
- The subagent directory/tool name **`triage` is unchanged**. Run-mode output fields are **byte-stable**; the output schema widens additively via a `mode` discriminator. A regression test pins run-mode compatibility with `apps/jace/agent/hooks/langfuse-verdict-score.ts` and the calibration join on `run_id`.
- **Root is the only model-side artifact writer.** Investigators and the debugger return advisories; they never call `save_investigation`. The **evidence route is the only writer of `kind: 'evidence'` items**; `save_investigation` must refuse to create/modify/delete them.
- The save route **rejects `verdict` and `status` fields with 400**. Verdicts travel only through `POST /api/v1/runner/investigations/verdict`, which runs `computeVerdictEligibility` server-side and **fails closed**.
- Route-enforced invariants (never prompt-only): `authority: 'human'` items are never overwritten by the runner save path; `evidence` items are immutable; a hypothesis may not enter `supported`/`refuted` without ≥ 1 entry in `evidence_refs`.
- Every externally-sourced string rendered to the model passes `hardenUntrusted` (`apps/jace/agent/lib/sanitize-untrusted.core.mjs`). Server-side evidence excerpts pass `scanForSecrets` + the `boundEvidence` caps (last 200 lines, 16 KB) before storage.
- `apps/jace` is **outside the pnpm workspace**: `npm ci`, no `@agentrail/*` imports, every persistence op is HTTP to the console (`JACE_CONSOLE_BASE_URL` + Bearer `JACE_CONSOLE_TOKEN`). Tools are thin `defineTool` wrappers over pure `.core.mjs` modules with injected `fetch`. Output schemas are **plain JSON Schema objects, not zod**. The approval gate key is **`approval`** (`needsApproval` does not exist). New ungated mutating tools must be added to `UNGATED_ADVISORY_WRITES` in `apps/jace/test/no-second-write-path.test.mjs`.
- Subagent tools resolve the session for console calls as `ctx.session.parent?.rootSessionId ?? ctx.session.id`.
- Console runner routes authenticate with `requireJaceConsoleSecret` and resolve tenant via `getJaceSessionByEveSessionId(eveSessionId)`. Human workspace routes: `auth()` → `getWorkspaceMembership(userId, workspaceId)` → writes require `role === "owner" || role === "admin"`.
- Nested investigators live at `apps/jace/agent/subagents/triage/subagents/<name>/`; every new subagent ships `disableTool()` sentinels for all 10 default-harness tools (`bash`, `write_file`, `read_file`, `glob`, `grep`, `web_fetch`, `web_search`, `todo`, `ask_question`, `load_skill`) unless the spec says keep one.
- One task = one branch = one PR (house PR-per-change rule). Conventional Commits. Commit at every green step.
- Before running a test file for the first time in a package, run that package's existing sibling test (e.g. briefs tests) once to confirm the exact runner invocation, then use the same invocation for yours.

## File Structure

```
packages/db-postgres/
  src/schema/investigations.ts                 (T1: tables + enums)
  src/schema/jace_sessions.ts                  (T1: + anchored_investigation_id)
  drizzle/migrations/0058_investigations.sql   (T1)
  drizzle/migrations/0059_jace_sessions_investigation_anchor.sql (T1)
  drizzle/migrations/meta/_journal.json        (T1: register both)
  src/queries/investigations.ts                (T2: all query fns + guards)
  src/queries/investigations.test.ts           (T2)
  src/queries/index.ts                         (T2: export barrel)
apps/console/
  app/api/v1/runner/investigations/route.ts            (T3: GET modes + POST save)
  app/api/v1/runner/investigations/verdict/route.ts    (T3)
  app/api/v1/runner/investigations/route.test.ts       (T3)
  lib/evidence/types.ts                        (T4: verbs, envelope, degradations)
  lib/evidence/registry.ts                     (T4: catalog∩rows derivation)
  lib/evidence/envelope.ts                     (T4: scrub→cap→harden→persist)
  lib/evidence/registry.test.ts                (T4: fake-adapter architecture test)
  app/api/v1/runner/evidence/route.ts          (T4)
  app/api/v1/runner/evidence/route.test.ts     (T4)
  lib/evidence/factory.ts + factory.test.ts    (T5)
  lib/evidence/github.ts + github.test.ts      (T6)
  lib/evidence/railway.ts + railway.test.ts    (T7)
  .../connectors/components/connector-helpers.ts (T7: railway entry + evidence caps)
  .../connectors/components/brand-icons.tsx      (T7: RailwayBrand)
  app/api/v1/workspaces/[workspaceId]/connectors/secret/route.ts (T7: catalog-derived allowlist)
  app/api/v1/workspaces/[workspaceId]/connectors/secret/verify.ts (T7: railway live verify)
  app/api/v1/runner/approvals/route.ts         (T12: investigation link stamping)
  app/(dashboard)/dashboard/[workspaceId]/investigations/… (T13: index/detail/actions)
apps/jace/
  agent/lib/fetch_investigations.core.mjs + tools/fetch_investigations.ts (T8)
  agent/lib/save_investigation.core.mjs  + tools/save_investigation.ts  (T8)
  agent/lib/record_verdict.core.mjs      + tools/record_verdict.ts      (T8)
  test/*.core.test.mjs                          (T8)
  agent/subagents/triage/instructions.md        (T9: debugger identity, two modes)
  agent/subagents/triage/lib/triage.core.mjs    (T9: mode union — TRIAGE_SCHEMA ∪ ROUND_REPORT)
  agent/subagents/triage/tools/fetch_changes.ts, search_events.ts (T9: verb tools)
  agent/subagents/triage/subagents/change/…     (T10)
  agent/subagents/triage/subagents/anomaly/…    (T10)
  agent/skills/debug/SKILL.md                   (T11: root flow grammar)
  agent/subagents/triage/skills/…               (T11: discipline + 3 playbooks)
  agent/instructions.md                         (T11: Debugging section)
```

---

### Task 1: Store — schema + migrations 0058/0059

**Files:**
- Create: `packages/db-postgres/src/schema/investigations.ts`
- Modify: `packages/db-postgres/src/schema/jace_sessions.ts` (add `anchored_investigation_id`)
- Modify: `packages/db-postgres/src/schema/index.ts` (export barrel — mirror how `briefs.ts` is exported)
- Create: `packages/db-postgres/drizzle/migrations/0058_investigations.sql`
- Create: `packages/db-postgres/drizzle/migrations/0059_jace_sessions_investigation_anchor.sql`
- Modify: `packages/db-postgres/drizzle/migrations/meta/_journal.json` (register idx 59 + 60, tags `0058_investigations`, `0059_jace_sessions_investigation_anchor`)

**Interfaces:**
- Consumes: existing `workspaces`, `repositories`, `jaceSessions` tables; the `briefs.ts` schema file as the 1:1 style template.
- Produces (exact exports later tasks import from `schema/investigations.ts`):
  `investigationStatusEnum` (`open|investigating|concluded|handed_off`), `investigationSeverityEnum` (`low|medium|high|critical`), `investigationOpenedByEnum` (`chat|run-outcome|alert`), `investigationItemKindEnum` (`timeline_event|evidence|hypothesis|finding|verdict|lesson_candidate`), `hypothesisStateEnum` (`open|supported|refuted|inconclusive`), `investigationVerdictEnum` (`root_caused|undetermined`), `verdictConfidenceEnum` (`confirmed|probable|circumstantial`), `investigationAuthorityEnum` (`human|jace`), `investigationLinkRoleEnum` (`recurrence_of|related`), `investigationIssueRoleEnum` (`mitigative|preventative`); tables `investigations`, `investigationItems`, `investigationLinks`, `investigationIssueLinks`.

- [ ] **Step 1: Write `schema/investigations.ts`** — mirror `briefs.ts` structure (doc comment, pgEnums, tables, uniques, indexes). Columns exactly as pinned in the spec's v1 contract:

```ts
// investigations: id uuid pk defaultRandom · workspace_id uuid notNull FK workspaces
// ON DELETE cascade · repository_id uuid nullable FK repositories ON DELETE set null ·
// slug text notNull · title text notNull · status investigation_status notNull
// default 'open' · severity investigation_severity notNull default 'medium' ·
// opened_by investigation_opened_by notNull default 'chat' · symptom_statement text
// notNull · symptom_signature text notNull default '' · affected_surface text notNull
// default '' · first_seen_at timestamptz nullable · verdict investigation_verdict
// nullable · confidence verdict_confidence nullable · depth_budget integer notNull
// default 8 · jace_session_ids jsonb notNull default [] · created_at/updated_at
// timestamptz defaultNow. UNIQUE (workspace_id, slug) named
// investigations_workspace_id_slug_unique.
//
// investigation_items: id · investigation_id FK investigations cascade · kind
// investigation_item_kind notNull · body text notNull · mechanism text notNull
// default '' · state hypothesis_state nullable · evidence_refs jsonb notNull
// default [] · data jsonb notNull default {} · authority investigation_authority
// notNull default 'jace' · created_at/updated_at. Index on investigation_id.
//
// investigation_links: id · investigation_id FK cascade · target_investigation_id
// FK investigations cascade · role investigation_link_role notNull · created_at.
//
// investigation_issue_links: id · investigation_id FK cascade · repo text notNull ·
// issue_number integer notNull · role investigation_issue_role notNull · created_at.
```

Also add the two FTS GIN indexes in the migration (Step 3): `investigations_title_fts_idx` on `to_tsvector('english', title || ' ' || symptom_signature)` and `investigation_items_body_fts_idx` on `to_tsvector('english', body)` — mirror how `0055_briefs.sql` declares its FTS indexes.

- [ ] **Step 2: Add the session anchor** to `schema/jace_sessions.ts`, directly below `anchoredBriefId`, copying its doc-comment style ("a THIRD, UNRELATED kind of anchor — do not conflate…"):

```ts
anchoredInvestigationId: uuid("anchored_investigation_id").references(
  () => investigations.id,
  { onDelete: "set null" }
),
```

- [ ] **Step 3: Write both migration SQL files by hand** (house practice for pre-assigned slots — read `0055_briefs.sql` and `0056_jace_sessions_brief_anchor.sql` first and mirror them: CREATE TYPE per enum, CREATE TABLE, constraints, GIN indexes; 0059 is a single `ALTER TABLE "jace_sessions" ADD COLUMN "anchored_investigation_id" uuid` + FK).
- [ ] **Step 4: Register both in `meta/_journal.json`** after idx 58 (`0057_guardrail_events`), preserving the file's exact entry shape.
- [ ] **Step 5: Verify the migration applies** — run the package's migration test/apply flow the same way the briefs slice did (check `packages/db-postgres/package.json` scripts; run against the local dev database). Expected: both migrations apply cleanly, `\d investigations` shows the unique constraint.
- [ ] **Step 6: Commit** — `feat(db): investigations store — tables, enums, session anchor (0058/0059)`.

---

### Task 2: Store — query layer with route-grade guards

**Files:**
- Create: `packages/db-postgres/src/queries/investigations.ts`
- Create: `packages/db-postgres/src/queries/investigations.test.ts`
- Modify: `packages/db-postgres/src/queries/index.ts` (export everything below)

**Interfaces:**
- Consumes: Task 1 tables; `queries/briefs.ts` is the template (`upsertBrief`, `patchBriefItems`, `computeBriefReadiness`, `searchBriefs`).
- Produces (exact signatures; later tasks call these):

```ts
upsertInvestigation(db, { workspaceId, slug, title?, symptomStatement?, symptomSignature?,
  affectedSurface?, severity?, openedBy?, firstSeenAt?, repositoryId?, appendSessionId? })
  : Promise<InvestigationRow>                       // partial patch on update, like upsertBrief
getInvestigationBySlug(db, workspaceId, slug): Promise<{ investigation, items } | null>
getInvestigationById(db, id): Promise<{ investigation, items } | null>
listInvestigations(db, workspaceId, limit?): Promise<InvestigationIndexRow[]>  // no items, updated_at desc
searchInvestigations(db, workspaceId, query, limit?): Promise<InvestigationIndexRow[]> // FTS, fallback recent
patchInvestigationItems(db, investigationId, items): Promise<{
  applied: string[]; skippedHumanAuthorityIds: string[];
  skippedEvidenceImmutableIds: string[]; skippedHypothesisNeedsEvidence: string[] }>
appendEvidenceItem(db, investigationId, { body, data }): Promise<{ id: string }>  // ROUTE-ONLY writer
computeVerdictEligibility(db, investigationId): Promise<{
  eligible: boolean; blocking: string[] }>
recordVerdict(db, investigationId, { verdict, confidence?, mechanismSummary?, missingEvidence? })
  : Promise<{ ok: true } | { ok: false; blocking: string[] }>   // append-only verdict item + denormalize
linkInvestigations(db, investigationId, targetInvestigationId, role): Promise<void>
linkInvestigationIssue(db, investigationId, repo, issueNumber, role): Promise<void>
setSessionInvestigationAnchor(db, jaceSessionId, investigationId): Promise<void>
clearSessionInvestigationAnchor(db, jaceSessionId): Promise<void>
getSessionInvestigationAnchor(db, jaceSessionId): Promise<string | null>
updateInvestigationItemAsHuman(db, itemId, patch): Promise<...>   // only fn allowed to write authority:'human'
createInvestigationItemAsHuman(db, investigationId, item): Promise<...>
deleteInvestigationItem(db, itemId): Promise<void>
```

- [ ] **Step 1: Write failing tests for the three write guards** (mirror `briefs.test.ts` setup/teardown):

```ts
test("patchInvestigationItems skips human-authority items", async () => {
  const inv = await mkInvestigation();
  const item = await createInvestigationItemAsHuman(db, inv.id,
    { kind: "hypothesis", body: "not the DB", state: "open" });
  const res = await patchInvestigationItems(db, inv.id,
    [{ id: item.id, body: "actually the DB" }]);
  expect(res.skippedHumanAuthorityIds).toEqual([item.id]);
});

test("patchInvestigationItems refuses any write to kind:'evidence'", async () => {
  const inv = await mkInvestigation();
  const ev = await appendEvidenceItem(db, inv.id,
    { body: "railway search_events excerpt", data: { provider: "railway", verb: "search_events" } });
  const res = await patchInvestigationItems(db, inv.id, [{ id: ev.id, body: "edited" }]);
  expect(res.skippedEvidenceImmutableIds).toEqual([ev.id]);
  // creating one via patch is refused too:
  const res2 = await patchInvestigationItems(db, inv.id, [{ kind: "evidence", body: "x" }]);
  expect(res2.skippedEvidenceImmutableIds.length).toBe(1);
});

test("hypothesis cannot enter supported/refuted without evidence_refs", async () => {
  const inv = await mkInvestigation();
  const res = await patchInvestigationItems(db, inv.id,
    [{ kind: "hypothesis", body: "pool exhaustion", state: "supported", evidenceRefs: [] }]);
  expect(res.skippedHypothesisNeedsEvidence.length).toBe(1);
});
```

- [ ] **Step 2: Write failing tests for `computeVerdictEligibility` + `recordVerdict`:**

```ts
test("eligibility requires supported+mechanism+evidence, and refuted rival or solePlausible", async () => {
  const inv = await mkInvestigation();
  expect((await computeVerdictEligibility(db, inv.id)).eligible).toBe(false);
  const ev = await appendEvidenceItem(db, inv.id, { body: "e", data: {} });
  await patchInvestigationItems(db, inv.id, [
    { kind: "hypothesis", body: "H1", mechanism: "conn pool starves", state: "supported", evidenceRefs: [ev.id] },
  ]);
  expect((await computeVerdictEligibility(db, inv.id)).eligible).toBe(false); // no refuted rival yet
  await patchInvestigationItems(db, inv.id, [
    { kind: "hypothesis", body: "H2", state: "refuted", evidenceRefs: [ev.id] },
  ]);
  expect((await computeVerdictEligibility(db, inv.id)).eligible).toBe(true);
});

test("recordVerdict(root_caused) fails closed; undetermined needs missingEvidence", async () => {
  const inv = await mkInvestigation();
  const r = await recordVerdict(db, inv.id, { verdict: "root_caused", confidence: "probable" });
  expect(r.ok).toBe(false);
  const u = await recordVerdict(db, inv.id, { verdict: "undetermined", missingEvidence: [] });
  expect(u.ok).toBe(false);
  const u2 = await recordVerdict(db, inv.id,
    { verdict: "undetermined", missingEvidence: ["metrics for checkout during window"] });
  expect(u2.ok).toBe(true);   // appends a kind:'verdict' item AND denormalizes investigations.verdict
});
```

Also test: `recordVerdict` never updates an existing verdict item (call twice → two items); a `recurrence_of` link via `linkInvestigations` round-trips; `searchInvestigations` finds a seeded investigation by a word in `symptom_signature` and falls back to most-recent on zero hits.

- [ ] **Step 3: Run tests, verify they fail** with "function not defined"/import errors.
- [ ] **Step 4: Implement `queries/investigations.ts`.** Copy `patchBriefItems`'s transaction-and-delta shape; the guard core:

```ts
for (const item of items) {
  const existing = item.id ? byId.get(item.id) : undefined;
  if (existing?.authority === "human") { skippedHumanAuthorityIds.push(item.id!); continue; }
  if (existing?.kind === "evidence" || (!existing && item.kind === "evidence")) {
    skippedEvidenceImmutableIds.push(item.id ?? item.body ?? "new"); continue;
  }
  const effectiveState = "state" in item ? item.state : existing?.state ?? null;
  const effectiveRefs = "evidenceRefs" in item ? item.evidenceRefs : existing?.evidenceRefs ?? [];
  const isHypothesis = (existing?.kind ?? item.kind) === "hypothesis";
  if (isHypothesis && (effectiveState === "supported" || effectiveState === "refuted")
      && (!Array.isArray(effectiveRefs) || effectiveRefs.length === 0)) {
    skippedHypothesisNeedsEvidence.push(item.id ?? item.body ?? "new"); continue;
  }
  // field-level partial upsert, mirroring patchBriefItems' `if ("x" in item)` pattern
}
```

`computeVerdictEligibility`:

```ts
const items = await tx.select().from(investigationItems)
  .where(eq(investigationItems.investigationId, investigationId));
const hyps = items.filter(i => i.kind === "hypothesis");
const supported = hyps.filter(h => h.state === "supported"
  && h.mechanism.trim() !== "" && (h.evidenceRefs as string[]).length > 0);
const refuted = hyps.filter(h => h.state === "refuted"
  && (h.evidenceRefs as string[]).length > 0);
const solePlausible = items.some(i => i.kind === "finding"
  && (i.data as Record<string, unknown>).solePlausible === true);
const blocking: string[] = [];
if (supported.length === 0) blocking.push("no supported hypothesis with mechanism and evidence");
if (refuted.length === 0 && !solePlausible)
  blocking.push("no refuted rival hypothesis and no solePlausible finding");
return { eligible: blocking.length === 0, blocking };
```

`recordVerdict`: `root_caused` → require eligibility AND `confidence`; `undetermined` → require non-empty `missingEvidence`; on ok, insert a `kind:'verdict'` item (`body` = mechanismSummary ?? "", `data` = `{ confidence, missingEvidence }`) and `UPDATE investigations SET verdict, confidence, status='concluded'`. `searchInvestigations`: copy `searchBriefs`'s raw-SQL FTS (`websearch_to_tsquery`, `ts_rank_cd`, recent fallback) over `title || ' ' || symptom_signature || ' ' || string_agg(items.body)`.

- [ ] **Step 5: Run tests → PASS.** Also run the full package test suite to confirm no regressions.
- [ ] **Step 6: Export from `queries/index.ts`, commit** — `feat(db): investigation queries — item guards, verdict eligibility, FTS, anchors`.

---

### Task 3: Console — runner investigations routes

**Files:**
- Create: `apps/console/app/api/v1/runner/investigations/route.ts`
- Create: `apps/console/app/api/v1/runner/investigations/verdict/route.ts`
- Create: `apps/console/app/api/v1/runner/investigations/route.test.ts` (+ `verdict/route.test.ts`)

**Interfaces:**
- Consumes: Task 2 queries; `apps/console/app/api/v1/runner/briefs/route.ts` is the template for auth, tenancy, modes, and the reject-a-field pattern.
- Produces (the wire contract Task 8's cores call):
  - `GET /api/v1/runner/investigations?eveSessionId=&mode=anchor|list|get|search&slug=&query=` → `{ investigation?, items?, investigations?, eligibility? }`; `get`/`anchor` attach `eligibility` verbatim from `computeVerdictEligibility`; `get` on missing slug → **404** (Jace renders "none yet"); `anchor` with no anchor → `{ investigation: null }`.
  - `POST /api/v1/runner/investigations` body `{ eveSessionId, slug?, title?, symptomStatement?, symptomSignature?, affectedSurface?, severity?, firstSeenAt?, items?, anchor? }` → `{ investigation, applied, skippedHumanAuthorityIds, skippedEvidenceImmutableIds, skippedHypothesisNeedsEvidence }`. **Any `verdict` or `status` key in the body → 400.** All free-text fields batch through `scanForSecrets` → any finding 422s the whole write (copy the briefs route's batch shape). `anchor: true` → `setSessionInvestigationAnchor`; `anchor: false` with no slug → pure clear.
  - `POST /api/v1/runner/investigations/verdict` body `{ eveSessionId, slug, verdict, confidence?, mechanismSummary?, missingEvidence? }` → 200 `{ ok: true }` or **409** `{ ok: false, blocking: [...] }`. Absent/uncomputable eligibility → 409 (fail closed).

- [ ] **Step 1: Write failing route tests** (mirror the co-located `route.test.ts` style used by the briefs/status routes): save rejects `{ verdict: "root_caused" }` and `{ status: "concluded" }` with 400; secret-bearing `symptomStatement` 422s; refusal arrays pass through; verdict route 409s on an empty investigation and 200s after seeding the eligibility fixture from Task 2's test; `get` attaches `eligibility`; unknown `eveSessionId` → 404.
- [ ] **Step 2: Run tests → FAIL** (route module not found).
- [ ] **Step 3: Implement both routes**, copying the briefs route preamble verbatim (`requireJaceConsoleSecret`, `getJaceSessionByEveSessionId`, workspace resolution) and its explicit reject block:

```ts
if ("verdict" in body || "status" in body) {
  return NextResponse.json(
    { error: "verdict and status never travel through save — use /investigations/verdict; status is derived" },
    { status: 400 }
  );
}
```

- [ ] **Step 4: Run tests → PASS.**
- [ ] **Step 5: Commit** — `feat(console): runner investigations routes — save with guards, fail-closed verdict`.

---

### Task 4: Console — evidence capability layer (types, registry, envelope, route)

**Files:**
- Create: `apps/console/lib/evidence/types.ts`, `apps/console/lib/evidence/registry.ts`, `apps/console/lib/evidence/envelope.ts`
- Create: `apps/console/app/api/v1/runner/evidence/route.ts`
- Create: `apps/console/lib/evidence/registry.test.ts`, `apps/console/app/api/v1/runner/evidence/route.test.ts`

**Interfaces:**
- Consumes: `CONNECTOR_CATALOG` (Task 7 adds `evidence` declarations; this task adds the optional field + a test-only fake), `getConnectorSecret`/`listConnectors` queries, `boundEvidence` (`apps/console/lib/evidence.ts` — note: existing file, different concern; new code lives under `lib/evidence/` directory), `scanForSecrets`, Task 2 `appendEvidenceItem` + `getSessionInvestigationAnchor`.
- Produces:

```ts
// types.ts
export type EvidenceVerb = "changes" | "search_events" | "signals" | "traces" | "probe";
export type EvidenceQuery = { verb: EvidenceVerb; windowStart: string; windowEnd: string;
  scope?: string; query?: string; limit?: number };
export type EvidenceEnvelope = { ref: string; provider: string; verb: EvidenceVerb;
  query: EvidenceQuery; capturedAt: string; excerpt: string; digest: string; truncated: boolean };
export type EvidenceDegradation = { degraded: true; reason:
  "config_missing" | "no_provider" | "no_investigation" | "bad_request" | "unreachable" |
  "unauthorized" | "upstream_error" | "unexpected_status" | "bad_body" };
export interface EvidenceAdapter {
  provider: string;
  verbs: EvidenceVerb[];
  query(workspaceId: string, q: EvidenceQuery, secret: string | null): Promise<
    { ok: true; raw: string } | { ok: false; reason: EvidenceDegradation["reason"] }>;
}
// registry.ts
export function evidenceCapabilities(catalog, connectorRows):
  Record<EvidenceVerb, string[]>;                       // declared ∩ (enabled + credentialed)
export function adapterFor(provider: string): EvidenceAdapter | null;   // registration map
export function registerAdapter(a: EvidenceAdapter): void;              // used by T5-T7 + tests
// envelope.ts
export async function captureEvidence(db, investigationId, provider, q, raw):
  Promise<EvidenceEnvelope>;   // scanForSecrets→redact, boundEvidence caps, sha256 digest,
                               // appendEvidenceItem persists, returns envelope w/ item id as ref
```

- Route: `GET /api/v1/runner/evidence?eveSessionId=&mode=capabilities` → `{ evidence: { changes: ["github","railway","factory"], search_events: [...] } }` (family-nested from day one). `GET …&verb=&windowStart=&windowEnd=&scope=&query=` → `{ envelopes: EvidenceEnvelope[] }` or a degradation. **No anchored investigation on the session → `no_investigation`** (except `mode=capabilities`, which needs no anchor).

- [ ] **Step 1: Write the architecture-preserving test first** (`registry.test.ts`):

```ts
test("a new provider = catalog entry + adapter, nothing else", async () => {
  registerAdapter({ provider: "fakeobs", verbs: ["signals"],
    query: async () => ({ ok: true, raw: "error_rate=0.42" }) });
  const caps = evidenceCapabilities(
    [...CONNECTOR_CATALOG, { kind: "fakeobs", capabilities: { evidence: ["signals"] } }],
    [{ provider: "fakeobs", enabled: true, hasSecret: true }]);
  expect(caps.signals).toContain("fakeobs");   // discoverable
  // and queryable through the route with zero prompt/subagent changes (route test below)
});
```

- [ ] **Step 2: Write route tests**: capabilities mode needs no anchor; verb query without anchored investigation → `no_investigation`; verb with no provider → `no_provider`; happy path persists an item (`kind:'evidence'`) whose `data.query` echoes the request and returns `ref === item.id`; an excerpt containing a fake secret (`AKIA…`) is redacted in both the stored item and the envelope; a 20 KB raw payload comes back `truncated: true` and ≤ 16 KB.
- [ ] **Step 3: Run → FAIL.** **Step 4: Implement** types/registry/envelope/route. Envelope order is pinned: `scanForSecrets(raw).redacted` → last-200-lines/16KB caps (reuse the constants from `apps/console/lib/evidence.ts`) → `sha256` digest of the capped excerpt → `appendEvidenceItem`. **Step 5: Run → PASS. Step 6: Commit** — `feat(console): evidence capability layer — registry, envelope-at-seam, runner route`.

---

### Task 5: Console — factory adapter

**Files:**
- Create: `apps/console/lib/evidence/factory.ts`, `apps/console/lib/evidence/factory.test.ts`
- Modify: `apps/console/lib/evidence/registry.ts` (register), `connector-helpers.ts` (internal `factory` catalog entry, `availability: "internal"` — extend the type; it renders nowhere but drives capabilities)

**Interfaces:**
- Consumes: existing failure-bundle building blocks — `getRunById`, `getReviewGatesForRun`, `getFailuresForRun`, `getRunEventsByRunId` (see `apps/console/app/api/v1/runner/failure-bundle/route.ts:80-84`); runs-listing query used by work-status.
- Produces: `factoryAdapter: EvidenceAdapter` with `verbs: ["changes","search_events"]`, always available, `secret` ignored (internal). `changes` → runs in window as change candidates (`run_id`, issue/PR refs, timestamps, state); `search_events` → `failure_events` + `run_events` matching `q.query` in window, serialized as line-oriented text for the envelope.

- [ ] **Step 1: Failing tests** with seeded runs/failure events: window filtering, query matching, both verbs return `ok: true` with non-empty `raw`; provider appears in `evidenceCapabilities` with **no connector row** (internal availability short-circuits the credentialed check).
- [ ] **Step 2 → FAIL. Step 3: Implement. Step 4 → PASS. Step 5: Commit** — `feat(console): factory evidence adapter — runs as changes, failure events as search_events`.

---

### Task 6: Console — github adapter

**Files:**
- Create: `apps/console/lib/evidence/github.ts`, `apps/console/lib/evidence/github.test.ts`; register in `registry.ts`; add `evidence: ["changes"]` to the existing github catalog entry.

**Interfaces:**
- Consumes: `getInstallationToken(workspaceId)` (`packages/db-postgres/src/queries/github-app-token.ts`), workspace repos from the github connector row's `config.repos`.
- Produces: `githubAdapter` with `verbs: ["changes"]`: merged PRs (`GET /repos/{repo}/pulls?state=closed&sort=updated` filtered to `merged_at` in window) + workflow runs (`GET /repos/{repo}/actions/runs?created=window`) serialized one-per-line: `merged_pr #212 "fix pool sizing" merged_at=2026-07-29T14:02Z by=bensigo` / `actions_run deploy.yml conclusion=failure at=…`.

- [ ] **Step 1: Failing tests** with injected `fetch` fake (the house pattern — cores take transports): token missing → `unauthorized`; GitHub 500 → `upstream_error`; happy path lines include PR number and timestamps; window bounds respected.
- [ ] **Step 2 → FAIL. Step 3: Implement** (8s timeout, `User-Agent: agentrail-console`, mirror `packages/github-app` request hygiene). **Step 4 → PASS. Step 5: Commit** — `feat(console): github evidence adapter — merged PRs and Actions runs as changes`.

---

### Task 7: Console — railway connector + adapter (the first new-provider proof)

**Files:**
- Modify: `apps/console/app/(dashboard)/dashboard/[workspaceId]/connectors/components/connector-helpers.ts` — add `railway` entry (`type: "observability"` — new `ConnectorType` value + `CONNECTOR_TYPE_META` + `SECTION_ORDER` entry; `connectMethod: "secret"`; `capabilities: { evidence: ["changes","search_events"] }`), extend `validateConnectorCredential` (Railway tokens are UUIDs — validate with a UUID regex).
- Modify: `connectors-panel.tsx` — `KIND_ICON` + `KIND_TINT` entries; Create: `RailwayBrand` in `brand-icons.tsx`.
- Modify: `apps/console/app/api/v1/workspaces/[workspaceId]/connectors/secret/route.ts` — **derive** `CREDENTIAL_PROVIDERS` from the catalog: `new Set(CONNECTOR_CATALOG.filter(e => e.connectMethod === "secret").map(e => e.kind))` (removes the hand-enumerated literal — the spec's behavior-driving change).
- Modify: `apps/console/app/api/v1/workspaces/[workspaceId]/connectors/secret/verify.ts` — Railway live verify: `POST https://backboard.railway.com/graphql/v2` with `Authorization: Bearer <token>`, body `{"query":"query { me { id } }"}`; 200 with `data.me.id` → valid. **First implementation step: confirm endpoint + query against current Railway docs via the `use-railway` skill / context7 — do not trust this from memory.**
- Create: `apps/console/lib/evidence/railway.ts` + `railway.test.ts`; register; `deployments(projectId…)` GraphQL → `changes` (deploy id, status, createdAt, meta.commitSha), `deploymentLogs`/`environmentLogs` → `search_events`. The workspace's Railway project id lives in the connector row's `config` (add `railwayProjectId?: string` to `ConnectorConfig`; the connect card's expanded form gets a project-id input alongside the token — copy the `SecretManage` form shape).

**Interfaces:**
- Consumes: Task 4 registry/envelope; `getConnectorSecret(workspaceId, "railway")`.
- Produces: `railwayAdapter` (`changes` + `search_events`); catalog-driven allowlist (no more hand-listed providers for secret-based connect).

- [ ] **Step 1: Failing tests** — connector-helpers: railway validates only UUID-shaped tokens; secret route: PUT for `railway` accepted (allowlist now catalog-derived), PUT for `github` still rejected; adapter (fake fetch): missing secret → `config_missing`, missing projectId → `bad_request`, GraphQL error body → `upstream_error`, happy-path lines include deploy id + commit sha.
- [ ] **Step 2 → FAIL. Step 3: Implement** (verify Railway API shapes first, per above). **Step 4 → PASS**, plus run the existing connectors panel tests to confirm the exhaustive `Record<ConnectorKind,…>` maps compile. **Step 5: Commit** — `feat(console): railway connector — catalog-derived allowlist, live verify, evidence adapter`.

---

### Task 8: Jace — root investigation tools

**Files:**
- Create: `apps/jace/agent/lib/fetch_investigations.core.mjs`, `save_investigation.core.mjs`, `record_verdict.core.mjs`
- Create: `apps/jace/agent/tools/fetch_investigations.ts`, `save_investigation.ts`, `record_verdict.ts`
- Create: `apps/jace/test/fetch_investigations.core.test.mjs`, `save_investigation.core.test.mjs`, `record_verdict.core.test.mjs`
- Modify: `apps/jace/test/no-second-write-path.test.mjs` — add `"save_investigation.ts"` and `"record_verdict.ts"` to `UNGATED_ADVISORY_WRITES`.

**Interfaces:**
- Consumes: Task 3 wire contract; `fetch_briefs.core.mjs`/`save_brief.core.mjs` are the line-for-line templates (modes, degraded taxonomy, 10s timeout, never-throw, `hardenUntrusted` render caps, refusal rendering).
- Produces (tool input schemas, exact):

```ts
fetch_investigations({ mode: "anchor"|"list"|"get"|"search", slug?, query? })
save_investigation({ slug?, title?, symptomStatement?, symptomSignature?, affectedSurface?,
  severity?, firstSeenAt?, items?: Array<{ id?, kind, body?, mechanism?, state?,
  evidenceRefs?, data? }>, anchor?: boolean })          // NO verdict, NO status keys — genuinely absent
record_verdict({ slug, verdict: "root_caused"|"undetermined", confidence?,
  mechanismSummary?, missingEvidence?: string[] })
```

`record_verdict.core.mjs` also fire-and-forgets the Langfuse score: `POST {LANGFUSE_BASE_URL}/api/public/scores` `{ name: "investigation_verdict", value: verdict, dataType: "CATEGORICAL", sessionId, metadata: { investigation_id: String(id), slug } }` — copy the transport + single-`console.warn` failure funnel from `agent/hooks/langfuse-verdict-score.ts`.

- [ ] **Step 1: Failing core tests** (injected fetch fakes): `fetch_investigations` — `get`+404 → `{ok:true, investigation: undefined}` not degraded; eligibility relayed verbatim and rendered as `NOT eligible for record_verdict — <blocking…>`; every rendered string hardened. `save_investigation` — refusal arrays rendered as `REFUSED (human-locked): …`, `REFUSED (evidence immutable): …`, `REFUSED (hypothesis needs evidence): …`; pure anchor-clear needs no slug; core never throws on network error (degraded `unreachable`). `record_verdict` — 409 renders blocking reasons and does NOT push a score; 200 pushes exactly one score with string `investigation_id`.
- [ ] **Step 2 → FAIL** (`cd apps/jace && npm test` — confirm invocation against an existing core test first). **Step 3: Implement cores + thin `defineTool` wrappers** (session resolution `ctx.session.parent?.rootSessionId ?? ctx.session.id`; no `approval` key on any of the three). **Step 4 → PASS**, including the updated `no-second-write-path` test. **Step 5: Commit** — `feat(jace): investigation tools — fetch/save/record_verdict with refusal relay`.

---

### Task 9: Jace — the debugger: identity, mode union, evidence verb tools

**Files:**
- Modify: `apps/jace/agent/subagents/triage/instructions.md` — full rewrite to the debugging-specialist identity: role ("You are Jace's debugger…"), **run mode** section preserving today's protocol verbatim (bundle → cite only present sections → diagnosis), **deep mode** section (mission envelope in; fan out nested investigators; correlate; return `ROUND_REPORT`; propose — never adjudicate — hypothesis updates, each with evidence refs; report gaps honestly), untrusted-content section copied from qa's.
- Modify: `apps/jace/agent/subagents/triage/agent.ts` — description rewritten (routing text: "Jace's debugger: diagnoses failed runs (run mode) and executes production investigation rounds (deep mode)…"); `outputSchema: DEBUGGER_SCHEMA`.
- Modify: `apps/jace/agent/subagents/triage/lib/triage.core.mjs` — add the union:

```js
// TRIAGE_SCHEMA stays EXPORTED and FIELD-IDENTICAL (run-mode contract).
export const ROUND_REPORT_SCHEMA = { type: "object", additionalProperties: false,
  required: ["mode", "round_summary", "findings", "proposed_hypotheses", "evidence_gaps", "suggested_next"],
  properties: {
    mode: { const: "deep" },
    round_summary: { type: "string" },
    findings: { type: "array", items: { type: "object",
      required: ["claim", "evidence_refs"], properties: {
        claim: { type: "string" },
        evidence_refs: { type: "array", items: { type: "string" }, minItems: 1 } } } },
    proposed_hypotheses: { type: "array", items: { type: "object",
      required: ["statement", "mechanism", "proposed_state", "evidence_refs"], properties: {
        statement: { type: "string" }, mechanism: { type: "string" },
        proposed_state: { enum: ["open", "supported", "refuted", "inconclusive"] },
        evidence_refs: { type: "array", items: { type: "string" } },
        what_would_settle_it: { type: "string" } } } },
    evidence_gaps: { type: "array", items: { type: "string" } },
    suggested_next: { type: "string" } } };
export const DEBUGGER_SCHEMA = { oneOf: [
  { allOf: [ TRIAGE_SCHEMA, { type: "object", properties: { mode: { const: "run" } } } ] },
  ROUND_REPORT_SCHEMA ] };
```

  (Exact composition may need adjusting to how `TRIAGE_SCHEMA` declares `additionalProperties` — the regression test in Step 1 is the arbiter; if `allOf` fights `additionalProperties:false`, inline a copied-field variant instead, with a unit test asserting field-set equality with `TRIAGE_SCHEMA` so drift is impossible.)
- Create: `apps/jace/agent/subagents/triage/tools/fetch_changes.ts`, `tools/search_events.ts` + `apps/jace/agent/subagents/triage/lib/evidence_verbs.core.mjs` (shared core: one GET to `/api/v1/runner/evidence`, verb param, degraded taxonomy incl. `no_investigation`, hardened rendering; session = `parent.rootSessionId`).
- Modify: `apps/jace/agent/hooks/langfuse-verdict-score.ts` — score only when parsed output has `mode !== "deep"` (run-mode verdict scoring unchanged; deep rounds get no triage_verdict score).
- Create: `apps/jace/test/debugger-schema.test.mjs` — the regression pins.

**Interfaces:**
- Consumes: Task 4 evidence route; existing `fetch_run_evidence` (untouched); nested investigators arrive in Task 10 (deep-mode prompt references them by name: `change`, `anomaly`).
- Produces: `DEBUGGER_SCHEMA`/`ROUND_REPORT_SCHEMA` exports; verb tools callable by the debugger and (Task 10) copied cores for investigators.

- [ ] **Step 1: Write the regression pins first (failing):**

```js
test("run-mode output validates against DEBUGGER_SCHEMA unchanged", () => {
  const legacyRunOutput = { run_id: "123", diagnosis: "verify gate failed on pytest",
    what_was_tried: "…", blocking_reason: "", suggested_next_action: "…",
    evidence_refs: [{ source: "failure_events", quote: "…" }] };  // copy a REAL fixture from existing triage tests
  assert.ok(validate(DEBUGGER_SCHEMA, legacyRunOutput));           // no mode field required for run outputs
});
test("verdict-score hook still scores run-mode and skips deep-mode", () => { /* feed both through the hook's parse path */ });
```

- [ ] **Step 2 → FAIL. Step 3: Implement** schema union + instructions rewrite + verb tools + hook guard. **Step 4 → PASS** including ALL existing triage tests untouched. **Step 5: Commit** — `feat(jace): triage becomes the debugger — mode union schema, evidence verbs, identity rewrite`.

---

### Task 10: Jace — nested mission investigators (change, anomaly)

**Files:**
- Create: `apps/jace/agent/subagents/triage/subagents/change/{agent.ts,instructions.md}`, `…/change/lib/change.core.mjs` (CHANGE_SCHEMA), `…/change/tools/` (fetch_changes.ts + 10 `disableTool()` sentinels)
- Create: `apps/jace/agent/subagents/triage/subagents/anomaly/{agent.ts,instructions.md}`, `…/anomaly/lib/anomaly.core.mjs` (ANOMALY_SCHEMA), `…/anomaly/tools/` (fetch_changes.ts, search_events.ts + sentinels)
- Create: `apps/jace/test/investigator-schemas.test.mjs`

**Interfaces:**
- Consumes: Task 9's `evidence_verbs.core.mjs` (copy into each investigator's `lib/` — Eve subagents share nothing; typed helpers are duplicated per the framework's own guidance, with a test asserting the copies stay in sync via content hash).
- Produces:

```js
export const CHANGE_SCHEMA = { type: "object", additionalProperties: false,
  required: ["candidates", "degraded"], properties: {
    candidates: { type: "array", items: { type: "object",
      required: ["what", "at", "why_relevant", "evidence_refs"], properties: {
        what: { type: "string" }, at: { type: "string" },
        why_relevant: { type: "string" },
        evidence_refs: { type: "array", items: { type: "string" }, minItems: 1 } } } },
    degraded: { type: "array", items: { type: "string" } } } };
export const ANOMALY_SCHEMA = { type: "object", additionalProperties: false,
  required: ["deviations", "signatures", "normal_surfaces", "first_deviation", "degraded"],
  properties: {
    deviations: { type: "array", items: { type: "object",
      required: ["where", "shape", "evidence_refs"], properties: {
        where: { type: "string" }, shape: { type: "string" },
        evidence_refs: { type: "array", items: { type: "string" }, minItems: 1 } } } },
    signatures: { type: "array", items: { type: "string" } },
    normal_surfaces: { type: "array", items: { type: "string" } },
    first_deviation: { type: "string" },
    degraded: { type: "array", items: { type: "string" } } } };
```

- `agent.ts` shape: copy `subagents/triage/agent.ts`'s `chooseModel` pattern; `change` uses the default gateway model; `anomaly` uses the default too (haiku override only if execution shows it suffices — do not pre-optimize).
- Instructions: mission-scoped ("You answer ONE question handed to you…"), evidence-refs-required discipline (every claim cites), degraded honesty (report `no_provider` gaps verbatim), untrusted-content section copied from qa's.

- [ ] **Step 1: Failing schema/content tests**: schemas validate fixtures; every claim-bearing array requires `evidence_refs` minItems 1; sentinel completeness (each `tools/` dir default-exports `disableTool()` for exactly the harness list minus kept tools — copy the existing sentinel-count test pattern from `apps/jace/test/`); instructions contain "answer ONE question" and never contain a provider name (grep-style content assertions like `skills.test.mjs`).
- [ ] **Step 2 → FAIL. Step 3: Implement. Step 4 → PASS. Step 5: Commit** — `feat(jace): nested change+anomaly investigators under the debugger`.

---

### Task 11: Jace — debug skill, playbooks, instructions.md section

**Files:**
- Create: `apps/jace/agent/skills/debug/SKILL.md` (root flow grammar)
- Create: `apps/jace/agent/subagents/triage/skills/discipline/SKILL.md` + `apps/jace/agent/subagents/triage/skills/playbooks/SKILL.md` with `references/regression-after-deploy.md`, `references/latency-creep.md`, `references/cannot-reproduce.md`
- Modify: `apps/jace/agent/instructions.md` — add `## Debugging (fetch_investigations / save_investigation / record_verdict)` section after the Briefs section
- Modify/Create: `apps/jace/test/skills.test.mjs` additions (or sibling `debug-skill.test.mjs`)

**Interfaces:**
- Consumes: everything prior; `skills/grill-me/SKILL.md` is the structural template (resolution-first ordering, autosave discipline, refusal relay).
- Produces: the root `debug` skill with pinned section order:
  1. `## Investigation resolution (before anything else)` — `fetch_investigations(mode:"anchor")` first always; then `search` on the human's words + symptom signature; confirm-once ("continue INV `checkout-500s`, or is this new?"); reopen-vs-new rule verbatim from the spec (undetermined+returns → reopen; concluded+fix-shipped+returns → new + `recurrence_of` link via `save_investigation` items? — links are server-written on… **correction**: v1 writes `recurrence_of` via a `data` field on save: add `links?: [{ targetSlug, role }]` to `save_investigation`'s schema in Task 8 and route in Task 3 — see Self-Review note S1).
  2. `## Witness interview` — verbatim symptom capture, first-seen, blast radius (and who is NOT affected), repro, severity → depth budget; never paraphrase into `symptom_statement`.
  3. `## Stabilize check` — one mitigation question before diagnosis; deploy-correlated → surface rollback immediately; advisory only.
  4. `## Rounds` — mission envelope contents (phase, window, capability map, ledger digest, playbook extract); dispatch the debugger; persist its round report via `save_investigation` deltas (findings → `finding` items, proposed hypotheses → `hypothesis` items with refs, gaps → `timeline_event` note); autosave between rounds; hard rules (recurrence before evidence; change sweep first; hypothesis-test missions only for ledgered hypotheses).
  5. `## Verdict` — relay `eligibility` verbatim, never self-derive; `record_verdict` refusals relayed; undetermined is honest and durable.
  6. `## Handoff` — mitigative vs preventative issues via gated `create_issue`, one approved call per issue; qa fix-verification dispatch after a mitigative fix ships; lesson candidates drafted, promotion is console-only.
  7. `## Capability voice` — capability-first rendering ("I can inspect deployments (GitHub, Railway)"), gaps voiced at most twice, providers never the subject of a sentence.
- instructions.md section: when to load the skill (incident-shaped messages), mode guidance (run-scoped → debugger run mode; recurrence/production/failed-quick-diagnosis → open investigation), qa boundary, and the qa-advisory→investigation seeding rule.

- [ ] **Step 1: Failing content assertions** (the #1498 pattern — `apps/jace/test/skills.test.mjs:117-239` style): must contain `fetch_investigations(mode: "anchor")` before any other tool mention; must instruct relaying `eligibility` verbatim and must NOT instruct re-deriving readiness; must not offer "defer" as an exit for an open hypothesis; playbook files exist and each names ≥ 1 discriminating test; instructions.md section contains the mode guidance and the words "capability-first".
- [ ] **Step 2 → FAIL. Step 3: Write the skill/playbooks/section. Step 4 → PASS. Step 5: Commit** — `feat(jace): debug skill + debugger playbooks + instructions routing`.

---

### Task 12: Console — investigation issue-link stamping at the approval seam

**Files:**
- Modify: `apps/console/app/api/v1/runner/approvals/route.ts` — where `enrichCreateIssueToolInput` already injects the server-computed `_brief`, additionally: if the requesting session has `anchored_investigation_id`, stamp `_investigation: { id, role }` (role from the issue draft: body containing the string `Mitigation` section marker → `mitigative`, else `preventative`; the debug skill's issue drafts carry an explicit `Role: mitigative|preventative` line in `requiredContext` — parse that, default `preventative`).
- Modify: the approval-execution path that runs after approve (follow `stampCreatedIssueUrl` in `apps/jace/agent/lib/create_issue.core.mjs` and the console's approve flow) — after issue creation succeeds, call `linkInvestigationIssue(db, investigationId, repo, issueNumber, role)`.
- Create/extend co-located route tests.

**Interfaces:**
- Consumes: Task 2 `linkInvestigationIssue`, `getSessionInvestigationAnchor`; existing `_brief` injection guard (`INJECTION GUARD` at approvals route:99 — model-supplied `_investigation` must be stripped the same way).
- Produces: `investigation_issue_links` rows written server-side, never model-asserted.

- [ ] **Step 1: Failing tests**: model-supplied `_investigation` in tool_input is stripped; anchored session + approved create_issue → link row with parsed role; unanchored session → no row, no error.
- [ ] **Step 2 → FAIL. Step 3: Implement. Step 4 → PASS. Step 5: Commit** — `feat(console): stamp investigation issue links server-side at the approval seam`.

---

### Task 13: Console UI — investigations surface + human gates

**Files:**
- Create: `apps/console/app/(dashboard)/dashboard/[workspaceId]/investigations/page.tsx` (index: title, `/slug`, severity pill, status pill, verdict pill, red `N open hypotheses` count, relative `updatedAt` — copy the briefs index shape)
- Create: `…/investigations/[slug]/page.tsx` (detail: eligibility banner green/red mirroring the briefs readiness banner; ledger grouped by kind in order `timeline_event, evidence, hypothesis, finding, verdict, lesson_candidate`; evidence items render provider/verb/query + excerpt in a `<pre>`; hypothesis cards show state + mechanism + linked refs)
- Create: `…/investigations/components/{badges.tsx,confirm-verdict.tsx,promote-lesson.tsx,investigations-format.ts}`
- Create: `apps/console/app/api/v1/workspaces/[workspaceId]/investigations/[slug]/confirm/route.ts` — `POST` owner/admin: sets `data.humanConfirmed = true` on the latest `verdict` item (via a new tiny query `confirmVerdictAsHuman(db, investigationId)` added to `queries/investigations.ts` with test).
- Create: `…/investigations/[slug]/promote/route.ts` — `POST` owner/admin body `{ itemId }`: copies a `lesson_candidate` item into workspace memory using the same server-side insert path the memory seeding uses (find it via the `runner/workspace-memory` GET's query module; reuse its insert query — do NOT add a Jace-side write).
- Co-located `route.test.ts` for both actions; component-level render tests only if the briefs pages have them (mirror).

**Interfaces:**
- Consumes: Task 2 queries; `briefs/` page + components as 1:1 templates; sidebar nav (`apps/console/app/components/sidebar-nav.ts` — add `{ label: "Investigations", href: "investigations", icon: SearchCode }` in the Engine room zone next to Briefs; add breadcrumb label).
- Produces: the human confirmation gate (`humanConfirmed`) that the knowledge loop and calibration read.

- [ ] **Step 1: Failing route tests** — confirm: member (non-admin) → 403; owner flips `humanConfirmed`; promote: rejects non-`lesson_candidate` items with 400; creates exactly one memory item; second promote of same item → 409.
- [ ] **Step 2 → FAIL. Step 3: Implement pages + actions. Step 4 → PASS.**
- [ ] **Step 5: Browser-verify** with the `verify-console-ui` skill (mint session row + cookie): index renders a seeded investigation; detail shows the red eligibility banner and the ledger groups; confirm button flips state.
- [ ] **Step 6: Commit** — `feat(console): investigations UI — ledger view, eligibility banner, confirm + promote gates`.

---

## Self-Review

**S1 (fixed inline above):** the spec's `recurrence_of`/`related` links needed a writer on the Jace path — added `links?: [{ targetSlug, role }]` to `save_investigation` (Task 8 schema) and the save route (Task 3): the route resolves `targetSlug` → id within the same workspace and calls `linkInvestigations`; unknown target slug → the link is skipped and reported in a `skippedLinks` array (never a hard failure). Task 3's tests must cover it; Task 8's refusal rendering includes `REFUSED (link target not found): …`.

**Spec coverage check:** methodology → T11 skill; capability layer + envelope + no_investigation → T4; behavior-driving catalog → T7 (allowlist derivation) + T4 (registry); factory/github/railway → T5/T6/T7; debugger identity + modes + regression pins → T9; nested investigators → T10; artifact + guards + eligibility + FTS + anchors → T1/T2; routes + fail-closed verdict → T3; issue links server-side → T12; UI + confirm + promote (knowledge loop, Jace stays memory-read-only) → T13; Langfuse `investigation_verdict` → T8; `intent:debugging` trace tag → **covered in T11's instructions.md section?** No — tags are stamped in `agent/lib/instrumentation.core.mjs`'s intent tagging; add to T9 Step 3: extend the existing intent-tag values with `intent:debugging` when the debug skill is loaded, mirroring how `intent:capable` is stamped, with one test in `instrumentation.test.mjs`. QA handoffs → T11 (skill prose; no new infra per spec). Escalation seeding (run-mode diagnosis → finding item) → T11 §4 prose. Out-of-scope items confirmed absent: signals/traces verbs ship in types (T4) but no adapters; hypothesis/probe vessels absent; alert door absent; defineDynamic absent.

**Type consistency check:** `evidence_refs` (snake) in Jace JSON schemas vs `evidenceRefs` (camel) in Drizzle/TS — the wire contract (Task 3 route) accepts camelCase `evidenceRefs` from `save_investigation`; Task 8's core maps the model-facing `evidence_refs` → wire `evidenceRefs`. Task 8 Step 3 must include that mapping and its test. Degradation taxonomy string set identical in T4 types and T8/T9 cores. `ROUND_REPORT` naming consistent across T9/T11.

## Execution

Per the user's standing instruction: subagent-driven execution — the coordinator (this session) dispatches one Sonnet 5 subagent per task with review between tasks (superpowers:subagent-driven-development). Task order is the dependency order above; T5/T6/T7 may run as a small parallel wave after T4 (cap 3, distinct files); everything else is sequential. Each task lands as its own branch + PR onto `main`, store tasks first.
