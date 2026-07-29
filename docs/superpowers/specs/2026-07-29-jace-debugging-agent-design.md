# Investigation — triage grown to production incidents

Status: design. v1 cut in "Out of scope". Epic + slices to be filed via
`to-issues` against this spec.

## Problem

Debugging is one of the highest-leverage engineering workflows, and Jace can
only do the smallest case of it. The only evidence read in the whole agent is
`fetch_run_evidence`, scoped to one factory `run_id` through one console
endpoint — triage explains why a *run* failed, because that is the only
evidence it has. Nothing explains why *production* is misbehaving: no deploy
history, no logs, no metrics, no traces, no way to correlate a symptom with
the change that caused it. When production breaks, the human debugs alone and
Jace — the agent that shipped the change — has nothing to say.

**This spec is not a new sibling capability.** It is what triage becomes:
investigation of why something is failing, grown from run-scoped diagnosis to
production incidents, with logs, deploy history, metrics, traces, recurrence,
and a durable artifact. Investigating a failed run remains the smallest case
of the same capability (see "One capability, two tiers"). qa stays distinct —
qa verifies what shipped; investigation explains why something fails.

The trap in fixing this is integration-first thinking: bolt on Sentry, bolt on
Datadog, and let the model freestyle over whatever comes back. The research
record on AI debugging agents is unambiguous about how that fails: confident
hallucination of root causes, symptom/cause conflation, recency bias, and —
worst — wrong RCAs laundered into institutional memory. The systems that work
(and the human craft they encode: Google SRE's hypothetico-deductive loop,
mitigate-first doctrine, Allspaw's critique of single-root-cause narratives)
all share one property: **the methodology is the architecture; the data
sources are interchangeable suppliers to it.**

Two design principles follow, and everything below serves them:

1. **Methodology drives; connectors supply.** Adding a provider adds evidence,
   never complexity: one adapter + one capability declaration. No new agents,
   no new prompts, no new investigation logic.
2. **Incorrect conclusions must be structurally difficult.** The server checks
   structure; the human confirms truth. The model cannot talk itself past
   either.

## The methodology

Every investigation follows one loop regardless of which providers exist.
Phases 3–6 iterate until the verdict bar is met or the depth budget is spent.

1. **Intake — the witness interview.** Root-led and conversational; the human
   is an evidence source. Capture the symptom in the reporter's verbatim words
   (never paraphrased into a premature diagnosis), first-seen time, blast
   radius (who is affected *and who is not*), reproduction if known, severity.
   Severity sets the depth budget.
2. **Stabilize check.** Before diagnosis, one question: is this bleeding badly
   enough to mitigate first (rollback / flag off / restart)? If a deploy
   correlates with first-seen, rollback is surfaced immediately. Advisory
   only — Jace proposes mitigations, never executes them.
3. **Timeline + what-changed sweep.** Recurrence check first (search past
   investigations by symptom signature), then reconstruct the window: deploys,
   merged PRs, config/flag changes, migrations, dependency bumps. Change is
   the ~70% prior (Google SRE); it is always swept before log-diving.
4. **Symptom localization.** RED/USE-style triage across configured providers
   in the window: which layer/service/route deviates, what signatures, which
   signal moved *first*, and a differential cut — what separates the bad
   cohort from the good one.
5. **Hypothesis ledger.** Enumerated competing hypotheses, each carrying a
   statement, a **mechanism** (how it would produce this symptom), the
   discriminating evidence needed, and a state:
   `open | supported | refuted | inconclusive`. Branching, not a why-chain.
   The ledger must either hold ≥ 2 live hypotheses at some point or record why
   only one was ever plausible (recency-bias guard).
6. **Discriminating tests.** For the leading hypothesis: the cheapest
   observation whose outcome distinguishes it from rivals — a specific query,
   not "more logs". Prior investigations' verdicts enter here **as hypotheses
   to test, never conclusions to adopt**.
7. **Verdict with receipts.** Either a causal narrative — mechanism chain,
   contributing factors (plural is legitimate), confidence tier, the refuted
   list, full evidence index — or an honest **`undetermined`**, a first-class
   durable outcome that parks with a non-empty "what evidence would settle
   this" list.
8. **Handoff.** Findings become house-format issues through the existing gated
   `create_issue`, split `mitigative` (closes this incident) vs `preventative`
   (addresses the class). Lessons reach workspace memory only through the
   human-gated promotion flow (below), never automatically.

The discipline is deliberately **model-independent**: it lives in the debug
skill, the investigator prompts and output schemas, and the route-enforced
gates — not in model choice. (The strongest empirical datapoint in the prior
art: the same model jumped a full point on a 5-point RCA accuracy scale when
handed encoded runbooks — methodology beats model tier.) Swapping the bound
model changes fluency, never the process.

## Architecture

```
Console connectors        (credentials, catalog, owner/admin managed)
        ↓
Evidence capability layer (typed verbs, adapters, envelope — console seams)
        ↓
Investigator subagents    (mission-typed, advisory-only, isolated)
        ↓
Root agent — investigation flow (interview, ledger, reasoning, verdict, handoff)
        ↓
Investigation artifact    (durable source of truth; the conversation is not)
        ↓
Human-confirmed knowledge (episodic always; semantic only through the gate)
```

Knowledge boundaries, pinned:

- **Skills teach Jace how to think.** The methodology and playbooks are
  procedural knowledge, loaded on demand, versioned in git.
- **Subagents give Jace isolated execution.** They exist for four properties
  only they provide: context isolation (evidence bulk never enters root),
  tool isolation (evidence verbs attach only to investigators), model tier
  selection, and `outputSchema` structured-advisory contracts. Same trust
  shape as qa/triage/reviewer: purely advisory, write nothing.
- **Providers supply evidence.** The debugging system never knows whether
  evidence came from Datadog, Grafana, Sentry, or Railway.

## Evidence capability layer

### Verbs, not vendors

A provider implements whichever of a small set of typed query verbs it
supports:

| verb | answers | v1 providers |
|---|---|---|
| `changes(window, scope)` | deploys, merges, flags, config, migrations | github, railway, factory |
| `search_events(window, query)` | log/event search + signatures | railway, factory |
| `signals(window, scope)` | RED/USE summaries: error rate, latency, saturation | — (post-v1) |
| `traces(window, filter)` | exemplar traces, slow spans | — (post-v1: langfuse) |
| `probe(target)` | active reproduction (browser/API) | — (post-v1: sidecars) |

Verb semantics are provider-agnostic; adapters translate. A verb with no
configured provider returns a typed degradation (`no_provider`), which the
investigation records as an **evidence gap** — feeding honest `undetermined`
verdicts and a conversational connect-nudge ("connect a metrics provider and
I can localize this further").

Placements for the wider provider set, so the mapping is never invented
per-provider later: deployments and CI/CD (GitHub Actions, Vercel, Railway)
→ `changes` (+ `search_events` for run/build logs); errors (Sentry) →
`search_events` + `signals`; edge/network (Cloudflare) → `signals` +
`search_events`; metrics (Datadog, Grafana, Prometheus) → `signals`; LLM
traces (Langfuse) → `traces` (+ `signals`).

### Capability-first self-model

Jace never thinks "I have a Datadog connector"; it thinks "I can inspect
metrics." Pinned as a rendering rule, not a hope: the capability map handed
to root (and echoed to the user at intake) is **capability-first, provider
as parenthetical attribution** — "I can inspect deployments (GitHub,
Railway); logs (Railway); metrics (none — see gaps)". The map also includes
Jace's **native capabilities** so the self-model is complete: comparing
historical incidents (recurrence search over investigations) and creating
engineering issues (`create_issue`) appear alongside connector-derived
verbs. Chat voice follows the same rule; provider names appear only as
attribution on evidence, never as the subject of a sentence.

**Nudge discipline:** a capability gap is voiced at most twice — once in the
intake capability summary, and once when it concretely blocks a step
("cannot localize latency without metrics — connect Grafana or Datadog and
this narrows fast"). Always recorded as an evidence gap on the artifact;
never repeated beyond those two moments.

### The capability declaration becomes behavior-driving

Today `CONNECTOR_CATALOG.capabilities` is display-only; every runtime
equivalent is a hand-enumerated literal (`CREDENTIAL_PROVIDERS`,
`MCP_PROVIDERS`, per-provider `secretConfig()` calls) — five-plus coordinated
edits per provider. Evidence reverses that: catalog entries gain
`capabilities.evidence: [verbs]`, and the UI, the secret-route allowlist, and
the discovery endpoint all **derive** from the one declaration. Adding a
provider is: catalog entry + adapter module + credential format/live-verify
pair. Nothing else.

Capabilities stay orthogonal to `ConnectorType` (Linear already carries
`tools` alongside issue-source). Observability providers get a display
section; grouping is presentational only. Connector rows, encrypted secret
storage (`connectors.secret`, AES-256-GCM), write-only masking, owner/admin
management, and the two-gate connect flow (format check + live credential
verification) are reused unchanged. Known pre-existing risk, noted not
solved here: `CONNECTOR_SECRET_KEY` has no rotation support; a growing
credential catalog raises its blast radius.

Discovery is **server-derived** — catalog declarations ∩ workspace connector
rows (enabled, credentialed) — never model-asserted, and the response nests a
family level from day one: `{ evidence: { changes: ["github","railway"],
search_events: ["railway"] } }`. `evidence` is the first capability family;
`knowledge` (the approved-direction context-source registry) and `probe` slot
in later as sibling families. The generic platform is deliberately **not**
built now — the family nesting is the only speculative generality, and it
costs one JSON level.

### The envelope seam

```
provider API
  ↓ adapter (per provider): auth, verb→API mapping, mandatory time window,
    provider-side result limits
  ↓ envelope seam (shared, in code not prompts):
    1. secret scrub        (scanForSecrets / boundEvidence lineage)
    2. size caps           (bounded excerpt — 16KB / 200-line discipline)
    3. injection hardening (hardenUntrusted; log lines are attacker-writable
                            text and are rendered inert, always)
    4. provenance + persist (evidence_ref id; provider, verb, query params,
                            excerpt, digest, captured_at — written to the
                            investigation ledger BY THE ROUTE at capture time)
  ↓ investigator: correlates envelopes, returns summary + refs
  ↓ root: ledger reasoning over refs; raw payloads never enter root context
  ↓ console UI: the human can see exactly what Jace saw
```

Three concerns, three homes: **caps and safety are structural** (the seam),
**relevance is judgment** (the investigator), **budget is governance** (root's
depth budget from severity). Because the route persists evidence at capture
time, evidence survives compaction and channel switches without the model
relaying anything, and every `evidence_ref` in the ledger is dereferenceable
later — by a resumed session, another engineer, or an auditor. Evidence is
also *re-derivable*: the ref stores the query that produced it.

## Investigator subagents

Mission-typed, never source-typed. **Investigators answer questions; providers
supply evidence.** A per-provider agent roster (Sentry agent, Datadog agent,
…) would push cross-source correlation — the actual debugging — back into
root and grow the roster with every integration. Four missions are the stable
set; each is defined by a question whose answer-shape is fixed, so providers
change the answer's resolution, never its shape:

- **`change`** — *"What changed in this window that could plausibly affect the
  failing surface?"* Assembles and relevance-ranks the candidate-change set
  across every change-shaped source, using the repo wiki's system model to
  rank plausibility. Returns ranked candidates with refs.
- **`anomaly`** — *"Where and when does the system deviate from baseline, and
  what is the deviation's shape?"* RED/USE triage, differential cuts,
  signature extraction, first-deviation ordering. Returns a localization map,
  signatures, and explicitly-normal surfaces (who is *not* affected is
  evidence too).
- **`hypothesis`** (post-v1 vessel) — *"Does hypothesis H, with mechanism M,
  survive discriminating test T?"* Strict verdict discipline:
  `supported | refuted | inconclusive` + what-would-settle-it. May report
  surprise observations as suggested hypotheses; never adjudicates them.
  Parallel dispatch of several is the branching.
- **`probe`** (post-v1 vessel) — *"What does the live system actually do,
  right now, when exercised?"* The only **active** investigator (it touches
  the system), hence separate: its own guardrail prompt (QA's "report only
  what you observed", GET-only defaults, never credentials, never destructive
  flows) and the browser sidecar connections attach only here.

All four are declared Eve subagents (`agent/subagents/<name>/`) in the
established shape: `outputSchema` task mode, `disableTool()` sentinels
stripping the default harness, thin authored tools over shared `lib/*.core.mjs`
cores, purely advisory. **Root's autosave is the only model-side artifact
writer; the evidence route is the only server-side one.** Deliberately not
investigators: the recurrence check (one FTS call), the witness interview,
hypothesis generation, timeline assembly, and the verdict — root's
non-delegable reasoning. The agent that never met the witness cannot own the
conclusion.

## Coordination — who decides what runs

**Root decides, dynamically, every dispatch.** There is no workflow engine;
the model reasons over the process. Three layers keep that disciplined:

- The **debug skill defines the grammar**: hard rules, few and checkable.
  Recurrence check before external evidence. Change sweep first once a window
  exists (cheapest, highest prior). Hypothesis-test missions only for
  hypotheses already in the ledger. Every dispatch's mission names the
  question, the window, and the capability map. Autosave between dispatches.
- **Playbooks bias openings, never script.** Named recipes for recurring
  incident shapes ("regression-after-deploy", "latency-creep",
  "cannot-reproduce") ship as reference files under the debug skill and map
  shapes to mission compositions — which investigators, which verbs
  emphasized, which discriminating tests have historically settled this
  shape. A playbook shapes the mission prompt; the roster never changes.
  Eve's `defineDynamic` is the later graduation path to per-workspace
  playbooks; not built in v1.
- **The artifact is the program counter.** Root chooses the next dispatch by
  reading the ledger (open hypotheses, evidence gaps, budget spent), so a
  killed turn, a compaction, or a channel switch resumes mid-loop from the
  artifact — resumability comes from state, not from an engine.

Parallelism is Eve-native: multiple investigator calls emitted in one
response run concurrently (fan-out is the documented batch behavior;
`change` + `anomaly` sweep together, hypothesis tests fan out per live
hypothesis later). Investigators sit at depth 1 of the default depth cap 3.

## One capability, two tiers — what happens to triage

Investigation is one capability at two maturity/cost tiers, not two concepts:

- **Fast tier — run diagnosis.** Today's `triage` subagent, one-shot and
  cheap: "why did run 123 fail?" → bundle → diagnosis in seconds. **v1 does
  not modify it.** It is live, calibrated (#1204 verdict scores), and wired
  into run-outcome replies; the deep tier lands beside it, not through it.
- **Deep tier — production investigation.** Everything in this spec: durable
  artifact, evidence layer, mission investigators, verdict gates.

Three seams join the tiers in v1:

- **The factory becomes an evidence provider.** An internal, always-on,
  credential-less `factory` adapter exposes what the failure bundle already
  holds — runs and their attempted changes → `changes`; `failure_events` +
  run timeline → `search_events`. A production investigation can then cite
  "run 123 deployed PR #212 at 14:02 and its verify gate failed" like any
  other evidence, through the same envelope.
- **Escalation is a typed handoff.** When a run failure recurs, looks
  production-impacting, or resists one-shot diagnosis, root offers to open an
  investigation; the triage diagnosis enters the ledger as a cited `finding`
  with its `evidence_refs` and provenance — the same shape as the qa handoff.
- **Routing prose becomes tier guidance.** The instructions boundary is not
  "triage vs debugging" but one rule: run-scoped question → fast tier;
  recurrence, production impact, or a failed quick diagnosis → escalate to
  the deep tier.

**Convergence (planned, post-v1):** once investigations are proven, the fast
tier is re-implemented as an auto-opened lightweight investigation
(`opened_by: run-outcome`, derived slug, low severity, no witness interview —
the bundle IS the witness statement), run diagnoses start compounding in the
episodic layer, and the standalone `triage` subagent is re-missioned or
retired. That step is named here so it is an evolution, not drift — but it
touches a live calibrated path, so it waits for the deep tier to earn trust.

## Investigation artifact

One investigation per **incident**, not per report. Intake runs the brief
discipline: `fetch_investigations(mode:"anchor")` first always; then FTS
search over symptom signatures; confirm-once with the human ("this sounds
like INV `checkout-500s` — continue it, or new?"); anchor on the
`jace_sessions` row; re-confirm on drift. Never silently attach, never
silently fork.

**Reopen vs new, pinned:** prior ended `undetermined` and the symptom returns
→ **reopen** (its missing-evidence list just got answered). Prior `concluded`,
fix shipped, symptom back → **new investigation + `recurrence_of` link** — the
link lands on the old investigation and structurally discredits its verdict
(no one has to remember to distrust it).

**Mutability, pinned:** evidence items are **immutable** (insert-only, written
solely by the evidence route; `save_investigation` cannot create, modify, or
delete `kind: evidence` items). Hypotheses are **mutable state machines** with
route-enforced transition guards. Verdicts are **append-only** items (current
one denormalized on the row); reopening never erases history.

**The verdict gate — `computeVerdictEligibility`,** the `computeBriefReadiness`
analog. `record_verdict(root_caused)` is refused unless, structurally:

- ≥ 1 hypothesis in `supported` state, with non-empty `mechanism` and ≥ 1
  linked evidence ref;
- ≥ 1 rival hypothesis `refuted` with its own evidence ref, **or** an explicit
  sole-plausible rationale (a `finding` item with `data.solePlausible: true`);
- a confidence tier (`confirmed | probable | circumstantial`) supplied.

`undetermined` has its own bar: a non-empty missing-evidence list. Eligibility
is computed server-side, relayed verbatim, never re-derived in prompts, and
**absence fails closed** — the same doctrine as the briefs readiness gate. The
server checks structure; the human confirms truth (below). Additional route
invariants, enforced in code not prompts: a hypothesis cannot enter
`supported`/`refuted` without a linked evidence ref; items with
`authority: human` are never overwritten by `save_investigation` (a human's
"it's not the DB" is pinned); `save_investigation` rejects any
verdict/status field outright with a 400 — verdicts travel only through
`record_verdict`.

## Root tools and flow

- `fetch_investigations({ mode: anchor|list|get|search, slug?, query? })` —
  mirrors `fetch_briefs` exactly (same modes, same degraded taxonomy, 404 on
  `get` = "none yet", not an error). `get`/`anchor` attach `eligibility`
  verbatim.
- `save_investigation({ slug?, title?, symptom?, severity?, window?, items?,
  anchor? })` — ungated delta autosave, the `save_brief` twin: per-item
  patches, refusal arrays relayed in plain language
  (`REFUSED (human-locked)`, `REFUSED (evidence immutable)`,
  `REFUSED (hypothesis needs evidence)`).
- `record_verdict({ slug, verdict, confidence?, mechanismSummary?,
  missingEvidence? })` — ungated but server-validated: the eligibility check
  IS the gate. Appends a verdict item; never edits one.
- **Handoff** reuses gated `create_issue` unchanged. The approvals seam
  already server-enriches `create_issue`; it additionally stamps an
  investigation link (role `mitigative | preventative`, from the issue
  draft's stated intent) keyed on the session's **anchored investigation** —
  server-side, never model-asserted. This wiring ships in v1 because
  `brief_work_links` proved that an unwired link table stays dead.
- The root `instructions.md` gains an Investigation section: load the `debug`
  skill for incident-shaped messages; tier guidance — run-scoped question →
  fast tier (`triage`), escalating to a full investigation on recurrence,
  production impact, or a failed quick diagnosis; shipped change needs
  checking → qa.

## Knowledge growth — three layers, two speeds, one gate

Debugging is designed as a **compounding capability** over three deliberately
distinct knowledge layers, each with a pinned consult-point and growth rule:

| layer | what | consulted | grows by |
|---|---|---|---|
| **Structural** | repo wiki + architecture (system model) | intake preflight; `change` investigator's relevance-ranking | wiki compilation (existing; unchanged here) |
| **Semantic** | confirmed lessons in workspace memory | intake preflight (`fetch_workspace_memory`) | human-gated promotion ONLY (below) |
| **Episodic** | every investigation, searchable, permanent | recurrence check; refuted-hypothesis and test-recipe transfer | automatically, per investigation |

None substitutes for another: the wiki explains how the system is built,
memory holds what the team has confirmed to be true, and investigations hold
what actually happened. An investigation naturally touches all three.

**Episodic (automatic, safe by construction).** Every investigation compounds
retrieval-side with zero ceremony: recurrence FTS finds it; refuted
hypotheses transfer and are never re-litigated; test recipes are reusable;
prior verdicts enter new ledgers as hypotheses with provenance. Wrong
conclusions are contained here: unconfirmed, and auto-discredited by any
future `recurrence_of` link.

**Semantic (human-gated; Jace never writes it).** Verdict recorded → human
confirms it (console, owner/admin) → Jace drafts typed `lesson_candidate`
items (`causal-pattern | test-recipe | system-gotcha`) → **the human promotes
each candidate from the console** into workspace memory. Workspace memory
stays exactly as read-only to Jace as #1220 made it — no new model-side write
path exists at all.

**Measurement.** Traces tagged `intent:debugging`; investigator advisories
scored through the existing verdict-score hook; `record_verdict` pushes an
`investigation_verdict` categorical score with `investigation_id` (string) in
metadata as the offline join key — the #1204/#1205 calibration pattern.
Fix-holds / reopen-rate calibration is the later offline job; the scores land
in v1 so it has data.

## QA ↔ Investigation collaboration

Not silos, not a merger. The boundary stays crisp — **qa judges what a run
shipped; investigation explains why something is failing** — and collaboration
happens through root and the artifact, never agent-to-agent. Two typed
handoffs, both riding existing machinery (qa dispatch, run-outcome channel,
`finding` items), both v1:

- **QA finding → investigation.** A qa advisory surfacing a production
  defect can seed an investigation: root offers to investigate, and the
  advisory enters the ledger as a `finding` item carrying the advisory's
  `evidence_refs` and Langfuse `callId` provenance in `data` — citable by
  hypotheses like any other item. The witness interview starts pre-populated
  with observed behavior instead of from zero.
- **Fix verification → investigation.** When a `mitigative` issue's fix
  ships (the run-outcome notification already reaches the anchored
  conversation), root dispatches qa with the investigation's discriminating
  test as the verification target ("confirm checkout no longer 500s under
  X"). The qa verdict lands on the investigation as a `finding`: pass →
  fix-verified; fail → the investigation stays open and the failed
  verification is new evidence. This is what makes fix-holds calibration
  measurable rather than aspirational.

Tool sharing is config, not coupling: the post-v1 `probe` investigator uses
the same browser sidecar connections as qa with a different mission and
schema.

## Eve/Jace fit (file-level)

- Skill: `apps/jace/agent/skills/debug/SKILL.md` + `references/<playbook>.md`,
  loaded via `load_skill` — grill-me's sibling.
- Subagents: `apps/jace/agent/subagents/{change,anomaly}/` (v1), each with
  `agent.ts` (description-routed, `outputSchema`), `instructions.md`,
  `lib/*.core.mjs` schemas + pure logic, `tools/` = verb wrappers +
  `disableTool()` sentinels. Directory name = tool name; no collisions with
  authored tools.
- Evidence tools send `ctx.session.parent?.rootSessionId ?? ctx.session.id` —
  the reviewer-tool seam, because child sessions have no `jace_sessions` row.
- Console: `GET /api/v1/runner/evidence` (+ `mode=capabilities`) and
  `GET|POST /api/v1/runner/investigations` — `requireJaceConsoleSecret` +
  `eveSessionId` tenancy, sibling of `runner/briefs`. Adapters under
  `apps/console/lib/evidence/<provider>.ts`; registry derived from the
  catalog declaration.
- Store: `packages/db-postgres/src/schema/investigations.ts` + queries;
  ClickHouse is not touched (evidence excerpts are bounded and belong with
  the artifact).

## v1 contract (pinned — parallel slices build against this)

Migration slots pre-assigned: **0058_investigations** (store) and
**0059_jace_sessions_investigation_anchor** (retrieval). Both must be
registered in `drizzle/migrations/meta/_journal.json`.

**Tables** (`packages/db-postgres/src/schema/investigations.ts`)

- `investigations` — `id`, `workspace_id` (FK cascade), `repository_id` (FK
  set null, NULLABLE), `slug`, `title`, `status`
  (`open|investigating|concluded|handed_off`, default `open`),
  `severity` (`low|medium|high|critical`), `opened_by`
  (`chat|run-outcome|alert`), `symptom_statement` (verbatim), 
  `symptom_signature` (normalized, FTS-indexed), `affected_surface`,
  `first_seen_at` (NULLABLE), `verdict` (`root_caused|undetermined`,
  NULLABLE), `confidence` (NULLABLE), `depth_budget` (int, server-derived
  from severity at creation),
  `jace_session_ids` (jsonb `[]`), `created_at`, `updated_at`.
  UNIQUE `(workspace_id, slug)`.
- `investigation_items` — `id`, `investigation_id` (FK cascade), `kind`
  (`timeline_event|evidence|hypothesis|finding|verdict|lesson_candidate`),
  `body` (statement/description), `mechanism` (text, default `''`), `state`
  (hypothesis state enum, NULLABLE — non-hypothesis kinds leave it NULL),
  `evidence_refs` (jsonb array of item ids, default `[]`), `data` (jsonb,
  kind-specific: evidence = provider/verb/query/excerpt/digest/captured_at;
  hypothesis = discriminating test + what-would-settle-it; verdict =
  confidence + missing-evidence; lesson_candidate = lesson type), `authority`
  (`human|jace`, default `jace`), `created_at`, `updated_at`.
- `investigation_links` — `id`, `investigation_id`, `target_investigation_id`,
  `role` (`recurrence_of|related`), `created_at`.
- `investigation_issue_links` — `id`, `investigation_id`, `repo`,
  `issue_number`, `role` (`mitigative|preventative`), `created_at`.
- `jace_sessions.anchored_investigation_id` — uuid FK, set null, NULLABLE;
  sibling of `anchored_brief_id`, same "second unrelated anchor" doc rule.

pgEnums: `investigation_status`, `investigation_severity`,
`investigation_opened_by`, `investigation_item_kind`, `hypothesis_state`
(`open|supported|refuted|inconclusive`), `investigation_verdict`
(`root_caused|undetermined`), `verdict_confidence`
(`confirmed|probable|circumstantial`), `investigation_link_role`,
`investigation_issue_role`, reuse `brief_authority`-shaped
`investigation_authority` (`human|jace`).

**Query exports**: `upsertInvestigation`, `getInvestigationBySlug`,
`listInvestigations`, `searchInvestigations` (FTS over title +
symptom_signature + item bodies), `patchInvestigationItems` (delta, with the
three refusal classes), `appendEvidenceItem` (route-only writer),
`recordVerdict`, `computeVerdictEligibility`, `linkInvestigations`,
`linkInvestigationIssue`, `setSessionInvestigationAnchor` /
`getSessionInvestigationAnchor` / `clearSessionInvestigationAnchor`,
`updateInvestigationItemAsHuman` / `createInvestigationItemAsHuman`.

**Routes**

- `GET /api/v1/runner/investigations?eveSessionId=&mode=anchor|list|get|search&slug=&query=`;
  `get`/`anchor` attach `eligibility` from `computeVerdictEligibility`.
- `POST /api/v1/runner/investigations` — save (delta items; rejects
  `verdict`/`status` with 400; `scanForSecrets` on write).
- `POST /api/v1/runner/investigations/verdict` — the only verdict writer;
  runs `computeVerdictEligibility` server-side and fails closed.
- `GET /api/v1/runner/evidence?eveSessionId=&verb=&…params` and
  `mode=capabilities` — dispatches to the provider adapter, applies the
  envelope (scrub → cap → harden → persist as an evidence item on the
  session's anchored investigation), returns envelopes + degradations from
  the closed taxonomy (`config_missing | no_provider | no_investigation |
  bad_request | unreachable | unauthorized | upstream_error |
  unexpected_status | bad_body`). A session with no anchored investigation
  gets `no_investigation` — evidence may not be captured off-artifact, which
  forces anchor-before-evidence and keeps every envelope dereferenceable.
- Console human surface: investigations index + detail under
  `(dashboard)/dashboard/[workspaceId]/investigations/` — ledger rendering
  grouped by kind, eligibility banner, evidence viewer, **confirm-verdict**
  action and **promote-lesson** action (owner/admin; promotion writes the
  memory item console-side).

**Catalog + adapters (v1)**

- `railway`: catalog entry (`connectMethod: secret`, live verify against the
  Railway API, `capabilities.evidence: ["changes","search_events"]`), adapter
  `apps/console/lib/evidence/railway.ts` (deployments → `changes`; deploy +
  runtime logs → `search_events`).
- `github`: no new connect surface (App installation already bound); adapter
  `apps/console/lib/evidence/github.ts` (merged PRs, deployments/Actions
  runs → `changes`) via `getInstallationToken`.
- `factory`: internal, always available, no connect surface or credential;
  adapter `apps/console/lib/evidence/factory.ts` over the failure-bundle
  sources (runs + attempted changes → `changes`; `failure_events` + run
  timeline → `search_events`). Declared in the catalog like any provider so
  discovery, capability rendering, and the envelope treat it uniformly.
- The secret-route allowlist and capability discovery derive from the catalog
  declaration — removing the hand-enumerated literals for these paths.

**Jace (v1)**

- `debug` skill + three playbook references; instructions.md Investigation
  section with the tier + qa guidance.
- Tools: `fetch_investigations`, `save_investigation`, `record_verdict`.
- Subagents: `change`, `anomaly` — schemas `CHANGE_SCHEMA` (ranked candidates,
  each with refs + why-relevant), `ANOMALY_SCHEMA` (deviations, signatures,
  normal surfaces, first-deviation, all ref-cited), degraded fields
  throughout; evidence verb tools for v1 verbs only.
- **Discriminating tests in v1 route through narrowed `change`/`anomaly`
  missions** ("did pool saturation move at 14:02?" is a deviation-shaped
  question). The dedicated `hypothesis` and `probe` vessels are the first
  post-v1 additions and change no foundations.
- Langfuse: `intent:debugging` trace tag; investigator scores via the
  existing verdict-score hook; `investigation_verdict` score on
  `record_verdict`.

## Verification

- A new provider added in a test (fake adapter + catalog entry) appears in
  capability discovery and is queryable by an unmodified investigator — zero
  prompt, subagent, or methodology changes. **This is the
  architecture-preserving test.**
- An investigator's evidence query persists an evidence item with no model
  relay; `save_investigation` cannot create, modify, or delete it.
- A hypothesis transition to `supported` without an evidence ref is refused
  at the route and the refusal is relayed in chat.
- `record_verdict(root_caused)` fails closed with no eligibility; succeeds
  only after a rival is refuted (or sole-plausible is recorded);
  `undetermined` is refused without a missing-evidence list.
- A human console edit (`authority: human`) survives a subsequent
  `save_investigation` touching the same item.
- An approved `create_issue` from an anchored session writes an
  `investigation_issue_links` row with the correct role.
- A log line containing "ignore previous instructions" reaches the ledger and
  chat rendering inert (hardened, no control characters, no navigable
  URLs).
- Interrupted investigation resumes: a second session (different channel)
  anchors via confirm-once, names settled hypotheses and the in-flight
  question, and re-asks nothing the witness already answered.
- Reopen rules: `undetermined` + recurring symptom → same investigation
  reopened; `concluded` + recurring symptom → new investigation with
  `recurrence_of` link, old verdict rendered as suspect in the console.
- An unconfigured verb returns `no_provider` and the gap is recorded on the
  artifact and voiced as a connect-nudge.
- An evidence query from a session with no anchored investigation is refused
  with `no_investigation` and captures nothing.
- The intake capability summary reads capability-first ("I can inspect
  deployments (GitHub, Railway)"); no chat rendering ever leads with a
  provider name.
- A qa advisory seeds an investigation as a cited `finding`; after a
  mitigative fix ships, the qa verification verdict is recorded on the
  investigation, and a failed verification leaves it open.
- A triage diagnosis escalates the same way: the diagnosis lands as a cited
  `finding`, and the `factory` provider answers `changes`/`search_events`
  for the run's window through the standard envelope.
- The fast tier is unmodified: run-outcome replies and triage verdict
  scoring behave byte-identically with the deep tier deployed.
- Langfuse: debugging traces carry the intent tag; `investigation_verdict`
  scores carry `investigation_id` as a string.

## Out of scope (v1 ships the invariants; these are additive)

- **`hypothesis` and `probe` investigator vessels.** Foundations (ledger,
  verbs, dispatch grammar) ship in v1; the vessels are the first follow-up.
- **`signals` and `traces` verbs + providers** (Langfuse traces fast-follow;
  Grafana, Prometheus, Datadog, Sentry, Vercel, Cloudflare adapters after).
- **Alert-webhook door.** `opened_by: alert` is reserved; the intake surface
  is a later slice — a new door, not a new architecture.
- **Per-workspace dynamic playbooks** (`defineDynamic`). Static playbook
  references first; promotion of learned recipes waits for real usage.
- **Mitigation execution.** Advisory forever within this capability;
  execution would be a separately-gated capability with its own spec.
- **Calibration job** (fix-holds / reopen-rate joins). Scores land in v1;
  the offline evaluation follows once there is data.
- **Evidence re-fetch UX** beyond the stored excerpt (the query is stored;
  a re-run affordance can come later).
- **Capability families beyond `evidence`** (`knowledge`, `probe` as
  families). Named so the discovery shape nests them; not built.
- **Secret-key rotation** for `CONNECTOR_SECRET_KEY`. Pre-existing gap,
  tracked separately; this spec only widens what it protects.
- **Tier convergence.** Re-implementing the fast tier as auto-opened
  lightweight investigations and retiring/re-missioning the standalone
  `triage` subagent waits until the deep tier has earned trust in
  production — it modifies a live, calibrated path.
