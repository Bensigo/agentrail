# Repo Wiki: compiled repository knowledge at ingest — design

**Date:** 2026-07-23
**Status:** Draft for review
**Owner:** bensigo
**Related:** `docs/prd/context-compiler-enterprise-control-plane.md` (Code Graph, Graph Enrichment, Codebase Unit, Context Rot), `docs/superpowers/specs/2026-07-17-jace-end-to-end-flow-design.md` (§north-star step 5: onboard → "Jace can now answer questions about the codebase"), `docs/superpowers/specs/2026-07-08-repo-structure-v2-and-install-footprint-v2-design.md` (D6: factory stays self-contained), `docs/prd/context-quality-v2-live-metrics-rerank-gatherer.md` (the gather phase — shipped, A/B-failed, shelved)

## 1. Problem

The Context Compiler compiles a lot — BM25 postings, a deterministic code graph
(27k nodes / 76k edges on this repo), symbol tables, chunk boundaries — but
**nothing it compiles is understanding**. Every compiled artifact is lexical or
structural. The expensive part of working in a repo — knowing what the modules
are, what they're responsible for, how they relate, where to start — is
recomputed by an LLM on every single task, or not available at all. A
2026-07-23 six-way code audit found four concrete costs:

1. **Jace cannot actually answer questions about a customer's codebase.** The
   e2e design promises it (step 5: onboard, then "Jace can now answer
   questions about the codebase"), but the shipped surface is four workspace
   memory items distilled from a 6,000-char digest
   (`agentrail/runner/onboard.py:45-51,87`). Jace's `codebase_query` tool runs
   `agentrail context query` with **no `cwd`** — it only ever queries the
   coordinator's own home checkout (`apps/jace/agent/lib/context_cli.core.mjs`,
   `runContextLookup`), and `apps/jace/agent/instructions.md` explicitly scopes
   it to "AgentRail's OWN codebase … NOT a workspace's connected repo." Clones
   are ephemeral everywhere (`tempfile.mkdtemp` + `shutil.rmtree` in
   `onboard.py`, `sandbox/native_runner.py`, `sandbox/docker_runner.py`), so
   between runs there is *nothing else to ask*. Repository knowledge dies with
   the clone.

2. **Repo knowledge is stored in the wrong system.** The onboarder writes
   `architecture` / `conventions` / `commands` / `glossary` items into
   `memory_items` (`onboard.py:45-51`, mapped onto the
   `decision|preference|fact` enum), where they compete in the same BM25
   ranking and the same 4,096-byte Memory Lane
   (`agentrail/context/memory_lane.py`) as genuine interaction-derived lessons
   (review findings, failure distillations). CONTEXT.md itself warns against
   exactly this ("Context Memory … _Avoid_: Hidden memory, permanent truth"),
   and `memory_items` has **no invalidation against code change** —
   `last_used_at` is never written, no `expires_at` column exists, the
   onboarder's 30-day gate only prevents *re-onboarding*. Architecture notes
   rot silently in a store designed for durable team decisions.

3. **Context packs carry zero orientation.** `PACK_SECTION_KEYS`
   (`agentrail/context/packs.py:22-38`) is task-scoped retrieval plus flat
   skill/tool pointers. `detect_codebase_units` runs on every index build and
   `index["codebaseUnits"]` is persisted — and `packs.py` never reads it. The
   executing agent starts every run with a counts summary, three snippets, and
   an instruction to go read CONTEXT.md and explore
   (`agentrail/run/prompts.py`, `common_header` + task blocks). The one phase
   built to fix this — gather, a per-task LLM recon pass — shipped, failed its
   A/B (cost more than it saved), and is shelved (`AGENTRAIL_JIT_GATHER`,
   default OFF). That is the decisive data point: **paying for orientation at
   query time, per task, does not amortize. Paying for it once at ingest
   does.**

4. **The slots for this were designed and left empty.** `ContextConfig.summary`
   is a full `ProviderConfig` (mode/provider/model,
   `agentrail/context/config.py:130`) whose only implementation is
   `build_index` raising `RuntimeError("context summary mode … is not
   implemented")`. The code graph ships a hardcoded
   `enrichment: {status: "not_used"}` stub (`index.py:1713-1717`).
   `ChunkRecord.summary` exists and is always `None` (`models.py:101`). The
   architecture anticipated compiled understanding; nobody ever specified what
   it should be.

## 2. The idea, in house language

Karpathy's "LLM Wiki" pattern (independently converged on by DeepWiki,
AutoWiki, OpenWiki, GBrain): **compile repository knowledge at ingest, not at
query**. The wiki is an intermediate representation of the repo — easier for
an agent to navigate than raw source — that the retrieval layer serves
*before* implementation detail. The repo stays the source of truth; the wiki
only decides where to look.

AgentRail already believes every load-bearing tenet of this pattern, in its
own vocabulary:

| LLM Wiki tenet | Existing house principle |
|---|---|
| Derive structure from reality, don't invent it | Code Graph is deterministic; Graph Enrichment is guarded low-authority (`server/ingestion.py` *rejects* `authority: "llm_enrichment"`) |
| Wiki is not the source of truth | Packs cite; agents Read the cited files; retrieval is the only sanctioned locator |
| Freshness is part of correctness | **Context Rot** is a named CONTEXT.md concept; index snapshots carry commit SHA + hashes |
| Compile, don't cache | The product's core surface is literally named the **Context Compiler** |
| Wiki ≠ memory | CONTEXT.md's Context Memory definition — currently violated by the onboarder (Problem 2) |
| Wiki doesn't replace retrieval | Karpathy's own caveat: at scale, hybrid search stays; the wiki reduces how much architectural reasoning retrieval must do |

What's missing is only the artifact itself. This spec defines it: the **Repo
Wiki** — a compiled, per-repository set of cited overview pages, generated at
index/onboard time, structured by the deterministic graph, worded by a cheap
LLM, freshness-tracked by input hashes, ranked below human docs and above
memory, and consumed by both Jace (chat-time Q&A) and the factory (pack
orientation).

## 3. Decisions

| Decision | Choice |
|---|---|
| Artifact name | **Repo Wiki**; pages are `sourceType="wiki_doc"` index records; local files under `.agentrail/context/wiki/` are a **disposable per-clone materialization** (generated cache) — never committed or PR'd into the user's repo |
| Page grain | One **repo overview** page + one page per **Codebase Unit** (existing detection, `index.py detect_codebase_units`; 8 units on this repo). Explicitly NOT per-file or per-symbol in v1 — symbol node IDs are path+name+line-keyed and rename-fragile; unit IDs are the only stable grain |
| Structure vs prose | Skeleton is 100% deterministic (unit file roster, exported symbols from `symbolTable`, unit→unit dependency edges, test coverage counts, manifests). The LLM writes only the prose (responsibilities, relationships, invariants) grounded in the skeleton — it organizes, it does not invent structure |
| New graph data | `unit_depends_on` edges: deterministic aggregation of existing `imports_file` edges through `contains_file` membership. `deterministic: true` — this is rollup, not Graph Enrichment; the `enrichment` stub stays `not_used` |
| Compile trigger | Inside `build_index` when `ContextConfig.summary.mode != "disabled"` — **filling the existing empty slot**, not adding a parallel config. Onboard (`run_onboard`) enables it; incremental thereafter |
| Freshness | Each page records `commitSha`, `inputsHash` (sha256 over the sorted `(path, contentHash)` pairs of its unit's files), `generatedAt`, `model`. Rebuild diff per page: hash unchanged → keep; changed → mark stale (freshness demotion via existing machinery) and regenerate. The onboarder's 30-day timer is replaced by hash diff |
| Authority | New authority tier `generated`: below `context_doc`/`taste_doc` (human, critical), above Memory Lane (untrusted). Wiki prose must never outrank code, tests, or human docs; every page carries citations and a provenance header |
| LLM call pattern | Headless `claude -p` with a cheap default (`claude-haiku-4-5`), same as `onboard.py _call_model` and `llm_rerank.py` — fail-open to skeleton-only pages, never hard-block on missing keys |
| Pack integration | New `repoOverview` key in the **stable cache-eligible prefix** of `PACK_SECTION_KEYS` (the comment at `packs.py:22-25` already separates stable from dynamic — overview content is identical across tasks, i.e. prompt-cache-friendly). Unit pages become rank-eligible `wiki_doc` retrieval candidates |
| System of record | **The server** — new Postgres `wiki_pages` table (workspace + repo scoped). Clones are ephemeral (`tempfile.mkdtemp` + `rmtree` on every path), so the checkout can never be the wiki's home: knowledge must persist independently of clones. Pushed at onboard/index like memory items; replace-by-`(repository_id, slug)` semantics mirroring `replaceMemoryItemsByWriter` |
| Page record shape | One row per page, structure promoted out of the blob: `body_md` (the canonical artifact agents consume) + `skeleton` jsonb (the deterministic inputs) + `links` jsonb (the page graph) + promoted columns for identity/provenance/freshness. Maps 1:1 onto the pattern's required properties — stable identity (`slug`), predictable organization (`kind` + slug tree), explicit relationships (`links`), provenance (`commit_sha`/`citations`/`model`/`written_by`), ownership (workspace/repo fk), freshness (`inputs_hash`/`stale`) |
| Jace surface | New read-only `fetch_repo_wiki` tool (list / get / search), untrusted-framed like `fetch_workspace_memory`; instructions route customer-repo architecture questions to wiki first, memory for team decisions |
| Console surface | In scope (not optional): a read-only Engine-room Wiki view rendering `body_md` **verbatim from the same rows the LLM consumes** — one content source, zero console-side editing. Human corrections flow through `.agentrail/context.md` (higher authority, feeds the next compile), never through the wiki |
| Factory self-containment | Honors D6: packs read wiki only from the **local index**; no mid-run network reads. A fresh clone **hydrates** its local wiki cache from `wiki_pages` once, at context-setup time — the same pattern and failure mode as `memory_fetch.py`'s snapshot pull (TTL'd, non-fatal) — then hash-diff regenerates only stale pages |
| Memory boundary restored | The onboarder stops writing `architecture`/`conventions`/`commands`/`glossary` into `memory_items` once the wiki flag graduates; `memory_items` returns to interaction-derived knowledge only (decisions, preferences, failures) |
| Rollout | Everything behind `AGENTRAIL_CONTEXT_REPO_WIKI` + config, default OFF; graduates only by the two-set eval gate (no regress on seen + held-out, improvement on one) |

## 4. Design

### 4.1 The artifact

A wiki page is markdown with YAML frontmatter:

```markdown
---
slug: wiki/unit/agentrail-context        # stable identity: unit id
title: agentrail/context — Context Compiler
kind: unit                                # overview | unit
commitSha: 129103aa
inputsHash: sha256:…                      # over sorted (path, contentHash) of unit files
generatedAt: 2026-07-23T14:00:00Z
model: claude-haiku-4-5-20251001
citations: [agentrail/context/index.py, agentrail/context/packs.py, …]
---

> Compiled from source at 129103aa. Verify claims against the cited files;
> the source is authoritative.

## Responsibility
<LLM prose, grounded in the skeleton — 3-6 sentences>

## Structure                              ← deterministic skeleton, verbatim
- 31 files, 4,102 symbols; key exports: build_index, build_context_pack, query_context …
- Depends on: agentrail/shared. Depended on by: agentrail/run, agentrail/cli.
- Tests: 519 linked via tests_source edges (agentrail/tests/context/).

## Key files
<LLM-annotated roster: path — one-line role, from the skeleton's file list>

## Relationships & invariants
<LLM prose; each claim must cite a file from the roster>

Related: [[wiki/unit/agentrail-run]], [[wiki/overview]]
```

The **overview page** is the same shape at repo grain: what the product is
(seeded from README/CONTEXT.md head), the unit roster with one-liners, and the
unit dependency diagram as a text edge list. Page budget: ≤ 1,200 output
tokens per page, ≤ 24 unit pages per repo (larger repos get the biggest 24
units by file count; the cap is `log()`-ged, never silent).

The `[[slug]]` links plus `unit_depends_on` edges make pages *navigable*:
identify concept → open page → follow explicit relationships → Read cited
source — navigation before search, exactly the pattern's point.

### 4.2 Compile pipeline

```
build_index (index.py)
  … existing stages: records → chunks → graph → symbolTable → postings …
  + unit_depends_on rollup            (deterministic, always on — PR 1)
  + if summary.mode != "disabled" and AGENTRAIL_CONTEXT_REPO_WIKI:
      hydrate .agentrail/context/wiki/ from server wiki_pages
        (setup-time fetch, memory_fetch.py pattern: TTL'd local snapshot,
         non-fatal — a fresh ephemeral clone starts from the durable server
         copy, never from zero; a persistent self-host checkout makes this
         a no-op)
      for each unit: inputsHash diff → unchanged? keep page : regenerate
        skeleton = deterministic render from index/graph        ($0)
        prose    = headless `claude -p` over skeleton + bounded file heads
                   (fail-open: on any error, page ships skeleton-only)
      overview page: regenerated when any unit page changed
      pages written to .agentrail/context/wiki/*.md
      pages ingested as SourceRecords: sourceType="wiki_doc",
        authority="generated", contentHash, chunked + posted like any source
      cost: one cost event per compile via run/pricing.py cost_usd
```

Incrementality is real at page grain even though `build_code_graph` is
monolithic: the hash diff runs over `SourceRecord.contentHash` values that the
index already computes. Steady-state cost on a repo like this one: a typical
change touches 1-2 units → 2-3 Haiku calls per re-index (~cents); onboard pays
~9 calls once. A per-compile dollar ceiling (`summary` config) is a hard stop.

The `.agentrail/context/` exclusion in `config.py` (generated caches) keeps
the wiki dir out of the *file walk*; wiki records are injected by the compile
step directly, so the index never re-reads its own output as user source.

Why hydration is load-bearing: without it, every fresh fleet clone finds an
empty wiki dir, hash-diffs every page as changed, and recompiles the whole
wiki per run — LLM cost and latency exactly where the design promises
amortization. The server row, not the checkout, is the artifact; the local
dir is a working copy that dies with the clone, by design.

### 4.3 Consumption — factory

- `repoOverview` section: `build_context_pack` inlines the overview page
  (capped ~2k tokens) into the stable prefix, alongside `requiredContext`.
  Human docs (CONTEXT.md/TASTE.md) keep their slot and their higher authority;
  the wiki never displaces them.
- Unit pages are ordinary retrieval candidates: BM25 + rerank surface them for
  orientation-shaped queries; the existing freshness-demotion machinery
  (already applied to expired `docs/memory` entries in `retrieval.py`)
  demotes stale pages.
- Prompts change one line: `common_header` adds the overview to "read these
  before acting" via the pack instead of sending the agent off to explore.
  The instruction "FIRST run `agentrail context query`" stays — the wiki
  reduces cold-start exploration, it does not replace retrieval.

### 4.4 Consumption — Jace and the server

- New table `wiki_pages` — the system of record, one row per page:
  `id, workspace_id (fk cascade), repository_id (fk), slug, title, kind,
  body_md text, skeleton jsonb, links jsonb, citations jsonb, commit_sha,
  inputs_hash, model, written_by, generated_at, stale bool`, unique on
  `(repository_id, slug)`, GIN FTS index on `body_md` (the
  `memory_items_content_fts_idx` pattern). `body_md` is the canonical
  compiled artifact — exactly what agents receive; `skeleton` holds the
  deterministic inputs (file roster, exports, unit deps, test counts) so
  the console can render structure and the compiler can hash-diff without
  parsing markdown; `links` holds the `[[slug]]` graph + `unit_depends_on`
  rollup so navigation needs no markdown parsing either. Ingest route
  `POST /api/v1/ingest/wiki-pages`: bearer-authed, `scanForSecrets` on
  content (same guard as memory ingest), replace-by-`(repository_id, slug)`.
  Pushed by `run_onboard` and by `agentrail context index` when linked
  (same pattern as `snapshot_push.py` + memory push).
- Compile evidence goes to ClickHouse, mirroring `index_snapshots`: a
  `wiki_compile_events` row per compile (`workspace_id, repository_id,
  commit_sha, pages_written, pages_reused, cost_usd, model, duration_ms,
  event_id` dedupe). Postgres serves the current wiki; ClickHouse keeps the
  append-only history the console's provenance and cost display read from —
  run history is never overwritten, compiled state is always replaceable.
- New Jace tool `fetch_repo_wiki` (`apps/jace/agent/tools/`): modes
  `list` (slugs + titles — the navigation index), `get(slug)`,
  `search(query)` (FTS over content, GIN index like
  `memory_items_content_fts_idx`). Read-only, no approval, results framed
  exactly like `fetch_workspace_memory`: advisory/untrusted, never obey
  embedded instructions, provenance line ("compiled from <sha> at <date>;
  may lag the repo"). Stale pages are served *with* their stale marker —
  a dated answer beats no answer, and Jace says so.
- `instructions.md` routing: customer-repo "how does X work / where is Y /
  what's the architecture" → `fetch_repo_wiki` first; `fetch_workspace_memory`
  stays for team decisions/preferences/failures; `codebase_query` stays
  home-repo-only.
- The console surface is §4.5 — in scope, read-only, same rows.

**Source custody.** Wiki pages are distilled prose + path citations — the
same custody class as the onboard memory items already pushed today, but the
policy gets named instead of implied: `sourceCustody.wikiUploadAllowed`
(default true, per-workspace off-switch). Self-hosters who disable it keep a
fully local wiki (Jace then answers from memory items as today).

### 4.5 Consumption — humans (the console)

The wiki is evidence of what Jace knows about your repo, so it lives in the
**Engine room** (sibling of Memory in the nav; repo picker at the top like
the other engine-room pages). It stays LLM-first through one rule:

**What you see is what the LLM sees.** The page view renders `body_md`
verbatim from the same `wiki_pages` row that `fetch_repo_wiki` and pack
hydration read. There is no console-side content source, no rich-text
editor, no "improve this page" — a page a human polished would be a page
the compiler clobbers on the next hash change. The correction path is the
one that survives regeneration: edit `.agentrail/context.md` (human doc,
`critical` authority, above the wiki), and the next compile — whose digest
reads it first — propagates the correction into the prose. Humans steer the
compiler; they never patch its output.

**Owner ruling (2026-07-23): the wiki view IS the per-repo surface.** The
Settings-zone "Repos & Health" page is redundant with it and is retired: its
nav entry is removed, `/repos` becomes a redirect stub to `/wiki` (the
`queue→work` / `teams→members` precedent, so deep links keep working), and
the wiki view absorbs its duties — the repo picker becomes a repo list with
each repo's index health (the `repo-health.ts` healthy/stale/critical chip,
last-indexed age, short commit, source count; index freshness and wiki
freshness are different facts and are labeled distinctly), and the one
management affordance that page had — the owner/admin-gated "Add repo"
dialog — moves into the wiki view's repo list. Everything else stays
read-only.

The view:

- **Nav tree in file-structure format**: pages are organized hierarchically
  by the unit's repo path (overview at root; `apps/ → console, jace`,
  `packages/ → …` as expandable groups mirroring the codebase layout),
  derived from structural data (`links`/`skeleton`/unit path — never parsed
  from prose). `unit_depends_on` in/out shown per page — the same navigation
  index `fetch_repo_wiki list` serves Jace.
- **Per-page file tree**: the unit's file roster from `skeleton` jsonb
  renders as a collapsible file tree — the Structure section's data shown as
  actual structure.
- **Rendered | Source toggle + download**: Source shows `body_md` verbatim
  in monospace — the artifact exactly as the LLM consumes it (the
  what-you-see-is-what-the-LLM-sees rule made literal) — and a "Download
  .md" button saves the page (client-side, filename from the slug). No new
  server surface.
- **Provenance bar** on every page: compiled from `<short-sha>` ·
  `generated_at` · model · last compile cost (from `wiki_compile_events`).
  Stale pages carry a visible stale badge (current `inputs_hash` mismatch),
  consistent with the console display rule — staleness age and stale-page
  count are falsifiable numbers; there is no "knowledge score".
- **Citations deep-link** to the repo host at the pinned `commit_sha` (blob
  URL), so every prose claim is one click from the source that grounds it —
  names over IDs everywhere, per house rule.
- **Recompile** is the only content affordance: a button surfacing the
  existing re-index mechanism (the repos-table "Re-index" precedent) —
  audited, queue-driven, no direct console-to-LLM path. (Add-repo, above, is
  connection management riding along from the retired page — not a content
  write path.)
- Empty state (flag OFF or never compiled): "No wiki compiled yet", with
  the re-index affordance — never a fake page.

### 4.6 The memory boundary, restored

After graduation, the boundary matches CONTEXT.md's definitions:

| Store | Holds | Written by | Freshness |
|---|---|---|---|
| **Repo Wiki** (`wiki_pages` + local `wiki_doc`) | Knowledge **about the document set**: architecture, module responsibilities, relationships, conventions, commands, glossary | Compiler at index/onboard | Input-hash diff; stale-marked, demoted, regenerated |
| **Workspace memory** (`memory_items`) | Knowledge **from interaction**: decisions, preferences, review lessons, failure patterns | Reviewer, humans-from-failures | Advisory; rot-scored |

Transition: while the flag is OFF, `onboard.py` behaves exactly as today.
With the flag ON it writes wiki pages *and* keeps seeding the four memory
items (dual-write) so `fetch_workspace_memory` never regresses; the memory
seeding is removed in the graduation PR. The onboarder digest also gains the
two highest-signal files it currently skips: `.agentrail/context.md` /
`CONTEXT.md` and `TASTE.md` (today `_DIGEST_FILES` samples only generic
contributor docs, `onboard.py:69-79`).

### 4.7 Safety and authority invariants

- Wiki prose never becomes graph truth: no LLM-derived edges enter
  `graph.edges`; `enrichment.status` stays `"not_used"`; the server
  contract's rejection of authoritative `llm_enrichment` submissions stands.
- Rank ordering is enforced where authority is scored: `wiki_doc` sits below
  `context_doc`/`taste_doc` and can never satisfy a fixture's required-source
  slot on behalf of a code file.
- Injection surface: wiki content is model-generated from repo content —
  treat like memory on the read side (untrusted framing in Jace tool
  results; fence-marker neutralization reused from
  `memory_lane._neutralize_fence_markers` where content is fenced).
- Nothing wiki-related ever lands in the customer's repository: no committed
  files, no wiki content in factory PRs, no writes outside the
  `.agentrail/context/` generated-cache namespace of a disposable clone. The
  only durable copy is `wiki_pages`; deleting a workspace deletes its wiki
  (fk cascade), same as memory.
- Red line from the eval harness: wiki pages must be excluded from eval
  workspaces' agent-visible trees when the arm is OFF, or the A/B is
  contaminated — the arm bridge handles this via the env flag.

## 5. Not building (v1)

- Per-file or per-symbol pages (identity too fragile; cost explosion; the
  symbol table + `context def` already serve that grain).
- Concept pages beyond units (v2 candidate once page-to-page linking has
  usage data).
- An LLM concept graph, embeddings store, or any new retrieval engine — BM25
  + existing rerank rank the pages.
- A human documentation product. The console view (§4.5) renders the
  agent's artifact read-only; there is no console editing, no separate
  human content source, no doc site. The consumer is the agent.
- Any factory-runtime network dependency (D6 stands).
- Chat-time wiki *writes* by Jace — compile is the only writer.

## 6. Evaluation & rollout

House rules apply: flag OFF until falsifiable evidence, judged by the two-set
gate. Three measurement surfaces, most-decisive first:

1. **E2E arm** — `repo_wiki` joins the PLUS layers: env bridge in
   `agentrail/evals/runner.py _arm_env`, arm `full-plus-repo_wiki` in
   `arms/__init__.py`, run against `full`. Known gap the arm must respect:
   the current 12-task corpus is fully localized (1-5 pre-registered files
   per task) — it structurally cannot reward orientation. The corpus PR adds
   ≥3 high-scatter cross-module tasks (difficulty is already "proxied by
   required-context scatter"), at least one `heldOut`. Metrics: solve rate,
   $/solved, wall-time, false-green — the standard report.
2. **Orientation probes** — new fixture kind in the retrieval eval: NL
   questions ("where is retry/escalation decided?", "what owns pricing?")
   with `expectedFiles` ground truth, scored by the existing
   `requiredSourceInclusion`/`recallAt10`/`fileRPrecision` machinery, run
   with wiki on/off. Cheap, deterministic, and measures exactly the claim
   "compiled understanding improves where-to-look."
3. **Live counters** (post-graduation observability, can go negative):
   read-share of wiki sections via `liveContextMetrics` (read-grounded
   precision already lands in `run.json`), and executor exploration
   tool-calls per run before first cited-file Read.

Rollout ladder: PRs land flag-OFF → dogfood ON for this repo (the factory
already dogfoods its own packs) → eval arm A/B → two-set gate verdict →
graduate flag default-ON + onboarder memory-seeding removal, or shelve with
the report attached (the gather precedent shows we honor negative results).

## 7. Delivery plan

Small PRs, each independently green, flags OFF throughout (issues to be filed
from this spec after review):

| # | PR | Acceptance criteria |
|---|---|---|
| 1 | `unit_depends_on` rollup + per-unit export summary in index/graph | Edges deterministic from `imports_file`×`contains_file`; counts in `ingestionHealth`; graph tests extended; no retrieval behavior change |
| 2 | Wiki compiler: skeleton renderer + prose layer + `.agentrail/context/wiki/` + `wiki_doc` records + inputs-hash freshness + `agentrail context wiki build/status/show` | `summary.mode` honored (the `not_implemented` raise retired); fail-open skeleton-only on LLM error; cost event emitted; hash-unchanged pages byte-identical across rebuilds |
| 3 | Pack `repoOverview` (stable prefix) + `wiki_doc` retrieval + authority tier `generated` + orientation-probe fixtures | Flag-OFF pack bytes identical to today; probes runnable via `agentrail context evaluate`; wiki never satisfies a code-file required-source |
| 4 | Server: `wiki_pages` migration + `wiki_compile_events` (ClickHouse) + ingest route + push from onboard/index + **hydration fetch client** + custody switch | Secret-scan on ingest; replace-by-slug idempotent; hydration test: a fresh clone with server creds regenerates **zero** unchanged pages; migration follows house journal rules; onboarder dual-writes behind flag. (Until this PR, PR 2's compiler is local-only — fine for persistent self-host/dev checkouts, not the fleet) |
| 5 | Jace `fetch_repo_wiki` + instructions routing | Read-only, untrusted-framed, stale-marked; workspace resolved server-side from session (per the subagent session-id rule); no second write path |
| 6 | Console Engine-room Wiki view (§4.5) — can land parallel to 5 | Renders `body_md` verbatim from `wiki_pages`; file-structure nav + per-page roster tree from structural data; Rendered/Source toggle + .md download; absorbs "Repos & Health" (nav entry retired, `/repos` redirect stub, index-health chips in the repo list, Add-repo dialog relocated); provenance bar + stale badge + last-compile cost from `wiki_compile_events`; citations deep-link at pinned `commit_sha`; empty state honest; **browser-verified via minted DB session (CI skips console tests)** |
| 7 | Eval arm + corpus high-scatter tasks + A/B report → graduation decision | `full-plus-repo_wiki` runnable; ≥3 new tasks (≥1 held-out); two-set verdict recorded; graduation or shelving PR includes the report |

## 8. Open questions

1. Custody default for enterprise mode — is `wikiUploadAllowed: true` an
   acceptable default under `metadata_only`, given the onboard-memory
   precedent, or should enterprise default to local-only wiki?
2. Multi-repo workspaces: one overview per repo (proposed) vs. a workspace
   rollup page — decide when a real multi-repo workspace exists.
3. Should wiki citations feed the `_lesson_target_hints`-style retrieval
   boost (a fresh page boosting its cited files), or is that double-counting
   with `repoOverview`? Measure in the arm before deciding.

## Appendix — CONTEXT.md glossary entry (to add in PR 2)

> **Repo Wiki**:
> A compiled, per-repository set of cited overview pages (repo overview + one
> per Codebase Unit) generated at index/onboard time — structure from the
> deterministic Code Graph, prose from a bounded cheap-model pass — stored
> durably in the server's `wiki_pages` (checkouts are ephemeral and customer
> repos are never written to), materialized per-clone as `wiki_doc` sources,
> freshness-tracked by input hashes, ranked below human context docs and
> above memory.
> It tells agents where to look; the source stays the truth.
> _Avoid_: Treating wiki prose as evidence; storing repository knowledge in
> workspace memory; per-file page explosions; console-side page editing or
> any second human content source (the console renders the agent's artifact
> read-only); any factory-runtime network fetch of wiki content.
