# Briefs — Jace's durable understanding of one idea

Status: design. v1 cut in "Out of scope".

## Problem

Grilling is the highest-leverage step in the whole factory: every issue, every
run, and every PR downstream is bounded by how well the idea was pinned. Today
it is the weakest.

Evidence — the `i want to add a blog our app` session, 2026-07-27 14:57–15:10 UTC,
9 turns on `z-ai/glm-4.6`
([first turn](https://jp.cloud.langfuse.com/project/cmrnqtog20006ad0ed9f9ct1o/traces/3da8c4cb637f2b2803eea8ba01b9c0c2),
[last](https://jp.cloud.langfuse.com/project/cmrnqtog20006ad0ed9f9ct1o/traces/88d31e550adfca1045284b8e221ab8db)).
The only tool call in the entire session was `load_skill('grill-me')`. Two
independent failures:

**Nothing went in.** No `fetch_repo_wiki`, no `fetch_workspace_memory`, no
`fetch_backlog` — all available. So Jace asked the human what the repo already
answers: turn 9 was *"What's your current tech stack? Frontend framework?
Backend? Where is the app hosted?"*, two turns after the user had said
"monorepo" and "console". The rule in `instructions.md` that says call
`fetch_repo_wiki` FIRST is scoped to *"a connected-repo ARCHITECTURE question"*
— i.e. when the human asks one. Grilling isn't one, so nothing routes repo
context into ideation at all.

**Nothing came out.** Nine questions, zero of grill-me's six areas closed, no
summary, session dead. And the skill's only persistence instruction
(`skills/grill-me/SKILL.md:55`) is to write `CONTEXT.md`, with `docs/adr/` at
:73 — both impossible in the hosted deployment, which by design has no
checkout (`apps/jace/Dockerfile` installs no git and clones no repo). Those
writes land in an ephemeral `/workspace` sandbox and die with the container.
A phantom write is worse than no write: it reads as captured.

`wiki_pages.ts` already states the principle this violates — *"clones are
ephemeral … so a checkout can never be where wiki knowledge lives."* Elicited
knowledge needs the same server-durable home compiled knowledge already has.

## Design

### The unit: one brief per idea

A **brief** is the durable understanding of ONE product idea, keyed
`(workspace_id, slug)` — upsert-by-identity, mirroring `wiki_pages`'
`(repository_id, slug)`. It is long-lived and evolves: adding auth to the blog
six months on reopens the same brief rather than forking a second one, because
that is the same product understanding growing, not a new idea.

Jace proposes the slug; the human renames it in the console. The slug is
stable identity, not something the model re-invents per conversation.

Sessions attach many-to-one (`jace_session_ids[]`). Briefs outlive every
conversation that touches them, and `repository_id` is nullable so a brief can
exist before a repo is connected.

### Items, not prose

A brief is a set of typed items, not a document. Everything the model needs to
reason about — what's settled, what's missing, what shipped — falls out of one
row shape rather than needing a second reporting layer.

| Field | Values | Purpose |
|---|---|---|
| `area` | problem \| users \| constraints \| scope \| success-signal | grill-me coverage |
| `statement` | text | the requirement, normalized |
| `evidence` | text | the user's own words that settled it, verbatim |
| `kind` | required \| optional \| unknown \| out-of-scope | is this a requirement, and how firm |
| `state` | open \| resolved | is it still live in the current phase |
| `resolution` | implemented \| deferred \| rejected \| satisfied-elsewhere | set when `state = resolved` |
| `authority` | human \| jace | who asserted it |

`statement` alone is not enough. After a context compaction Jace has the brief
and nothing else; a normalized paraphrase loses the *why* and the next turn
re-asks a settled question — the original bug. `evidence` keeps the intent:
*"for now since am the only one approve to publish it"* carries more on resume
than "single approver model."

### state and resolution

`state` exists because a brief lives forever but readiness is a property of the
CURRENT phase. Phase one's settled items must not block phase two, and phase
two's fresh unknowns must not be masked by phase one's completeness. The
readiness check runs over `open` items only.

`resolution` exists because not every requirement ends in shipped code. Without
it, "which requirements were implemented?" and "what did we reject?" cannot be
answered from state alone.

**`deferred` seeds the next phase.** A deferred item is resolved for gate
purposes but stays on the brief as known future work; reopening the brief flips
chosen deferred items back to `open`. That IS the reopen mechanism, and it
means phase two never starts from a blank page.

**An `unknown` may never be deferred.** It can only be answered (→ `required` /
`optional`) or marked `out-of-scope`. "We'll figure it out later" is precisely
the gap a builder fills by inventing an acceptance criterion. `out-of-scope`
removes work from the idea; `deferred` schedules it — distinct, not
overlapping.

### Autosave, and a label the model cannot game

No save action. Every resolved item writes on the turn it resolves, as a delta
— Jace patches one item, never rewrites the brief. Full-replace writes would
cost a full regurgitation per turn and let the model silently drop earlier
content.

Autosave is not only crash insurance: it is what lets Jace survive context
compaction, because the understanding is already externalized.

`status` is `draft | ready` and is a HUMAN label, toggled in the console.
Implementation-readiness is computed separately from the items. `to-issues`
gates on the computed check, never the label — otherwise "ready" becomes a flag
the model sets to unblock itself.

### Human edits win, enforced at the route

An item with `authority: human` is locked: `save_brief` drops writes to it.
This is route enforcement, not a prompt instruction — "please don't overwrite"
fails the first time the model feels confident, and a human whose correction is
silently reverted stops correcting.

### Retrieval — the whole mismatch surface

Briefs are small by construction: one idea, item-sized statements, no
transcript. `get` returns the whole brief; nothing is ever ranked or trimmed
INSIDE one. So retrieval only ever answers *which brief*, never *which part* —
which confines the entire risk to one decision, with two ways to get it wrong:

- **False attach** — "I want a changelog" lands on `brief/blog`. Two ideas
  merge, and with reopen-by-default there is no close to bound the damage.
- **False new** — "the blog thing" opens `brief/blog-2`. Context splits and
  resume degrades over time instead of improving.

Semantic matching alone commits both, so the human is the tiebreaker exactly
once per conversation:

1. **Shortlist** by FTS/BM25 over brief titles and statements — the same rail
   `retrieveMemory` uses at step 1. Embeddings stay out; the house position is
   lexical + graph and this does not justify reversing it.
2. **Confirm before the first write** in a conversation: *"This sounds like the
   Blog brief — continue it, or start something new?"*
3. **Anchor** the confirmed brief id on the `jace_sessions` row for the rest of
   the conversation.
4. **Re-confirm on drift** — a later message scoring poorly against the anchor
   asks again rather than writing. The failure mode is a redundant question,
   never a corrupted brief.

### Grounding, and forced re-grounding when stale

A brief stores `grounding`: the wiki page slugs and memory item ids read at
last write, with the wiki's own commit stamp. Every wiki page is already
provenance-stamped, so this is a comparison, not new machinery.

On resume Jace compares stamps. Same commit — continue. Any cited page moved —
**re-ground before proposing, and say so.** Not a warning it can talk past: a
three-week-old read of a repo that has since moved is exactly how a confident
wrong proposal gets made.

### Readiness gate

`to-issues` is BLOCKED while any `open` item has `kind: unknown`. An unknown
that reaches an issue becomes an acceptance criterion the builder invents —
that is where hallucination enters the factory.

The gate cannot become a workaround because both exits are themselves recorded
decisions with an author and a timestamp: answer the unknown, or mark it
`out-of-scope`. Deleting the item is the only bypass, and it is visible.

### Brief → Work (not Brief → Issue)

Depending on scope a brief produces no work yet, one issue, several issues, or
an epic that expands into issues. The shape decision is derived at planning
time and does not mutate the brief.

The RESULT is recorded: a link table between brief items and issues, each link
carrying a role (`epic-parent` | `slice`). Without it nothing can flip items to
`resolved / implemented`, and "what shipped for this idea" has no answer.
`to-issues` already publishes an epic as a parent issue first and points slices
at it as Parent, so the epic case needs no new mechanism — only the link.

**The runner never learns briefs exist.** It executes from the issue and its
context pack, unchanged. Briefs are the planning artifact; issues are the
execution artifact.

### Server seam

- `GET|POST /api/v1/runner/briefs` — sibling of the existing
  `runner/workspace-memory` GET, using the same `requireJaceConsoleSecret` +
  `eveSessionId` → `workspaceId` resolution, so no new tenancy surface.
  `scanForSecrets` on write, as `ingest/memory-items` already does.
- `fetch_briefs(mode: list | get | search)` — same three-mode shape as
  `fetch_repo_wiki`, so there is one idiom to learn.
- `save_brief(slug, patch)` — delta only. No approval gate: it is internal and
  reversible, and `create_issue` remains the only boundary crossing.
- Console: a brief view with per-item editing. A human edit flips
  `authority: human` and locks the item.

### grill-me changes

- **Preflight before question one**: `fetch_repo_wiki(list)` +
  `fetch_workspace_memory` + `fetch_briefs(search)`. Never ask for what those
  returned.
- **Resume, don't restart**: open with what is settled, the question that was
  in flight, and what is still open. Not "so, tell me about the blog."
- **Write as you go**, per resolved item.
- **Drive to the gate**: keep closing areas until the readiness check passes.
- **Delete the `CONTEXT.md` and ADR sections.** Jace never authors either.
  Repos that maintain a `CONTEXT.md` keep it, and Jace reads it through the
  wiki — read-only, always.

## v1 contract (pinned — parallel slices build against this)

Migration slots are pre-assigned so concurrent slices never collide:
**0055_briefs** (store) and **0056_jace_sessions_brief_anchor** (retrieval).
Both must be registered in `drizzle/migrations/meta/_journal.json` — a
migration absent from the journal is silently skipped.

**Tables** (`packages/db-postgres/src/schema/briefs.ts`)

- `briefs` — `id`, `workspace_id` (FK workspaces, cascade), `repository_id`
  (FK repositories, set null, NULLABLE), `slug`, `title`, `status`
  (`draft|ready`, default `draft`), `open_question` (text, default `''`),
  `grounding` (jsonb, default `{}`), `jace_session_ids` (jsonb, default `[]`),
  `created_at`, `updated_at`. UNIQUE `(workspace_id, slug)`.
- `brief_items` — `id`, `brief_id` (FK briefs, cascade), `area`, `statement`,
  `evidence` (default `''`), `kind`, `state` (default `open`), `resolution`
  (NULLABLE), `authority` (default `jace`), `created_at`, `updated_at`.
- `brief_work_links` — `id`, `brief_id`, `brief_item_id` (NULLABLE), `repo`,
  `issue_number`, `role` (`epic-parent|slice`), `created_at`.

pgEnums: `brief_area` (problem, users, constraints, scope, success-signal),
`brief_item_kind` (required, optional, unknown, out-of-scope),
`brief_item_state` (open, resolved), `brief_item_resolution` (implemented,
deferred, rejected, satisfied-elsewhere), `brief_authority` (human, jace).

**Query exports** (`packages/db-postgres/src/queries/briefs.ts`):
`upsertBrief`, `getBriefBySlug`, `listBriefs`, `searchBriefs` (FTS, mirroring
`fetchFtsCandidates`), `patchBriefItems`, `setBriefStatus`, `linkBriefWork`,
`computeBriefReadiness`.

**Route**: `GET /api/v1/runner/briefs?eveSessionId=&mode=list|get|search&slug=&query=`
and `POST /api/v1/runner/briefs` with `{ eveSessionId, slug, patch }`.

**Tools**: `fetch_briefs({ mode, slug?, query? })` and
`save_brief({ slug, title?, status?, openQuestion?, grounding?, items? })`
where each item is `{ id?, area, statement, evidence?, kind, state?, resolution? }`.

Two invariants live in the ROUTE, not in any prompt: items with
`authority: 'human'` are never overwritten by `save_brief`, and `save_brief`
may not set `state: 'resolved'` on an item whose `kind` is `unknown`, with any
resolution or none — an unknown is not a requirement yet, so there is nothing
to resolve. Change the kind first (answered → `required`/`optional`, dropped →
`out-of-scope`). Naming only `deferred` here would close one door in a room
with four: the readiness gate keys on `state = 'open' AND kind = 'unknown'`, so
ANY resolution clears it.

## Verification

- A grill interrupted mid-session leaves a brief whose items match the answers
  given, and a recorded in-flight question. Replay of the blog transcript
  yields ≥ 3 pinned areas rather than 0.
- A second conversation on the same idea opens by naming what is settled and
  asks no question already answered in the brief.
- A human console edit survives a subsequent `save_brief` touching the same
  item.
- `to-issues` refuses to run with one `open` + `unknown` item, and proceeds
  once it is marked `out-of-scope`.
- A brief cited against a wiki page that has since recompiled triggers a
  re-ground before any proposal.
- Issues created from a brief appear in the link table; their items read
  `resolved / implemented`.

## Out of scope

v1 ships the invariants — the parts that corrupt data or lose knowledge if got
wrong later. Everything below is additive and waits for real usage:

- **Item revision history.** `updated_at` + `authority` is enough for v1.
- **Split-brief repair** for a false attach. Confirm-once is the prevention;
  the repair is the known follow-up.
- **Automatic work-shape derivation** (single / multiple / epic). v1 records
  whatever links `to-issues` produces; Jace and the human decide the shape.
- **Guided reopen UX.** The data supports flipping deferred items to `open` in
  v1; the flow can wait.
- **Projection into `memory_items`.** Briefs stay self-contained — one store,
  one reader, no mirror to keep in sync.
- **Langfuse session grouping.** These traces carry an empty `sessionId`, so a
  grill cannot be reviewed as a unit today. Needed before any eval of whether
  this worked; tracked separately.
