# Port `run issue` pipeline to native Python — Slice 2

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax.

**Goal:** Replace the legacy bash per-issue plan/execute pipeline (`run_issue`/`run_issue_phase` and their ~15 helpers in `scripts/agentrail-legacy`) with native Python, so `agentrail/cli/commands/run.py:exec_issue` (and AFK's `_implement`) call Python directly instead of shelling to `agentrail-legacy run issue`.

**Architecture:** New `agentrail/run/` package. Built bottom-up across **five sub-slices**, each its own PR:
- **2a — primitives** (THIS plan, fully detailed): context-pack reuse + run-artifact JSON writers + process/timeout/env helpers. Pure building blocks, not yet wired in — zero runtime behavior change.
- **2b — prompts**: `prompt_common_header`, `prompt_issue`, `issue_run_phase_prompt`, skill-resolution formatting.
- **2c — skills**: port `resolve_skills_json` (the embedded Node resolver) to Python.
- **2d — state machine**: port `update_run_state` (the shared `.agentrail/state.json` writer) with atomic+locked writes.
- **2e — orchestration + cutover**: native `run_issue`/`run_issue_phase`; flip `exec_issue` to native (behind `AGENTRAIL_NATIVE_RUN` flag first), verify, then make native the default.

Slice 3 (separate) deletes the legacy `run`/`run_issue`/`run_batch` bash once 2e is the default.

**Boundary decisions (apply to all sub-slices):**
- **Keep `templates/scripts/ralph-loop` and `scripts/lib/timeout.sh` as separate executables.** They are templates shipped into target repos, not part of the `agentrail-legacy` dispatcher we're deleting. The native execute phase invokes `ralph-loop` as a subprocess (sub-slice 2e). We port only `agentrail-legacy`'s logic.
- **Reuse native context code.** `agentrail/context/packs.build_context_pack(target_dir, kind, number, phase)` and `agentrail/context/retrieval.search_context(target_dir, query, *, limit)` already produce exactly what the bash shelled out for. Do not reimplement retrieval.
- **Preserve downstream-consumed fields exactly** (see "Must-preserve" below). Other fields are write-only debug aids — keep them for parity but they are not load-bearing.

**Tech Stack:** Python 3 stdlib + existing `agentrail.context.*` and `agentrail.shared.json`. Tests: `unittest`/`unittest.mock` via `python -m pytest`, matching `tests/cli/test_run_cli.py`.

---

## Must-preserve fields (consumed downstream — verified by code-explorer)

- **`run.json`** (`.agentrail/runs/<run_id>/run.json`): `startedAt`, `targetType`, `targetIssue`, `agent`, `executionAttempt`, `maxExecutionAttempts`, `resolvedSkills`, `contextPackFile`. (Also keep for parity: `command`, `failedVerificationAttempts`, `promptFile`, `resolvedSkillsFile`, `contextRetrieval`.)
- **`plan/status.json`**: `status` (read by resume logic; must be `"completed"` on success).
- **`plan/output.md`**: the captured plan agent output (read at resume to seed the execute prompt).
- **`.agentrail/state.json` `workflow.*`**: handled in sub-slice 2d, not 2a.

---

# SUB-SLICE 2a — Primitives (this plan)

New package `agentrail/run/` with three focused modules. None are wired into `exec_issue` yet; this PR only adds tested building blocks. Run dirs are per-run (no concurrent writers), so plain `agentrail.shared.json.write_json` is fine here; the shared-`state.json` locking problem is 2d's concern.

## File Structure
- Create `agentrail/run/__init__.py` (empty package marker).
- Create `agentrail/run/context.py` — issue text + context-pack reuse + summary.
- Create `agentrail/run/artifacts.py` — run/phase JSON writers.
- Create `agentrail/run/proc.py` — env sanitize, timeout-exec-with-tee, ralph path.
- Create `tests/run/__init__.py`, `tests/run/test_context.py`, `tests/run/test_artifacts.py`, `tests/run/test_proc.py`.

---

## Task 1: Package marker + test package

**Files:** Create `agentrail/run/__init__.py`, `tests/run/__init__.py`.

- [ ] **Step 1:** Create `agentrail/run/__init__.py` with a one-line docstring:
```python
"""Native per-issue run pipeline (plan/execute) — replaces the legacy bash run_issue."""
```
- [ ] **Step 2:** Create empty `tests/run/__init__.py`.
- [ ] **Step 3:** Verify discovery: `cd /Users/macbook/work/bensigo-ai-workflow && python -m pytest tests/run -q` → "no tests ran" (exit 5) is acceptable; must not error on import.
- [ ] **Step 4:** Commit: `git add agentrail/run/__init__.py tests/run/__init__.py && git commit -m "feat(run): add native run pipeline package"`

---

## Task 2: `agentrail/run/context.py` — issue text + context pack reuse

Port `issue_resolution_text` (legacy:4209), `build_context_pack_file` (legacy:4813), `context_pack_summary` (legacy:4837), `context_retrieval_metadata_json` (legacy:4922), `context_selected_snippets`. Reuse native context APIs — do NOT shell to `python3 -m agentrail.cli.main context …`.

**Functions to implement:**

```python
from __future__ import annotations
import subprocess
from pathlib import Path
from typing import Any, Dict, List, Optional
from agentrail.context.packs import build_context_pack
from agentrail.context.retrieval import search_context


def issue_resolution_text(target_dir: Path, issue: int) -> str:
    """Issue title + '\n' + body via gh, or fallback 'GitHub issue #N'."""
    proc = subprocess.run(
        ["gh", "issue", "view", str(issue), "--json", "title,body",
         "--jq", '.title + "\n" + (.body // "")'],
        cwd=str(target_dir), check=False, capture_output=True, text=True,
    )
    text = proc.stdout.strip() if proc.returncode == 0 else ""
    return text or f"GitHub issue #{issue}"


def build_issue_context_pack(target_dir: Path, issue: int, phase: str) -> Optional[str]:
    """Build a context pack for the issue/phase; return the relative jsonPath
    (e.g. '.agentrail/context/packs/issue-123-plan-….json') or None on failure."""
    try:
        pack = build_context_pack(target_dir, "issue", issue, phase)
    except Exception:
        return None
    return pack.get("jsonPath")


def context_pack_summary(target_dir: Path, pack_file: Optional[str]) -> str:
    """Human-readable summary block read from the pack JSON. Mirror the format of
    legacy context_pack_summary (scripts/agentrail-legacy:4837-4878). Empty string
    if pack_file is falsy or unreadable."""
    # Read <target_dir>/<pack_file>, then emit the block below.


def context_retrieval_metadata(target_dir: Path, query: str) -> Dict[str, Any]:
    """Return search_context(...)['runMetadata'] or {} on failure."""
    try:
        return search_context(target_dir, query, limit=10).get("runMetadata", {}) or {}
    except Exception:
        return {}


def context_selected_snippets(target_dir: Path, query: str) -> str:
    """Compact 'path:line-range' list from search_context(...)['results'] (limit 6).
    Mirror the legacy formatter; empty string on failure/no results."""
```

**`context_pack_summary` format** (port verbatim from legacy:4837-4878 — read those lines; the block is):
```
Context pack:
- Pack file: <pack_file>
- Target: issue #<number> <phase>
- Goal: <pack.goal.summary or "(none)">
- Required context: <N> (<comma-joined first few paths>)
- Likely files: <N> (<…>)
- Retrieval mode: <pack.index.retrievalMode or pack.provider…>
Use the selected context above before broad repo discovery.
```
(Use the actual keys present in the dict returned by `build_context_pack`; the implementer must open a real pack or read the legacy node script to get exact key paths — do not invent keys.)

**Tests (`tests/run/test_context.py`):**
- `issue_resolution_text`: patch `agentrail.run.context.subprocess.run` → returncode 0, stdout "Title\nBody" → returns "Title\nBody"; returncode 1 → returns "GitHub issue #5".
- `build_issue_context_pack`: patch `agentrail.run.context.build_context_pack` → returns `{"jsonPath": ".agentrail/context/packs/x.json"}` → returns that string; patch it to raise → returns None.
- `context_retrieval_metadata`: patch `search_context` → `{"runMetadata": {"retrievalMode": "x"}}` → returns that dict; raise → `{}`.
- `context_pack_summary`: write a temp pack JSON with known keys, assert the summary contains "Context pack:", the pack path, and "Target: issue #". Falsy `pack_file` → "".
- `context_selected_snippets`: patch `search_context` → results with file/line fields → assert formatted "path:line" appears; empty results → "".

**Steps:** TDD per function (failing test → implement → pass). Commit: `feat(run): native issue context + pack-summary helpers`.

---

## Task 3: `agentrail/run/artifacts.py` — run/phase JSON writers

Port `write_run_metadata` (legacy:5513), `update_run_metadata_attempts` (legacy:5581), `write_phase_status` (legacy:5615), `write_phase_metadata` (legacy:5655). Use `agentrail.shared.json.write_json`/`read_json`. Use exact field names from "Must-preserve".

```python
from __future__ import annotations
from pathlib import Path
from typing import Any, Dict, List, Optional
from agentrail.shared.json import read_json, write_json


def write_run_metadata(path: Path, *, started_at: str, issue: int, agent: str,
                       command: str, prompt_file: str, resolved_skills_file: str,
                       resolved_skills: List[Dict[str, Any]], max_execution_attempts: int,
                       context_pack_file: Optional[str],
                       context_retrieval: Dict[str, Any]) -> None:
    write_json(path, {
        "startedAt": started_at,
        "targetType": "issue",
        "targetIssue": issue,
        "agent": agent,
        "command": command,
        "executionAttempt": 1,
        "maxExecutionAttempts": max_execution_attempts,
        "failedVerificationAttempts": 0,
        "promptFile": prompt_file,
        "contextPackFile": context_pack_file,
        "contextRetrieval": context_retrieval or {},
        "resolvedSkillsFile": resolved_skills_file,
        "resolvedSkills": resolved_skills,
    })


def update_run_metadata_attempts(path: Path, *, execution_attempt: int,
                                 max_execution_attempts: int,
                                 failed_verification_attempts: int,
                                 verifier_findings_file: str = "",
                                 blocked_reason: str = "") -> None:
    data = read_json(path)
    data["executionAttempt"] = execution_attempt
    data["maxExecutionAttempts"] = max_execution_attempts
    data["failedVerificationAttempts"] = failed_verification_attempts
    if verifier_findings_file:
        data["verifierFindingsFile"] = verifier_findings_file
    if blocked_reason:
        data["blockedReason"] = blocked_reason
    write_json(path, data)


def write_phase_status(path: Path, *, phase: str, status: str, started_at: str,
                       finished_at: Optional[str], exit_status: int,
                       metadata_file: str, output_file: str,
                       execution_attempt: int, max_execution_attempts: int,
                       verifier_findings_file: str = "") -> None:
    data = {
        "phase": phase, "status": status, "startedAt": started_at,
        "finishedAt": finished_at, "exitStatus": exit_status,
        "metadataFile": metadata_file, "outputFile": output_file,
        "executionAttempt": execution_attempt,
        "maxExecutionAttempts": max_execution_attempts,
    }
    if verifier_findings_file:
        data["verifierFindingsFile"] = verifier_findings_file
    write_json(path, data)


def write_phase_metadata(path: Path, *, phase: str, started_at: str,
                         finished_at: Optional[str], status: str, exit_status: int,
                         issue: int, agent: str, command: str, prompt_file: str,
                         context_pack_file: Optional[str], output_file: str,
                         status_file: str, run_id: str, run_dir: str,
                         execution_attempt: int, max_execution_attempts: int,
                         verifier_findings_file: str = "") -> None:
    data = {
        "phase": phase, "startedAt": started_at, "finishedAt": finished_at,
        "status": status, "exitStatus": exit_status, "targetType": "issue",
        "targetIssue": issue, "agent": agent, "command": command,
        "promptFile": prompt_file, "contextPackFile": context_pack_file,
        "outputFile": output_file, "statusFile": status_file,
        "runId": run_id, "runDir": run_dir, "executionAttempt": execution_attempt,
        "maxExecutionAttempts": max_execution_attempts,
    }
    if verifier_findings_file:
        data["verifierFindingsFile"] = verifier_findings_file
    write_json(path, data)
```

**Tests (`tests/run/test_artifacts.py`):** write to a tmp path, read back, assert each must-preserve field present with correct value; assert `verifierFindingsFile`/`blockedReason` absent when empty and present when set; `update_run_metadata_attempts` round-trips an existing file and updates only the attempt fields.

**Steps:** TDD. Commit: `feat(run): native run/phase artifact writers`.

---

## Task 4: `agentrail/run/proc.py` — env sanitize, timeout-exec-with-tee, ralph path

Port `sanitized_agent_exec` and `portable_timeout` (scripts/lib/timeout.sh) and `ralph_executor_path` (legacy:5437).

```python
from __future__ import annotations
import os
import subprocess
import sys
from pathlib import Path
from typing import List, Optional

STRIP_ENV_VARS = (
    "CLAUDECODE", "CLAUDE_CODE_SESSION_ID", "CLAUDE_CODE_ENTRYPOINT",
    "CLAUDE_AGENT_SDK_VERSION", "CLAUDE_CODE_EXECPATH", "CLAUDE_EFFORT",
    "AI_AGENT", "CODEX_SESSION", "CODEX_SANDBOX", "CURSOR_SESSION", "CURSOR_AGENT",
)


def sanitized_env() -> dict:
    """os.environ minus the agent-session vars (mirror sanitized_agent_exec)."""
    return {k: v for k, v in os.environ.items() if k not in STRIP_ENV_VARS}


def ralph_executor_path(target_dir: Path, repo_dir: Path) -> Optional[Path]:
    """Lookup order (legacy ralph_executor_path): installed copy in target's
    .agentrail/source, then repo templates, then target scripts. None if missing."""
    candidates = [
        target_dir / ".agentrail" / "source" / "templates" / "scripts" / "ralph-loop",
        repo_dir / "templates" / "scripts" / "ralph-loop",
        target_dir / "scripts" / "ralph-loop",
    ]
    for c in candidates:
        if c.exists() and os.access(c, os.X_OK):
            return c
    return None


def run_with_timeout(argv: List[str], *, cwd: Path, timeout: int, output_file: Path,
                     stdin_text: Optional[str] = None, env: Optional[dict] = None) -> int:
    """Run argv, tee combined stdout+stderr to BOTH the live console and output_file,
    enforce a wall-clock timeout. Return the exit code, or 124 on timeout
    (mirrors portable_timeout)."""
    env = env if env is not None else sanitized_env()
    output_file.parent.mkdir(parents=True, exist_ok=True)
    proc = subprocess.Popen(
        argv, cwd=str(cwd), env=env,
        stdin=subprocess.PIPE if stdin_text is not None else None,
        stdout=subprocess.PIPE, stderr=subprocess.STDOUT, text=True,
    )
    if stdin_text is not None and proc.stdin is not None:
        try:
            proc.stdin.write(stdin_text); proc.stdin.close()
        except BrokenPipeError:
            pass
    chunks: List[str] = []
    try:
        assert proc.stdout is not None
        for line in proc.stdout:
            chunks.append(line)
            sys.stdout.write(line)
        rc = proc.wait(timeout=timeout)
    except subprocess.TimeoutExpired:
        proc.kill(); proc.wait()
        rc = 124
    finally:
        output_file.write_text("".join(chunks))
    return rc
```

**Tests (`tests/run/test_proc.py`):**
- `sanitized_env`: with `patch.dict(os.environ, {"CLAUDECODE": "1", "KEEP": "1"})` → result excludes `CLAUDECODE`, includes `KEEP`.
- `ralph_executor_path`: build a temp target with an executable `scripts/ralph-loop` → returns it; none present → None.
- `run_with_timeout`: run `["bash","-lc","echo hi"]` (or `[sys.executable,"-c","print('hi')"]` for portability) cwd=tmp, timeout=10, output_file=tmp/out.log → rc 0 and out.log contains "hi". Run a sleeping command with timeout=1 → rc 124 (mark `@unittest.skipUnless` on a POSIX shell if needed; prefer `[sys.executable,"-c","import time;time.sleep(5)"]`).

**Steps:** TDD. Commit: `feat(run): native env-sanitize, timeout-exec-with-tee, ralph path`.

---

## Task 5: Full suite + commit boundary

- [ ] Run `cd /Users/macbook/work/bensigo-ai-workflow && python -m pytest tests/ -q` → all pass (new `tests/run/*` included, no regressions).
- [ ] Confirm nothing imports `agentrail.run` from production paths yet (grep): `grep -rn "agentrail.run" agentrail/cli agentrail/afk` → no hits (2a is not wired in).
- [ ] Open PR titled `feat(run): native pipeline primitives — Slice 2a` referencing the run migration. Body: lists the three modules, notes "not wired in; zero runtime change," and links this plan.

---

# Sub-slices 2b–2e (separate detailed plans when reached — outline only)

**2b — prompts.** Port `prompt_common_header` (NOT yet traced — read `scripts/agentrail-legacy` around where `prompt_issue` calls it; it emits CONTEXT.md/TASTE.md content, memory recall, workflow state), `prompt_issue` (legacy:4985), `issue_run_phase_prompt` (legacy:5910) incl. `bounded_phase_text` truncation (legacy:5900), and skill-resolution formatting (`print_skill_resolution`). New module `agentrail/run/prompts.py`. Pure string assembly; reuse 2a's context helpers. Must trace and faithfully reproduce the plan/execute prompt structure documented by the code-explorer.

**2c — skills.** Port the embedded Node `resolve_skills_json` (legacy:758) to Python: read `docs/agents/skill-registry.json` (target, then `templates/docs/agents/`), walk the tree (≤1000 files, skip `.git`/`node_modules`/`.agentrail`/`dist`), match by task keywords + file-path signals + package deps, cap at `maxAutoSkills=4`, include explicit skills (error on unknown/unavailable). New module `agentrail/run/skills.py`. Output schema must match the documented `{registryPath,targetDir,autoSkills,maxAutoSkills,unavailable,resolved[]}` so `run.json.resolvedSkills` and the prompt formatter stay compatible.

**2d — state machine.** Port `update_run_state` (legacy:5991) → `.agentrail/state.json`. New module `agentrail/run/state.py`. **Landmine:** shared singleton with concurrent writers (run_batch ThreadPoolExecutor; AFK worktree manager). Implement read-modify-write with an atomic write (`tempfile`+`os.replace`) under an `fcntl.flock` advisory lock on a sidecar lockfile. Preserve every `workflow.*` field in "Must-preserve" (activeRun, activeIssue, activePhase, phase, goals[], completedRuns[] capped at 20, worktrees[], lastCompletedStep, nextSuggestedAction, updatedAt). Must not clobber `workflow.worktrees` written by AFK.

**2e — orchestration + cutover.** Port `run_issue_phase` and `run_issue` (legacy:6376-6566) into `agentrail/run/pipeline.py`, composing 2a–2d. Execute phase invokes `ralph-loop` via `run_with_timeout`; plan phase pipes the plan prompt to `bash -lc <agent_command>` via `run_with_timeout(stdin_text=…)`. Replicate resume (`AGENTRAIL_RESUME`), the `review-fix` plan-skip, attempts/timeout (`AGENTRAIL_AGENT_TIMEOUT` default 1800, `AGENTRAIL_MAX_EXECUTION_ATTEMPTS`). Then change `run.py:exec_issue` to call the native pipeline when `AGENTRAIL_NATIVE_RUN=1` (legacy default), verify end-to-end on a real issue in a scratch repo, then flip the default to native. AFK's `_implement` then transparently uses native. Slice 3 deletes the legacy bash `run` paths.
