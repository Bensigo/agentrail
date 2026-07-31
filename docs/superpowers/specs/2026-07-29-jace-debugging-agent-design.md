# Debugging — triage becomes Jace's debugging specialist

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

**This spec introduces no new agent.** It turns the existing `triage`
subagent into **Jace's debugging specialist** — the same deliberate identity
qa holds for validation: **qa validates software; triage debugs software.**
Run diagnosis is one *mode* of debugging, not the definition of the agent;
everything here — durable investigations, evidence providers, hypothesis
ledgers, discriminating tests, recurrence, qa collaboration — is what makes
triage a full debugger. The directory/tool name `triage` is kept for wire and
calibration continuity (verdict scores, run-outcome replies); the identity,
description, and prompt become the debugger. Implementation evolves in
stages for safety, but the architectural identity is debugging from day one.

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
triage — THE DEBUGGER    (mission execution: fans out nested mission
  ├─ change/               investigators, correlates evidence, returns
  ├─ anomaly/               structured round reports; run diagnosis is
  └─ hypothesis/, probe/    its fast mode)                    [post-v1]
        ↓
Root agent               (interface + custodian: witness interview, artifact
                          custody, verdict gate, handoff, channel voice)
        ↓
Investigation artifact    (durable source of truth; the conversation is not)
        ↓
Human-confirmed knowledge (episodic always; semantic only through the gate)
```

Two-level coordination, still no workflow engine: **root decides rounds**
(reading the ledger and the conversation), **the debugger decides within a
round** (which nested investigators, which verbs). The conversation cannot
live inside a one-shot subagent, so the debugger works in rounds: root hands
it a mission — phase, window, capability map, current ledger digest,
playbook extract — and it returns a round report; root persists, talks to
the witness, decides the next round.

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

## The debugger's mission investigators

Mission-typed, never source-typed. **Investigators answer questions; providers
supply evidence.** A per-provider agent roster (Sentry agent, Datadog agent,
…) would push cross-source correlation — the actual debugging — back up a
level and grow the roster with every integration. Four missions are the stable
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

All four are declared Eve subagents **nested inside the debugger**
(`agent/subagents/triage/subagents/<name>/` — nesting is Eve-native) in the
established shape: `outputSchema` task mode, `disableTool()` sentinels
stripping the default harness, thin authored tools over shared `lib/*.core.mjs`
cores. They are advisory to their parent: they return structured findings to
the debugger, which correlates them into one round report for root. The
debugger itself also carries the evidence verb tools, so a narrow
discriminating test is one verb call, no nested dispatch. **Root's autosave
remains the only model-side artifact writer; the evidence route the only
server-side one** — the debugger proposes ledger updates with receipts in its
round report, root adjudicates and persists. (If transcription proves lossy
in practice, granting the debugger `save_investigation` is a contained
relaxation: every invariant lives in the route, not in who calls it.)
Non-delegable to any subagent: the witness interview, anchoring, hypothesis
adjudication, the verdict, and the gated handoff — the agent that never met
the witness cannot own the conclusion.

## Coordination — who decides what runs

**Root decides rounds; the debugger decides within a round.** There is no
workflow engine; the model reasons over the process at both levels. Three
layers keep that disciplined:

- The **debug skill defines the grammar**: hard rules, few and checkable.
  Recurrence check before external evidence. Change sweep first once a window
  exists (cheapest, highest prior). Hypothesis-test missions only for
  hypotheses already in the ledger. Every round's mission names the
  question, the window, and the capability map. Autosave between rounds.
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

Parallelism is Eve-native: the debugger emits multiple nested-investigator
calls in one response and they run concurrently (fan-out is the documented
batch behavior; `change` + `anomaly` sweep together, hypothesis tests fan
out per live hypothesis later). Depths under the default cap of 3: root 0,
debugger 1, mission investigators 2.

## One debugger, two modes

The debugger is one agent with one discipline at two cost levels — run
diagnosis is a *mode* of debugging, not a separate concept:

- **Run mode.** Today's behavior: "why did run 123 fail?" → bundle →
  diagnosis in seconds, still driven by `fetch_run_evidence`. **v1 keeps this
  behavior-stable**: the output schema widens *additively* to a
  mode-discriminated union (run-mode fields byte-identical), pinned by a
  regression test against the verdict-score hook and the calibration joins.
- **Deep mode.** Production investigation, executed in rounds: root hands a
  mission, the debugger fans out its nested investigators, correlates, and
  returns a `ROUND_REPORT` — findings, proposed hypothesis updates with
  evidence refs, gaps, suggested next round.

Three seams join the modes in v1:

- **The factory becomes an evidence provider.** An internal, always-on,
  credential-less `factory` adapter exposes what the failure bundle already
  holds — runs and their attempted changes → `changes`; `failure_events` +
  run timeline → `search_events`. A production investigation can then cite
  "run 123 deployed PR #212 at 14:02 and its verify gate failed" like any
  other evidence, through the same envelope.
- **Escalation is a typed handoff.** When a run failure recurs, looks
  production-impacting, or resists one-shot diagnosis, root offers to open an
  investigation; the run-mode diagnosis enters the ledger as a cited
  `finding` with its `evidence_refs` and provenance — the same shape as the
  qa handoff.
- **Routing prose becomes mode guidance.** One rule: run-scoped question →
  run mode; recurrence, production impact, or a failed quick diagnosis →
  open an investigation and work in deep mode.

**Convergence (planned, post-v1):** once deep mode is proven, run mode is
re-plumbed onto the `factory` evidence verbs and auto-opens a lightweight
investigation per diagnosis (`opened_by: run-outcome`, derived slug, low
severity, no witness interview — the bundle IS the witness statement), so run
diagnoses start compounding in the episodic layer, and the private
`fetch_run_evidence` tool retires. Named here so it is an evolution, not
drift — but it touches a live calibrated path, so it waits for deep mode to
earn trust.

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
- The root `instructions.md` gains a Debugging section: load the `debug`
  skill for incident-shaped messages; mode guidance — run-scoped question →
  the debugger's run mode, escalating to a full investigation on recurrence,
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

## QA ↔ Debugger collaboration

Not silos, not a merger. The boundary stays crisp — **qa validates software;
triage debugs software** — and collaboration
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

- Root skill: `apps/jace/agent/skills/debug/SKILL.md` — the FLOW grammar
  (interview, anchoring, rounds, gates, mode routing, handoff), loaded via
  `load_skill` — grill-me's sibling. The investigation DISCIPLINE and the
  playbooks live with the specialist: `agent/subagents/triage/skills/`
  (per-subagent skills are Eve-supported), so the debugger carries its own
  craft.
- The debugger: `apps/jace/agent/subagents/triage/` — identity, description,
  and `instructions.md` rewritten to the debugging specialist; output schema
  widened additively to a mode-discriminated union (run mode byte-stable,
  `ROUND_REPORT` added); evidence verb tools + `fetch_run_evidence` both
  present in v1.
- Nested mission investigators:
  `apps/jace/agent/subagents/triage/subagents/{change,anomaly}/` (v1), each
  with `agent.ts` (description-routed, `outputSchema`), `instructions.md`,
  `lib/*.core.mjs` schemas + pure logic, `tools/` = verb wrappers +
  `disableTool()` sentinels. Directory name = tool name within the parent's
  namespace.
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

- `debug` root skill (flow grammar) + the debugger's own skills (discipline +
  three playbooks); instructions.md Debugging section with mode + qa
  guidance.
- Root tools: `fetch_investigations`, `save_investigation`, `record_verdict`.
- The debugger (`triage`): identity/prompt rewrite, mode-discriminated union
  schema (run mode byte-stable, regression-pinned against the verdict hook
  and calibration joins; `ROUND_REPORT` added), evidence verb tools for v1
  verbs.
- Nested investigators: `change`, `anomaly` — schemas `CHANGE_SCHEMA` (ranked
  candidates, each with refs + why-relevant), `ANOMALY_SCHEMA` (deviations,
  signatures, normal surfaces, first-deviation, all ref-cited), degraded
  fields throughout; evidence verb tools for v1 verbs only.
- **Discriminating tests in v1 route through narrowed `change`/`anomaly`
  missions within a round** ("did pool saturation move at 14:02?" is a
  deviation-shaped question). The dedicated `hypothesis` and `probe` vessels
  are the first post-v1 additions and change no foundations.
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
- Run mode is behavior-stable: run-outcome replies and triage verdict
  scoring are byte-identical after the schema union lands
  (regression-pinned).
- A deep-mode round trip: root dispatches one mission; the debugger fans out
  nested `change` + `anomaly` concurrently and returns one round report;
  root persists it; every proposed hypothesis update cites evidence captured
  during that round.
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
- **Mode convergence.** Re-plumbing run mode onto the `factory` evidence
  verbs, auto-opening lightweight investigations per run diagnosis, and
  retiring `fetch_run_evidence` waits until deep mode has earned trust in
  production — it modifies a live, calibrated path.
- **Debugger-direct ledger writes.** v1 keeps root as the sole model-side
  artifact writer; granting the debugger `save_investigation` is a named,
  contained relaxation if round-report transcription proves lossy (all
  invariants live in the route).

## As built (v1) — deviations from this spec

Recorded 2026-07-29 at implementation completion (13 tasks, PRs #1503–#1524;
each task adversarially reviewed with fix rounds; final whole-branch review:
READY-WITH-CONDITIONS). The pinned sections above are preserved as designed;
these are the deltas reality forced, each with its reason:

- **Migration slots: 0059/0060/0063, not 0058/0059.** Slot 0058 was claimed
  by #1500 (thread engagement) after this spec pinned it; the store landed as
  0059_investigations + 0060_jace_sessions_investigation_anchor. Review round
  T12 added 0063_investigation_issue_links_unique (a unique index making the
  issue-link write idempotent at the database level) — numbered 0063 because
  the concurrent billing arc live-applied 0061/0062 first. First-come
  precedent both times; each migration header documents its renumber.
- **Playbooks live under the ROOT debug skill (`skills/debug/references/`),
  not `subagents/triage/skills/`.** The debugger's `load_skill` is
  deliberately stripped by its sentinels, so per-subagent skills would be
  unloadable; root embeds the playbook extract into each mission envelope —
  which is what the Coordination section always specified. `defineDynamic`
  per-workspace playbooks remain the later path, now root-side.
- **The `intent:debugging` trace tag was dropped from v1.** The intent
  classifier is deliberately binary (chit-chat/capable), and no skill-load
  signal exists at the instrumentation seam. The `investigation_verdict`
  score carries the observability; the tag can return with a mechanism.
- **`depth_budget` is stored but not yet severity-derived** — every
  investigation gets the column default (8). The debug skill instructs
  severity-paced discipline honestly; the server-side derivation is a
  tracked follow-up, and the schema doc-comment is corrected with it.
- **A fourth root tool exists: `fetch_evidence_capabilities`.** The spec's
  three-tool list left the capability map unreachable from root (caught in
  T11 review); the tool renders capability-first ("I can inspect deployments
  (github, railway, factory)") and is read-only.
- **Verdict route returns `investigationId`** on 200 so the Langfuse score's
  `metadata.investigation_id` is the durable id, not the renamable slug.
- **Known follow-ups filed at completion:** a read path + console rendering
  for `investigation_links`/`investigation_issue_links` (the recurrence
  "renders the old verdict as suspect" bullet is unmet until then);
  severity→depth-budget derivation; the factory adapter's createdAt-ranged
  run query + wedged-run horizon edge; an admin unclaim affordance for the
  promote crash window; assorted test hygiene.

## As built (Wave 2) — the provider roster, 2026-07-31

The "additional providers expand capability without changing the foundation"
claim was exercised at scale: nine stacked PRs (#1527–#1538) atop the v1 arc,
zero prompt/methodology/investigator changes anywhere (reviewer-asserted from
every diff), evidence-layer core files untouched throughout.

- **Foundations:** generalized connect forms (`extraConfigFields` arrays,
  composite `secretParts` joined client-side with a server-side split
  helper, catalog-derived key allowlists, URL keys scheme-gated centrally)
  and the Jace-side `fetch_signals`/`fetch_traces` verb tools (all three
  evidence-core copies, sync-tested).
- **Providers shipped:** Langfuse (traces + single-row RED signals),
  Sentry (error events + signals; free text quoted per the real search
  grammar with round-trip tests), Datadog (rollup-collapsed signals +
  `message:`-scoped log search), Prometheus (four instant RED/USE queries,
  two-layer PromQL escaping proven order-correct), Grafana (sanctioned
  pivot to alerts/annotations as `search_events` — datasource-proxy
  querying is undocumented first-party and exceeds the Viewer role),
  Vercel (v7 deployments + deployment events incl. alias-assigned),
  Cloudflare (edge signals + firewall events via the inline-filter GraphQL
  idiom with schema-dump-confirmed leaf scalars).
- **Wave lessons now pinned as process:** vendor claims verified against
  raw doc fetches only (a summarizing fetch fabricated a "verbatim" type
  citation from a screenshot-heavy page — caught in review); query-DSL
  escaping tested by round-tripping the provider's documented unescape,
  for the exact field queried; secret fixtures structurally fake with no
  contiguous live-scanned prefix (concat-split).
- **Pre-deploy additions:** a Cloudflare live-token smoke (both verbs — the
  query shapes are schema-grounded but never ran against a real zone; the
  failure mode degrades gracefully but silently) and a recommended live
  composite-connect check (Langfuse pk/sk, JP region).
- **Wave follow-up filed:** search-horizon caveats across all seven
  search-ish adapters (bounded-fetch + client filter can render a false
  "(no matching events)") + the Jace-side excerpt head-truncation fix.
