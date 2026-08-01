# AC Proof Gate (Arc C) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make per-AC verification real: the run parses the issue's acceptance criteria, the builder binds each to concrete test/check evidence, coverage math can actually fail, every run emits `ac_evidence.json`, and an unprovable AC becomes an honest `unverifiable` refusal instead of a fake green.

**Architecture:** Pure policy math in `agentrail/guardrails/policies/` (no I/O — enforced by `test_policies_purity.py`), thin I/O adapters in `agentrail/guardrails/adapters/`, orchestration in `agentrail/run/pipeline.py`. A bespoke three-state flag (`off|observe|enforce`, default `observe`) stages rollout. The refusal rides the existing `run.json` refusal-marker channel (`hosted-refusal: ` prefix contract) — no new terminal vocabulary.

**Tech Stack:** Python 3 stdlib only (JUnit via `xml.etree`), pytest, bash (entrypoint.sh heredoc).

**Spec:** `docs/superpowers/specs/2026-07-31-ac-proof-gate-design.md` (build-ready, merged #1553).

## Global Constraints

- Repo root for all commands: the worktree checkout of branch `feat/ac-proof-gate`. Run tests as `python3 -m pytest <paths> -q` from repo root.
- **Purity guard:** modules under `agentrail/guardrails/policies/` may not import `subprocess`, adapters, or do file I/O — `agentrail/tests/guardrails/test_policies_purity.py:58-68` enforces it and must stay green.
- **Frozen eval answer-keys** (`evals/corpus/*/answer_key/*`) construct `AcCoverage(total=, covered=)` directly — its constructor, fields, and `is_satisfied` semantics must not change. Never edit anything under `evals/corpus/`.
- **Byte-identical default behavior for the gate verdict in `off` and `observe` modes:** the gate's pass/fail inputs stay exactly today's (`declared_check_coverage`, the renamed legacy math). Observe adds evidence lines and artifacts only — it can never flip a verdict.
- The `hosted-refusal: ` prefix (`agentrail/sandbox/native_runner.py:86`) is a byte-exact cross-process contract with `packages/db-postgres/src/queries/runner.ts` — reuse the constant, never retype it in Python; the entrypoint.sh heredoc must carry the identical literal.
- No new dependencies. No changes under `apps/` or `packages/`. Never touch `apps/jace/pnpm-lock.yaml`.
- Search discipline: the repo hook blocks Grep/Glob and bare `grep` — use Read with the exact paths given here, and `bash <<'EOF' ... python3 ... EOF` heredocs for any residual search.
- Commit after each task with the message given in the task.

## File Structure

| File | Responsibility |
| --- | --- |
| `agentrail/guardrails/policies/input_contract.py` | + `parse_acceptance_criteria` (THE one AC parser, pure) |
| `agentrail/afk/input_contract.py` | shim re-export of the new parser |
| `agentrail/run/state.py` | heading-drift fix in `issue_goal_defaults` |
| `agentrail/guardrails/policies/objective.py` | + `AcEvidenceItem`/`AcStatus`/`AcCoverageDetail`; `evaluate(... ac_coverage_detail=)` |
| `agentrail/guardrails/policies/check_runner.py` | rewritten `ac_coverage_for` (real per-AC math); legacy math renamed `declared_check_coverage` |
| `agentrail/run/verify_gate.py` | JUnit XML emission (`--junit-xml`) |
| `agentrail/guardrails/adapters/ac_evidence.py` | NEW: bindings/waivers/JUnit file I/O |
| `agentrail/run/artifacts.py` | + `write_ac_evidence` (read-merge-write) |
| `agentrail/run/pipeline.py` | + `ac_proof_mode()`; gate-section wiring; refusal write |
| `agentrail/afk/queue_state.py` | + `Event.REFUSED` transition (no budget burn) |
| `agentrail/heartbeat/runtime.py` | + `_event_for()` refusal routing before the status map |
| `agentrail/docker/runner/entrypoint.sh` | refusal branch in the heredoc parser (lockstep) |
| `agentrail/run/prompts.py` | C3 builder binding discipline |

---

### Task 0: Baseline

**Files:** none (verification only)

- [ ] **Step 1: Confirm branch + clean tree**

Run: `git -C . status --short --branch`
Expected: `## feat/ac-proof-gate...origin/main` and no unstaged changes (the plan file may be present/committed).

- [ ] **Step 2: Baseline the focused suite**

Run:
```bash
python3 -m pytest agentrail/tests/run/test_check_runner.py agentrail/tests/guardrails/test_objective_gate_unified.py agentrail/tests/run/test_objective_gate.py agentrail/tests/run/test_pipeline_objective_gate.py agentrail/tests/run/test_red_green.py agentrail/tests/run/test_verify_gate_classification.py agentrail/tests/afk/test_input_contract.py agentrail/tests/afk/test_queue_state.py agentrail/tests/guardrails/test_policies_purity.py agentrail/tests/run/test_state.py -q
```
Expected: all pass. Record the count; every later task must not regress it.

---

### Task 1: One AC parser, exposed to the run

**Files:**
- Modify: `agentrail/guardrails/policies/input_contract.py` (parser at :76-82, `_acceptance_section` at :358-365, `validate` at :368-391)
- Modify: `agentrail/afk/input_contract.py` (shim re-export)
- Modify: `agentrail/run/state.py:60,70` (`issue_goal_defaults` AC heading regex)
- Test: `agentrail/tests/afk/test_input_contract.py`, `agentrail/tests/run/test_state.py`

**Interfaces:**
- Produces: `parse_acceptance_criteria(issue_body: str) -> List[str]` — checkbox AC texts, document order, `[]` when section missing/no checkboxes. Importable from BOTH `agentrail.guardrails.policies.input_contract` and the `agentrail.afk.input_contract` shim.

- [ ] **Step 1: Write the failing tests** (append to `agentrail/tests/afk/test_input_contract.py`)

```python
from agentrail.afk.input_contract import parse_acceptance_criteria


def test_parse_acceptance_criteria_extracts_checkboxes():
    body = "## Acceptance criteria\n- [ ] AC one works\n- [x] AC two tested\n"
    assert parse_acceptance_criteria(body) == ["AC one works", "AC two tested"]


def test_parse_acceptance_criteria_tolerant_heading_drift_case():
    # THE drift case: intake admits this, run/state's strict regex missed it.
    body = "## Acceptance Criteria (P0)\n- [ ] ships behind a flag\n"
    assert parse_acceptance_criteria(body) == ["ships behind a flag"]


def test_parse_acceptance_criteria_empty_cases():
    assert parse_acceptance_criteria("") == []
    assert parse_acceptance_criteria("no headings") == []
    assert parse_acceptance_criteria("## Acceptance criteria\nprose only\n") == []


def test_validate_and_parser_agree():
    body = "## Acceptance criteria\n- [ ] AC1: build exits 0.\n"
    from agentrail.afk.input_contract import validate, Validated
    result = validate(body)
    assert isinstance(result, Validated)
    assert result.criteria == parse_acceptance_criteria(body)
```

And in `agentrail/tests/run/test_state.py`, inside the existing acceptance-criteria test class (near :96-116), add:

```python
    def test_acceptance_heading_with_suffix_collected(self):
        # Parity with intake (Arc C): '## Acceptance Criteria (P0)' passes
        # queue admission and must not be invisible to run state.
        text = "## Acceptance Criteria (P0)\n- [ ] do this\n"
        goal = state.issue_goal_defaults({}, {}, 7, text, "2026-08-01T00:00:00Z")
        assert goal["successCriteria"] == ["do this"]
```
(Match the surrounding tests' actual call pattern for `issue_goal_defaults` / `section_items` — mirror how the neighboring test at :96-106 invokes it.)

- [ ] **Step 2: Run to verify failure**

Run: `python3 -m pytest agentrail/tests/afk/test_input_contract.py agentrail/tests/run/test_state.py -q`
Expected: FAIL — `ImportError: cannot import name 'parse_acceptance_criteria'` and the new state test failing.

- [ ] **Step 3: Implement**

In `agentrail/guardrails/policies/input_contract.py`, directly after `_acceptance_section` (:365), add:

```python
def parse_acceptance_criteria(issue_body: str) -> List[str]:
    """Checkbox acceptance criteria from the issue body, in document order (pure).

    THE one AC parser (Arc C): the same tolerant section + checkbox extraction
    queue admission uses, exposed so the run pipeline and intake can never
    drift. Returns verbatim criterion texts; empty when the section is missing
    or holds no checkboxes (prompt-only runs, prose bodies).
    """
    section = _acceptance_section(issue_body)
    if not section:
        return []
    criteria = [m.group(1).strip() for m in _CHECKBOX.finditer(section)]
    return [c for c in criteria if c]
```

Refactor `validate` (:368-391) to use it — rejection wordings byte-identical:

```python
def validate(issue_body: str) -> Result:
    """Decide whether an issue may enter the Issue Queue (pure). [keep existing docstring body]"""
    section = _acceptance_section(issue_body)
    if not section:
        return Rejected(
            missing_ac="no 'Acceptance criteria' section in the issue body"
        )
    criteria = parse_acceptance_criteria(issue_body)
    if not criteria:
        return Rejected(
            missing_ac=(
                "Acceptance criteria are not machine-checkable: no checkbox "
                "criteria the Objective Gate could turn into runnable checks"
            )
        )
    return Validated(criteria=criteria)
```

In `agentrail/afk/input_contract.py`: add `parse_acceptance_criteria` to the import block and `__all__`.

In `agentrail/run/state.py:70` change the AC regex in `issue_goal_defaults` from
`re.compile(r"^##\s+Acceptance criteria\s*$", re.I)` to
`re.compile(r"^##\s+acceptance\s+criteria\b", re.I)`
and update the docstring line at :60 to match. Add a one-line comment: `# Tolerant heading (Arc C parity with intake's _AC_SECTION): allows suffixes like '(P0)'. Deeper #-levels remain intake-only.` Leave `section_items` itself unchanged (its bullet semantics are pinned by existing tests and shared with Non-goals).

- [ ] **Step 4: Run to verify pass**

Run: `python3 -m pytest agentrail/tests/afk/test_input_contract.py agentrail/tests/run/test_state.py agentrail/tests/guardrails/test_input_contract_v2.py agentrail/tests/guardrails/test_migrated_guardrails.py -q`
Expected: PASS (including all pre-existing admission tests — wordings unchanged).

- [ ] **Step 5: Commit**

```bash
git add agentrail/guardrails/policies/input_contract.py agentrail/afk/input_contract.py agentrail/run/state.py agentrail/tests/afk/test_input_contract.py agentrail/tests/run/test_state.py
git commit -m "feat(guardrails): expose parse_acceptance_criteria — one AC parser for intake and run (Arc C §1)"
```

---

### Task 2: Per-AC detail types + `evaluate` extension

**Files:**
- Modify: `agentrail/guardrails/policies/objective.py` (dataclasses live beside `AcCoverage` at :67-82; `evaluate`'s AC section at :298-318)
- Test: `agentrail/tests/guardrails/test_objective_gate_unified.py` (or the module the existing `evaluate` tests live in — follow where `test_red_when_no_acceptance_criteria_declared` sits: `agentrail/tests/run/test_objective_gate.py:99`)

**Interfaces:**
- Produces: `AcEvidenceItem(type, ref, granularity, result="passed")`, `AcStatus(id, text, status, evidence=(), note="")`, `AcCoverageDetail(acs=())` with `.unbound_ids -> List[str]`, `.to_ac_coverage() -> AcCoverage`, `.to_dict()`. `AC_STATUSES = ("proven_test", "proven_check", "waived", "unbound")`.
- Produces: `evaluate(..., ac_coverage_detail: Optional[AcCoverageDetail] = None)` — a NEW keyword-only param; when set with non-empty `acs` it appends an `acceptance-criteria-proof` evidence line and, if unsatisfied, the failed reason `acceptance-criteria unbound: AC2, AC4`. It runs IN ADDITION to (never instead of) the legacy `ac_coverage` block, so "no declared verification → red" survives an all-waived run.

- [ ] **Step 1: Write the failing tests** (append to `agentrail/tests/run/test_objective_gate.py`)

```python
from agentrail.guardrails.policies.objective import (
    AcCoverageDetail, AcEvidenceItem, AcStatus, AcCoverage, evaluate,
)


def _detail(*statuses):
    return AcCoverageDetail(acs=tuple(statuses))


def test_detail_derives_coverage_and_unbound_ids():
    detail = _detail(
        AcStatus(id="AC1", text="a", status="proven_test",
                 evidence=(AcEvidenceItem(type="test", ref="t.py::x", granularity="test"),)),
        AcStatus(id="AC2", text="b", status="waived"),
        AcStatus(id="AC3", text="c", status="unbound"),
    )
    assert detail.unbound_ids == ["AC3"]
    cov = detail.to_ac_coverage()
    assert (cov.total, cov.covered) == (3, 2)
    assert not cov.is_satisfied


def test_evaluate_enforce_names_unbound_acs():
    from agentrail.guardrails.policies.objective import CheckResult
    verdict = evaluate(
        checks=[CheckResult(name="verify", passed=True, detail="exit 0")],
        ac_coverage=AcCoverage(total=1, covered=1),
        ac_coverage_detail=_detail(
            AcStatus(id="AC1", text="a", status="proven_test"),
            AcStatus(id="AC2", text="b", status="unbound"),
            AcStatus(id="AC4", text="d", status="unbound"),
        ),
    )
    assert verdict.state == "fail"
    assert "acceptance-criteria unbound: AC2, AC4" in verdict.failed_reasons


def test_evaluate_detail_satisfied_passes_and_legacy_still_gates():
    # All ACs waived but ZERO declared verification: legacy coverage must
    # still red the gate — waive-everything is not a bypass.
    verdict = evaluate(
        checks=[],
        ac_coverage=AcCoverage(total=0, covered=0),
        ac_coverage_detail=_detail(AcStatus(id="AC1", text="a", status="waived")),
    )
    assert verdict.state == "fail"
    assert "acceptance-criteria not satisfied" in verdict.failed_reasons


def test_evaluate_without_detail_is_unchanged():
    verdict = evaluate(
        checks=[], ac_coverage=AcCoverage(total=2, covered=2),
    )
    assert verdict.state == "pass"
```

- [ ] **Step 2: Run to verify failure**

Run: `python3 -m pytest agentrail/tests/run/test_objective_gate.py -q`
Expected: FAIL — ImportError on the new names.

- [ ] **Step 3: Implement**

In `agentrail/guardrails/policies/objective.py`, after the `AcCoverage` dataclass (:82), add:

```python
AC_STATUSES = ("proven_test", "proven_check", "waived", "unbound")


@dataclass(frozen=True)
class AcEvidenceItem:
    """One captured proof behind an AC binding (a passed test or check)."""

    type: str          # "test" | "check"
    ref: str           # pytest node id or declared check name
    granularity: str   # "test" | "command" — honest capture resolution
    result: str = "passed"

    def to_dict(self) -> Dict[str, Any]:
        return {"type": self.type, "ref": self.ref,
                "granularity": self.granularity, "result": self.result}


@dataclass(frozen=True)
class AcStatus:
    """One acceptance criterion's proof state (id is positional: AC1..ACn)."""

    id: str
    text: str
    status: str  # one of AC_STATUSES
    evidence: Tuple["AcEvidenceItem", ...] = ()
    note: str = ""  # honesty detail, e.g. "bound to tests/x.py::test_y which failed"

    def to_dict(self) -> Dict[str, Any]:
        data: Dict[str, Any] = {
            "id": self.id, "text": self.text, "status": self.status,
            "evidence": [e.to_dict() for e in self.evidence],
        }
        if self.note:
            data["note"] = self.note
        return data


@dataclass(frozen=True)
class AcCoverageDetail:
    """Per-AC coverage — the real math behind :class:`AcCoverage` (Arc C).

    ``AcCoverage`` keeps its exact constructor and meaning (frozen eval
    answer-keys construct it directly); this detail DERIVES one from per-AC
    statuses: covered = proven or waived, never unbound.
    """

    acs: Tuple[AcStatus, ...] = ()

    @property
    def unbound_ids(self) -> List[str]:
        return [a.id for a in self.acs if a.status == "unbound"]

    def to_ac_coverage(self) -> AcCoverage:
        covered = sum(1 for a in self.acs if a.status != "unbound")
        return AcCoverage(total=len(self.acs), covered=covered)

    def to_dict(self) -> Dict[str, Any]:
        return {"acs": [a.to_dict() for a in self.acs], "unbound": self.unbound_ids}
```

(Ensure `Tuple` is in the module's `typing` import.)

In `evaluate`: add the keyword-only parameter `ac_coverage_detail: Optional[AcCoverageDetail] = None` to the signature, and directly AFTER the existing `if ac_coverage is not None:` block (:301-318) add a sibling block (both run — the legacy block is untouched):

```python
    # 3b. Per-AC proof coverage (Arc C, enforce mode). Runs IN ADDITION to the
    #    legacy declared-check coverage above: that block still guarantees
    #    "no declared verification → red", so an all-waived AC set can never
    #    bypass verification entirely.
    if ac_coverage_detail is not None and ac_coverage_detail.acs:
        derived = ac_coverage_detail.to_ac_coverage()
        if derived.is_satisfied:
            evidence.append(Evidence(
                name="acceptance-criteria-proof", passed=True,
                detail=f"{derived.covered}/{derived.total} proven or waived",
            ))
        else:
            unbound = ", ".join(ac_coverage_detail.unbound_ids)
            evidence.append(Evidence(
                name="acceptance-criteria-proof", passed=False,
                detail=f"{derived.covered}/{derived.total} proven; unbound: {unbound}",
            ))
            failed_reasons.append(f"acceptance-criteria unbound: {unbound}")
```

- [ ] **Step 4: Run to verify pass**

Run: `python3 -m pytest agentrail/tests/run/test_objective_gate.py agentrail/tests/guardrails/test_objective_gate_unified.py agentrail/tests/guardrails/test_policies_purity.py -q`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add agentrail/guardrails/policies/objective.py agentrail/tests/run/test_objective_gate.py
git commit -m "feat(guardrails): AcCoverageDetail + evaluate(ac_coverage_detail=) — per-AC gate math with named unbound reasons (Arc C §4)"
```

---

### Task 3: Rewrite `ac_coverage_for` — the audit's hole closes

**Files:**
- Modify: `agentrail/guardrails/policies/check_runner.py:98-107` (+ module docstring line for `ac_coverage_for`)
- Modify: `agentrail/run/pipeline.py:1984` call site + its import of `ac_coverage_for` (find the import near the top: `bash <<'EOF'\npython3 -c "import re,pathlib; [print(i+1, l) for i,l in enumerate(pathlib.Path('agentrail/run/pipeline.py').read_text().splitlines()) if 'ac_coverage_for' in l or 'declared_check_coverage' in l]"\nEOF`)
- Modify: any other `ac_coverage_for` caller/shim (`agentrail/run/check_runner.py` back-compat shim if it re-exports it — same search across `agentrail/`)
- Test: `agentrail/tests/run/test_check_runner.py`

**Interfaces:**
- Consumes: `AcCoverageDetail`, `AcStatus`, `AcEvidenceItem` from Task 2; `CheckResult` (already imported).
- Produces: `ac_coverage_for(acs: Sequence[str], bindings: Mapping[str, Sequence[str]], test_results: Mapping[str, str], check_results: Sequence[CheckResult], waivers: Mapping[str, Mapping[str, str]]) -> AcCoverageDetail` — pure.
- Produces: `declared_check_coverage(checks: List[VerifyCheck]) -> AcCoverage` — the OLD body verbatim under an honest name (the legacy "declared verification exists" proxy). The pipeline's legacy call switches to it; behavior byte-identical.
- Produces: `_normalize_test_ref(ref: str) -> str` (module-private) — dotted normal form: `a/b/test_x.py::TestC::test_y` ≡ junit `classname="a.b.test_x.TestC" name="test_y"`.

- [ ] **Step 1: Write the failing tests** (rewrite the `ac_coverage_for` tests in `agentrail/tests/run/test_check_runner.py`; keep every non-coverage test unchanged; retarget existing declared-proxy assertions at `declared_check_coverage`)

```python
from agentrail.guardrails.policies.check_runner import (
    VerifyCheck, ac_coverage_for, declared_check_coverage,
)
from agentrail.guardrails.policies.objective import CheckResult


def _cov(**kw):
    defaults = dict(acs=[], bindings={}, test_results={}, check_results=[], waivers={})
    defaults.update(kw)
    return ac_coverage_for(**defaults)


def test_declared_check_coverage_keeps_legacy_semantics():
    assert declared_check_coverage([]).total == 0
    cov = declared_check_coverage([VerifyCheck(name="verify", command="true")])
    assert (cov.total, cov.covered) == (1, 1)


def test_ac_coverage_proven_by_passed_test():
    detail = _cov(
        acs=["persists the record"],
        bindings={"AC1": ["agentrail/tests/run/test_x.py::test_persist"]},
        test_results={"agentrail.tests.run.test_x.test_persist": "passed"},
    )
    assert detail.acs[0].status == "proven_test"
    assert detail.acs[0].evidence[0].granularity == "test"


def test_ac_coverage_binding_to_failed_test_is_unbound_with_note():
    detail = _cov(
        acs=["a"], bindings={"AC1": ["t/test_x.py::test_y"]},
        test_results={"t.test_x.test_y": "failed"},
    )
    assert detail.acs[0].status == "unbound"
    assert "failed" in detail.acs[0].note


def test_ac_coverage_binding_to_missing_identifier_is_unbound():
    detail = _cov(acs=["a"], bindings={"AC1": ["t/test_x.py::test_gone"]})
    assert detail.acs[0].status == "unbound"
    assert "not found" in detail.acs[0].note


def test_ac_coverage_proven_by_passed_check_is_command_granularity():
    detail = _cov(
        acs=["a"], bindings={"AC1": ["verify"]},
        check_results=[CheckResult(name="verify", passed=True, detail="exit 0")],
    )
    assert detail.acs[0].status == "proven_check"
    assert detail.acs[0].evidence[0].granularity == "command"


def test_ac_coverage_waived_and_unbound_mix():
    detail = _cov(
        acs=["a", "b", "c"],
        bindings={"AC1": ["t/test_x.py::test_a"]},
        test_results={"t.test_x.test_a": "passed"},
        waivers={"AC2": {"reason": "manual-only", "by": "owner", "at": "2026-08-01"}},
    )
    statuses = [a.status for a in detail.acs]
    assert statuses == ["proven_test", "waived", "unbound"]
    cov = detail.to_ac_coverage()
    assert (cov.total, cov.covered) == (3, 2)


def test_audit_hole_regression_covered_can_be_less_than_total():
    # The audit's exact finding: covered==total was unconditional. Pin that a
    # constructible input now yields covered < total.
    detail = _cov(acs=["a", "b"], bindings={"AC1": ["verify"]},
                  check_results=[CheckResult(name="verify", passed=True, detail="exit 0")])
    cov = detail.to_ac_coverage()
    assert cov.covered < cov.total
```

- [ ] **Step 2: Run to verify failure**

Run: `python3 -m pytest agentrail/tests/run/test_check_runner.py -q`
Expected: FAIL — ImportError on `declared_check_coverage` / signature mismatch.

- [ ] **Step 3: Implement**

Replace `ac_coverage_for` (:98-107) in `agentrail/guardrails/policies/check_runner.py`:

```python
def declared_check_coverage(checks: List[VerifyCheck]) -> AcCoverage:
    """LEGACY declared-verification proxy (pure) — the pre-Arc-C behavior.

    >=1 declared check → fully covered; zero → ``AcCoverage(0, 0)`` (gate red:
    "no acceptance criteria declared" / can't verify). Kept byte-identical as
    the ``off``/``observe`` gate input and the no-verification floor in
    ``enforce`` — real per-AC math is :func:`ac_coverage_for` below.
    """
    total = len(checks)
    return AcCoverage(total=total, covered=total)


def _normalize_test_ref(ref: str) -> str:
    """Dotted normal form so junit classnames and pytest node ids compare equal.

    ``a/b/test_x.py::TestC::test_y`` and junit ``classname="a.b.test_x.TestC"
    name="test_y"`` (key ``a.b.test_x.TestC.test_y``) both normalize to the
    same string.
    """
    return ref.replace("/", ".").replace(".py::", "::").replace("::", ".")


def ac_coverage_for(
    acs: Sequence[str],
    bindings: Mapping[str, Sequence[str]],
    test_results: Mapping[str, str],
    check_results: Sequence[CheckResult],
    waivers: Mapping[str, Mapping[str, str]],
) -> AcCoverageDetail:
    """Real per-AC coverage math (pure) — Arc C.

    ids are positional (``AC1``..``ACn`` over ``acs`` in document order). A
    binding is only evidence if the bound identifier exists in the captured
    results AND passed — a binding to a missing or failed test is honestly
    ``unbound`` (with a note saying why). A waived AC counts covered without
    proof; the waiver itself is recorded by the caller. Statuses:
    ``proven_test`` | ``proven_check`` | ``waived`` | ``unbound``.
    """
    passed_checks = {c.name for c in check_results if getattr(c, "passed", False)}
    declared_checks = {c.name for c in check_results}
    normalized_tests = {_normalize_test_ref(str(k)): v for k, v in test_results.items()}
    statuses: List[AcStatus] = []
    for index, text in enumerate(acs):
        ac_id = f"AC{index + 1}"
        if ac_id in waivers:
            statuses.append(AcStatus(id=ac_id, text=str(text), status="waived"))
            continue
        evidence: List[AcEvidenceItem] = []
        notes: List[str] = []
        for raw in bindings.get(ac_id, ()) or ():
            ref = str(raw).strip()
            if not ref:
                continue
            outcome = normalized_tests.get(_normalize_test_ref(ref))
            if outcome == "passed":
                evidence.append(AcEvidenceItem(type="test", ref=ref, granularity="test"))
            elif outcome is not None:
                notes.append(f"bound to {ref} which {outcome}")
            elif ref in passed_checks:
                evidence.append(AcEvidenceItem(type="check", ref=ref, granularity="command"))
            elif ref in declared_checks:
                notes.append(f"bound to check {ref} which failed")
            else:
                notes.append(f"bound to {ref}, not found in captured results")
        if any(e.type == "test" for e in evidence):
            status = "proven_test"
        elif evidence:
            status = "proven_check"
        else:
            status = "unbound"
        statuses.append(AcStatus(
            id=ac_id, text=str(text), status=status,
            evidence=tuple(evidence), note="; ".join(notes),
        ))
    return AcCoverageDetail(acs=tuple(statuses))
```

Update the module's imports (`AcCoverageDetail, AcEvidenceItem, AcStatus` from `agentrail.guardrails.policies.objective`) and the docstring line :14. Update `agentrail/run/pipeline.py:1984` to `ac_coverage=declared_check_coverage(declared)` (+ its import line), and fix any shim/other caller the Step-1 search found the same way.

- [ ] **Step 4: Run to verify pass**

Run: `python3 -m pytest agentrail/tests/run/test_check_runner.py agentrail/tests/run/test_pipeline_objective_gate.py agentrail/tests/guardrails/test_policies_purity.py agentrail/tests/run/test_pipeline.py -q`
Expected: PASS (pipeline behavior unchanged — same values, new name).

- [ ] **Step 5: Commit**

```bash
git add agentrail/guardrails/policies/check_runner.py agentrail/run/pipeline.py agentrail/tests/run/test_check_runner.py
git commit -m "feat(guardrails): real per-AC coverage math — ac_coverage_for can finally fail (Arc C §4, audit hole)"
```
(Include any shim file the search updated.)

---

### Task 4: JUnit capture in verify_gate

**Files:**
- Modify: `agentrail/run/verify_gate.py` (pytest invocation at :327-329; module constants near the top where `TEST_SCOPE_ENV` lives)
- Test: `agentrail/tests/run/test_verify_gate_classification.py` (or the module's existing test home — mirror where `main()`/pytest-invocation behavior is tested; if `main()` has no direct test, add `agentrail/tests/run/test_verify_gate_junit.py`)

**Interfaces:**
- Produces: `DEFAULT_JUNIT_REPORT = os.path.join(".agentrail", "run", "pytest-report.xml")` and `JUNIT_ENV = "AGENTRAIL_VERIFY_JUNIT_XML"` — exported constants (Task 5's adapter reads `DEFAULT_JUNIT_REPORT`).
- The pytest invocation gains `--junit-xml=<resolved path>` (env override → default), with the parent dir created first.

- [ ] **Step 1: Write the failing test** (new file `agentrail/tests/run/test_verify_gate_junit.py`)

```python
"""Arc C §3: verify_gate emits a JUnit report so per-test evidence exists."""
from agentrail.run import verify_gate


def test_junit_constants_exported():
    assert verify_gate.DEFAULT_JUNIT_REPORT.endswith("pytest-report.xml")
    assert verify_gate.JUNIT_ENV == "AGENTRAIL_VERIFY_JUNIT_XML"


def test_resolve_junit_path_env_override(monkeypatch):
    monkeypatch.setenv(verify_gate.JUNIT_ENV, "/tmp/custom-report.xml")
    assert verify_gate.resolve_junit_path() == "/tmp/custom-report.xml"
    monkeypatch.delenv(verify_gate.JUNIT_ENV)
    assert verify_gate.resolve_junit_path() == verify_gate.DEFAULT_JUNIT_REPORT


def test_main_pytest_invocation_carries_junit_flag(monkeypatch, tmp_path):
    # Force the "run the tests" path with a fake decide() and capture the call.
    calls = {}
    monkeypatch.chdir(tmp_path)
    monkeypatch.setattr(verify_gate, "collect_changed_files", lambda _: ["x_test.py"])
    monkeypatch.setattr(verify_gate, "decide", lambda _: (0, ""))
    monkeypatch.setattr(
        verify_gate, "select_pytest_targets",
        lambda *a, **k: ["agentrail/tests/run/test_state.py"],
    )
    monkeypatch.setattr(
        verify_gate.subprocess, "call",
        lambda argv: calls.setdefault("argv", argv) and 0 or 0,
    )
    verify_gate.main([])
    assert any(str(a).startswith("--junit-xml=") for a in calls["argv"])
```
(Adjust the monkeypatched helper names to the module's real ones — Read `agentrail/run/verify_gate.py` around `main()` first; the shapes above match :277-334.)

- [ ] **Step 2: Run to verify failure**

Run: `python3 -m pytest agentrail/tests/run/test_verify_gate_junit.py -q`
Expected: FAIL — no `DEFAULT_JUNIT_REPORT` attribute.

- [ ] **Step 3: Implement**

Near the existing env-name constants in `verify_gate.py` add:

```python
# Arc C §3: where the pytest run drops its JUnit XML so the AC Proof Gate can
# bind acceptance criteria to per-test results. Env override for harnesses
# that relocate it; default lives under .agentrail/run/ beside other run scratch.
JUNIT_ENV = "AGENTRAIL_VERIFY_JUNIT_XML"
DEFAULT_JUNIT_REPORT = os.path.join(".agentrail", "run", "pytest-report.xml")


def resolve_junit_path() -> str:
    """The JUnit report path this verify run writes (env override → default)."""
    return (os.environ.get(JUNIT_ENV) or "").strip() or DEFAULT_JUNIT_REPORT
```

In `main()` replace the pytest call (:327-329):

```python
        junit_path = resolve_junit_path()
        junit_dir = os.path.dirname(junit_path)
        if junit_dir:
            os.makedirs(junit_dir, exist_ok=True)
        return subprocess.call(
            [sys.executable, "-m", "pytest", "-q", "-p", "no:cacheprovider",
             f"--junit-xml={junit_path}", *test_files]
        )
```

- [ ] **Step 4: Run to verify pass**

Run: `python3 -m pytest agentrail/tests/run/test_verify_gate_junit.py agentrail/tests/run/test_verify_gate_classification.py -q`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add agentrail/run/verify_gate.py agentrail/tests/run/test_verify_gate_junit.py
git commit -m "feat(run): verify_gate emits JUnit XML — per-test identifiers exist for AC binding (Arc C §3)"
```

---

### Task 5: The AC-evidence adapter (bindings / waivers / JUnit I/O)

**Files:**
- Create: `agentrail/guardrails/adapters/ac_evidence.py`
- Test: `agentrail/tests/guardrails/test_ac_evidence_adapter.py` (new)

**Interfaces:**
- Consumes: `_load_config` from `agentrail.guardrails.adapters.check_runner`; `DEFAULT_JUNIT_REPORT` from Task 4.
- Produces: `load_ac_bindings(target_dir) -> Tuple[Dict[str, List[str]], Dict[str, Dict[str, str]]]` (bindings, unverifiable-declarations), `load_ac_waivers(target_dir) -> Dict[str, Dict[str, str]]`, `load_junit_results(target_dir) -> Dict[str, str]` (dotted `classname.name` → `passed|failed|error|skipped`). All defensive: missing/malformed → empty.

- [ ] **Step 1: Write the failing tests** (new file `agentrail/tests/guardrails/test_ac_evidence_adapter.py`)

```python
"""Arc C §2/§3 I/O: bindings, waivers, and JUnit capture are adapter-only."""
import json

from agentrail.guardrails.adapters.ac_evidence import (
    load_ac_bindings, load_ac_waivers, load_junit_results,
)

_JUNIT = """<?xml version="1.0" encoding="utf-8"?>
<testsuites>
  <testsuite name="pytest" tests="3">
    <testcase classname="agentrail.tests.run.test_x" name="test_pass" time="0.01"/>
    <testcase classname="agentrail.tests.run.test_x" name="test_fail" time="0.01">
      <failure message="boom">trace</failure>
    </testcase>
    <testcase classname="agentrail.tests.run.test_x" name="test_skip" time="0.0">
      <skipped message="later"/>
    </testcase>
  </testsuite>
</testsuites>
"""


def _write(tmp_path, rel, text):
    path = tmp_path / rel
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(text)
    return path


def test_bindings_lists_and_unverifiable_objects(tmp_path):
    _write(tmp_path, ".agentrail/ac_bindings.json", json.dumps({
        "AC1": ["agentrail/tests/run/test_x.py::test_pass", ""],
        "AC3": {"unverifiable": True, "why": "needs prod creds",
                "whatWouldProveIt": "a staging login"},
        "": ["ignored"],
        "AC4": "not-a-list-ignored",
    }))
    bindings, unverifiable = load_ac_bindings(tmp_path)
    assert bindings == {"AC1": ["agentrail/tests/run/test_x.py::test_pass"]}
    assert unverifiable == {"AC3": {"why": "needs prod creds",
                                    "whatWouldProveIt": "a staging login"}}


def test_bindings_missing_or_malformed_is_empty(tmp_path):
    assert load_ac_bindings(tmp_path) == ({}, {})
    _write(tmp_path, ".agentrail/ac_bindings.json", "{not json")
    assert load_ac_bindings(tmp_path) == ({}, {})


def test_waivers_load_and_default_empty(tmp_path):
    assert load_ac_waivers(tmp_path) == {}
    _write(tmp_path, ".agentrail/ac_waivers.json", json.dumps(
        {"AC2": {"reason": "manual-only", "by": "owner", "at": "2026-08-01"}}
    ))
    assert load_ac_waivers(tmp_path)["AC2"]["reason"] == "manual-only"


def test_junit_results_default_path_and_outcomes(tmp_path):
    _write(tmp_path, ".agentrail/run/pytest-report.xml", _JUNIT)
    results = load_junit_results(tmp_path)
    assert results["agentrail.tests.run.test_x.test_pass"] == "passed"
    assert results["agentrail.tests.run.test_x.test_fail"] == "failed"
    assert results["agentrail.tests.run.test_x.test_skip"] == "skipped"


def test_junit_results_verify_report_config_override(tmp_path):
    _write(tmp_path, "reports/custom.xml", _JUNIT)
    _write(tmp_path, ".agentrail/config.json", json.dumps({"verifyReport": "reports/custom.xml"}))
    assert load_junit_results(tmp_path)  # found via config, not default


def test_junit_missing_report_is_empty(tmp_path):
    assert load_junit_results(tmp_path) == {}
```

- [ ] **Step 2: Run to verify failure**

Run: `python3 -m pytest agentrail/tests/guardrails/test_ac_evidence_adapter.py -q`
Expected: FAIL — module does not exist.

- [ ] **Step 3: Implement** — create `agentrail/guardrails/adapters/ac_evidence.py`:

```python
"""AC-evidence adapter — the file I/O behind the AC Proof Gate (Arc C).

The coverage math (:func:`agentrail.guardrails.policies.check_runner.ac_coverage_for`)
is pure. Something has to read the builder-declared bindings
(``.agentrail/ac_bindings.json``), the human-authored waivers
(``.agentrail/ac_waivers.json``), and the captured JUnit report — that is this
adapter's only job. Defensive throughout: a missing or malformed file yields
empty data (the gate then reads the affected ACs as honestly ``unbound``),
never an exception.
"""
from __future__ import annotations

import json
import logging
import xml.etree.ElementTree as ET
from pathlib import Path
from typing import Any, Dict, List, Mapping, Optional, Tuple

from agentrail.guardrails.adapters.check_runner import _load_config
from agentrail.run.verify_gate import DEFAULT_JUNIT_REPORT

_log = logging.getLogger(__name__)

BINDINGS_FILE = Path(".agentrail") / "ac_bindings.json"
WAIVERS_FILE = Path(".agentrail") / "ac_waivers.json"


def _load_json(path: Path) -> Optional[Any]:
    if not path.is_file():
        return None
    try:
        return json.loads(path.read_text(encoding="utf-8"))
    except Exception as exc:  # noqa: BLE001 — defensive: malformed file = no data
        _log.warning("could not parse %s: %s", path, exc)
        return None


def load_ac_bindings(target_dir: Path) -> Tuple[Dict[str, List[str]], Dict[str, Dict[str, str]]]:
    """Read ``.agentrail/ac_bindings.json`` → ``(bindings, unverifiable)``.

    ``{"AC1": ["tests/x.py::test_a"], "AC3": {"unverifiable": true, "why":
    "...", "whatWouldProveIt": "..."}}`` — a list value is proof pointers
    (pytest node ids or declared check names); an object value with truthy
    ``unverifiable`` is the builder's declared refusal for that AC.
    """
    data = _load_json(Path(target_dir) / BINDINGS_FILE)
    bindings: Dict[str, List[str]] = {}
    unverifiable: Dict[str, Dict[str, str]] = {}
    if not isinstance(data, Mapping):
        return bindings, unverifiable
    for key, value in data.items():
        ac_id = str(key).strip()
        if not ac_id:
            continue
        if isinstance(value, (list, tuple)):
            refs = [str(v).strip() for v in value if str(v).strip()]
            if refs:
                bindings[ac_id] = refs
        elif isinstance(value, Mapping) and value.get("unverifiable"):
            unverifiable[ac_id] = {
                "why": str(value.get("why") or ""),
                "whatWouldProveIt": str(value.get("whatWouldProveIt") or ""),
            }
    return bindings, unverifiable


def load_ac_waivers(target_dir: Path) -> Dict[str, Dict[str, str]]:
    """Read ``.agentrail/ac_waivers.json`` → ``{id: {reason, by, at}}``.

    Human-authored, in-repo, explicit (spec §7). The gate treats a waived AC
    as covered; recording and surfacing the waiver is the caller's job.
    """
    data = _load_json(Path(target_dir) / WAIVERS_FILE)
    waivers: Dict[str, Dict[str, str]] = {}
    if not isinstance(data, Mapping):
        return waivers
    for key, value in data.items():
        ac_id = str(key).strip()
        if not ac_id or not isinstance(value, Mapping):
            continue
        waivers[ac_id] = {
            "reason": str(value.get("reason") or ""),
            "by": str(value.get("by") or ""),
            "at": str(value.get("at") or ""),
        }
    return waivers


def load_junit_results(target_dir: Path) -> Dict[str, str]:
    """Parse the captured JUnit report → ``{dotted test key: outcome}``.

    Report path: the ``verifyReport`` key of ``.agentrail/config.json`` when
    declared (repos whose verify command emits its own JUnit file), else the
    verify-gate default. Keys are ``classname.name`` (the policy's
    ``_normalize_test_ref`` maps pytest node ids onto the same form); outcomes
    are ``passed`` / ``failed`` / ``error`` / ``skipped``. Missing or
    malformed report → ``{}`` (command-level evidence still works).
    """
    config = _load_config(Path(target_dir)) or {}
    declared = str(config.get("verifyReport") or "").strip()
    report = Path(target_dir) / (declared or DEFAULT_JUNIT_REPORT)
    if not report.is_file():
        return {}
    try:
        root = ET.parse(report).getroot()
    except ET.ParseError as exc:
        _log.warning("could not parse junit report %s: %s", report, exc)
        return {}
    results: Dict[str, str] = {}
    for case in root.iter("testcase"):
        classname = (case.get("classname") or "").strip()
        name = (case.get("name") or "").strip()
        if not name:
            continue
        key = f"{classname}.{name}" if classname else name
        if case.find("failure") is not None:
            outcome = "failed"
        elif case.find("error") is not None:
            outcome = "error"
        elif case.find("skipped") is not None:
            outcome = "skipped"
        else:
            outcome = "passed"
        results[key] = outcome
    return results
```

- [ ] **Step 4: Run to verify pass**

Run: `python3 -m pytest agentrail/tests/guardrails/test_ac_evidence_adapter.py agentrail/tests/guardrails/test_policies_purity.py -q`
Expected: PASS (adapter may do I/O; purity guard untouched because nothing under `policies/` imports it).

- [ ] **Step 5: Commit**

```bash
git add agentrail/guardrails/adapters/ac_evidence.py agentrail/tests/guardrails/test_ac_evidence_adapter.py
git commit -m "feat(guardrails): ac_evidence adapter — bindings, waivers, JUnit capture I/O (Arc C §2-§3)"
```

---

### Task 6: The flag + observe-mode wiring + `ac_evidence.json`

**Files:**
- Modify: `agentrail/run/pipeline.py` — `ac_proof_mode()` beside `jit_gather_enabled` (:150-162); gate-section wiring around :1934-1991
- Modify: `agentrail/run/artifacts.py` — `write_ac_evidence` after `write_run_refusal_marker` (:101)
- Test: `agentrail/tests/run/test_pipeline_objective_gate.py` (integration, follow its existing fixture style) + flag tests in the same file or `agentrail/tests/run/test_pipeline.py`'s style

**Interfaces:**
- Consumes: `parse_acceptance_criteria` (Task 1, import from `agentrail.guardrails.policies.input_contract`), `ac_coverage_for`/`declared_check_coverage` (Task 3), adapter loaders (Task 5), `Evidence` (already exported by the objective policy).
- Produces: `ac_proof_mode(target_dir: Optional[Path] = None) -> str` returning `"off" | "observe" | "enforce"`; `AC_PROOF_ENV = "AGENTRAIL_AC_PROOF_GATE"`; `write_ac_evidence(path, *, mode, issue, head_sha, acs, unbound, waived, unverifiable)`; the run emits `<run_dir>/ac_evidence.json` whenever mode != off.

- [ ] **Step 1: Write the failing tests**

Flag tests (place beside the pipeline flag tests — e.g. append to `agentrail/tests/run/test_pipeline_objective_gate.py`):

```python
import json

from agentrail.run import pipeline as pipeline_mod


def test_ac_proof_mode_default_is_observe(monkeypatch, tmp_path):
    monkeypatch.delenv("AGENTRAIL_AC_PROOF_GATE", raising=False)
    assert pipeline_mod.ac_proof_mode(tmp_path) == "observe"


def test_ac_proof_mode_env_beats_config(monkeypatch, tmp_path):
    (tmp_path / ".agentrail").mkdir()
    (tmp_path / ".agentrail" / "config.json").write_text(json.dumps({"acProofGate": "enforce"}))
    monkeypatch.setenv("AGENTRAIL_AC_PROOF_GATE", "off")
    assert pipeline_mod.ac_proof_mode(tmp_path) == "off"
    monkeypatch.delenv("AGENTRAIL_AC_PROOF_GATE")
    assert pipeline_mod.ac_proof_mode(tmp_path) == "enforce"


def test_ac_proof_mode_typo_falls_through(monkeypatch, tmp_path):
    monkeypatch.setenv("AGENTRAIL_AC_PROOF_GATE", "enforcee")
    assert pipeline_mod.ac_proof_mode(tmp_path) == "observe"
```

Artifact writer test (append to the same file):

```python
def test_write_ac_evidence_merges(tmp_path):
    from agentrail.run.artifacts import write_ac_evidence
    from agentrail.shared.json import read_json
    path = tmp_path / "ac_evidence.json"
    write_ac_evidence(path, mode="observe", issue=7, head_sha="abc",
                      acs=[{"id": "AC1", "text": "a", "status": "unbound", "evidence": []}],
                      unbound=["AC1"], waived=[], unverifiable=[])
    write_ac_evidence(path, mode="observe", issue=7, head_sha="abc",
                      acs=[], unbound=[], waived=[], unverifiable=[
                          {"ac": "AC1", "why_unbound": "x", "what_would_prove_it": "y"}])
    data = read_json(path)
    assert data["mode"] == "observe" and data["unverifiable"][0]["ac"] == "AC1"
```

Observe-mode integration test — follow the existing end-to-end fixture in `agentrail/tests/run/test_pipeline_objective_gate.py` (it drives `_run_pipeline`/`run_prompt` with `resolution_text="Fix the bug.\n\n## Acceptance criteria\n- [ ] It works."` style fixtures). Add:

```python
def test_observe_mode_emits_ac_evidence_and_never_flips_verdict(...existing fixture args...):
    # Arrange the fixture exactly as the neighboring green-path test does,
    # with resolution_text carrying one checkbox AC and NO bindings file.
    # Run with AGENTRAIL_AC_PROOF_GATE=observe (monkeypatch.setenv).
    # Assert: run_dir/ac_evidence.json exists; its acs[0]["status"] == "unbound";
    # its mode == "observe"; the run's gate verdict EQUALS the neighboring
    # test's verdict (observe changed nothing); run.json's
    # objectiveGate.evidence contains an entry named "ac-proof-observe".

def test_off_mode_writes_no_artifact(...):
    # Same fixture with AGENTRAIL_AC_PROOF_GATE=off → no ac_evidence.json.
```
(These two are sketched because they must reuse the module's existing fixture helpers verbatim — copy the arrange/act body of the closest green-path test, then apply the listed asserts. Everything asserted is specified above; do not weaken the asserts.)

- [ ] **Step 2: Run to verify failure**

Run: `python3 -m pytest agentrail/tests/run/test_pipeline_objective_gate.py -q`
Expected: FAIL — no `ac_proof_mode` attribute.

- [ ] **Step 3: Implement**

Pipeline flag, after `jit_gather_enabled` (:162):

```python
# Arc C: the AC Proof Gate's three-state rollout flag. Deliberately NOT
# layer_enabled (that defaults ON, boolean): observe (compute + emit evidence,
# never gate) is the safe default; enforce is per-repo opt-in; off is the
# emergency stop. Precedent: jit_gather_enabled above (bespoke rollout flag).
AC_PROOF_ENV = "AGENTRAIL_AC_PROOF_GATE"
AC_PROOF_MODES = ("off", "observe", "enforce")


def ac_proof_mode(target_dir: Optional[Path] = None) -> str:
    """Resolve the AC Proof Gate mode: ``off`` | ``observe`` | ``enforce``.

    Precedence: env (evals/tests/emergency stop) → ``.agentrail/config.json``
    key ``acProofGate`` (per-repo opt-in) → default ``observe``. An
    unrecognized value falls through to the next source, so a typo can never
    silently flip enforcement.
    """
    raw = (os.environ.get(AC_PROOF_ENV) or "").strip().lower()
    if raw in AC_PROOF_MODES:
        return raw
    if target_dir is not None:
        config = _load_config(Path(target_dir)) or {}
        value = str(config.get("acProofGate") or "").strip().lower()
        if value in AC_PROOF_MODES:
            return value
    return "observe"
```
(`_load_config` import from `agentrail.guardrails.adapters.check_runner` — add to pipeline's import block if absent.)

Artifact writer, in `agentrail/run/artifacts.py` after `write_run_refusal_marker`:

```python
def write_ac_evidence(
    path: Path,
    *,
    mode: str,
    issue: int,
    head_sha: str,
    acs: List[Dict[str, Any]],
    unbound: List[str],
    waived: List[Dict[str, Any]],
    unverifiable: List[Dict[str, Any]],
) -> None:
    """Write/merge the per-run AC evidence artifact (Arc C, spec §5).

    Read-merge-write (the :func:`write_run_refusal_marker` idiom) so the
    refusal payload can join an already-written artifact — and vice versa —
    without clobbering. Written beside run.json at gate-finalization time;
    consumed by Arc D's Change Record and Arc E's calibration.
    """
    data = read_json(path) if path.exists() else {}
    data.update({
        "mode": mode, "issue": issue, "headSha": head_sha,
        "acs": acs, "unbound": unbound, "waived": waived,
    })
    if unverifiable:
        data["unverifiable"] = unverifiable
    write_json(path, data)
```

Gate-section wiring in `_run_pipeline` — restructure :1982-1991 (variable names in scope there: `declared`, `gate_checks`, `red_green_evidence`, `verification_evidence`, `metadata_file`, `rc`, `issue`, `target_dir`, `resolution_text`):

```python
    # Arc C: parse ACs with the intake parser, load bindings/waivers, compute
    # real per-AC coverage. observe = evidence only; enforce = it gates.
    ac_mode = ac_proof_mode(target_dir)
    ac_texts: List[str] = parse_acceptance_criteria(resolution_text) if ac_mode != "off" else []
    ac_detail = None
    ac_waivers: Dict[str, Dict[str, str]] = {}
    ac_unverifiable: Dict[str, Dict[str, str]] = {}
    if ac_mode != "off":
        ac_bindings, ac_unverifiable = load_ac_bindings(target_dir)
        ac_waivers = load_ac_waivers(target_dir)
        ac_detail = ac_coverage_for(
            ac_texts, ac_bindings, load_junit_results(target_dir),
            gate_checks, ac_waivers,
        )

    gate_result = evaluate(
        checks=gate_checks,
        ac_coverage=declared_check_coverage(declared),
        ac_coverage_detail=(ac_detail if ac_mode == "enforce" and ac_texts else None),
        red_green_evidence=red_green_evidence,
        verification_evidence=verification_evidence,
    )

    # Observe mode: a NON-GATING one-line summary joins the gate evidence so
    # run.json surfaces coverage without new readers (spec §5). Appended
    # before finalize so it persists; passed=True — observation, not verdict.
    if ac_mode == "observe" and ac_detail is not None:
        derived = ac_detail.to_ac_coverage()
        unbound_ids = ", ".join(ac_detail.unbound_ids)
        summary = (
            f"{derived.covered}/{derived.total} ACs proven or waived"
            + (f"; unbound: {unbound_ids}" if unbound_ids else "")
            if ac_texts else "no acceptance criteria parsed"
        )
        gate_result.evidence.append(
            Evidence(name="ac-proof-observe", passed=True, detail=summary)
        )

    outcome = finalize_objective_gate(
        metadata_file, gate_result=gate_result, review_advisory=None,
        independent_review_status=rc.independent_review_status,
    )

    # Arc C §5: every non-off run emits the per-AC evidence artifact.
    if ac_mode != "off" and ac_detail is not None:
        parsed_ids = {a.id for a in ac_detail.acs}
        declared_unverifiable = [
            {"ac": ac_id, "why_unbound": info.get("why", ""),
             "what_would_prove_it": info.get("whatWouldProveIt", "")}
            for ac_id, info in sorted(ac_unverifiable.items())
            if ac_id in parsed_ids
        ]
        artifacts.write_ac_evidence(
            rc.run_dir / "ac_evidence.json",
            mode=ac_mode,
            issue=issue,
            head_sha=_head_sha(target_dir),
            acs=[a.to_dict() for a in ac_detail.acs],
            unbound=ac_detail.unbound_ids,
            waived=[
                {"id": a.id, **ac_waivers.get(a.id, {})}
                for a in ac_detail.acs if a.status == "waived"
            ],
            unverifiable=declared_unverifiable,
        )
```

Plus the small helper near the pipeline's other subprocess helpers:

```python
def _head_sha(target_dir: Path) -> str:
    """Current HEAD sha of the run's working tree (best-effort, '' on failure)."""
    try:
        proc = subprocess.run(
            ["git", "rev-parse", "HEAD"], cwd=str(target_dir),
            capture_output=True, text=True, check=False,
        )
        return proc.stdout.strip() if proc.returncode == 0 else ""
    except Exception:  # noqa: BLE001 — the artifact key is best-effort
        return ""
```

Imports to add in pipeline.py: `parse_acceptance_criteria` (policies.input_contract), `load_ac_bindings, load_ac_waivers, load_junit_results` (adapters.ac_evidence), `Evidence` and `declared_check_coverage` (extend the existing objective/check_runner import lines), `_load_config` (adapters.check_runner), `subprocess` if not already imported. IMPORTANT: verify the exact local names at the call site by Reading pipeline.py :1930-2000 before editing — if `rc.run_dir` or `issue` is named differently in that scope, follow the file, not this plan.

- [ ] **Step 4: Run to verify pass**

Run: `python3 -m pytest agentrail/tests/run/test_pipeline_objective_gate.py agentrail/tests/run/test_pipeline.py agentrail/tests/run/test_objective_gate.py -q`
Expected: PASS — including both new integration tests and every pre-existing pipeline test (observe default must not disturb them; if a pre-existing test breaks, the wiring changed behavior — fix the wiring, never the old test).

- [ ] **Step 5: Commit**

```bash
git add agentrail/run/pipeline.py agentrail/run/artifacts.py agentrail/tests/run/test_pipeline_objective_gate.py
git commit -m "feat(run): ac_proof_mode flag + observe wiring — every run emits ac_evidence.json (Arc C §5, §8)"
```

---

### Task 7: Enforce mode — the gate that can fail

**Files:**
- Test: `agentrail/tests/run/test_pipeline_objective_gate.py` (integration; the wiring itself landed in Task 6)

**Interfaces:**
- Consumes: everything from Tasks 1-6. No new production code expected — this task PROVES enforce end-to-end and fixes whatever the proof flushes out.

- [ ] **Step 1: Write the failing-or-passing integration tests** (append; reuse the same fixture pattern as Task 6's tests)

```python
def test_enforce_three_acs_two_bindings_cannot_green(...):
    # Fixture: resolution_text with THREE checkbox ACs; a bindings file
    # binding AC1 + AC2 to the declared 'verify' check name; checks pass;
    # AGENTRAIL_AC_PROOF_GATE=enforce.
    # Assert: gate verdict is red; run.json objectiveGate.failedReasons
    # contains "acceptance-criteria unbound: AC3"; ac_evidence.json has
    # acs[2].status == "unbound" and mode == "enforce".

def test_enforce_all_bound_and_waived_greens(...):
    # Same fixture, AC1+AC2 bound to the passing 'verify' check, AC3 waived
    # via .agentrail/ac_waivers.json. Assert: gate verdict green (when the
    # fixture's checks pass); ac_evidence.json waived[0]["id"] == "AC3" and
    # the waiver's reason/by/at recorded verbatim.

def test_enforce_zero_acs_keeps_legacy_behavior(...):
    # Fixture with resolution_text carrying NO AC section, enforce mode.
    # Assert: verdict identical to the observe/off fixture (legacy
    # declared-check coverage decides); ac_evidence.json exists with
    # "acs": [] — vacuously inapplicable, honestly recorded (spec §1).
```
(Same sketch discipline as Task 6: copy the neighboring fixture body; every assert listed is required.)

- [ ] **Step 2: Run**

Run: `python3 -m pytest agentrail/tests/run/test_pipeline_objective_gate.py -q`
Expected: ideally PASS from Task 6's wiring; any failure is a wiring bug — fix in `pipeline.py`/`objective.py` (not by weakening asserts) and re-run.

- [ ] **Step 3: Commit**

```bash
git add agentrail/tests/run/test_pipeline_objective_gate.py
git commit -m "test(run): enforce-mode proof — 3-AC/2-binding cannot green; waivers recorded; zero-AC legacy (Arc C §4, §7)"
```

---

### Task 8: The `unverifiable` refusal — local branch, hosted reuse, bash lockstep

**Files:**
- Modify: `agentrail/run/pipeline.py` (refusal write, directly after Task 6's artifact block)
- Modify: `agentrail/afk/queue_state.py` (`Event` at :91-105, `transition` at :252-312)
- Modify: `agentrail/heartbeat/runtime.py` (`_STATUS_TO_EVENT` at :56-60, dispatch at :473)
- Modify: `agentrail/docker/runner/entrypoint.sh` (heredoc parser at :80-145)
- Test: `agentrail/tests/afk/test_queue_state.py`, `agentrail/tests/heartbeat/test_runtime.py`, `agentrail/tests/sandbox/test_native_runner.py`, new `agentrail/tests/sandbox/test_entrypoint_lockstep.py`, `agentrail/tests/run/test_pipeline_objective_gate.py`

**Interfaces:**
- Consumes: `HOSTED_REFUSAL_PREFIX` from `agentrail.sandbox.native_runner` (:86 — the byte-exact TS contract; import it, never retype).
- Produces: `Event.REFUSED = "refused"`; `transition(entry, Event.REFUSED) -> Terminal.ESCALATED_TO_HUMAN` with `remaining_budget` and `tier` UNCHANGED; `_event_for(result: RunResult) -> Event` in runtime; pipeline writes the refusal marker (`kind="unverifiable"`) when enforce + declared-unverifiable ACs; entrypoint.sh recognizes the marker.

- [ ] **Step 1: Write the failing tests**

`agentrail/tests/afk/test_queue_state.py` (append; mirror the module's existing transition-test style):

```python
def test_refused_event_escalates_without_budget_burn():
    entry = QueueEntry(number=7, remaining_budget=2, state=QueueState.RUNNING)
    out = transition(entry, Event.REFUSED)
    assert out.state is Terminal.ESCALATED_TO_HUMAN
    assert out.remaining_budget == 2   # refusal never burns budget
    assert out.tier == entry.tier      # and never bumps tier
```

`agentrail/tests/heartbeat/test_runtime.py` (append; import shapes from the module's existing tests):

```python
def test_event_for_refusal_prefix_routes_to_refused():
    from agentrail.heartbeat.runtime import _event_for
    from agentrail.sandbox.native_runner import HOSTED_REFUSAL_PREFIX
    from agentrail.sandbox.docker_runner import RunResult
    result = RunResult(status="error", cost_usd=0.0,
                       gate_reason=f"{HOSTED_REFUSAL_PREFIX}unverifiable acceptance criteria: AC3")
    assert _event_for(result) is Event.REFUSED


def test_event_for_unknown_status_still_defaults_gate_red():
    # The exploration's sharpest trap, pinned: the default stays GATE_RED for
    # unknown statuses, and refusal NEVER falls through to it.
    from agentrail.heartbeat.runtime import _event_for
    from agentrail.sandbox.docker_runner import RunResult
    assert _event_for(RunResult(status="banana", cost_usd=0.0)) is Event.GATE_RED
```
(`RunResult` construction: match its real dataclass signature — Read `agentrail/sandbox/docker_runner.py`'s RunResult first and adjust required fields.)

`agentrail/tests/sandbox/test_native_runner.py` (append — round-trip already half-exists for #1267; add the unverifiable kind):

```python
def test_unverifiable_refusal_marker_round_trips_to_prefixed_error(tmp_path):
    # write_run_refusal_marker(kind="unverifiable") → _result_from_run_json
    # must yield status "error" with the HOSTED_REFUSAL_PREFIX-prefixed
    # message — mirror the existing refusal-marker test body, changing kind
    # and message to "unverifiable acceptance criteria: AC3", and assert the
    # reason is HOSTED_REFUSAL_PREFIX + that message.
```

New `agentrail/tests/sandbox/test_entrypoint_lockstep.py`:

```python
"""Lockstep pin (Arc C §6): the bash run.json parser mirrors native_runner.

agentrail/docker/runner/entrypoint.sh duplicates _result_from_run_json in a
python heredoc. #1267's refusal branch never made it there — a refusal in the
container path fell through to 'red' and burned retries. Pin the branch AND
the byte-exact prefix so the two parsers cannot drift silently again.
"""
from pathlib import Path

from agentrail.sandbox.native_runner import HOSTED_REFUSAL_PREFIX

_ENTRYPOINT = Path(__file__).resolve().parents[2] / "docker" / "runner" / "entrypoint.sh"


def test_entrypoint_parses_refusal_marker_with_exact_prefix():
    text = _ENTRYPOINT.read_text()
    assert 'data.get("refusal")' in text
    assert f'"{HOSTED_REFUSAL_PREFIX}"' in text or f"'{HOSTED_REFUSAL_PREFIX}'" in text


def test_entrypoint_refusal_branch_precedes_gate_read():
    text = _ENTRYPOINT.read_text()
    assert text.index('data.get("refusal")') < text.index('data.get("objectiveGate")')
```

Pipeline integration (append to `test_pipeline_objective_gate.py`, same fixture discipline):

```python
def test_enforce_declared_unverifiable_writes_refusal_marker(...):
    # Fixture: one AC; bindings file declares
    # {"AC1": {"unverifiable": true, "why": "needs prod creds",
    #          "whatWouldProveIt": "a staging login"}}; enforce mode.
    # Assert: run.json has refusal.kind == "unverifiable" and refusal.message
    # containing "AC1"; ac_evidence.json "unverifiable"[0] carries ac,
    # why_unbound, what_would_prove_it; the run exits non-zero; in observe
    # mode the SAME fixture writes NO refusal marker (declaration recorded in
    # the artifact only).
```

- [ ] **Step 2: Run to verify failure**

Run: `python3 -m pytest agentrail/tests/afk/test_queue_state.py agentrail/tests/heartbeat/test_runtime.py agentrail/tests/sandbox/test_entrypoint_lockstep.py -q`
Expected: FAIL — `Event.REFUSED` missing, `_event_for` missing, entrypoint pin failing.

- [ ] **Step 3: Implement**

`agentrail/afk/queue_state.py` — extend `Event` (docstring + member):

```python
    - ``REFUSED`` — the run refused to proceed (hosted startup gap, or Arc C's
      declared-unverifiable ACs): straight to a human, NO budget consumed.
```
```python
    REFUSED = "refused"
```
And in `transition`, after the SECURITY_BLOCK branch (:293):

```python
    if event is Event.REFUSED:
        # A refusal (startup config gap, or acceptance criteria the run
        # declared unverifiable) is a human's decision, not a retryable
        # failure: budget and tier are preserved untouched — retrying cannot
        # fix a static gap, and burning budget on it would mask the signal.
        return replace(entry, state=Terminal.ESCALATED_TO_HUMAN)
```
Also update the module docstring's termination argument if it enumerates events (:267-270 — REFUSED is terminal-producing, so the argument still holds).

`agentrail/heartbeat/runtime.py` — import `HOSTED_REFUSAL_PREFIX` from `agentrail.sandbox.native_runner`; after `_STATUS_TO_EVENT` (:60) add:

```python
def _event_for(result: "RunResult") -> Event:
    """Queue event for a run result — refusals FIRST, then the status map.

    A refusal's ``gate_reason`` starts with the deterministic
    ``HOSTED_REFUSAL_PREFIX`` (#1267 cross-process contract; Arc C's
    ``unverifiable`` rides the same channel). It must route to
    ``Event.REFUSED`` BEFORE the status map: refusals surface as
    ``status="error"``, and the map's ``GATE_RED`` default would silently
    burn retry budget on a gap no retry can fix.
    """
    if (result.gate_reason or "").startswith(HOSTED_REFUSAL_PREFIX):
        return Event.REFUSED
    return _STATUS_TO_EVENT.get(result.status, Event.GATE_RED)
```
And replace :473 `event = _STATUS_TO_EVENT.get(result.status, Event.GATE_RED)` with `event = _event_for(result)`.

`agentrail/run/pipeline.py` — directly after Task 6's `write_ac_evidence` call, still inside the `ac_mode != "off"` block:

```python
        # Arc C §6: the builder declared ACs unverifiable. In enforce mode
        # that is a REFUSAL — the marker rides the existing channel
        # (write_run_refusal_marker → 'hosted-refusal: ' prefix → straight to
        # a human, no retry burn). The gate above is already red (declared-
        # unverifiable ACs are unbound), so exit codes need no new path; the
        # marker takes precedence in every result parser.
        if ac_mode == "enforce" and declared_unverifiable:
            compact = ", ".join(entry["ac"] for entry in declared_unverifiable)
            artifacts.write_run_refusal_marker(
                metadata_file,
                kind="unverifiable",
                status="error",
                message=f"unverifiable acceptance criteria: {compact}",
                independent_review_value=independent_review_metadata_value(
                    rc.independent_review_status
                ),
            )
```
(`independent_review_metadata_value` is the existing helper `finalize_objective_gate` uses at :391 — same module, already in scope.)

`agentrail/docker/runner/entrypoint.sh` — in the python heredoc, replace the gate read (:95) so the refusal branch comes first:

```python
    refusal = data.get("refusal")
    if isinstance(refusal, dict):
        # Mirror agentrail/sandbox/native_runner.py::_result_from_run_json
        # (#1267 + Arc C 'unverifiable'): a refusal marker beats everything.
        # The prefix is the byte-exact cross-process contract — keep in
        # lockstep with HOSTED_REFUSAL_PREFIX there and in runner.ts.
        status = "error"
        message = str(refusal.get("message") or "hosted run refused at startup")
        reason = "hosted-refusal: " + message
    else:
        gate = data.get("objectiveGate") or {}
        verdict = gate.get("verdict")
        if verdict == "green":
            status = "green"
        elif verdict == "red":
            status = "red"
            reasons = gate.get("failedReasons") or []
            reason = "; ".join(str(r) for r in reasons)
        else:
            # No gate recorded: fall back to the process exit status.
            status = "green" if run_status == 0 else "red"
            if status == "red":
                reason = f"agentrail run exited {run_status}"
```

- [ ] **Step 4: Run to verify pass**

Run:
```bash
python3 -m pytest agentrail/tests/afk/test_queue_state.py agentrail/tests/heartbeat/test_runtime.py agentrail/tests/sandbox/test_native_runner.py agentrail/tests/sandbox/test_entrypoint_lockstep.py agentrail/tests/run/test_pipeline_objective_gate.py -q
```
Expected: PASS, including every pre-existing heartbeat/queue test (REFUSED is additive; GATE_RED default pinned).

- [ ] **Step 5: Commit**

```bash
git add agentrail/afk/queue_state.py agentrail/heartbeat/runtime.py agentrail/run/pipeline.py agentrail/docker/runner/entrypoint.sh agentrail/tests/afk/test_queue_state.py agentrail/tests/heartbeat/test_runtime.py agentrail/tests/sandbox/test_native_runner.py agentrail/tests/sandbox/test_entrypoint_lockstep.py agentrail/tests/run/test_pipeline_objective_gate.py
git commit -m "feat(run): unverifiable refusal — Event.REFUSED without budget burn, entrypoint lockstep, _STATUS_TO_EVENT trap pinned (Arc C §6)"
```

---

### Task 9: C3 — builder binding discipline in the factory prompt

**Files:**
- Modify: `agentrail/run/prompts.py` (the execute-phase text at :773+ and/or the shared role segment `_shared_inline` near :735-745 — Read the surrounding structure first; the block must reach BOTH the test-author and execute roles, in ONE place if a shared segment exists, else duplicated with a comment naming the twin)
- Test: `agentrail/tests/run/test_prompts.py` (prose pins)

**Interfaces:**
- Consumes: nothing new. Produces: prompt text only. The plan phase's existing "Acceptance criteria mapping" heading (:764) stays untouched.

- [ ] **Step 1: Write the failing prose pins** (append to `agentrail/tests/run/test_prompts.py`, mirroring its existing build-prompt call style at :999/:1134)

```python
def test_execute_prompt_carries_ac_binding_discipline():
    text = _build_execute_prompt_for_test()  # mirror the neighboring tests' helper/call
    assert ".agentrail/ac_bindings.json" in text
    assert "unverifiable" in text
    assert "waivers are human-authored" in text.lower() or "never write" in text.lower()


def test_test_author_prompt_carries_ac_binding_discipline():
    text = _build_test_author_prompt_for_test()  # same discipline for the red-first role
    assert ".agentrail/ac_bindings.json" in text
```

- [ ] **Step 2: Run to verify failure**

Run: `python3 -m pytest agentrail/tests/run/test_prompts.py -q`
Expected: the two new pins FAIL.

- [ ] **Step 3: Implement** — add this block to the shared/role text so both roles receive it:

```
Acceptance-criteria bindings (AC Proof Gate):
- Maintain `.agentrail/ac_bindings.json` as you work: when you write the test
  that proves ACn, record it — {"ACn": ["<pytest node id>"]}. Bind to a
  declared verify-check name only when no per-test id exists.
- A binding is evidence only if the bound test/check runs and PASSES. Write
  the red-first test, bind it, then make it pass — the binding is born with
  the test, not backfilled at the end.
- If an AC genuinely cannot be verified in this run (needs credentials or
  services the run will never have), declare it instead of faking it:
  {"ACn": {"unverifiable": true, "why": "...", "whatWouldProveIt": "..."}}.
  Never claim done over an AC you could neither prove nor declare.
- Never write `.agentrail/ac_waivers.json` — waivers are human-authored only.
```

- [ ] **Step 4: Run to verify pass**

Run: `python3 -m pytest agentrail/tests/run/test_prompts.py -q`
Expected: PASS (old prompt pins included — the block must not disturb existing pinned wording).

- [ ] **Step 5: Commit**

```bash
git add agentrail/run/prompts.py agentrail/tests/run/test_prompts.py
git commit -m "feat(run): builder binding discipline in factory prompts — bindings born with the test (Arc C C3)"
```

---

### Task 10: Whole-arc verification + AC walk

**Files:** none new (verification, fixes only)

- [ ] **Step 1: Full focused suite + collateral modules**

Run:
```bash
python3 -m pytest agentrail/tests/run agentrail/tests/guardrails agentrail/tests/afk agentrail/tests/heartbeat agentrail/tests/sandbox -q
```
Expected: PASS. Fix regressions without weakening any assert.

- [ ] **Step 2: Walk the AC checklist below** — for each item, name the file+test that proves it. Any unproven item goes back to its task.

- [ ] **Step 3: Push + PR** (coordinator handles the final review + merge sequence).

## Acceptance criteria (final walk)

1. **One parser:** the run pipeline parses ACs via `parse_acceptance_criteria` (the intake parser); the `## Acceptance Criteria (P0)` drift case is fixed in `run/state.py` and pinned by parity tests.
2. **Bindings are adapter-read:** `.agentrail/ac_bindings.json` (and waivers) reach the pure math as plain data; `test_policies_purity.py` stays green.
3. **Test capture is honest:** verify_gate emits JUnit XML; `verifyReport` config overrides the location; evidence granularity is labeled `test` or `command`, never inflated.
4. **Real math:** `ac_coverage_for` yields per-AC `proven_test|proven_check|waived|unbound`; a binding to a missing or failed test is unbound-with-note; `AcCoverage`'s constructor is unchanged and frozen eval answer-keys are untouched; the audit-hole pin proves `covered < total` is constructible.
5. **Artifact:** every `observe`/`enforce` run writes `ac_evidence.json` (mode, issue, headSha, per-AC statuses+evidence, unbound, waived verbatim, unverifiable payload) via read-merge-write, and run.json's `objectiveGate.evidence` carries the one-line summary.
6. **Observe never gates; off is byte-identical:** gate verdicts in `off`/`observe` equal pre-arc behavior on identical fixtures.
7. **Enforce gates:** a 3-AC/2-binding run cannot green; failed reason names the ACs (`acceptance-criteria unbound: AC3`); zero-AC runs keep legacy behavior; all-waived cannot bypass "no declared verification → red".
8. **Refusal:** enforce + declared-unverifiable writes the `kind="unverifiable"` refusal marker with the structured payload duplicated into `ac_evidence.json`; hosted contract unchanged; local queue gains `Event.REFUSED` → `ESCALATED_TO_HUMAN` with budget and tier untouched; `_STATUS_TO_EVENT`'s GATE_RED default is pinned (unknown status → GATE_RED; refusal never hits the default); entrypoint.sh parses the marker with the byte-exact prefix, pinned by the lockstep test.
9. **Waivers:** in-repo `.agentrail/ac_waivers.json`, human-authored, treated as covered, recorded verbatim, always named in the summary.
10. **Flag:** `ac_proof_mode()` resolves env → config `acProofGate` → default `observe`; typos fall through; `off` is the emergency stop.
11. **C3:** factory prompts (test-author + execute) carry the binding discipline including the unverifiable declaration and the waivers-are-human-only rule, prose-pinned.
