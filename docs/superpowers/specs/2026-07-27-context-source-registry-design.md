# Context source registry — design

**Date:** 2026-07-27
**Status:** approved in direction, implementation not started
**Predecessor:** `docs/superpowers/specs/2026-07-23-repo-wiki-compiled-repo-knowledge-design.md`
**Supersedes:** the task-time hydration approach (an earlier draft of this date,
removed in the same PR that adds this file)

## Problem

The Repo Wiki compiles, pushes, and serves — 64 module-grain pages exist for
`Bensigo/agentrail` — but nothing on the work-producing path reads it. The
first attempt to fix that hydrated the server's pages into the ephemeral
clone, then re-entered `compile_wiki` with a `$0` cost ceiling so the pages
would be read back as `wiki_doc` records without any model call.

That works, and it is one-off plumbing. The problems with it are structural,
not cosmetic:

1. **It is wiki-specific.** Every future knowledge source — ADRs, tickets,
   incident write-ups, external docs — would need its own hydrate path, its
   own record-minting path, and its own place in `build_index`.
2. **It re-materializes a source of truth that already exists.** `wiki_pages`
   in Postgres is the system of record (owner ruling, 2026-07-23). Writing a
   disposable copy into every clone so the local indexer can hand it back is
   a redundant round trip.
3. **It taxes every pack build.** `context/index.py:2214` disables the
   content-based index cache whenever the wiki flag is on, so a run re-indexes
   the repo on each pack build instead of reusing a fresh index. That cost is
   larger than the download it was paired with.
4. **The `$0` ceiling is a workaround.** It exploits `_CostTracker.exceeded`
   being `total_usd >= ceiling` so the budget reads as breached before page
   one. It is correct and it is tested, but it means "load pages" is spelled
   as "compile, but forbidden to spend".

Meanwhile the shape the wiki should have already exists elsewhere in the
engine. `agentrail/context/planner.py` classifies a query *before* retrieval
runs and picks a `retrievalMode` (`exact`, `exact_bm25`, `exact_graph`,
`semantic`, `hybrid`, `excluded`) from deterministic signals — no model call.
The missing idea is not "plan before you search". It is "sources are
interchangeable".

## Goal

One retrieval architecture. Code, wiki, memory, and future knowledge sources
sit behind the same interface, are selected and weighted by the same
deterministic planner, and land in one ranked pool judged by one ranker. The
wiki stops being special-cased; adding the next source stops requiring engine
changes.

Hydration disappears rather than being optimized.

## A. The source interface

Every source implements one method:

```python
class ContextSource(Protocol):
    name: str            # "code" | "wiki" | "memory" | ...
    authority: str       # feeds score_authority/authority_demotion, unchanged

    def search(self, query: RetrievalQuery, budget: SourceBudget) -> List[Candidate]:
        ...
```

A `Candidate` is what the merge step already understands: a source record, an
optional chunk, a raw relevance score, and the provenance strings retrieval
already renders. Sources do not decide inclusion, do not trim to a token
budget, and do not rank against each other. They return scored candidates and
stop.

Two implementations at the start:

- **`code`** — wraps today's `query_context` path over `index.json`. Local,
  no network. This is a wrapper, not a rewrite: the existing hybrid retriever,
  expansion layer, and reranker are untouched.
- **`wiki`** — HTTP against the console. Remote, no local cache, no clone-side
  files.

`memory` is deliberately staged second (see §F).

## B. The registry

A registry maps name → source instance, built once per pack build from the
resolved config. `packs.build_context_pack` asks the planner which sources to
consult, calls `search` on each, and merges. Adding a source is a registry
entry plus an implementation — no change to `packs.py`, the planner's merge,
or the ranker.

Sources are consulted concurrently. A source that raises, times out, or
returns nothing degrades to zero candidates and is recorded in the pack's
provenance — never fails the build. This mirrors the existing fail-open
contract on `fetch_memory_snapshot` and `compile_wiki`.

## C. The planner selects and weights

`planner.py` grows a second output beside `retrievalMode`:

```
{"retrievalMode": "hybrid", "sources": {"code": 1.0, "wiki": 0.6, "memory": 1.4}}
```

Still deterministic, still regex-and-signal driven, still no model call. The
signals it already detects map onto source relevance directly — `path` and
`symbol` anchors favour code, `question` with no anchor favours wiki, the
existing `_MEMORY_RE` signal (`previous`, `regression`, `prior`, `lesson`)
favours memory.

Two rules keep this honest:

- **A weight of 0 means "do not call this source".** That is a latency and
  cost decision, not a quality one — see §H. It must be reachable only from a
  strong signal, and the skipped source is named in pack provenance so a
  missing-context postmortem can see it.
- **No model may enter this path.** Task-time LLM recon is the gather phase:
  it shipped, it was A/B'd against the two-set gate, it failed, and #1049 was
  closed with the flag off. Source selection is a small classification a
  signal table can do; the moment it becomes a model call we are re-running a
  paid experiment.

## D. Merge and authority

One pool, one ranker, the existing tiering. `authority_demotion` already
encodes the rule this design must not lose ([retrieval.py:161](../../../agentrail/context/retrieval.py)):

| tier | delta | sources |
|---|---|---|
| `critical` | +0.45 | `context_doc`, `taste_doc` |
| `high` | +0.30 | pinned/required context |
| normal | 0.00 | code, docs |
| `generated` | −0.20 | `wiki_doc` |
| `low` | −0.45 | low-trust |
| `denied` | −999 | secrets, denied paths |

The `generated` demotion is what makes "a wiki page never outranks an
equally-matched code source" true, and it is only expressible because both
candidates are scored in one comparison. Per-source result lists cannot state
it. Freshness demotions (`memory_freshness`, `wiki_page_freshness`) apply
after the merge, unchanged.

## E. Score comparability — the hard part

BM25 scores are corpus-relative: inverse document frequency depends on what is
in the corpus. A score from a 64-page wiki corpus and a score from a
40k-chunk code corpus are not on the same scale, and naively concatenating
them lets corpus size decide the pack.

The pack must not ship until this is settled. Two candidate approaches, to be
decided with measurement rather than argument:

1. **Rank-based fusion.** Each source returns its own ranking; the merge uses
   reciprocal rank fusion, which is scale-free by construction. Loses score
   magnitude, which the authority deltas currently act on — those would move to
   rank offsets.
2. **Per-source normalization to a shared scale**, calibrated once against the
   retrieval fixtures so the mapping is measured, not assumed. Keeps the
   existing additive authority/freshness arithmetic intact.

(2) preserves more of what is already tuned and is the starting assumption.
(1) is the fallback if calibration proves unstable across repos.

## F. What happens to memory

Memory is currently two different things: `memory_lane` (a deterministic,
independently byte-capped lane that bypasses the retrieval budget entirely)
and file-backed `memory` records that *are* ranked. Folding the lane into the
registry is the right end state but it changes pack bytes for every run,
including runs with no wiki and no new source.

So: memory stays a lane in phase one. The registry ships with `code` and
`wiki`, proves the interface and the merge, and memory migrates as its own
change with its own gate run. This keeps the first measurement clean —
whatever the gate says, it is saying it about the wiki, not about a memory
regression riding along.

## G. Server side

There is no search on the server today. `/api/v1/context/wiki-pages`, the
workspace `/wiki` route, and Jace's `fetch_repo_wiki` are all list-or-read by
repo. So:

- **`wiki.read` / `wiki.list` need no new server work.** The existing
  authed list endpoint plus `load_link` already gives a runner everything the
  CLI needs. This is why `agentrail context wiki show|status` can go
  server-backed first, independently of the registry, and is the natural first
  PR.
- **`wiki.search` is net-new.** It must run comparable ranking over page
  bodies, not Postgres full-text defaults, or wiki relevance will be
  measurably worse than code relevance and the merge will fill packs with the
  wrong pages. The realistic options are running the same BM25 + rerank code
  server-side over page bodies, or returning the full page set for small
  repos and ranking locally with a documented page-count ceiling above which
  server-side ranking is required.

## H. What we are actually buying

Stated plainly so it is measured honestly: **source selection buys latency and
call volume, not pack precision.** The pack budget already filters — an
irrelevant wiki page scores low and never reaches the 20-item cap. Skipping a
source saves a round trip; it does not make the pack better.

The errors are asymmetric. Consulting a useless source costs a few hundred
milliseconds the ranker discards. Wrongly skipping a source removes context
the agent cannot know is missing. So the default is to consult, and a zero
weight needs a strong signal behind it.

The precision work is elsewhere in this design: per-source *weighting* (a
regression scoring prior-task memory up), and the merge putting wiki prose in
honest competition with firsthand code.

## I. Measurement

The two-set acceptance gate, unchanged: no regression on the seen set, no
regression on the held-out set, improvement on at least one. Arms:

- registry OFF (today's code path) vs registry ON with `code` only — must be
  byte-identical or the wrapper is wrong.
- registry ON with `code` + `wiki` — the question the gate exists to answer.

Orientation probes (`agentrail/context/orientation-probes.json`) and the
retrieval fixtures both need wiki-answerable cases added; the existing corpora
cannot reward an orientation layer (audit finding, 2026-07-23).

## J. Non-goals

- No model call in the pack path.
- No change to how the wiki is compiled, pushed, or rendered in the console.
- No change to Jace's `fetch_repo_wiki`, which is already server-backed and
  needs nothing from this design.
- No new knowledge sources in phase one. The point is that adding them later
  is cheap, not that we add them now.

## K. Sequence

1. **Split #1475** to the pieces that survive any version of this: the
   `origin_repo_full_name` move to `shared/git.py`, Jace's wiki grounding
   rules, and the zero-ceiling compile test. Removes the hydration path, the
   hosted-config `summary` block, and the executor prompt ladder (which has no
   data to point at until step 2). Nothing flips in production on merge.
2. **Server-backed `agentrail context wiki show|status|search`**, with the
   executor prompt ladder shipped alongside it so the commands the prompt
   names actually return pages.
3. **The registry**, `code` source only, gated. Prove byte-identical packs.
4. **The `wiki` source** and the planner's source weights. Run the gate.
5. **Migrate the memory lane** into the registry, as its own change.

Steps 3–5 each carry a flag defaulting off.

## Open questions

- §E: rank fusion or calibrated normalization. Decide with the fixtures.
- §G: the page-count ceiling above which local ranking over a full page set
  stops being acceptable.
- Whether `index.py:2214`'s cache-shortcut bypass can be deleted outright once
  no compile happens on the run path. It exists so a page can regenerate when
  the source tree is unchanged, which is an onboarder concern, not a run one.
