# Review-gate realignment to ADR 0007

**Date:** 2026-06-17
**Status:** Design — approved for planning
**Related:** [ADR 0007](../../adr/0007-objective-gate-is-done-review-advisory.md), ADR 0008 (anti-false-green roles)

## Problem

The code carries two conflicting models of "review".

ADR 0007 already decided the intended one: a run's definition of **done** is the
**Objective Gate** (tests, build, lint pass + acceptance criteria met). LLM code
review is **advisory only** — findings are suggestions a human can convert into
issues on the dashboard. Merge is gated by objective signals, never by an LLM
verdict.

The implementation never followed it:

- `agentrail/afk/review.py` splits findings into `blocking` (P0/P1) and
  `advisory` (P2/P3). Blocking findings gate the merge and trigger auto-fix.
- `agentrail/afk/runner.py` `_review_loop` blocks merge on `has_blocking`,
  auto-fixes in place, re-reviews, and escalates to `human-review-needed`. This
  is the "LLM verdict decides merge" loop ADR 0007 says to remove.
- `apps/console/.../review-gates/page.tsx` frames findings as failures
  ("Blocking reasons", red "N bugs" badge, "why it blocked") and has **no** way
  to turn a finding into an issue — the core human-triage interaction is missing.
- There is **no objective gate in code at all**: `_merge` just squash-merges.
  Today the *only* thing gating merge is review findings being clean. So
  naively making findings advisory would merge every PR unconditionally — worse
  than the status quo.

## Goal

1. Merge is gated **only** by an objective gate (CI green + deterministic
   security checks). Never by LLM findings.
2. All LLM review findings are **advisory**. They are surfaced on the Review
   Gates page.
3. From the Review Gates page a human can convert any finding into a **Linear**
   (if the Linear connector is active) or **GitHub** issue, formatted with our
   house issue standard.
4. On objective-gate failure the agent gets a **bounded** chance to fix
   (max 2 attempts), then escalates to human review.

Out of scope: changing the review subagent's *prompt* — it already inspects
correctness, security/data-loss risk, missing tests, product mismatch
(`templates/docs/agents/pr-review.md`). Only the handling of its output changes.

---

## Part A — CLI runner

### A1. New module: `agentrail/afk/objective_gate.py`

A deterministic gate. No LLM opinion. Pure-ish logic over `gh` + the PR diff so
it is unit-testable.

```
ObjectiveGateResult:
    state: "pass" | "fail" | "pending"
    reasons: list[str]        # human-readable, e.g. "CI check 'test' failed"
    passed -> state == "pass"
```

Checks:

1. **CI checks** — via a new thin `gh.pr_checks(pr)` wrapper around
   `gh pr checks <pr> --json name,state,conclusion` (or the equivalent status
   API). Policy:
   - any check failed → `fail`, name in `reasons`
   - any check still running/queued → `pending` (caller waits)
   - all checks passed → continue to security checks
   - **zero checks present → `fail`** with reason "no CI checks configured" — a
     merge with no objective signal violates ADR 0007. Not a silent pass.
2. **Security checks** — deterministic, run in-runner on the PR diff so they do
   not depend on the repo's CI configuration:
   - *Secret/key scan* — scan **added** diff lines for high-confidence patterns
     (private-key headers `-----BEGIN ... PRIVATE KEY-----`, AWS access key ids,
     high-entropy `token=`/`api_key=`/`secret=` assignments). Hit → `fail`.
   - *Deleted-file-still-in-use* — for each file deleted in the diff, grep the
     rest of the working tree for imports/references (module path and basename).
     Still referenced → `fail`.

These security checks are defense-in-depth heuristics, not bulletproof. They are
in-runner precisely so a repo without a secret-scanning CI job is still covered.

### A2. Rewrite `agentrail/afk/review.py`

Remove the blocking/advisory split entirely:

- Delete `AUTO_FIX_SEVERITIES`, `autofix_prompt`, `ReviewOutcome.has_blocking`,
  `ReviewOutcome.blocking`, `advisory_comment`'s "P2/P3 do not block" framing.
- `ReviewOutcome` becomes `{ findings: list[Finding], memory_suggestions }`.
- `Finding` keeps `severity` (P0–P3) as **display metadata only** — it routes
  nothing.
- Replace the module docstring's blocking rule with: "All findings are advisory;
  merge is decided by the objective gate (ADR 0007)."
- Keep a single `findings_comment(pr, outcome)` that posts an informational PR
  comment summarizing advisory findings and linking to the dashboard Review
  Gates page. (Informational only — never blocks.)

### A3. Rewrite `_review_loop` in `runner.py`

It stops being a review-fix loop. New shape (rename to `_review_and_gate` for
clarity):

1. Run the review subagent once → advisory `findings`.
2. Push review-gate telemetry (see A4). Post the informational findings PR
   comment.
3. Run the objective gate, polling `gh pr checks` until `state != "pending"` or
   a timeout (reuse the existing round bound as a CI-poll bound).
4. Branch on the gate:
   - **pass** → `_merge`. On success: `MERGED`.
   - **fail** → hand the gate's `reasons` to the agent as an **objective-fix**
     prompt (fix failing CI / security issues — *not* findings). Re-run the
     gate. Bounded to **2 fix attempts**. After the 2nd failed attempt, label
     `human-review-needed`, attach `reasons`, set `HUMAN_REVIEW`.

The objective-fix prompt lives next to the gate (e.g.
`objective_gate.fix_prompt(reasons)`); it instructs the agent to make failing
tests/build/lint pass and resolve flagged security issues with minimal change,
commit, and not open a new PR/issue. LLM findings are never auto-fixed.

### A4. `review_push.py` — flip the telemetry semantics

The review-gate row now describes the **objective gate**, not findings:

- `status` ← objective gate state (`pass`→`passed`, `fail`→`failed`,
  `pending`→`pending`).
- `blocking_reasons` ← objective gate `reasons` (CI/security), **not** findings.
- `findings` ← the full advisory findings list (unchanged shape:
  `{ severity, category, description, suggested_fix }`).

This is the change that makes the dashboard honest: pass/fail reflects objective
signals; findings are a separate advisory list.

---

## Part B — Console Review Gates page

### B1. Reframe `review-gates/page.tsx`

- `passed/failed/pending` now means the **objective gate** state. Update the
  page header copy to ADR 0007 language: the gate passes/fails on objective
  evidence (CI: tests/build/lint, plus security checks); findings are advisory.
- "Blocking reasons" → relabel "Why merge was blocked" (renders the objective
  reasons — data already present).
- Findings count badge: red "N bugs" → neutral "N findings" with advisory
  styling (not red-as-failure).

### B2. Per-finding "Create issue" control

Mirror `failures/[failureId]/failure-actions.tsx`:

- Each finding row gets a "Create issue" button.
- Clicking opens a small editor pre-filled with the house-format body (B4) and a
  target selector.
- Default target: **Linear if the Linear connector is active for the workspace,
  else GitHub**. If both are connected the user can switch.
- Body is editable so a human can tighten the acceptance criterion before
  filing.
- On success show the created issue link (`url`, `number`/`identifier`).

### B3. New route: `app/api/v1/workspaces/[workspaceId]/review-gates/[gateId]/issue/route.ts`

POST body: `{ findingIndex: number, target?: "github" | "linear", title?, body? }`.

- Auth + workspace membership check (same as the failures route).
- Load the gate via `getReviewGate(workspaceId, gateId)`; pick
  `gate.findings[findingIndex]` (404 if out of range).
- Resolve target: explicit `target` wins; otherwise default by connector state
  (Linear active → linear, else github).
- Build title + body via the house-format builder (B4) unless overridden by the
  request.
- Create the issue using GitHub / Linear logic copied from the failures route
  (`createGithubIssue` / `createLinearIssue` shapes).
- Return `{ ok: true, target, url, number? , identifier? }`.

### B4. House-format builder (new shared helper)

Turns a finding into our standard issue body:

```
title: [review] <finding.title or truncated description>

## Parent
Run <runId> · PR <prUrl>

## What to build
<finding.description>
Suggested fix: <finding.suggested_fix>

## Acceptance criteria
- [ ] <derived, human-editable: the described issue is resolved and covered by a test>

## Verification
<derived from finding.category — e.g. tests pass, visual evidence attached>

_Filed from the AgentRail review gate <gateId>, finding #<index>._
```

Pre-filled and editable so the AC is machine-checkable enough to satisfy the
input contract (`agentrail/afk/input_contract.py`) when the issue re-enters the
queue.

---

## Part C — Data

No migration required. Findings remain the gate's JSONB array, referenced by
`(gateId, findingIndex)`: the gate has a stable UUID and the stored array order
is stable. Only the *meaning* of `status` / `blockingReasons` changes (now
objective, per A4). The `findings` finding shape is unchanged.

---

## Testing

- `objective_gate`: unit tests for each branch — CI fail, CI pending, CI pass,
  zero checks, secret detected, deleted-file-still-referenced, all-clear.
  Mock `gh` and the diff; no network.
- `review.py`: `classify` returns a flat advisory `findings` list; no blocking
  concept remains.
- `runner` `_review_and_gate`: pass → merge; fail → fix attempt; 2 failed
  attempts → human-review (assert no merge, label applied). Mock the gate and
  agent.
- Console route: GitHub path, Linear path, default-by-connector, out-of-range
  index → 404, house-format body shape.
- Console page: browser-verify the advisory framing and the create-issue flow
  (per the "verify console UI in browser" practice).

## Risks / notes

- Security heuristics can false-positive (e.g. a deleted file referenced only in
  a comment). Keep patterns conservative; surface the reason so a human can
  override via re-run.
- "Zero CI checks → fail" will hold runs on repos without CI. Acceptable and
  intended under ADR 0007; the dogfood target (this repo) has CI.
- The bounded objective-fix loop (max 2) replaces the old unbounded
  review-fix cascade and keeps the loop falsifiable.
