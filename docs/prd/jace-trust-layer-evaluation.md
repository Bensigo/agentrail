# Jace trust-layer evaluation program

## Status and boundary

This is the canonical post-MVP evaluation phase for the acceptance spine
recorded in [the canonical trust-layer migration ledger](../trust-layer-migration-ledger.md).
It does not validate the product today. Legacy AgentRail execution evaluations
remain a distinct benchmark; they are reusable infrastructure, not proof that
Jace earned trust.

No product-benefit claim is allowed until a held-out controlled result or a
separately labelled production human-outcome result supports it.

## Canonical unit: Acceptance Case

An immutable **Acceptance Case** contains:

- frozen user request and source-conversation turn(s), with source provenance;
- a pinned repository snapshot and independently labelled relevant sources;
- the approved target Acceptance Contract and missing-question/clarification
  ground truth;
- one or more builder-produced PR revisions, each exact head and diff identity;
- available safe environment(s) and permitted proof modality;
- hidden or independently scored labels for contract, context, review,
  criterion proof, correction, and final outcome;
- complete run provenance: case/corpus version, arm, model/config, prompt and
  guardrail versions, Context Pack hash/token budget, PR head, environment,
  artifact references, scorer version, and outcome source.

The independent labels, not Jace’s own verdict, are truth. Cases have frozen
development and held-out splits. A task that cannot be independently labelled
is explicitly unscored for that scorecard; it is never converted to a pass.

## Required ablations

Every eligible case runs paired, fixed-configuration arms:

1. **agent-alone** — the builder gets only the frozen request;
2. **contract-only** — the builder gets the independently approved Acceptance
   Contract without Jace retrieval;
3. **contract-plus-pack** — the builder gets the approved Contract and bounded
   Context Pack;
4. **full-jace-loop** — intake/clarification, confirmed Contract, Pack,
   exact-head review, proof plan, correction, receipt, and human outcome seam.

The old factory `baseline`/`full` arm names are not substitutes for these arms.

## Independent scorecards

| Scorecard | Required measures |
| --- | --- |
| Intake and contract | Necessary-missing-question precision/recall, unnecessary-question rate, criterion fidelity/completeness, and safe refusal correctness. |
| Context | Relevant-source sufficiency/recall, irrelevant-source rate, freshness/provenance validity, selected tokens, total tokens, and cost. |
| Review | Required-failure detection recall, false-block/noise rate, blocker grounding, and exact-head safety. |
| Criterion proof | Whether UI/API/job/data evidence proves the specific criterion on the exact head/environment, or correctly yields `not_proven`/`not_testable`; API artifacts must be redaction-checked. |
| Correction | Required packet fields, evidence binding, confirmed receipt, and whether a subsequent builder attempt can repair the stated failure. |
| End-to-end | False-green rate, human accept/rework/reject/revert outcome, and measured human review effort. |

All rates carry numerator, denominator, unknown/unscored count, case segment,
and confidence/repetition metadata. A generic preview smoke test has no
criterion-proof credit.

### Current offline proof-verifier contract

The evaluator now has a pure fixture-owned proof verifier. Each
`independentLabels.proof.criteria` row names one approved criterion, permitted
modality, and expected verdict; a passing API row also names its expected
status. The verifier accepts only metadata bound to the frozen PR head and
environment. It requires observed behavior plus a PNG/JPEG for UI, a redacted
JSON request/status card for API, a trigger plus bounded log/output for jobs,
or authorized readback plus an assertion for data. Missing or ambiguous hidden
labels are `unscored`; they never become a pass. This checks fixture and
artifact lineage only. It neither executes a preview nor replaces an
independent human/outcome scorer.

The evaluator-owned proof scorer emits two segments per criterion: the
modality outcome (for example `ui`) and modality artifact validity (for example
`ui-artifact-validity`). This keeps a passing feature with invalid evidence
visible as a proof false green instead of letting behavior success mask the
trust failure.

## Evidence classes and promotion

Offline controlled truth, canary evidence, and production human outcomes are
reported in separate tables. Production outcomes are never backfilled as hidden
truth, and offline success never implies live adoption benefit.

Promotion is `promote`, `hold`, or `reject`, never an opaque aggregate score.
The promotion contract must define metric floors and maximum false-green/noise
ceilings per required segment, minimum powered sample/repetitions, exact
case/config/scorer provenance, held-out completion, and no missing mandatory
scorecards. Missing, synthetic-only, ambiguous, or underpowered evidence is
`hold`; a violated safety floor is `reject`.

## Reuse versus incompatible legacy pieces

Reusable mechanics:

- frozen commit-pinned task loading and held-out exclusion:
  `agentrail/evals/corpus/loader.py`;
- separate hidden-test scorer and immutable execution `RunRecord`:
  `agentrail/evals/scorer.py`, `agentrail/evals/run_record.py`;
- repeated arm runner/reporting and existing solve/cost/false-green summaries:
  `agentrail/evals/README.md`, `agentrail/evals/reporter.py`;
- context oracle/quality and usage-cost capture;
- explicit human review-time events:
  `packages/db-postgres/src/schema/review_events.ts`.

Incompatible as proof without new work:

- factory hidden tests score code-task completion, not missing-question or
  contract fidelity, runtime-proof validity, correction usefulness, or human
  trust;
- existing `baseline`/`full` arms do not express the four Acceptance-Case
  ablations;
- existing false-green is Objective Gate versus hidden execution test, not
  “Jace said proven but independent/human outcome rejected/reworked/reverted”;
- review/run rows do not yet bind an Acceptance Case, arm, Pack/config/scorer,
  correction receipt, and final outcome as one immutable lineage;
- the nightly canary is a bounded health probe, not held-out Jace validation or
  production evidence.

## Narrow implementation phases

1. **Case corpus and provenance:** schema/fixtures/loader for Acceptance Cases,
   independently labelled dev and held-out data, safe environments, and exact
   lineage.
2. **Four-arm runner and independent scorers:** preserve legacy execution
   benchmark; add Jace-specific contract/context/review/proof/correction
   scoring without exposing hidden labels to the evaluated flow.
3. **Scorecards and promotion:** report all denominators/segments, metric floors,
   tri-state result, and artifact redaction checks.
4. **Canary and production separation:** attach production human outcomes only
   through explicit provenance and publish them independently of offline scores.

## Legacy-eval migration and removal policy

Do not preserve factory/code-execution evaluation product logic for history.
Do not delete shared mechanics or historical reports blindly either. Before any
destructive edit, map direct callers, create/migrate the Acceptance-Case
replacement, run its targeted coverage, and verify old imports are gone.

| Classification | Current components | Action and condition |
| --- | --- | --- |
| Reuse as neutral infrastructure | `corpus/loader.py`, `run_record.py`, `reporter.py`, `regression_gate.py`, `pricing_adapter.py`, canary scheduling, and the pure hidden-test scoring seam | Generalize them around Acceptance Cases and the four arms. A hidden test remains one optional independent code-outcome scorer; it is not proof of contract, runtime evidence, or human trust. |
| Replace | `runner.py::SandboxAgentExecutor`, current factory `arms/`, `spine.py` execution assumptions, factory `task.json`/answer-key fixture contract, and the current CLI/canary report semantics | Add a case executor, proof verifier, Acceptance-Case fixture schema, and four-arm scorecards first. Migrate CLI/canary callers with explicit evidence-class labels. |
| Remove after migration | `packer_tightening.py` and its factory A/B command, factory-memory reporting, and execution-layer ablation fixtures/tests that do not map to a Jace scorecard | Remove only after the new Context scorecard replaces the measurable question, direct import/caller searches are empty, and replacement tests pass. Historical reports may stay archived as legacy execution evidence, clearly labelled. |

Direct dependencies presently make deletion unsafe: the CLI imports
`SandboxAgentExecutor` and `ProductionHiddenTestRunner`
(`agentrail/cli/commands/evals.py`); `spine.py`, `canary.py`, and their tests
depend on the executor/hidden-test interfaces; the workflow invokes the CLI.
`ProductionHiddenTestRunner` can be retained only as an optional independent
source-code outcome scorer, while an Acceptance-Case proof verifier handles
criterion-specific UI/API/job/data evidence.

### Bounded migration order

1. Add an Acceptance-Case schema/loader alongside the legacy corpus and tests
   for frozen dev/held-out labels and provenance.
2. Extend or adapt `RunRecord` with case/arm/contract/pack/evidence lineage;
   add independent scorecards and tests.
3. Implement case executor and verifier protocols; retain hidden tests where a
   frozen code outcome is valid, and add modality proof scoring. The pure
   criterion-proof verifier and scorer now exist; they still need a real
   fixture corpus and persisted run/report path.
4. Migrate spine, CLI, canary, reporter, and regression gate to Acceptance
   Cases. Verify each scorecard carries denominators and sample-size state.
5. Run targeted replacement coverage and a bounded offline smoke corpus.
6. Re-run direct import/caller searches. Only then delete factory-only arms,
   packer/memory reports, obsolete fixtures, docs, and tests in a separate
   cleanup change.
