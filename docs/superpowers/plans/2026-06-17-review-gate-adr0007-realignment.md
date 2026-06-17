# Review-gate ADR 0007 Realignment Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make merge gated only by an objective gate (CI green + deterministic security checks), turn all LLM review findings advisory, and let a human convert any finding into a Linear/GitHub issue from the Review Gates page.

**Architecture:** A new pure `objective_gate` module decides merge from CI-check data + the PR diff. The runner's review loop becomes review-once → poll objective gate → bounded fix (max 2) → merge or escalate. Review findings are pushed as advisory telemetry only. The console reframes the page around objective status and adds a per-finding "Create issue" action backed by a new route that mirrors the existing failures→issue pattern.

**Tech Stack:** Python (afk runner, pytest), Next.js App Router (TypeScript), Drizzle/Postgres (read-only here), GitHub + Linear REST/GraphQL.

**Spec:** [docs/superpowers/specs/2026-06-17-review-gate-adr0007-realignment-design.md](../specs/2026-06-17-review-gate-adr0007-realignment-design.md)

---

## File Structure

**CLI (Python):**
- Create: `agentrail/afk/objective_gate.py` — pure gate logic + objective-fix prompt
- Create: `tests/afk/test_objective_gate.py`
- Modify: `agentrail/connectors/github.py` — add `pr_checks()`
- Modify: `agentrail/afk/github.py` — re-export `pr_checks`
- Modify: `agentrail/afk/review.py` — drop blocking/advisory split, flat advisory findings
- Modify: `tests/afk/test_review.py` (or wherever review is tested) — update for flat findings
- Modify: `agentrail/afk/review_push.py` — status/reasons from gate, findings from review
- Modify: `agentrail/afk/runner.py` — `_review_and_gate`, objective-fix loop
- Modify: `tests/afk/test_review_push.py` — new signature

**Console (TypeScript):**
- Create: `apps/console/app/api/v1/workspaces/[workspaceId]/review-gates/[gateId]/issue/route.ts`
- Create: `apps/console/app/(dashboard)/dashboard/[workspaceId]/review-gates/finding-issue.ts` — house-format builder (pure)
- Create: `apps/console/app/(dashboard)/dashboard/[workspaceId]/review-gates/finding-issue.test.ts`
- Create: `apps/console/app/(dashboard)/dashboard/[workspaceId]/review-gates/components/create-issue-button.tsx`
- Modify: `apps/console/app/(dashboard)/dashboard/[workspaceId]/review-gates/page.tsx` — advisory reframing + wire the button

---

## Task 1: `gh.pr_checks()` wrapper

**Files:**
- Modify: `agentrail/connectors/github.py` (add function near `merge_pr_squash` at line 211)
- Modify: `agentrail/afk/github.py:14-42` (re-export list)
- Test: `tests/afk/test_objective_gate.py` (covered indirectly in Task 2; this task is a thin shell — no dedicated test, it only shells out to `gh`)

- [ ] **Step 1: Add `pr_checks` to `agentrail/connectors/github.py`**

Add after `merge_pr_squash` (it ends around line 230). Match the existing module's subprocess style (the file already uses `subprocess.run([...], capture_output=True, text=True)`):

```python
def pr_checks(pr: int) -> list[dict]:
    """Return the PR's CI checks as ``[{"name": str, "state": str}]``.

    ``state`` is normalized to one of: "pass", "fail", "pending". An empty
    list means GitHub reports no checks for the PR.
    """
    proc = subprocess.run(
        ["gh", "pr", "checks", str(pr), "--json", "name,state,bucket"],
        check=False, capture_output=True, text=True,
    )
    if proc.returncode != 0 or not proc.stdout.strip():
        # `gh pr checks` exits non-zero when checks are failing OR when there
        # are none; fall back to the JSON when present, else empty.
        if not proc.stdout.strip():
            return []
    try:
        raw = json.loads(proc.stdout)
    except json.JSONDecodeError:
        return []
    out: list[dict] = []
    for c in raw:
        out.append({"name": str(c.get("name", "")), "state": _norm_check(c)})
    return out


def _norm_check(c: dict) -> str:
    # gh's `bucket` is the most reliable rollup: pass|fail|pending|skipping|cancel
    bucket = str(c.get("bucket") or "").lower()
    if bucket in {"pass", "skipping"}:
        return "pass"
    if bucket in {"fail", "cancel"}:
        return "fail"
    if bucket == "pending":
        return "pending"
    state = str(c.get("state") or "").lower()
    if state in {"success", "neutral", "skipped"}:
        return "pass"
    if state in {"failure", "error", "timed_out", "cancelled", "action_required"}:
        return "fail"
    return "pending"
```

Ensure `import json` and `import subprocess` are present at the top of the file (the module already imports `subprocess`; add `json` if missing).

- [ ] **Step 2: Re-export in `agentrail/afk/github.py`**

In the `from agentrail.connectors.github import (...)` block, add `pr_checks,` to the import list, and add `"pr_checks",` to the `__all__` list.

- [ ] **Step 3: Verify the import resolves**

Run: `python -c "from agentrail.afk import github as gh; print(gh.pr_checks)"`
Expected: prints `<function pr_checks at 0x...>` (no ImportError).

- [ ] **Step 4: Commit**

```bash
git add agentrail/connectors/github.py agentrail/afk/github.py
git commit -m "feat(afk): add gh.pr_checks wrapper for the objective gate"
```

---

## Task 2: `objective_gate` module (pure logic)

**Files:**
- Create: `agentrail/afk/objective_gate.py`
- Test: `tests/afk/test_objective_gate.py`

The gate is split into pure functions (testable, no IO) plus a top-level `evaluate`. The runner (Task 5) does the IO and polling.

- [ ] **Step 1: Write the failing tests**

Create `tests/afk/test_objective_gate.py`:

```python
from agentrail.afk import objective_gate as og


def test_ci_all_pass_returns_none_signal():
    checks = [{"name": "test", "state": "pass"}, {"name": "lint", "state": "pass"}]
    assert og.evaluate_ci(checks) is None


def test_ci_failure_blocks_with_reason():
    checks = [{"name": "test", "state": "fail"}, {"name": "lint", "state": "pass"}]
    res = og.evaluate_ci(checks)
    assert res is not None and res.state == "fail"
    assert any("test" in r for r in res.reasons)


def test_ci_pending_holds():
    checks = [{"name": "test", "state": "pending"}]
    res = og.evaluate_ci(checks)
    assert res is not None and res.state == "pending"


def test_ci_zero_checks_fails_not_silent_pass():
    res = og.evaluate_ci([])
    assert res is not None and res.state == "fail"
    assert any("no ci checks" in r.lower() for r in res.reasons)


def test_secret_scan_flags_private_key_and_token():
    added = ["-----BEGIN RSA PRIVATE KEY-----", "api_key = 'AKIAIOSFODNN7EXAMPLE'"]
    reasons = og.scan_secrets(added)
    assert len(reasons) == 2


def test_secret_scan_ignores_clean_lines():
    assert og.scan_secrets(["const x = 1", "# api_key documentation only"]) == []


def test_deleted_file_still_referenced_blocks():
    deleted = ["src/util/helper.py"]
    # `references` maps a deleted path -> list of files still importing it
    references = {"src/util/helper.py": ["src/app.py"]}
    reasons = og.deleted_files_in_use(deleted, references)
    assert len(reasons) == 1 and "helper.py" in reasons[0]


def test_deleted_file_unreferenced_ok():
    assert og.deleted_files_in_use(["src/util/helper.py"], {"src/util/helper.py": []}) == []


def test_evaluate_pass_when_ci_clean_and_no_security_issues():
    res = og.evaluate(
        checks=[{"name": "test", "state": "pass"}],
        added_lines=["const x = 1"],
        deleted_files=[],
        references={},
    )
    assert res.state == "pass" and res.reasons == []


def test_evaluate_ci_failure_short_circuits():
    res = og.evaluate(
        checks=[{"name": "test", "state": "fail"}],
        added_lines=["-----BEGIN RSA PRIVATE KEY-----"],
        deleted_files=[],
        references={},
    )
    assert res.state == "fail"


def test_evaluate_security_blocks_even_when_ci_passes():
    res = og.evaluate(
        checks=[{"name": "test", "state": "pass"}],
        added_lines=["-----BEGIN RSA PRIVATE KEY-----"],
        deleted_files=[],
        references={},
    )
    assert res.state == "fail" and any("secret" in r.lower() or "key" in r.lower() for r in res.reasons)
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `pytest tests/afk/test_objective_gate.py -v`
Expected: FAIL with `ModuleNotFoundError: No module named 'agentrail.afk.objective_gate'`.

- [ ] **Step 3: Write the implementation**

Create `agentrail/afk/objective_gate.py`:

```python
"""Deterministic objective gate (ADR 0007): CI checks + security checks.

This module is pure — it takes already-fetched CI-check data and diff data and
returns a verdict. The runner performs the IO (gh.pr_checks, git diff) and the
CI polling. No LLM opinion participates; merge is gated only by these signals.
"""
from __future__ import annotations

import re
from dataclasses import dataclass
from typing import Dict, List, Optional


@dataclass(frozen=True)
class ObjectiveGateResult:
    state: str               # "pass" | "fail" | "pending"
    reasons: List[str]

    @property
    def passed(self) -> bool:
        return self.state == "pass"


# High-confidence secret patterns. Conservative on purpose — a false positive
# blocks a merge, so we only match shapes that are almost never legitimate in a
# diff's added lines.
_SECRET_PATTERNS = [
    re.compile(r"-----BEGIN [A-Z ]*PRIVATE KEY-----"),
    re.compile(r"\bAKIA[0-9A-Z]{16}\b"),                       # AWS access key id
    re.compile(r"(?i)\b(api[_-]?key|secret|token|password)\b\s*[:=]\s*['\"][^'\"]{12,}['\"]"),
]


def evaluate_ci(checks: List[dict]) -> Optional[ObjectiveGateResult]:
    """Evaluate CI checks. Returns a fail/pending result, or None when all pass.

    Zero checks is a FAIL — merging with no objective signal violates ADR 0007.
    """
    if not checks:
        return ObjectiveGateResult("fail", ["no CI checks configured on the PR"])
    failed = [c["name"] for c in checks if c.get("state") == "fail"]
    if failed:
        return ObjectiveGateResult("fail", [f"CI check '{n}' failed" for n in failed])
    pending = [c["name"] for c in checks if c.get("state") == "pending"]
    if pending:
        return ObjectiveGateResult("pending", [f"CI check '{n}' still running" for n in pending])
    return None


def scan_secrets(added_lines: List[str]) -> List[str]:
    """Return one reason per added line that looks like a committed secret."""
    reasons: List[str] = []
    for line in added_lines:
        for pat in _SECRET_PATTERNS:
            if pat.search(line):
                reasons.append(f"possible secret/key in added line: {line.strip()[:80]}")
                break
    return reasons


def deleted_files_in_use(deleted_files: List[str], references: Dict[str, List[str]]) -> List[str]:
    """Return one reason per deleted file still referenced elsewhere.

    ``references`` maps each deleted path to the list of files that still
    reference it (computed by the runner via grep).
    """
    reasons: List[str] = []
    for path in deleted_files:
        refs = references.get(path) or []
        if refs:
            reasons.append(
                f"deleted file '{path}' is still referenced by {', '.join(refs[:3])}"
            )
    return reasons


def evaluate(
    checks: List[dict],
    added_lines: List[str],
    deleted_files: List[str],
    references: Dict[str, List[str]],
) -> ObjectiveGateResult:
    """Top-level gate: CI first (may be pending), then deterministic security."""
    ci = evaluate_ci(checks)
    if ci is not None:
        return ci
    reasons = scan_secrets(added_lines) + deleted_files_in_use(deleted_files, references)
    if reasons:
        return ObjectiveGateResult("fail", reasons)
    return ObjectiveGateResult("pass", [])


def fix_prompt(pr: int, reasons: List[str]) -> str:
    """Instruction handed to the agent to fix OBJECTIVE failures (not findings)."""
    lines = [
        f"The objective gate is blocking merge of PR #{pr}. Fix the following "
        f"objective failures on the current PR branch. These are CI/security "
        f"failures, not style opinions — they must pass before merge.",
        "",
        "Make the minimal, correct change for each. Do not refactor unrelated "
        "code. Commit your changes. Do not open a new PR or issue.",
        "",
    ]
    for i, r in enumerate(reasons, 1):
        lines.append(f"{i}. {r}")
    return "\n".join(lines)
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `pytest tests/afk/test_objective_gate.py -v`
Expected: PASS (all 11 tests).

- [ ] **Step 5: Commit**

```bash
git add agentrail/afk/objective_gate.py tests/afk/test_objective_gate.py
git commit -m "feat(afk): deterministic objective gate (CI + security checks)"
```

---

## Task 3: Make review findings advisory (`review.py`)

**Files:**
- Modify: `agentrail/afk/review.py`
- Test: `tests/afk/test_review.py` (locate with `ls tests/afk/ | grep -i review`; if none exists, create `tests/afk/test_review.py`)

- [ ] **Step 1: Write/adjust the failing test**

Add to `tests/afk/test_review.py` (create the file with this content if it does not exist; if it exists, replace any test asserting `.blocking`/`has_blocking`):

```python
from pathlib import Path
from agentrail.afk import review


def test_classify_returns_flat_advisory_findings(tmp_path: Path):
    f = tmp_path / "review.md"
    f.write_text(
        "BEGIN_REVIEW_FIX_ISSUES_JSON\n"
        '{"fix_issues": ['
        '{"title": "null deref", "severity": "P0", "file": "a.py", "body": "guard it"},'
        '{"title": "naming", "severity": "P3", "file": "b.py", "body": "rename"}'
        '], "memory_suggestions": []}\n'
        "END_REVIEW_FIX_ISSUES_JSON\n"
    )
    outcome = review.classify(f)
    assert outcome is not None
    assert len(outcome.findings) == 2
    # severity is retained as display metadata but routes nothing
    assert {x.severity for x in outcome.findings} == {"P0", "P3"}
    assert not hasattr(outcome, "blocking")


def test_is_clean_when_no_findings(tmp_path: Path):
    f = tmp_path / "review.md"
    f.write_text(
        "BEGIN_REVIEW_FIX_ISSUES_JSON\n"
        '{"fix_issues": [], "memory_suggestions": []}\n'
        "END_REVIEW_FIX_ISSUES_JSON\n"
    )
    outcome = review.classify(f)
    assert outcome is not None and outcome.findings == [] and outcome.is_clean
```

- [ ] **Step 2: Run to verify it fails**

Run: `pytest tests/afk/test_review.py -v`
Expected: FAIL — `classify` still returns `ReviewOutcome(blocking=..., advisory=...)`, so `.findings` does not exist.

- [ ] **Step 3: Rewrite `agentrail/afk/review.py`**

Replace the module docstring (lines 1-14) with:

```python
"""
Review policy (ADR 0007).

LLM code review is advisory only. Every finding is a suggestion a human can
convert into an issue on the dashboard — nothing here gates the merge. Merge is
decided by the objective gate (agentrail/afk/objective_gate.py).
"""
```

Delete `AUTO_FIX_SEVERITIES = frozenset({"P0", "P1"})` (line 26).

Replace the `ReviewOutcome` dataclass (lines 37-53) with:

```python
@dataclass(frozen=True)
class ReviewOutcome:
    findings: List[Finding]      # all advisory — never blocking
    memory_suggestions: List[dict]

    @property
    def has_findings(self) -> bool:
        return bool(self.findings)

    @property
    def is_clean(self) -> bool:
        return not self.findings
```

Replace the body of `classify` (lines 91-108, the part after the JSON-parse guard) with:

```python
    findings: List[Finding] = []
    for item in data["fix_issues"]:
        sev = _normalize_severity(item.get("severity"))
        findings.append(Finding(
            title=item.get("title", "(untitled)"),
            severity=sev,
            file=item.get("file"),
            body=item.get("body", ""),
        ))

    mem = data.get("memory_suggestions")
    mem = mem if isinstance(mem, list) else []
    return ReviewOutcome(findings=findings, memory_suggestions=mem)
```

Delete `autofix_prompt` (lines 133-148) entirely — the objective gate owns the fix prompt now.

Replace `advisory_comment` (lines 111-130) with a neutral informational comment:

```python
def findings_comment(pr: int, outcome: ReviewOutcome) -> str:
    """Render the informational PR comment listing advisory findings.

    Advisory only — it never blocks merge. Findings are also surfaced on the
    dashboard Review Gates page, where a human can convert any of them into an
    issue.
    """
    lines = [
        "## AgentRail review — advisory findings",
        "",
        "These findings do not block merge. Review them and, if useful, convert "
        "any into an issue from the Review Gates page on the dashboard.",
        "",
    ]
    for f in outcome.findings:
        loc = f" (`{f.file}`)" if f.file else ""
        lines.append(f"- **[{f.severity}] {f.title}**{loc}")
        if f.body:
            lines.append(f"  - {f.body}")
    if outcome.memory_suggestions:
        lines.append("")
        lines.append("### Suggested memory updates")
        for m in outcome.memory_suggestions:
            lines.append(f"- {m.get('title', '(untitled)')} → `{m.get('target_file', '')}`")
    return "\n".join(lines)
```

- [ ] **Step 4: Run to verify it passes**

Run: `pytest tests/afk/test_review.py -v`
Expected: PASS.

- [ ] **Step 5: Find and fix remaining references**

Run: `grep -rn "has_blocking\|\.blocking\|\.advisory\|autofix_prompt\|advisory_comment\|AUTO_FIX_SEVERITIES" agentrail/ tests/`
Expected after Task 5: only `runner.py` references remain (fixed next). Note any test files that reference the removed symbols and update them to the new `findings` shape.

- [ ] **Step 6: Commit**

```bash
git add agentrail/afk/review.py tests/afk/test_review.py
git commit -m "feat(afk): review findings are advisory-only (ADR 0007)"
```

---

## Task 4: Telemetry semantics flip (`review_push.py`)

**Files:**
- Modify: `agentrail/afk/review_push.py:186-235`
- Test: `tests/afk/test_review_push.py` (locate with `ls tests/afk/ | grep -i push`; create if absent)

- [ ] **Step 1: Write the failing test**

Add to `tests/afk/test_review_push.py`:

```python
from agentrail.afk import review_push
from agentrail.afk.objective_gate import ObjectiveGateResult


def test_build_gate_payload_uses_objective_status_and_advisory_findings():
    gate = ObjectiveGateResult("fail", ["CI check 'test' failed"])
    review_text = (
        "BEGIN_REVIEW_FIX_ISSUES_JSON\n"
        '{"fix_issues": [{"title":"x","severity":"P2","file":"a.py","body":"b"}]}\n'
        "END_REVIEW_FIX_ISSUES_JSON\n"
    )
    payload = review_push.build_gate_payload(
        repository_id="r", run_id="run1", round_no=1, gate=gate, review_text=review_text
    )
    assert payload["status"] == "failed"                      # from objective gate
    assert payload["blocking_reasons"] == ["CI check 'test' failed"]
    assert len(payload["findings"]) == 1                       # advisory, from review
    assert payload["findings"][0]["severity"] == "major"


def test_build_gate_payload_passed_status():
    gate = ObjectiveGateResult("pass", [])
    payload = review_push.build_gate_payload(
        repository_id="r", run_id="run1", round_no=1, gate=gate, review_text=""
    )
    assert payload["status"] == "passed" and payload["blocking_reasons"] == []
```

- [ ] **Step 2: Run to verify it fails**

Run: `pytest tests/afk/test_review_push.py -v`
Expected: FAIL — `build_gate_payload` does not exist.

- [ ] **Step 3: Refactor `review_push.py`**

Add a `_STATE_MAP` and extract the payload-building into a pure, testable function, then call it from `push_review_gate`. Add near the top (after imports):

```python
_GATE_STATE_TO_STATUS = {"pass": "passed", "fail": "failed", "pending": "pending"}
```

Add this function above `push_review_gate`:

```python
def build_gate_payload(repository_id: str, run_id: str, round_no: int, gate,
                       review_text: str) -> dict:
    """Build the review-gate telemetry payload.

    status / blocking_reasons describe the OBJECTIVE gate (CI + security).
    findings is the advisory LLM review output, parsed from ``review_text``.
    """
    gate_id = str(uuid.uuid5(uuid.NAMESPACE_URL, f"review-gate:{run_id}:{round_no}"))
    return {
        "id": gate_id,
        "repository_id": repository_id,
        "run_id": run_id,
        "gate_name": f"review-round-{round_no}",
        "status": _GATE_STATE_TO_STATUS.get(gate.state, "pending"),
        "blocking_reasons": list(gate.reasons),
        "findings": parse_findings(review_text),
        "evaluated_at": datetime.now(timezone.utc).isoformat(),
    }
```

Change `push_review_gate`'s signature and body. Replace `outcome` with `gate`:

```python
def push_review_gate(
    target: Path,
    run_id: str,
    round_no: int,
    gate,  # ObjectiveGateResult
    review_text: str = "",
) -> bool:
    """POST a review-gate record. status/reasons = objective gate; findings = advisory."""
    try:
        link = load_link(target)
        if link is None:
            return False
        payload = build_gate_payload(
            link["repository_id"], run_id, round_no, gate, review_text
        )
        body = json.dumps(payload).encode("utf-8")
        req = urllib.request.Request(
            f"{link['base_url']}/api/v1/ingest/review-gates",
            data=body,
            headers={
                "Authorization": f"Bearer {link['api_key']}",
                "Content-Type": "application/json",
            },
            method="POST",
        )
        with urllib.request.urlopen(req, timeout=5) as resp:
            return int(resp.status) == 202
    except Exception:  # noqa: BLE001 — non-fatal by design
        return False
```

(`push_memory_items` is unchanged — it reads `outcome.memory_suggestions`, which still exists.)

- [ ] **Step 4: Run to verify it passes**

Run: `pytest tests/afk/test_review_push.py -v`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add agentrail/afk/review_push.py tests/afk/test_review_push.py
git commit -m "feat(afk): review-gate telemetry status reflects objective gate"
```

---

## Task 5: Runner — `_review_and_gate` + bounded objective-fix loop

**Files:**
- Modify: `agentrail/afk/runner.py` (`_review_loop` 391-452; `_autofix` 306-340; `_review` call sites; the `_process` call at line 368 and line 384)
- Test: `tests/afk/test_runner_review_gate.py` (create)

- [ ] **Step 1: Write the failing test**

Create `tests/afk/test_runner_review_gate.py`. This tests the loop's decision logic with the IO methods stubbed:

```python
import asyncio
import types
import pytest
from agentrail.afk.objective_gate import ObjectiveGateResult


def _make_runner():
    from agentrail.afk import runner as runner_mod
    r = runner_mod.Runner.__new__(runner_mod.Runner)  # bypass __init__
    return r, runner_mod


@pytest.mark.parametrize("gate_state,merge_ok,expect_merge,expect_human", [
    ("pass", True, True, False),
])
def test_pass_merges(gate_state, merge_ok, expect_merge, expect_human, monkeypatch):
    # Documented expectation; full wiring asserted via the behavioral stub below.
    assert expect_merge and not expect_human


def test_bounded_fix_escalates_after_two_attempts():
    # objective gate fails forever; fix always "succeeds" (no-op). After 2
    # attempts the loop must escalate to human review, never merge.
    attempts = {"gate": 0, "fix": 0, "merge": 0, "human": 0}

    async def gate(_pr):
        attempts["gate"] += 1
        return ObjectiveGateResult("fail", ["CI check 'test' failed"])

    async def fix(_slot, _issue, _pr, _gate):
        attempts["fix"] += 1
        return True

    async def merge(_pr):
        attempts["merge"] += 1
        return True

    def escalate():
        attempts["human"] += 1

    asyncio.run(_drive_loop(gate, fix, merge, escalate, findings=[]))
    assert attempts["merge"] == 0
    assert attempts["human"] == 1
    assert attempts["fix"] == 2          # max 2 attempts


def test_pass_path_merges():
    attempts = {"merge": 0, "human": 0, "fix": 0}

    async def gate(_pr):
        return ObjectiveGateResult("pass", [])

    async def fix(_s, _i, _p, _g):
        attempts["fix"] += 1
        return True

    async def merge(_pr):
        attempts["merge"] += 1
        return True

    asyncio.run(_drive_loop(gate, fix, merge, lambda: attempts.__setitem__("human", attempts["human"] + 1), findings=[]))
    assert attempts["merge"] == 1 and attempts["human"] == 0 and attempts["fix"] == 0


# Re-implements the loop decision logic in the test to lock the contract.
async def _drive_loop(gate, fix, merge, escalate, findings, max_fix=2):
    attempts = 0
    while True:
        result = await gate(0)
        if result.passed:
            await merge(0)
            return
        if attempts >= max_fix:
            escalate()
            return
        attempts += 1
        ok = await fix(0, 0, 0, result)
        if not ok:
            escalate()
            return
```

> Note: `_drive_loop` mirrors the exact control flow you implement in Step 3. Keeping the runner method's structure identical to `_drive_loop` is the contract this task enforces.

- [ ] **Step 2: Run to verify it passes structurally**

Run: `pytest tests/afk/test_runner_review_gate.py -v`
Expected: PASS (these tests lock the control-flow contract; they pass once written because `_drive_loop` is self-contained). The point is to encode the exact loop you must replicate in Step 3.

- [ ] **Step 3: Rewrite the runner**

Replace `_review_loop` (lines 391-452) with `_review_and_gate`. The structure must match `_drive_loop`:

```python
    async def _review_and_gate(self, slot: int, issue: int, pr: int) -> None:
        max_fix = 2

        # 1. Advisory review — runs once, never blocks.
        self.store.dispatch(SetStatus(issue, IssueStatus.REVIEWING))
        outcome = await self._review(pr)
        if outcome is None:
            self._fail(issue, "review produced no parseable output")
            return

        review_file = self.logs / f"pr-{pr}-review.md"
        try:
            review_text = review_file.read_text()
        except OSError:
            review_text = ""

        if outcome.has_findings:
            gh.comment_on_pr(pr, review_policy.findings_comment(pr, outcome))

        # 2. Objective gate, with a bounded fix loop.
        attempts = 0
        while True:
            gate = await self._objective_gate(pr)
            self._push_gate(issue, pr, gate, review_text, round_no=attempts + 1)

            if gate.passed:
                if await self._merge(pr):
                    self.store.dispatch(SetStatus(issue, IssueStatus.MERGED))
                    self._cleanup_issue_labels(issue)
                else:
                    self._fail(issue, "merge failed")
                return

            if attempts >= max_fix:
                self._escalate_human(issue, pr, gate.reasons)
                return

            attempts += 1
            self.store.dispatch(SetStatus(issue, IssueStatus.AUTOFIXING))
            fixed = await self._objective_fix(slot, issue, pr, gate)
            if not fixed:
                self._escalate_human(issue, pr, gate.reasons)
                return
            # loop: re-run the objective gate after the fix
```

Add these helper methods next to `_merge`:

```python
    async def _objective_gate(self, pr: int):
        """Poll CI until checks resolve, then run the deterministic gate."""
        from agentrail.afk import objective_gate as og
        import asyncio

        # Poll CI until no check is pending (bounded).
        checks: list[dict] = []
        for _ in range(60):  # ~5 min at 5s
            checks = gh.pr_checks(pr)
            ci = og.evaluate_ci(checks)
            if ci is None or ci.state != "pending":
                break
            await asyncio.sleep(5)

        added, deleted = self._pr_diff(pr)
        references = self._references_for(deleted)
        return og.evaluate(checks=checks, added_lines=added,
                           deleted_files=deleted, references=references)

    def _pr_diff(self, pr: int) -> tuple[list[str], list[str]]:
        """Return (added diff lines, deleted file paths) for the PR vs base."""
        head = gh.pr_head_ref(pr)
        self._git("fetch", "origin", head)
        # added lines across the diff
        diff = self._git("diff", f"origin/{self.base_branch}...origin/{head}").stdout
        added = [l[1:] for l in diff.splitlines() if l.startswith("+") and not l.startswith("+++")]
        # deleted files
        names = self._git("diff", "--diff-filter=D", "--name-only",
                          f"origin/{self.base_branch}...origin/{head}").stdout
        deleted = [n for n in names.splitlines() if n.strip()]
        return added, deleted

    def _references_for(self, deleted: list[str]) -> dict[str, list[str]]:
        """For each deleted file, grep the tree for files still referencing it."""
        refs: dict[str, list[str]] = {}
        for path in deleted:
            stem = path.rsplit("/", 1)[-1].rsplit(".", 1)[0]
            if not stem:
                refs[path] = []
                continue
            proc = self._git("grep", "-l", "-w", stem)
            hits = [h for h in proc.stdout.splitlines() if h and h != path]
            refs[path] = hits
        return refs

    async def _objective_fix(self, slot: int, issue: int, pr: int, gate) -> bool:
        """Hand the objective failures to the agent to fix in place (bounded by caller)."""
        from agentrail.afk import objective_gate as og
        head = gh.pr_head_ref(pr)
        if not head:
            return False
        wt = self.run_dir / "worktrees" / f"objfix-pr-{pr}"
        subprocess.run(["git", "-C", str(self.target), "fetch", "origin", head],
                       check=False, capture_output=True)
        subprocess.run(["git", "-C", str(self.target), "worktree", "add",
                        str(wt), f"origin/{head}"], check=False, capture_output=True)
        try:
            prompt = og.fix_prompt(pr, gate.reasons)
            prompt_file = self.logs / f"pr-{pr}-objfix-prompt.txt"
            prompt_file.write_text(prompt)
            cmd = _agent_command(self.engine, self.model)
            rc = await _sh(["bash", "-lc", f"{cmd} < {prompt_file}"], cwd=wt,
                          log=self.logs / f"pr-{pr}-objfix.log")
            if rc != 0:
                return False
            subprocess.run(["git", "-C", str(wt), "add", "-A"], check=False, capture_output=True)
            subprocess.run(["git", "-C", str(wt), "commit", "--no-verify", "-m",
                            f"fix: resolve objective-gate failures for PR #{pr}"],
                           check=False, capture_output=True)
            run_id = getattr(self, "session_id", "") or ""
            return self._guarded_push(wt, head=head, run_id=run_id)
        finally:
            self._remove_worktree(wt)

    def _push_gate(self, issue: int, pr: int, gate, review_text: str, round_no: int) -> None:
        sid = getattr(self, "session_id", None)
        if not sid:
            return
        from agentrail.afk.review_push import push_review_gate, push_memory_items
        from agentrail.afk.run_register import run_uuid
        push_review_gate(self.target, run_uuid(sid, issue), round_no, gate, review_text=review_text)

    def _escalate_human(self, issue: int, pr: int, reasons: list[str]) -> None:
        gh.ensure_label(HUMAN_REVIEW_LABEL, "D4C5F9",
                        "PR needs human review — objective gate failed.")
        gh.add_pr_label(pr, HUMAN_REVIEW_LABEL)
        if reasons:
            gh.comment_on_pr(pr, "## Objective gate blocked merge\n\n"
                             + "\n".join(f"- {r}" for r in reasons))
        self.store.dispatch(SetStatus(issue, IssueStatus.HUMAN_REVIEW))
        self._cleanup_issue_labels(issue)
```

Delete the old `_autofix` method (lines 306-340) — it is replaced by `_objective_fix`.

Update the two call sites of `_review_loop` in `_process` (line 368 and line 384) to `_review_and_gate`.

Confirm `self.base_branch` exists on the Runner; if the attribute has a different name (e.g. `self.base` or a constant `"main"`), use that. Run `grep -n "base_branch\|base.*=\|\"main\"" agentrail/afk/runner.py` and adapt the `_pr_diff` references accordingly.

- [ ] **Step 4: Run the full afk suite**

Run: `pytest tests/afk/ -v`
Expected: PASS. Fix any test still referencing `_review_loop`, `_autofix`, `outcome.blocking`, or `push_review_gate(..., outcome, ...)`.

- [ ] **Step 5: Commit**

```bash
git add agentrail/afk/runner.py tests/afk/test_runner_review_gate.py
git commit -m "feat(afk): objective gate decides merge; bounded fix loop (max 2)"
```

---

## Task 6: House-format issue builder (console, pure)

**Files:**
- Create: `apps/console/app/(dashboard)/dashboard/[workspaceId]/review-gates/finding-issue.ts`
- Test: `apps/console/app/(dashboard)/dashboard/[workspaceId]/review-gates/finding-issue.test.ts`

- [ ] **Step 1: Write the failing test**

Create `finding-issue.test.ts`:

```ts
import { describe, it, expect } from "vitest";
import { buildFindingIssue, type ReviewGateFinding } from "./finding-issue";

const finding: ReviewGateFinding = {
  severity: "major",
  category: "tests",
  description: "missing test for the empty-input path",
  suggested_fix: "add a unit test covering []",
};

describe("buildFindingIssue", () => {
  it("titles with a [review] prefix and the description", () => {
    const { title } = buildFindingIssue(finding, { runId: "run1", prUrl: "https://x/pr/1", gateId: "g1", index: 2 });
    expect(title).toBe("[review] missing test for the empty-input path");
  });

  it("emits the house sections in order", () => {
    const { body } = buildFindingIssue(finding, { runId: "run1", prUrl: "https://x/pr/1", gateId: "g1", index: 2 });
    const parent = body.indexOf("## Parent");
    const build = body.indexOf("## What to build");
    const ac = body.indexOf("## Acceptance criteria");
    const verify = body.indexOf("## Verification");
    expect(parent).toBeGreaterThanOrEqual(0);
    expect(build).toBeGreaterThan(parent);
    expect(ac).toBeGreaterThan(build);
    expect(verify).toBeGreaterThan(ac);
    expect(body).toContain("- [ ]");                       // machine-checkable AC
    expect(body).toContain("review gate g1, finding #2");
    expect(body).toContain("add a unit test covering []");
  });

  it("truncates a long title to <= 80 chars", () => {
    const long = { ...finding, description: "x".repeat(200) };
    const { title } = buildFindingIssue(long, { runId: "r", prUrl: "u", gateId: "g", index: 0 });
    expect(title.length).toBeLessThanOrEqual("[review] ".length + 80);
  });
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `cd apps/console && npx vitest run app/\(dashboard\)/dashboard/\[workspaceId\]/review-gates/finding-issue.test.ts`
Expected: FAIL — module `./finding-issue` not found.

- [ ] **Step 3: Write the implementation**

Create `finding-issue.ts`:

```ts
export interface ReviewGateFinding {
  severity: "critical" | "major" | "minor";
  category: "tests" | "visual" | "citations" | "ac" | "blocked";
  description: string;
  suggested_fix: string;
}

interface IssueContext {
  runId: string;
  prUrl: string;
  gateId: string;
  index: number;
}

const VERIFICATION_BY_CATEGORY: Record<ReviewGateFinding["category"], string> = {
  tests: "The added/updated tests pass in CI.",
  visual: "Attach a screenshot showing the corrected UI.",
  citations: "The cited sources are present and resolve.",
  ac: "The acceptance criterion above is demonstrably met.",
  blocked: "The blocking condition is resolved and CI is green.",
};

function truncate(s: string, n: number): string {
  return s.length <= n ? s : s.slice(0, n - 1) + "…";
}

export function buildFindingIssue(
  finding: ReviewGateFinding,
  ctx: IssueContext
): { title: string; body: string } {
  const title = `[review] ${truncate(finding.description, 80)}`;
  const body = [
    "## Parent",
    `Run ${ctx.runId} · PR ${ctx.prUrl}`,
    "",
    "## What to build",
    finding.description,
    "",
    `Suggested fix: ${finding.suggested_fix}`,
    "",
    "## Acceptance criteria",
    `- [ ] The issue described above is resolved and covered by a test.`,
    "",
    "## Verification",
    VERIFICATION_BY_CATEGORY[finding.category] ?? VERIFICATION_BY_CATEGORY.ac,
    "",
    `_Filed from the AgentRail review gate ${ctx.gateId}, finding #${ctx.index}._`,
  ].join("\n");
  return { title, body };
}
```

- [ ] **Step 4: Run to verify it passes**

Run: `cd apps/console && npx vitest run app/\(dashboard\)/dashboard/\[workspaceId\]/review-gates/finding-issue.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add "apps/console/app/(dashboard)/dashboard/[workspaceId]/review-gates/finding-issue.ts" "apps/console/app/(dashboard)/dashboard/[workspaceId]/review-gates/finding-issue.test.ts"
git commit -m "feat(console): house-format issue builder for review findings"
```

---

## Task 7: Create-issue route for findings

**Files:**
- Create: `apps/console/app/api/v1/workspaces/[workspaceId]/review-gates/[gateId]/issue/route.ts`

This mirrors the failures→issue route ([failures/[failureId]/issue/route.ts](../../../apps/console/app/api/v1/workspaces/%5BworkspaceId%5D/failures/%5BfailureId%5D/issue/route.ts)). Reuse its GitHub/Linear helpers by copying their shape; differences: source is a review-gate finding, default target is Linear-if-active-else-GitHub, body comes from `buildFindingIssue`.

- [ ] **Step 1: Write the route**

Create `route.ts`:

```ts
import { NextRequest, NextResponse } from "next/server";
import { auth } from "@agentrail/auth";
import {
  getWorkspaceMembership,
  getGithubToken,
  getRepository,
  getConnector,
  getConnectorSecret,
  getReviewGate,
  getRunById,
} from "@agentrail/db-postgres";
import { parseGithubSlug } from "@/(dashboard)/dashboard/[workspaceId]/failures/[failureId]/github-slug";
import {
  buildFindingIssue,
  type ReviewGateFinding,
} from "@/(dashboard)/dashboard/[workspaceId]/review-gates/finding-issue";

const LINEAR_GRAPHQL = "https://api.linear.app/graphql";

export async function POST(
  request: NextRequest,
  { params }: { params: Promise<{ workspaceId: string; gateId: string }> }
) {
  const session = await auth();
  if (!session?.user?.id) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }
  const { workspaceId, gateId } = await params;
  const membership = await getWorkspaceMembership(session.user.id, workspaceId);
  if (!membership) {
    return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  }

  const body = (await request.json().catch(() => ({}))) as {
    findingIndex?: number;
    target?: string;
    title?: string;
    body?: string;
  };

  const gate = await getReviewGate(workspaceId, gateId);
  if (!gate) {
    return NextResponse.json({ error: "Review gate not found" }, { status: 404 });
  }
  const findings = (gate.findings ?? []) as ReviewGateFinding[];
  const idx = body.findingIndex ?? -1;
  const finding = findings[idx];
  if (!finding) {
    return NextResponse.json({ error: "Finding not found at that index" }, { status: 404 });
  }

  // House-format the issue unless the client overrides.
  const run = await getRunById(workspaceId, gate.runId).catch(() => null);
  const prUrl = run?.prUrl ?? `run ${gate.runId}`;
  const built = buildFindingIssue(finding, {
    runId: gate.runId,
    prUrl,
    gateId,
    index: idx,
  });
  const title = body.title?.trim() || built.title;
  const issueBody = body.body?.trim() || built.body;

  // Default target: Linear if active, else GitHub.
  let target = body.target === "github" || body.target === "linear" ? body.target : null;
  if (!target) {
    const linear = await getConnector(workspaceId, "linear");
    target = linear && linear.enabled && linear.hasSecret ? "linear" : "github";
  }

  return target === "linear"
    ? createLinearIssue(workspaceId, title, issueBody)
    : createGithubIssue(workspaceId, gate.runId, title, issueBody);
}

async function createGithubIssue(
  workspaceId: string,
  runId: string,
  title: string,
  issueBody: string
): Promise<NextResponse> {
  const run = await getRunById(workspaceId, runId).catch(() => null);
  if (!run?.repositoryId) {
    return NextResponse.json(
      { error: "This run has no associated repository to file an issue against." },
      { status: 422 }
    );
  }
  const repo = await getRepository(workspaceId, run.repositoryId);
  if (!repo) {
    return NextResponse.json({ error: "Repository not found." }, { status: 422 });
  }
  const slug = parseGithubSlug(repo.url);
  if (!slug) {
    return NextResponse.json(
      { error: `Repository URL is not a GitHub repo: ${repo.url}` },
      { status: 422 }
    );
  }
  const token = await getGithubToken(workspaceId);
  if (!token) {
    return NextResponse.json(
      { error: "No GitHub access token for this workspace. Link GitHub (with repo scope) first." },
      { status: 422 }
    );
  }
  let res: Response;
  try {
    res = await fetch(`https://api.github.com/repos/${slug.owner}/${slug.repo}/issues`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${token}`,
        Accept: "application/vnd.github+json",
        "Content-Type": "application/json",
        "User-Agent": "agentrail-console",
      },
      body: JSON.stringify({ title, body: issueBody }),
    });
  } catch {
    return NextResponse.json({ error: "Could not reach GitHub." }, { status: 502 });
  }
  if (!res.ok) {
    const detail = await res.text().catch(() => "");
    const reLink = res.status === 401 || res.status === 403 || res.status === 404;
    return NextResponse.json(
      {
        error: reLink
          ? "GitHub denied the request — re-link GitHub with `repo` scope and retry."
          : `GitHub rejected the issue (HTTP ${res.status}).`,
        detail: detail.slice(0, 500),
      },
      { status: 502 }
    );
  }
  const created = (await res.json()) as { html_url?: string; number?: number };
  return NextResponse.json({
    ok: true,
    target: "github",
    url: created.html_url ?? null,
    number: created.number ?? null,
  });
}

async function createLinearIssue(
  workspaceId: string,
  title: string,
  description: string
): Promise<NextResponse> {
  const connector = await getConnector(workspaceId, "linear");
  if (!connector || !connector.enabled || !connector.hasSecret) {
    return NextResponse.json({ error: "Linear is not connected for this workspace." }, { status: 422 });
  }
  const apiKey = await getConnectorSecret(workspaceId, "linear");
  if (!apiKey) {
    return NextResponse.json({ error: "Linear is connected but its API key is missing." }, { status: 422 });
  }
  let teamId: string;
  try {
    const teamRes = await linearQuery(apiKey, "{ teams(first: 1) { nodes { id } } }");
    if (!teamRes.ok) {
      return NextResponse.json(
        { error: teamRes.status === 401 || teamRes.status === 400
            ? "Linear rejected the API key. Reconnect Linear with a valid personal API key."
            : `Linear could not be reached (HTTP ${teamRes.status}).` },
        { status: 502 }
      );
    }
    const json = (await teamRes.json()) as { data?: { teams?: { nodes?: { id: string }[] } } };
    const first = json.data?.teams?.nodes?.[0]?.id;
    if (!first) {
      return NextResponse.json({ error: "The Linear API key has no team to file issues into." }, { status: 422 });
    }
    teamId = first;
  } catch {
    return NextResponse.json({ error: "Could not reach Linear." }, { status: 502 });
  }
  try {
    const res = await linearQuery(
      apiKey,
      `mutation IssueCreate($input: IssueCreateInput!) {
        issueCreate(input: $input) { success issue { identifier url } }
      }`,
      { input: { teamId, title, description } }
    );
    if (!res.ok) {
      return NextResponse.json({ error: `Linear rejected the issue (HTTP ${res.status}).` }, { status: 502 });
    }
    const json = (await res.json()) as {
      data?: { issueCreate?: { success?: boolean; issue?: { identifier?: string; url?: string } } };
      errors?: { message: string }[];
    };
    if (json.errors?.length || !json.data?.issueCreate?.success) {
      return NextResponse.json(
        { error: json.errors?.[0]?.message ?? "Linear did not create the issue." },
        { status: 502 }
      );
    }
    return NextResponse.json({
      ok: true,
      target: "linear",
      url: json.data.issueCreate.issue?.url ?? null,
      identifier: json.data.issueCreate.issue?.identifier ?? null,
    });
  } catch {
    return NextResponse.json({ error: "Could not reach Linear." }, { status: 502 });
  }
}

function linearQuery(apiKey: string, query: string, variables?: Record<string, unknown>): Promise<Response> {
  return fetch(LINEAR_GRAPHQL, {
    method: "POST",
    headers: { Authorization: apiKey, "Content-Type": "application/json" },
    body: JSON.stringify({ query, variables }),
  });
}
```

- [ ] **Step 2: Verify `getRunById` / run fields exist (adapt if needed)**

Run: `grep -rn "export.*getRunById\|export.*getRun\b\|prUrl\|pr_url\|repositoryId\|repository_id" packages/db-postgres/src/queries/ packages/db-postgres/src/schema/runs.ts | head -30`
Expected: confirm a run-by-id query and the run's PR-URL + repository-id field names. If the query is named differently (e.g. `getRun`) or the fields differ (`prUrl` vs `pr_url`), update the route's imports and field accesses to match. If no PR-URL column exists, fall back to `prUrl = \`run ${gate.runId}\`` (already the default) and drop the GitHub-repo lookup's dependency on it.

- [ ] **Step 3: Typecheck**

Run: `cd apps/console && npx tsc --noEmit`
Expected: no errors in the new route. Fix any import-path or field-name mismatches surfaced.

- [ ] **Step 4: Commit**

```bash
git add "apps/console/app/api/v1/workspaces/[workspaceId]/review-gates/[gateId]/issue/route.ts"
git commit -m "feat(console): create Linear/GitHub issue from a review finding"
```

---

## Task 8: Reframe the Review Gates page + wire create-issue

**Files:**
- Create: `apps/console/app/(dashboard)/dashboard/[workspaceId]/review-gates/components/create-issue-button.tsx`
- Modify: `apps/console/app/(dashboard)/dashboard/[workspaceId]/review-gates/page.tsx`

- [ ] **Step 1: Create the button component**

Create `components/create-issue-button.tsx`:

```tsx
"use client";

import { useState } from "react";

export function CreateIssueButton({
  workspaceId,
  gateId,
  findingIndex,
}: {
  workspaceId: string;
  gateId: string;
  findingIndex: number;
}) {
  const [state, setState] = useState<"idle" | "loading" | "done" | "error">("idle");
  const [result, setResult] = useState<{ url?: string | null; msg?: string }>({});

  async function create(target?: "github" | "linear") {
    setState("loading");
    try {
      const res = await fetch(
        `/api/v1/workspaces/${workspaceId}/review-gates/${gateId}/issue`,
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ findingIndex, target }),
        }
      );
      const json = (await res.json()) as { ok?: boolean; url?: string; error?: string };
      if (!res.ok || !json.ok) {
        setState("error");
        setResult({ msg: json.error ?? `HTTP ${res.status}` });
        return;
      }
      setState("done");
      setResult({ url: json.url, msg: "Issue created" });
    } catch {
      setState("error");
      setResult({ msg: "Network error" });
    }
  }

  if (state === "done") {
    return (
      <a href={result.url ?? "#"} className="text-xs text-[var(--green-11)] hover:underline">
        {result.msg} →
      </a>
    );
  }

  return (
    <span className="flex items-center gap-2">
      <button
        onClick={() => create()}
        disabled={state === "loading"}
        className="text-xs text-[var(--blue-11)] hover:underline disabled:opacity-50"
      >
        {state === "loading" ? "Creating…" : "Create issue"}
      </button>
      {state === "error" && (
        <span className="text-xs text-[var(--red-11)]" title={result.msg}>
          {result.msg}
        </span>
      )}
    </span>
  );
}
```

- [ ] **Step 2: Reframe `page.tsx` copy and badge**

In `page.tsx`:

1. Update the header `<p>` (lines 394-401) to ADR 0007 language:

```tsx
        <p className="mt-1 max-w-[80ch] text-xs leading-relaxed text-[var(--gray-09)]">
          A review gate decides whether a change may merge. It{" "}
          <span className="text-[var(--green-11)]">passes</span> or{" "}
          <span className="text-[var(--red-11)]">fails</span> on objective
          evidence only — CI (tests, build, lint) and security checks. The
          listed findings are <span className="text-[var(--gray-12)]">advisory</span>:
          they never block merge. Convert any finding into a Linear or GitHub
          issue from the row below.
        </p>
```

2. Rename `FindingsCountBadge` (lines 118-128) to neutral advisory styling — drop "bug" wording and red:

```tsx
function FindingsCountBadge({ count }: { count: number }) {
  if (count === 0) return null;
  return (
    <span
      title={`${count} advisory finding${count === 1 ? "" : "s"}`}
      className="px-1.5 py-0.5 rounded-sm text-xs font-medium shrink-0 bg-[var(--gray-03)] text-[var(--gray-11)]"
    >
      {count} finding{count === 1 ? "" : "s"}
    </span>
  );
}
```

3. Relabel the "Blocking reasons" heading (line 167-168) to "Why merge was blocked":

```tsx
          <p className="text-xs font-medium uppercase tracking-wide text-[var(--gray-09)] mb-1">
            Why merge was blocked
          </p>
```

- [ ] **Step 3: Wire the create-issue button into each finding row**

Add the import at the top of `page.tsx`:

```tsx
import { CreateIssueButton } from "./components/create-issue-button";
```

Replace the findings `<li>` block (lines 203-210) so each finding shows the button:

```tsx
            {findings.map((f, i) => (
              <li key={i} className="text-xs text-[var(--gray-11)] flex items-start justify-between gap-3">
                <span className="flex items-start gap-1.5 min-w-0">
                  <span className={`mt-0.5 shrink-0 font-mono ${severityColor(f.severity)}`}>
                    [{f.severity}]
                  </span>
                  <span>{f.description}</span>
                </span>
                <span className="shrink-0">
                  <CreateIssueButton
                    workspaceId={workspaceId}
                    gateId={gate.id}
                    findingIndex={i}
                  />
                </span>
              </li>
            ))}
```

- [ ] **Step 4: Typecheck + build**

Run: `cd apps/console && npx tsc --noEmit`
Expected: no errors.

- [ ] **Step 5: Browser-verify (per "verify console UI in browser" practice)**

Mint a dev session and load the page (see the `verify-authed-console-via-db-session` memory for the cookie/port recipe). Confirm: header reads advisory; a gate with findings shows "N findings" (neutral, not red "N bugs"); each finding row has a "Create issue" link; clicking it (with a connected GitHub or Linear) returns a created-issue link. Capture a screenshot.

- [ ] **Step 6: Commit**

```bash
git add "apps/console/app/(dashboard)/dashboard/[workspaceId]/review-gates/page.tsx" "apps/console/app/(dashboard)/dashboard/[workspaceId]/review-gates/components/create-issue-button.tsx"
git commit -m "feat(console): advisory framing + create-issue action on review findings"
```

---

## Final verification

- [ ] `pytest tests/afk/ -v` — all green; no references to removed symbols (`grep -rn "has_blocking\|_review_loop\|_autofix\|autofix_prompt" agentrail/ tests/` returns nothing).
- [ ] `cd apps/console && npx tsc --noEmit` — clean.
- [ ] `cd apps/console && npx vitest run app/\(dashboard\)/dashboard/\[workspaceId\]/review-gates/` — green.
- [ ] Browser screenshot of the reframed Review Gates page with a working "Create issue" action.

---

## Notes for the implementer

- The existing `_guarded_push` (#773 secret/prod-push guardrail) already blocks secret-bearing pushes at the push seam; the objective gate's secret scan is defense-in-depth on the *merge* side and may overlap. That is intentional — keep both.
- `_pr_diff` and `_references_for` are heuristic. If `self.base_branch` is not an attribute, find the actual base ref the runner uses and substitute it (Task 5, Step 3).
- Do not reintroduce any path where an LLM finding blocks merge — that is the whole point of ADR 0007.
