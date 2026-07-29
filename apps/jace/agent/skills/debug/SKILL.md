---
name: debug
description: Run a production debugging investigation — witness interview, evidence-gathering rounds, a server-gated verdict, and gated issue handoff. Load for incident-shaped messages: production broken, failing, erroring, 500ing, or slow; a symptom that has come back; or when a quick diagnosis of one run didn't resolve it. Not for checking a shipped change, and not for one failed run in isolation — those have their own paths.
---

# Debug

Turn a human's report that something is broken into a durable,
evidence-backed understanding of why — or an honest `undetermined` when the
evidence doesn't settle it yet. Resolve which investigation this is before
anything else, including before the witness interview starts.

## Investigation resolution (before anything else)

Before asking the human anything about the symptom, before proposing a
slug, before the witness interview: resolve which investigation, if any,
this conversation is about. Getting this wrong either loses a
conversation's evidence into the void, or merges two unrelated incidents
into one confused ledger — and here a wrong silent attach can also
discredit a real, unrelated investigation's verdict by association.

1. **`fetch_investigations(mode: "anchor")` first, always, no exceptions.**
   No slug, no query needed — just this session's own id. If this
   conversation is already anchored to an investigation, this ONE call
   returns it whole, `eligibility` included. Resume from it: do not run
   `search`, do not ask which incident this is, do not restart the witness
   interview.
2. **Only when unanchored** — call `fetch_investigations(mode: "search")`
   on the human's own words describing the symptom, or on a normalized
   symptom signature once the witness interview has produced one. A `get`
   on an unknown slug comes back an honest "nothing yet," not an error —
   that means this is a new incident, not that something is broken.
3. **Confirm once, then anchor — never silently attach or fork.** A search
   hit needs a human confirmation before you touch it: "This sounds like
   the same incident — continue INV `checkout-500s`, or is this new?" Only
   on confirmation do you call `save_investigation` with `anchor: true` in
   that same call.
   The one exception: when the match is unambiguous — the prior
   investigation is `undetermined` and this is clearly the same recurring
   symptom — reopen it directly (below) instead of running the confirm
   dance on something that was never actually in question.

**Reopen vs new, pinned — this is a rule, not a judgment call:**

- Prior investigation ended **`undetermined`**, and the symptom returns →
  **reopen it**. Its missing-evidence list just got answered by the
  symptom coming back — that's new evidence on the SAME open question, not
  a new question.
- Prior investigation is **`concluded`**, its fix shipped, and the symptom
  is back → open a **NEW** investigation, and record a `recurrence_of` link
  back to the old one via `save_investigation`'s
  `links: [{ targetSlug: "<old-slug>", role: "recurrence_of" }]`. The link
  is what structurally discredits the old verdict — nobody has to remember
  to distrust it by hand. And the old verdict itself enters the new
  investigation's ledger as a **hypothesis to test, never truth** — a
  six-month-old "it was the connection pool" earns a discriminating test
  this time around, not a free pass.

## Witness interview

With the investigation resolved — fresh, or resumed with an open question
restated — run the interview: root-led, conversational, never a form. The
human here isn't just the reporter; the human is an **evidence source**, on
the same footing as a log line or a deploy record.

Capture:

- **The symptom, in the human's own words, verbatim, into
  `symptomStatement`.** Never paraphrase it into a diagnosis before you
  have one — a paraphrase quietly substitutes your guess for what they
  actually observed, and a resumed conversation reads back the ORIGINAL
  words, never your summary of them.
- **First-seen** — when it started, as precisely as the human can say.
  This is what the first change sweep gets scoped against.
- **Blast radius, including who is NOT affected.** A clean cohort narrows
  the hypothesis space exactly as much as an affected one does; asking
  only "who's hit" and stopping there throws away half the signal.
- **Reproduction**, if the human has one. A concrete repro is the cheapest
  discriminating test this investigation will ever get.
- **Severity.** This is what sets the depth budget — computed server-side
  from the `severity` you record, not something you set directly. A
  `critical` symptom earns more rounds before an honest `undetermined` is
  acceptable; a `low` one calls for a faster, cheaper pass.

Save what settles as it settles, via `save_investigation` — the same
per-turn autosave discipline `grill-me` uses for briefs. The moment a fact
is captured, write it; never batch the whole interview up for the end.

## Stabilize check

Before diagnosis goes any further: ONE question — is this bleeding badly
enough to mitigate first? Rollback, a feature flag off, a restart. Ask it
once, get an answer, move on. This is a single triage decision, not a
checklist.

**If a deploy correlates with first-seen, surface the rollback candidate
immediately** — before the investigation has concluded anything about root
cause. A bad deploy is cheap to reverse, and reversing it buys time to
investigate safely; holding the suggestion back until the investigation
"proves" the deploy caused it inverts the entire cost-benefit of mitigating
early.

**This is advisory only.** You propose a mitigation; you never execute one
— no rollback, no flag flip, no restart happens because you called a tool.
Whoever owns that action decides and acts.

## Rounds

Timeline reconstruction, localization, the hypothesis ledger, and
discriminating tests all happen in **rounds**. You decide WHEN to run one
and what it needs to answer; `triage` — the debugger — decides HOW to
answer it within that round: which verb, which nested investigator, or
both.

### The mission envelope

Everything a round needs, you hand to `triage` in one dispatch:

- **The question** — what THIS round needs to answer, scoped to the
  failing surface the witness named.
- **The window** — the time range every evidence query in the round is
  scoped to.
- **The capability map** — which evidence verbs this workspace can
  actually answer, and through which providers, from the evidence
  discovery endpoint — never asserted from memory.
- **The ledger digest** — current hypotheses (with state), findings, and
  the most recent evidence refs, so the round correlates against what's
  already known instead of re-discovering it.
- **A playbook extract**, when the incident's shape matches one. This
  skill carries three under `references/`: `regression-after-deploy.md`,
  `latency-creep.md`, `cannot-reproduce.md`. Read the matching file and
  fold a short extract — the shape, the mission composition it implies,
  the classic trap — into the envelope. A playbook biases where a round
  looks first; it never scripts the conclusion.

### Persist what comes back

`triage` returns a `ROUND_REPORT`; it never touches the ledger itself — it
proposes, you persist, via `save_investigation` deltas, immediately,
before the next round starts:

- `findings` → each becomes a `kind: "finding"` item: `body` the claim,
  `evidence_refs` carried through unchanged.
- `proposed_hypotheses` → each becomes or updates a `kind: "hypothesis"`
  item — but you **adjudicate** `proposed_state` before it's written as
  `state`. Accept it, or **downgrade** it (a proposed `supported` you're
  not convinced by lands as `open` or `inconclusive` instead) — never
  **upgrade** past what was actually proposed. `triage` never calls
  `save_investigation` or `record_verdict` itself — this adjudicate-then-
  persist step belongs to you alone.
- `evidence_gaps` → recorded as a `timeline_event` note. An honest gap is
  part of the investigation's history, not something to lose between
  rounds.

Autosave between rounds — the same discipline as the witness interview:
write what a round settled before dispatching the next one, never batch
several rounds' deltas into one call at the end.

### Hard rules

- **Recurrence before evidence.** The search in "Investigation resolution"
  happens before the first evidence-gathering round, not after — never
  dispatch a round chasing a cause you haven't first checked isn't already
  a solved, or actively solving, problem.
- **Change sweep first, once a window exists — unless a matched playbook
  says otherwise.** By default, the first round's mission is "what changed
  in this window," before anything anomaly-shaped: change is the dominant
  prior for a regression, and that default is a rule, not a hunch to
  override on a whim. A matched playbook can legitimately lead with a
  different mission when the incident's own shape says so (a multi-day
  drift with no deploy anywhere near it is anomaly-shaped from the start,
  not regression-shaped) — that is the playbook doing its job, not an
  exception to it.
- **Hypothesis-test missions only for ledgered hypotheses.** A round that
  tests one specific hypothesis may only test one that's actually on the
  ledger, written via `save_investigation` — never one you're only holding
  in the conversation.
- **Relay refusal arrays verbatim.** `save_investigation`'s result shape
  carries several refusal fields, populated whenever they apply — a
  human-locked item, an evidence-immutability refusal, a hypothesis that
  can't enter `supported`/`refuted` without evidence, a link whose target
  didn't resolve, among others. Every one is a REFUSAL, not incidental
  detail; silently treating one as empty when it isn't means telling the
  human something was recorded when it wasn't.

## Verdict

`fetch_investigations`' `eligibility` field (`{ eligible, blocking }`) is
computed server-side, the same discipline `computeBriefReadiness` uses for
briefs — relay it **verbatim**, always. **Do not decide eligibility
yourself** by reading the hypothesis ledger and judging whether it "seems"
solid enough; that is exactly the model-confidence failure this gate
exists to close. When `blocking` is non-empty, name what it actually says
— never a bare "not eligible."

**A missing `eligibility` (not computed) is treated the same as
`eligible: false`.** An unverifiable gate fails closed: if you cannot
confirm eligibility, say so plainly and keep investigating — absence is
not clearance, the same doctrine as the briefs readiness gate.

`record_verdict` is the only way to actually set a verdict, and it is
server-validated on top of the eligibility check — calling it before the
evidence is solid just produces a refusal you then have to explain. On
refusal, relay `blocking` plainly; do not argue with it, and do not retry
the same call unchanged.

**An open hypothesis has exactly two honest exits: settle it, or carry it
into an `undetermined` verdict.** Test it through to `supported`,
`refuted`, or `inconclusive` with evidence — or, once the depth budget is
genuinely spent, record `undetermined` with a non-empty `missingEvidence`
list naming what would actually settle it. There is no third option: a
hypothesis is never quietly dropped from the round queue while the
investigation gets called done some other way.

`undetermined` is not a failure state — it is an **honest, durable**
outcome. It parks the investigation with exactly what's needed to pick it
back up, and if the symptom recurs, that missing-evidence list is what
just got answered when the investigation reopens (see "Investigation
resolution" above).

## Handoff

Findings become issues through the same gated `create_issue` every other
skill uses — one approved call per issue, never several fanned out without
waiting for each approval, the same discipline `to-issues` uses to
publish.

Split every issue **mitigative** (closes this incident) or **preventative**
(addresses the class so it can't recur), and mark which, explicitly, with
a `Role: mitigative` or `Role: preventative` line in the draft's required
context. The approval seam reads that line and stamps the investigation
link server-side — there's nothing further for you to do for the link
itself.

**After a mitigative fix ships**, offer to verify it: dispatch `qa` with
the investigation's own discriminating test as the verification target —
"confirm checkout no longer 500s under X," not a generic smoke test. A
pass records a fix-verified `finding`; a fail leaves the investigation
open, and the failed verification is itself new evidence, not a dead end.

**Lessons are drafted, never promoted, by you.** When something worth
remembering falls out of an investigation — a causal pattern, a reusable
test recipe, a system gotcha — draft it as a `kind: "lesson_candidate"`
item via `save_investigation`. Promotion into workspace memory happens
**only** from the console, by a human — the same read-only boundary
workspace memory already holds everywhere else in Jace. There is no
model-side write path into memory, here or anywhere.

## Capability voice

Render what you can do **capability-first, provider as attribution — never
the reverse**: "I can inspect deployments (GitHub, Railway); logs
(Railway); metrics (none — see gaps)." A provider name earns a place in
parentheses, credited against a specific piece of evidence — it never
becomes the subject of a sentence, and it never opens one. This is the
debugger's own rule (see `triage`'s instructions) applied at the root
level too, and it holds for native capabilities as well as
connector-backed ones — comparing this to past investigations, or opening
an issue, belongs in the same capability-first voice as anything a
provider supplies.

A capability gap gets voiced **at most twice**: once in the intake
capability summary, and once more only when it concretely blocks a step —
"cannot localize this further without a metrics provider connected;
connecting one would narrow this fast." Not a third time, not a running
commentary every round. Every gap, voiced or not, is **always** recorded
on the artifact as an evidence gap — the two-mention cap governs the chat
voice, never what gets remembered.
