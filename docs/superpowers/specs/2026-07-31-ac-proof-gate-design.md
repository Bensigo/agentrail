# AC Proof Gate — Design (Arc C)

**Date:** 2026-07-31 (directional) · **2026-08-01 refined build-ready** against a full read of the pipeline code
**Status:** Build-ready; awaiting implementation plan. Per the owner memo: **this arc is the product** — infrastructure everything else consumes.
**Scope:** Core pipeline (`agentrail/`): AC parsing into the run, real per-AC coverage, structured test capture, binding declaration, the `ac_evidence.json` artifact, the `unverifiable` refusal outcome, waivers, and a three-state rollout flag.
**Prior art:** the audit's central finding — `agentrail/guardrails/policies/check_runner.py:98-107` returns `AcCoverage(total=total, covered=total)` unconditionally; the exploration map (2026-08-01) is folded in below with exact seams.
**Non-goals:** per-test granularity for repos whose verify commands cannot emit a JUnit report (they get honest command-level evidence, never fake test-level); DB-backed waiver rows (the sync path has no DB — hosted rows arrive with Arcs D/E); automated QA-evidence joins (schema slot reserved; Arc B/D wire it); console UI for the artifact (Arc D); changing best-of-N, the verifier, or the red-green proof's own validity rules.

## Judgment removed

- **Verification** — "done" stops being one model line on a coverage function
  that cannot fail; it becomes a per-AC evidence table a human audits in
  seconds.
- **Merge confidence** — "every AC proven or explicitly waived" becomes a
  checkable claim, and the foundation every other arc's trust claims rest on.

## Problem (what the code actually does today)

Three facts, verified against the live code, make the current gate
structurally unable to check what it claims:

1. **Coverage never saw the ACs.** The one production call
   (`agentrail/run/pipeline.py:1984`) feeds `ac_coverage_for` the *declared
   verify shell commands* from `.agentrail/config.json` — the variable is
   literally `declared`. The issue's checkboxes are parsed only at queue
   admission (`input_contract.validate`, never imported by the pipeline) and
   in a display-only, stricter-regex duplicate (`run/state.py:28-51`). The
   run itself holds no parsed ACs at all.
2. **There are no test identifiers.** Verify execution collapses each
   declared command to one exit code (`guardrails/adapters/check_runner.py:85-122`);
   `verify_gate.py` invokes pytest with no structured report (`:327-329`).
   Nothing in the system can name a test that passed.
3. **The red-green trail is transient.** `Observation`/`Trail` live only in
   memory; a boolean digest survives into `run.json`. There is no artifact
   to bind ACs to.

So the entire ask-to-shipped binding rests on one model verdict line, and
`covered == total` is unconditional.

## Decision

Build the missing substrate, then the gate, then the refusal — three phases
in one arc, each independently shippable and flag-staged:

- **C1 — Evidence substrate (observe-only).** The run parses ACs with the
  intake parser (one parser, drift killed); the builder declares
  `ac_bindings`; verify captures per-test results via JUnit XML where the
  verify command supports it; `ac_coverage_for` is rewritten to real per-AC
  math; every run emits `ac_evidence.json`. Nothing gates yet.
- **C2 — Enforcement + refusal.** In `enforce` mode, an unbound AC fails
  the Objective Gate — or, when the run *itself* declares it cannot bind
  ("I can build this but cannot verify AC3"), it terminates `unverifiable`,
  riding the existing refusal channel straight to the owner without burning
  retries. Waivers (in-repo, recorded, explicit) unbind the gate honestly.
- **C3 — Builder discipline.** The factory prompt instructs the builder to
  maintain bindings as it works (a red-first test for AC2 is born bound to
  AC2). Prompt + template work, pinned like all prose.

## Design

### 1. One AC parser, in the run (C1)

- `input_contract`'s tolerant parsing (`_AC_SECTION`/`_CHECKBOX`,
  `input_contract.py:76-93`) is exposed as a pure
  `parse_acceptance_criteria(issue_body) -> list[str]` and called from the
  run pipeline right after `issue_resolution_text` (`pipeline.py:1379`).
  ACs get positional ids `AC1..ACn` paired with their verbatim text (ids
  are positional; the artifact records the text beside the id so any
  mid-run issue edit is visible, not silent).
- `run/state.py`'s duplicate, stricter parser (`section_items` with
  `^##\s+Acceptance criteria\s*$`) switches to the same helper —
  killing the drift where `## Acceptance Criteria (P0)` passes intake but
  is invisible to run state.
- Prompt-only runs (no issue) have zero ACs: coverage is vacuously
  inapplicable and the artifact says so (`"acs": []`, mode recorded) — the
  gate never blocks a run that never had criteria.

### 2. Binding declaration (C1 + C3)

- The builder maintains `.agentrail/ac_bindings.json` in the workspace:
  `{ "AC1": ["agentrail/tests/run/test_x.py::test_persist", ...], ... }` —
  values are pytest node ids where available, else declared-check names.
  Model-proposed, machine-verified: a binding is only evidence if the bound
  identifier exists in the captured results AND passed.
- The pipeline reads the file through an adapter (I/O stays out of
  policies — `test_policies_purity.py:58-68` enforces this) and passes
  plain data into the pure gate math.
- C3 adds the builder-prompt rule (write the binding when you write the
  test; red-first TRAIL discipline unchanged) with prose pins in the
  factory prompt's test file.

### 3. Structured test capture (C1)

- `agentrail/run/verify_gate.py::main()` adds
  `--junit-xml=<run_dir>/pytest-report.xml` to its pytest invocation
  (`:327-329`) — stdlib-consumable XML, no plugins. An adapter parses it
  into `[{ nodeId, outcome }]`.
- Repos with arbitrary verify commands: a new optional
  `.agentrail/config.json` key `verifyReport: <path>` names a JUnit file
  their command produces. Present → test-level evidence; absent →
  **command-level evidence** (the AC binds to a declared `VerifyCheck`
  name that passed), and the artifact labels every evidence item's
  granularity `test` or `command` — honest, never inflated.

### 4. Real coverage math (C1)

`ac_coverage_for` is rewritten as pure policy taking plain args:

```python
def ac_coverage_for(acs, bindings, test_results, check_results, waivers) -> AcCoverageDetail
# per-AC status: proven_test | proven_check | waived | unbound
# AcCoverage(total, covered) is derived from it — the dataclass keeps its
# exact constructor and meaning, so the frozen eval answer-keys
# (evals/corpus/*/answer_key/*) stay green untouched.
```

`evaluate_objective` (`objective.py:301-318`) consumes the derived
`AcCoverage` exactly as today in `off`/`observe`; in `enforce` its
failed-reason names the unbound ACs (`"acceptance-criteria unbound: AC2,
AC4"`), not a generic line. A `qa` evidence type exists in the schema from
day one (criterion-text keyed) but nothing populates it yet — Arcs B/D do.

### 5. The artifact — `ac_evidence.json` (C1)

Written beside `run.json` (`run_dir`, `pipeline.py:1539-1557`) via the
`write_run_refusal_marker` read-merge-write idiom (`artifacts.py:69-101`),
at gate-finalization time (`finalize_objective_gate`, `pipeline.py:360`):

```json
{ "mode": "observe|enforce", "issue": 123, "headSha": "",
  "acs": [ { "id": "AC1", "text": "...", "status": "proven_test",
             "evidence": [ { "type": "test", "ref": "tests/...::test_x",
                             "granularity": "test", "result": "passed", "at": "..." } ] } ],
  "unbound": ["AC4"], "waived": [ { "id": "AC3", "reason": "...", "by": "...", "at": "..." } ] }
```

A one-line coverage summary also joins `run.json`'s
`objectiveGate.evidence[]` so existing surfaces see it without new
readers. This artifact is the verification stage of Arc D's Change Record
and the substrate of Arc E's calibration.

### 6. The `unverifiable` refusal (C2)

Rides the EXISTING refusal channel — no fourth terminal vocabulary:

- The run writes the established refusal marker into `run.json`
  (`write_run_refusal_marker` precedent) with `kind: "unverifiable"` and
  the structured payload `[{ ac, why_unbound, what_would_prove_it }]`
  duplicated into `ac_evidence.json`.
- Hosted path: `native_runner.py`'s refusal parsing (`:194-208`) and the
  TS `isHostedRefusal` branch (`runner.ts:945-948`) already route refusals
  straight to the owner without burning retries — `unverifiable` reuses
  that, with the notify line carrying the compact AC list.
- **Local path gets the missing parallel branch:** `afk/queue_state.py`
  gains a refusal event → `ESCALATED_TO_HUMAN` without budget/tier
  consumption, and `heartbeat/runtime.py`'s `_STATUS_TO_EVENT` map
  (`:56-60`) is updated EXPLICITLY — its `.get(status, Event.GATE_RED)`
  default would otherwise silently turn refusal into a retry-burning
  failure (the exploration's sharpest trap). A regression test pins that
  an unknown status still defaults to GATE_RED but `unverifiable`/refusal
  never hits the default.
- The duplicated bash parser (`agentrail/docker/runner/entrypoint.sh`,
  mirroring `_result_from_run_json`) is updated in lockstep — named in the
  plan as its own step so it cannot be forgotten.

### 7. Waivers (C2)

In-repo and explicit: `.agentrail/ac_waivers.json` —
`{ "AC3": { "reason", "by", "at" } }`, authored by a human (Jace chat flow
can write it later through the normal gated file-change path). The gate
treats a waived AC as covered; the artifact records the waiver verbatim;
the posted/reported summary always names waived ACs — waivers are visible,
never silent config. First-class DB rows arrive when Arc D/E attach this
artifact to hosted storage.

### 8. The flag (C1/C2 staging)

`layer_enabled` defaults ON (`pipeline.py:62-89`) — wrong shape. A bespoke
`ac_proof_mode()` (precedent: `jit_gather_enabled`, `pipeline.py:150-162`)
reads, in precedence order: `AGENTRAIL_AC_PROOF_GATE` env
(`off|observe|enforce`, for evals/tests) → `.agentrail/config.json` key
`acProofGate` → default **`observe`** (computing and emitting evidence is
harmless and starts Arc E's calibration clock; `off` exists as the
emergency stop; `enforce` is opt-in per repo, dogfooding on agentrail's own
repos first).

## Exploration contradictions — resolved

1. ACs not available in the run → §1 adds parsing to the pipeline (the
   arc's real first brick, not a rewire).
2. Coverage counts verify commands → §4 rewrites the math end to end.
3. No persisted TRAIL to extend → bindings live in their own declared file
   (§2); the TRAIL keeps its current shape (its validity rules are out of
   scope); `Observation` untouched.
4. No test identifiers → §3 builds capture, with the honest
   test/command granularity split.
5. Boolean default-ON flag machinery → §8's bespoke three-state mode.
6. Refusal's five-vocabulary threading + the GATE_RED default trap → §6
   reuses the refusal channel, adds the local branch, pins the trap with a
   regression test, and names the bash duplicate as a plan step.
7. "First-class waiver rows" impossible in the sync path → §7's in-repo
   recorded waivers now; rows deferred to D/E explicitly.

## Evidence & reuse (standing template section)

`ac_evidence.json` (per run, keyed run id + issue + headSha when present)
is consumed by: Arc D (Change Record verification stage), Arc E
(calibration: gate-held-vs-reverted joins; `false_green` rows), Arc B's
posted reviews (a later natural upgrade lets `acCoverage` cite
proven-vs-unbound per AC instead of diff inference). The refusal payload
is the first shipped instance of the audit's C5 ("a system that never
refuses is a system whose approval carries no information").

## Testing

- Pure policy tests: rewritten `ac_coverage_for` per-AC math (every status,
  binding-to-missing-test, binding-to-failed-test, waiver, zero-AC runs) in
  `agentrail/tests/run/test_check_runner.py` + gate integration in
  `test_objective_gate*.py` (a 3-AC/2-binding run cannot green in enforce);
  the purity guard (`test_policies_purity.py`) must stay green — all I/O in
  adapters.
- Parser unification: intake-vs-run parity cases incl. the
  `## Acceptance Criteria (P0)` drift case, in `test_input_contract.py` +
  a new state-parity case.
- JUnit capture: adapter parse tests (fixture XML), `verifyReport`
  fallback, command-granularity labeling.
- Refusal: queue_state transition tests (refusal event, no budget burn),
  the `_STATUS_TO_EVENT` explicit-map regression pin, `native_runner`
  round-trip, and a lockstep test asserting entrypoint.sh contains the
  marker-parsing update (string pin, mirroring the SQL/TS lockstep idiom).
- Artifact: schema round-trip, read-merge-write, always-emitted-in-observe.
- Regression pin on the audit's exact hole: a test asserting
  `covered == total` is no longer unconditional (constructible fixture
  where covered < total).
- Env gotchas honored: `AGENTRAIL_SERVER_*` stripping stays consistent in
  both places (`tests/conftest.py:12-22`, `verify_gate.py:283-290`);
  frozen eval answer-keys untouched and green.

## Rollout / compatibility

`observe` by default (artifact + summary line, zero gating) → `enforce`
per repo via config, agentrail's own repos first. `off` = emergency stop.
No behavior change for prompt-only runs or repos without ACs. The TS/hosted
side needs no schema change in C1 (artifact is runner-side); C2's refusal
reuses the existing hosted-refusal contract unchanged.

## Observability (north-star note)

Observe mode immediately produces the per-repo coverage baseline Arc E's
calibration publishes ("over N runs, X% of ACs proven, Y% waived, Z%
unbound"). Refusal rate becomes a shipped metric the moment C2 lands.
Success is not "the gate is strict"; it is that unproven "done" claims
become structurally impossible to make silently.
