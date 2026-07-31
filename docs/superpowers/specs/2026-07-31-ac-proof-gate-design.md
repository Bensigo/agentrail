# AC Proof Gate — Design (Arc C)

**Date:** 2026-07-31
**Status:** Directional — approved shape; gets a refinement pass (including a fresh read of the current pipeline code) when its build starts. Per the owner memo: **this arc is the product** — infrastructure everything else consumes, not a feature.
**Scope:** Core pipeline (`agentrail/`): per-AC evidence binding, a coverage computation that can actually fail, the run-level evidence artifact, and a verification refusal state.
**Prior art:** the audit's central finding — `agentrail/guardrails/policies/check_runner.py` `ac_coverage_for` returns `covered=total` unconditionally ("per-AC mapping deferred to the Verifier #782" and never built); the Objective Gate structurally cannot fail on AC coverage.
**Non-goals:** replacing the red-green trail, best-of-N, or the independent verifier (all stay — they are the scaffolding the audit called genuinely excellent); model-judged semantic AC matching as the *gate* (models propose bindings; the gate enforces bound evidence exists and passed); Jace-side changes (Arcs A/B own those).

## Judgment removed

- **Verification** — "done" stops being one model's one-line verdict and
  becomes a per-AC evidence table a human can audit in seconds.
- **Merge confidence** — the trust claim "every AC is proven or explicitly
  waived" is the foundation every other arc's claims rest on.

## Problem

The entire binding between "what was asked" and "what shipped" is one
model line (`VERDICT: accept`, reason capped at one line) sitting on a
coverage function that cannot return less than 100%. Jace produces more
artifacts than competitors and less proof: a senior still re-derives
everything.

## Decision

Each AC must bind to evidence before a run may claim done:

- a **named test** (declared binding, executed, passing), or
- a **QA `verified`** verdict for that criterion (post-ship path), or
- an **explicit human waiver** (recorded, visible).

Coverage becomes `covered = ACs-with-passing-evidence / total` — a number
that can fail the gate. A run that cannot bind an AC does not go green; it
**refuses honestly**: "I can build this but I cannot verify AC3 — here is
what I'd need." A system that never refuses is a system whose approval
carries no information.

## Design

### 1. Binding declaration (builder-side)

The run's builder declares bindings as it works — an `ac_bindings` section
in the run artifacts mapping `AC<n> → [test identifiers]` (exact test
names/ids as the repo's runner reports them). The red-green TRAIL entries
gain an optional `acRef`, so a test written red-first for AC2 carries that
provenance from birth. Model-proposed, machine-verified: the gate checks
each bound test exists in the executed suite and passed; a binding to a
test that never ran, or failed, is an unbound AC.

### 2. The gate (`ac_coverage_for` rewritten)

`ac_coverage_for` takes the parsed ACs (house checkbox format — already
the intake contract) plus the bindings and the verify-run results, and
returns real per-AC status: `proven (test) | proven (qa) | waived |
unbound`. Gate policy: any `unbound` AC → the run cannot green. The
existing tri-state gate and fail-closed parsing stay; this changes the
input from a constant to a computation.

### 3. The refusal state

A run with unbound ACs terminates in a new explicit outcome —
`unverifiable` — carrying the structured list: `[{ ac, why_unbound,
what_would_prove_it }]`. It routes to the owner like an escalation (not a
failure): approve a waiver, supply what's needed, or amend the AC. Waivers
are first-class rows (who, when, why), never silent config.

### 4. The evidence artifact

Every run emits `ac_evidence.json`: `[{ acId, text, status, evidence:
[{ type: test|qa|waiver, ref, result, at }] }]` — stored with run
artifacts and served through the console. This is the verification section
of Arc D's Change Record and the substrate of Arc E's calibration
(gate-held-vs-reverted per repo).

## Evidence & reuse

`ac_evidence.json` (per run, keyed run id + PR + headSha) is consumed by:
Arc D (Change Record verification stage), Arc E (calibration + false_green
rows join gate verdicts to revert events), and Arc B's posted reviews
(the reviewer can cite proven-vs-unbound status per AC instead of
inferring coverage from the diff alone — a later, natural upgrade to
`acCoverage`).

## Testing (sketch)

Python suite: binding parse/validate, coverage math (unbound fails),
waiver rows, refusal outcome shape, gate integration (a run with 3 ACs and
2 bindings cannot green), artifact schema round-trip, and a regression
test pinning that `covered == total` is no longer unconditional — the
audit's exact hole, made unrepresentable.

## Rollout

Flagged (`AC_PROOF_GATE`), staged: observe-only first (compute + emit the
artifact, don't gate), then enforce per workspace, dogfooding on
agentrail's own repos first. The observe-only stage also backfills the
calibration baseline Arc E wants.

## North-star note

This is the arc that makes **merge confidence** a measurable claim
("every AC proven or waived, here's the table") and gives **escaped
production defects** a denominator worth publishing. Refusal rate becomes
a shipped metric — the strongest trust signal in the category.
