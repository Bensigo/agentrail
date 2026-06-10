# Port `agentrail run` to the native Python CLI — Slice 1 (dispatch + batch shell)

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the legacy bash `run` dispatch, option parsing, agent/command resolution, active-run guard, issue selection, and `run batch` orchestration with a native `agentrail/cli/commands/run.py`, delegating only the inner per-issue plan/execute pipeline to the legacy script for now.

**Architecture:** Strangler-fig. The bugs we have actually hit in `run` all live in the bash *outer* layer — option parsing (the `run batch` double-shift that dropped the first issue), dispatch, and batch concurrency (duplicate PRs). We port that whole shell to Python and route `main.py`'s `run` to it. The single-issue plan/execute pipeline (`run_issue` and its prompt/skill/context/state-machine helpers, ~2,000 lines) is *not* a bug source and is large, so this slice delegates it unchanged: native code shells out to the legacy script as `agentrail-legacy run issue N …`. Later slices port that pipeline and then delete the legacy `run` paths. The native AFK runner already calls `agentrail run issue …`, so it transparently picks up the native dispatcher.

**Tech Stack:** Python 3 stdlib only (`subprocess`, `json`, `pathlib`, `os`, `concurrent.futures` for batch). Tests: `unittest` + `unittest.mock` (matching `tests/cli/test_console_cli.py`). Routed from `agentrail/cli/main.py`.

---

## Behavior being preserved (from `scripts/agentrail-legacy`)

Read these before starting so the port is faithful:
- `run_agentrail_run` (legacy:6711) — top dispatch: bare `run` selects a queued issue; `run issue N`; `run batch …`.
- `parse_run_options` (legacy:5462) — `--agent`/`--target`/`--command`/`--log-dir`; agent default sentinel `__config__`; agent allowlist `codex|claude|cursor|hermes|custom`.
- `configured_agent_name` (legacy:5405) / `configured_agent_command` (legacy:5351) — resolution precedence.
- `default_agent_command` (legacy:5330), `agent_command_env_name` (legacy:5299).
- `ensure_command_available` (legacy:5426), `ensure_source_run_allowed` (legacy:143), `is_agentrail_source_checkout` (legacy:129).
- `active_run_summary` (legacy:6288) / `active_run_issue` (legacy:6316) / `ensure_no_conflicting_active_run` (legacy:6333).
- `next_pickable_issue` (legacy:6349), `state_recommendation` (legacy:4258).
- `run_batch` (legacy:6568) — worktree-per-issue fan-out at `--concurrency` (default `AGENTRAIL_BATCH_CONCURRENCY` or 2); copies `.agentrail` into each worktree; runs each issue with `AGENTRAIL_ALLOW_SOURCE_RUN=1`.

### Resolution precedence (must match exactly)

`resolve_agent_name(target, fallback)`:
1. if `fallback != "__config__"` → `fallback`
2. else if `target/.agentrail/config.json` exists → `config.runner.name` or `"codex"`
3. else `"codex"`

`resolve_agent_command(agent, explicit, target)`:
1. if `explicit` non-empty → `explicit`
2. else if config exists and `agent == "__config__"` → `config.runner.command` or `""`
3. else if config exists and `config.runners[agent].command` non-empty → that
4. else if env `AGENTRAIL_<AGENT>_COMMAND` set → that
5. else if env `AGENTRAIL_AGENT_COMMAND` set → that
6. else `DEFAULT_COMMANDS[agent]`

`DEFAULT_COMMANDS`: `codex`→`codex exec --sandbox danger-full-access -`, `claude`→`claude -p --dangerously-skip-permissions`, `cursor`→`cursor-agent -p`, `hermes`→`hermes -p`, `custom`→`""`.

---

## File Structure

- **Create** `agentrail/cli/commands/run.py` — native `run` command (dispatch, parsing, resolution, guards, selection, batch).
- **Modify** `agentrail/cli/main.py` — route `run` to `run_run` (mirrors the existing `context`/`afk`/… blocks).
- **Create** `tests/cli/test_run_cli.py` — unit tests, all subprocess/gh/fs I/O patched.

Notes for the implementer:
- Read config with Python's `json`, not by shelling to `node` (behavior-preserving; the bash only used node because it had no interpreter).
- The legacy script path: reuse the same resolution `main.py._legacy_script()` uses — import and call it rather than duplicating. Single-issue execution calls that script binary directly (`[legacy, "run", "issue", …]`), which does **not** recurse through `main.py`.
- Match the repo's test style: `unittest.TestCase`, `unittest.mock.patch`, no pytest.

---

## Task 1: Module skeleton, constants, usage, dispatch entry

**Files:**
- Create: `agentrail/cli/commands/run.py`
- Test: `tests/cli/test_run_cli.py`

- [ ] **Step 1: Write the failing test**

```python
"""Unit tests for `agentrail run` CLI command (agentrail/cli/commands/run.py).

All external I/O (subprocess.run, gh, filesystem) is patched so these tests run
without an agent, gh, or a real repo.
"""
from __future__ import annotations

import unittest
from unittest.mock import patch

from agentrail.cli.commands.run import run_run, AGENTS, DEFAULT_COMMANDS


class RunHelpTests(unittest.TestCase):
    def test_help_flag_prints_usage_and_exits_zero(self) -> None:
        for flag in ("-h", "--help"):
            with self.subTest(flag=flag):
                with patch("builtins.print") as mock_print:
                    rc = run_run([flag])
                self.assertEqual(rc, 0)
                printed = " ".join(str(c) for c in mock_print.call_args_list)
                self.assertIn("Usage:", printed)

    def test_agent_allowlist_and_defaults_present(self) -> None:
        self.assertEqual(AGENTS, {"codex", "claude", "cursor", "hermes", "custom"})
        self.assertEqual(DEFAULT_COMMANDS["claude"], "claude -p --dangerously-skip-permissions")
        self.assertEqual(DEFAULT_COMMANDS["custom"], "")
```

- [ ] **Step 2: Run test to verify it fails**

Run: `python -m pytest tests/cli/test_run_cli.py -q` (or `python -m unittest tests.cli.test_run_cli -v`)
Expected: FAIL with `ModuleNotFoundError`/`ImportError` (run.py doesn't exist).

- [ ] **Step 3: Write minimal implementation**

```python
"""
``agentrail run`` — native dispatcher for the run command.

Replaces the legacy bash ``run`` outer layer: option parsing, agent/command
resolution, the source-checkout and active-run guards, queued-issue selection,
and ``run batch`` orchestration. The inner per-issue plan/execute pipeline is
still provided by the legacy script (delegated via subprocess) until a later
slice ports it.
"""
from __future__ import annotations

import os
import sys
from pathlib import Path
from typing import List

AGENTS = {"codex", "claude", "cursor", "hermes", "custom"}

DEFAULT_COMMANDS = {
    "codex": "codex exec --sandbox danger-full-access -",
    "claude": "claude -p --dangerously-skip-permissions",
    "cursor": "cursor-agent -p",
    "hermes": "hermes -p",
    "custom": "",
}

ENV_NAMES = {a: f"AGENTRAIL_{a.upper()}_COMMAND" for a in AGENTS}


class UsageError(Exception):
    """Raised for bad CLI input; carries an exit code (2 by default)."""

    def __init__(self, message: str, code: int = 2) -> None:
        super().__init__(message)
        self.code = code


def _usage() -> str:
    return """Usage:
  agentrail run [--agent NAME] [--target DIR] [--command CMD] [--log-dir DIR]
  agentrail run issue N [--agent NAME] [--target DIR] [--command CMD] [--log-dir DIR]
  agentrail run batch [--concurrency N] [--agent NAME] [--target DIR]
                      [--command CMD] [--base BRANCH] [--] ISSUE [ISSUE ...]

Bare `run` selects the next queued GitHub issue (labels: afk, ready-for-agent;
excludes afk-in-progress) and runs it. `run issue N` runs a specific issue.
`run batch` runs several issues in parallel, each in its own git worktree.
"""


def run_run(args: List[str]) -> int:
    if args and args[0] in ("-h", "--help"):
        print(_usage())
        return 0
    try:
        return _dispatch(args)
    except UsageError as exc:
        print(str(exc), file=sys.stderr)
        return exc.code


def _dispatch(args: List[str]) -> int:
    raise UsageError("not implemented")
```

- [ ] **Step 4: Run test to verify it passes**

Run: `python -m pytest tests/cli/test_run_cli.py -q`
Expected: PASS (2 tests).

- [ ] **Step 5: Commit**

```bash
git add agentrail/cli/commands/run.py tests/cli/test_run_cli.py
git commit -m "feat(cli): scaffold native run command (usage + constants)"
```

---

## Task 2: `parse_run_options` — faithful option parsing

**Files:**
- Modify: `agentrail/cli/commands/run.py`
- Test: `tests/cli/test_run_cli.py`

- [ ] **Step 1: Write the failing test**

```python
from agentrail.cli.commands.run import parse_run_options, UsageError


class ParseRunOptionsTests(unittest.TestCase):
    def test_defaults(self) -> None:
        opts = parse_run_options([])
        self.assertEqual(opts.agent, "__config__")
        self.assertEqual(opts.command, "")
        self.assertEqual(opts.log_dir, "")
        # target defaults to cwd
        self.assertTrue(opts.target)

    def test_all_flags(self) -> None:
        opts = parse_run_options(
            ["--agent", "claude", "--target", "/tmp/x",
             "--command", "claude -p", "--log-dir", "/tmp/logs"])
        self.assertEqual(opts.agent, "claude")
        self.assertEqual(opts.target, "/tmp/x")
        self.assertEqual(opts.command, "claude -p")
        self.assertEqual(opts.log_dir, "/tmp/logs")

    def test_bad_agent_rejected(self) -> None:
        with self.assertRaises(UsageError) as ctx:
            parse_run_options(["--agent", "bogus"])
        self.assertEqual(ctx.exception.code, 2)

    def test_flag_missing_value_rejected(self) -> None:
        for flag in ("--agent", "--target", "--command", "--log-dir"):
            with self.subTest(flag=flag):
                with self.assertRaises(UsageError):
                    parse_run_options([flag])

    def test_unknown_option_rejected(self) -> None:
        with self.assertRaises(UsageError):
            parse_run_options(["--nope"])
```

- [ ] **Step 2: Run test to verify it fails**

Run: `python -m pytest tests/cli/test_run_cli.py::ParseRunOptionsTests -q`
Expected: FAIL with `ImportError` for `parse_run_options`.

- [ ] **Step 3: Write minimal implementation**

Add to `run.py`:

```python
from dataclasses import dataclass


@dataclass
class RunOptions:
    agent: str = "__config__"
    target: str = ""
    command: str = ""
    log_dir: str = ""


def _need_value(args: List[str], i: int, flag: str) -> str:
    if i + 1 >= len(args) or args[i + 1].startswith("--"):
        raise UsageError(f"{flag} requires a value")
    return args[i + 1]


def parse_run_options(args: List[str]) -> RunOptions:
    opts = RunOptions(target=os.getcwd())
    i = 0
    while i < len(args):
        a = args[i]
        if a == "--agent":
            value = _need_value(args, i, "--agent")
            if value not in AGENTS:
                raise UsageError("--agent must be codex, claude, cursor, hermes, or custom")
            opts.agent = value; i += 2
        elif a == "--target":
            opts.target = _need_value(args, i, "--target"); i += 2
        elif a == "--command":
            opts.command = _need_value(args, i, "--command"); i += 2
        elif a == "--log-dir":
            opts.log_dir = _need_value(args, i, "--log-dir"); i += 2
        elif a in ("-h", "--help"):
            print(_usage()); raise UsageError("", code=0)
        else:
            raise UsageError(f"Unknown option: {a}")
    return opts
```

- [ ] **Step 4: Run test to verify it passes**

Run: `python -m pytest tests/cli/test_run_cli.py::ParseRunOptionsTests -q`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add -A && git commit -m "feat(cli): native run option parsing"
```

---

## Task 3: Agent name/command resolution

**Files:**
- Modify: `agentrail/cli/commands/run.py`
- Test: `tests/cli/test_run_cli.py`

- [ ] **Step 1: Write the failing test**

```python
import json
import tempfile
from agentrail.cli.commands.run import resolve_agent_name, resolve_agent_command


class ResolveAgentTests(unittest.TestCase):
    def _cfg(self, data: dict) -> str:
        d = tempfile.mkdtemp()
        (Path(d) / ".agentrail").mkdir()
        (Path(d) / ".agentrail" / "config.json").write_text(json.dumps(data))
        return d

    def test_name_explicit_fallback_wins(self) -> None:
        self.assertEqual(resolve_agent_name("/nope", "claude"), "claude")

    def test_name_from_config_runner(self) -> None:
        d = self._cfg({"runner": {"name": "cursor"}})
        self.assertEqual(resolve_agent_name(d, "__config__"), "cursor")

    def test_name_default_codex_when_no_config(self) -> None:
        self.assertEqual(resolve_agent_name("/nope", "__config__"), "codex")

    def test_command_explicit_wins(self) -> None:
        self.assertEqual(resolve_agent_command("claude", "my-cmd", "/nope"), "my-cmd")

    def test_command_config_runner_when_config_sentinel(self) -> None:
        d = self._cfg({"runner": {"command": "cfg-cmd"}})
        self.assertEqual(resolve_agent_command("__config__", "", d), "cfg-cmd")

    def test_command_runners_map(self) -> None:
        d = self._cfg({"runners": {"claude": {"command": "map-cmd"}}})
        self.assertEqual(resolve_agent_command("claude", "", d), "map-cmd")

    def test_command_env_agent_specific(self) -> None:
        with patch.dict(os.environ, {"AGENTRAIL_CLAUDE_COMMAND": "env-cmd"}, clear=False):
            self.assertEqual(resolve_agent_command("claude", "", "/nope"), "env-cmd")

    def test_command_default(self) -> None:
        with patch.dict(os.environ, {}, clear=True):
            self.assertEqual(resolve_agent_command("claude", "", "/nope"),
                             DEFAULT_COMMANDS["claude"])
```

(Add `import os` reference already present; ensure `DEFAULT_COMMANDS` imported at top of test file.)

- [ ] **Step 2: Run test to verify it fails**

Run: `python -m pytest tests/cli/test_run_cli.py::ResolveAgentTests -q`
Expected: FAIL (`ImportError`).

- [ ] **Step 3: Write minimal implementation**

```python
import json


def _read_config(target: str) -> dict:
    path = Path(target) / ".agentrail" / "config.json"
    if not path.exists():
        return {}
    try:
        return json.loads(path.read_text())
    except (ValueError, OSError):
        return {}


def resolve_agent_name(target: str, fallback: str) -> str:
    if fallback != "__config__":
        return fallback
    cfg = _read_config(target)
    if cfg:
        return (cfg.get("runner") or {}).get("name") or "codex"
    return "codex"


def resolve_agent_command(agent: str, explicit: str, target: str) -> str:
    if explicit:
        return explicit
    cfg = _read_config(target)
    if cfg and agent == "__config__":
        return (cfg.get("runner") or {}).get("command") or ""
    if cfg:
        runners = cfg.get("runners") or {}
        cmd = (runners.get(agent) or {}).get("command")
        if cmd:
            return cmd
    env_specific = os.environ.get(ENV_NAMES.get(agent, ""))
    if env_specific:
        return env_specific
    generic = os.environ.get("AGENTRAIL_AGENT_COMMAND")
    if generic:
        return generic
    return DEFAULT_COMMANDS.get(agent, "")


def ensure_command_available(command_line: str) -> None:
    import shutil
    binary = command_line.split()[0] if command_line.strip() else ""
    if not binary:
        raise UsageError("runner command is empty")
    if shutil.which(binary) is None:
        raise UsageError(f"missing required command: {binary}", code=1)
```

- [ ] **Step 4: Run test to verify it passes**

Run: `python -m pytest tests/cli/test_run_cli.py::ResolveAgentTests -q`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add -A && git commit -m "feat(cli): native agent name/command resolution"
```

---

## Task 4: Source-checkout guard

**Files:**
- Modify: `agentrail/cli/commands/run.py`
- Test: `tests/cli/test_run_cli.py`

- [ ] **Step 1: Write the failing test**

```python
from agentrail.cli.commands.run import is_source_checkout, ensure_source_run_allowed


class SourceGuardTests(unittest.TestCase):
    def _make_source(self) -> str:
        d = tempfile.mkdtemp()
        p = Path(d)
        (p / "package.json").write_text(json.dumps({"name": "@bensigo/agentrail"}))
        (p / "templates" / "scripts").mkdir(parents=True)
        (p / "scripts").mkdir()
        exe = p / "scripts" / "agentrail"
        exe.write_text("#!/bin/sh\n"); exe.chmod(0o755)
        return d

    def test_detects_source_checkout(self) -> None:
        self.assertTrue(is_source_checkout(self._make_source()))

    def test_non_source_dir_is_false(self) -> None:
        self.assertFalse(is_source_checkout(tempfile.mkdtemp()))

    def test_guard_blocks_without_override(self) -> None:
        d = self._make_source()
        with patch.dict(os.environ, {}, clear=True):
            with self.assertRaises(UsageError) as ctx:
                ensure_source_run_allowed(d, "run issue #1")
            self.assertEqual(ctx.exception.code, 1)

    def test_guard_allows_with_override(self) -> None:
        d = self._make_source()
        with patch.dict(os.environ, {"AGENTRAIL_ALLOW_SOURCE_RUN": "1"}, clear=True):
            ensure_source_run_allowed(d, "run issue #1")  # no raise
```

- [ ] **Step 2: Run test to verify it fails**

Run: `python -m pytest tests/cli/test_run_cli.py::SourceGuardTests -q`
Expected: FAIL (`ImportError`).

- [ ] **Step 3: Write minimal implementation**

```python
def is_source_checkout(target: str) -> bool:
    p = Path(target)
    pkg = p / "package.json"
    if not pkg.exists():
        return False
    if not (p / "templates" / "scripts").is_dir():
        return False
    exe = p / "scripts" / "agentrail"
    if not (exe.exists() and os.access(exe, os.X_OK)):
        return False
    try:
        return json.loads(pkg.read_text()).get("name") == "@bensigo/agentrail"
    except (ValueError, OSError):
        return False


def ensure_source_run_allowed(target: str, action: str) -> None:
    if is_source_checkout(target) and os.environ.get("AGENTRAIL_ALLOW_SOURCE_RUN") != "1":
        raise UsageError(
            f"Refusing to {action} in the AgentRail source checkout.\n\n"
            "This repo is the AgentRail package source, not an installed target "
            "project. Use a real target project, or set AGENTRAIL_ALLOW_SOURCE_RUN=1 "
            "only for deliberate source dogfooding.",
            code=1,
        )
```

- [ ] **Step 4: Run test to verify it passes**

Run: `python -m pytest tests/cli/test_run_cli.py::SourceGuardTests -q`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add -A && git commit -m "feat(cli): native source-checkout run guard"
```

---

## Task 5: Active-run guard (reads `.agentrail/state.json`)

**Files:**
- Modify: `agentrail/cli/commands/run.py`
- Test: `tests/cli/test_run_cli.py`

Faithful to `active_run_issue` (legacy:6316): the active run is `state.workflow.activeRun`; its issue is `run.targetIssue ?? workflow.activeIssue`.

- [ ] **Step 1: Write the failing test**

```python
from agentrail.cli.commands.run import active_run_issue, ensure_no_conflicting_active_run


class ActiveRunTests(unittest.TestCase):
    def _state(self, data: dict) -> str:
        d = tempfile.mkdtemp()
        (Path(d) / ".agentrail").mkdir()
        (Path(d) / ".agentrail" / "state.json").write_text(json.dumps(data))
        return d

    def test_no_state_file_returns_none(self) -> None:
        self.assertIsNone(active_run_issue(tempfile.mkdtemp()))

    def test_no_active_run_returns_none(self) -> None:
        d = self._state({"workflow": {}})
        self.assertIsNone(active_run_issue(d))

    def test_active_run_issue_from_target_issue(self) -> None:
        d = self._state({"workflow": {"activeRun": {"targetIssue": 42}}})
        self.assertEqual(active_run_issue(d), "42")

    def test_conflict_same_issue_raises(self) -> None:
        d = self._state({"workflow": {"activeRun": {"targetIssue": 7}}})
        with patch("builtins.print"):
            with self.assertRaises(UsageError):
                ensure_no_conflicting_active_run(d, "7")

    def test_no_conflict_when_no_active(self) -> None:
        d = self._state({"workflow": {}})
        ensure_no_conflicting_active_run(d, "7")  # no raise
```

- [ ] **Step 2: Run test to verify it fails**

Run: `python -m pytest tests/cli/test_run_cli.py::ActiveRunTests -q`
Expected: FAIL (`ImportError`).

- [ ] **Step 3: Write minimal implementation**

```python
def active_run_issue(target: str):
    path = Path(target) / ".agentrail" / "state.json"
    if not path.exists():
        return None
    try:
        state = json.loads(path.read_text())
    except (ValueError, OSError):
        return None
    workflow = state.get("workflow") or {}
    run = workflow.get("activeRun")
    if not isinstance(run, dict):
        return None
    issue = run.get("targetIssue")
    if issue is None:
        issue = workflow.get("activeIssue")
    return None if issue is None else str(issue)


def ensure_no_conflicting_active_run(target: str, issue: str) -> None:
    active = active_run_issue(target)
    if active is None:
        return
    if active == issue:
        print(f"active run already exists for issue #{issue}; resume or inspect it "
              f"with: agentrail run --target {target}", file=sys.stderr)
    else:
        print(f"active run already exists for issue #{active}; refusing to start "
              f"issue #{issue}", file=sys.stderr)
    raise UsageError("", code=1)
```

- [ ] **Step 4: Run test to verify it passes**

Run: `python -m pytest tests/cli/test_run_cli.py::ActiveRunTests -q`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add -A && git commit -m "feat(cli): native active-run conflict guard"
```

---

## Task 6: Queued-issue selection via `gh`

**Files:**
- Modify: `agentrail/cli/commands/run.py`
- Test: `tests/cli/test_run_cli.py`

Faithful to `next_pickable_issue` (legacy:6349): `gh issue list --state open --label afk --label ready-for-agent --search "sort:created-asc -label:afk-in-progress" --limit 20 --json number,title,url`, pick the lowest-numbered.

- [ ] **Step 1: Write the failing test**

```python
from unittest.mock import MagicMock
from agentrail.cli.commands.run import next_pickable_issue


class NextPickableTests(unittest.TestCase):
    def test_picks_lowest_number(self) -> None:
        payload = json.dumps([
            {"number": 9, "title": "b", "url": "u9"},
            {"number": 4, "title": "a", "url": "u4"},
        ])
        cp = MagicMock(returncode=0, stdout=payload)
        with patch("agentrail.cli.commands.run.subprocess.run", return_value=cp):
            picked = next_pickable_issue("/tmp/x")
        self.assertEqual(picked, (4, "a", "u4"))

    def test_empty_returns_none(self) -> None:
        cp = MagicMock(returncode=0, stdout="[]")
        with patch("agentrail.cli.commands.run.subprocess.run", return_value=cp):
            self.assertIsNone(next_pickable_issue("/tmp/x"))

    def test_gh_failure_returns_none(self) -> None:
        cp = MagicMock(returncode=1, stdout="")
        with patch("agentrail.cli.commands.run.subprocess.run", return_value=cp):
            self.assertIsNone(next_pickable_issue("/tmp/x"))
```

- [ ] **Step 2: Run test to verify it fails**

Run: `python -m pytest tests/cli/test_run_cli.py::NextPickableTests -q`
Expected: FAIL (`ImportError`).

- [ ] **Step 3: Write minimal implementation**

```python
import subprocess


def next_pickable_issue(target: str):
    proc = subprocess.run(
        ["gh", "issue", "list", "--state", "open", "--label", "afk",
         "--label", "ready-for-agent", "--search",
         "sort:created-asc -label:afk-in-progress", "--limit", "20",
         "--json", "number,title,url"],
        cwd=target, check=False, capture_output=True, text=True,
    )
    if proc.returncode != 0:
        return None
    try:
        issues = json.loads(proc.stdout or "[]")
    except ValueError:
        return None
    if not issues:
        return None
    best = min(issues, key=lambda it: int(it["number"]))
    return (int(best["number"]), best.get("title", ""), best.get("url", ""))
```

- [ ] **Step 4: Run test to verify it passes**

Run: `python -m pytest tests/cli/test_run_cli.py::NextPickableTests -q`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add -A && git commit -m "feat(cli): native queued-issue selection via gh"
```

---

## Task 7: Single-issue execution — delegate to legacy pipeline

**Files:**
- Modify: `agentrail/cli/commands/run.py`
- Test: `tests/cli/test_run_cli.py`

`exec_issue` builds the legacy argv and runs it. It calls the legacy **script binary directly** (resolved via `main._legacy_script()`), so it does not recurse through `main.py`. It passes through `--target`/`--agent`/`--command`/`--log-dir` and preserves `AGENTRAIL_ALLOW_SOURCE_RUN`.

- [ ] **Step 1: Write the failing test**

```python
from agentrail.cli.commands.run import exec_issue, RunOptions


class ExecIssueTests(unittest.TestCase):
    def test_builds_legacy_run_issue_argv(self) -> None:
        cp = MagicMock(returncode=0)
        opts = RunOptions(agent="claude", target="/tmp/x", command="claude -p", log_dir="")
        with patch("agentrail.cli.commands.run.subprocess.run", return_value=cp) as m, \
             patch("agentrail.cli.commands.run._legacy_script", return_value=Path("/legacy")):
            rc = exec_issue(11, opts)
        self.assertEqual(rc, 0)
        argv = m.call_args.args[0]
        self.assertEqual(argv[:4], ["/legacy", "run", "issue", "11"])
        self.assertIn("--target", argv); self.assertIn("/tmp/x", argv)
        self.assertIn("--agent", argv); self.assertIn("claude", argv)
        self.assertIn("--command", argv); self.assertIn("claude -p", argv)

    def test_omits_command_when_empty(self) -> None:
        cp = MagicMock(returncode=3)
        opts = RunOptions(agent="claude", target="/tmp/x", command="", log_dir="")
        with patch("agentrail.cli.commands.run.subprocess.run", return_value=cp) as m, \
             patch("agentrail.cli.commands.run._legacy_script", return_value=Path("/legacy")):
            rc = exec_issue(11, opts)
        self.assertEqual(rc, 3)
        self.assertNotIn("--command", m.call_args.args[0])
```

- [ ] **Step 2: Run test to verify it fails**

Run: `python -m pytest tests/cli/test_run_cli.py::ExecIssueTests -q`
Expected: FAIL (`ImportError` for `exec_issue` / `_legacy_script`).

- [ ] **Step 3: Write minimal implementation**

```python
from agentrail.cli.main import _legacy_script  # reuse the same resolution


def exec_issue(issue: int, opts: RunOptions, *, allow_source: bool = False) -> int:
    argv = [str(_legacy_script()), "run", "issue", str(issue),
            "--target", opts.target, "--agent", opts.agent]
    if opts.command:
        argv += ["--command", opts.command]
    if opts.log_dir:
        argv += ["--log-dir", opts.log_dir]
    env = os.environ.copy()
    if allow_source:
        env["AGENTRAIL_ALLOW_SOURCE_RUN"] = "1"
    proc = subprocess.run(argv, env=env, check=False)
    return int(proc.returncode)
```

Note: importing `_legacy_script` from `agentrail.cli.main` at module top would create a circular import (main imports run). Import it lazily inside `exec_issue` instead, OR move `_legacy_script` into a small shared module. **Chosen:** lazy import.

Replace the top-level import with a lazy one and adjust the patch target accordingly:

```python
def _legacy_script() -> Path:
    from agentrail.cli.main import _legacy_script as resolve
    return resolve()
```

(Keep the test's patch target `agentrail.cli.commands.run._legacy_script` — it now patches this wrapper.)

- [ ] **Step 4: Run test to verify it passes**

Run: `python -m pytest tests/cli/test_run_cli.py::ExecIssueTests -q`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add -A && git commit -m "feat(cli): delegate single-issue run to legacy pipeline"
```

---

## Task 8: `run batch` — native worktree fan-out

**Files:**
- Modify: `agentrail/cli/commands/run.py`
- Test: `tests/cli/test_run_cli.py`

Faithful to `run_batch` (legacy:6568) but using `concurrent.futures.ThreadPoolExecutor` for the slot pool (each task is a blocking `exec_issue` subprocess). Parse: `--concurrency` (default `AGENTRAIL_BATCH_CONCURRENCY` or 2), `--agent`, `--target`, `--command`, `--base` (default `main`), `--` then issue list; bare positionals are issues. Validate ≥1 issue and positive concurrency. Each issue gets its own detached worktree off `origin/<base>`; `.agentrail` is copied in; `exec_issue` runs with `allow_source=True`; worktrees are removed at the end. **This is where the `run batch` double-shift bug lived — porting it natively removes that whole class of bash-arg bug.**

- [ ] **Step 1: Write the failing test**

```python
from agentrail.cli.commands.run import parse_batch_args, run_batch


class ParseBatchTests(unittest.TestCase):
    def test_positional_issues_and_defaults(self) -> None:
        cfg = parse_batch_args(["360", "361"])
        self.assertEqual(cfg.issues, [360, 361])
        self.assertEqual(cfg.concurrency, 2)
        self.assertEqual(cfg.base, "main")

    def test_double_dash_issue_list(self) -> None:
        cfg = parse_batch_args(["--concurrency", "3", "--", "5", "6", "7"])
        self.assertEqual(cfg.concurrency, 3)
        self.assertEqual(cfg.issues, [5, 6, 7])

    def test_requires_at_least_one_issue(self) -> None:
        with self.assertRaises(UsageError):
            parse_batch_args(["--concurrency", "2"])

    def test_rejects_non_positive_concurrency(self) -> None:
        with self.assertRaises(UsageError):
            parse_batch_args(["--concurrency", "0", "5"])

    def test_first_issue_not_dropped(self) -> None:
        # regression: the legacy bash double-shift dropped the first issue
        cfg = parse_batch_args(["360", "361"])
        self.assertIn(360, cfg.issues)


class RunBatchExecTests(unittest.TestCase):
    def test_runs_each_issue_once(self) -> None:
        calls = []
        def fake_exec(issue, opts, allow_source=False):
            calls.append(issue); return 0
        with patch("agentrail.cli.commands.run.exec_issue", side_effect=fake_exec), \
             patch("agentrail.cli.commands.run._git_worktree_add"), \
             patch("agentrail.cli.commands.run._git_worktree_remove"), \
             patch("agentrail.cli.commands.run._git_fetch"), \
             patch("agentrail.cli.commands.run._seed_agentrail"):
            rc = run_batch(["--target", "/tmp/x", "360", "361"])
        self.assertEqual(rc, 0)
        self.assertEqual(sorted(calls), [360, 361])
```

- [ ] **Step 2: Run test to verify it fails**

Run: `python -m pytest tests/cli/test_run_cli.py::ParseBatchTests tests/cli/test_run_cli.py::RunBatchExecTests -q`
Expected: FAIL (`ImportError`).

- [ ] **Step 3: Write minimal implementation**

```python
import shutil
from concurrent.futures import ThreadPoolExecutor
from dataclasses import dataclass, field


@dataclass
class BatchConfig:
    issues: List[int] = field(default_factory=list)
    concurrency: int = 2
    agent: str = "claude"
    target: str = ""
    command: str = ""
    base: str = "main"


def parse_batch_args(args: List[str]) -> BatchConfig:
    cfg = BatchConfig(
        concurrency=int(os.environ.get("AGENTRAIL_BATCH_CONCURRENCY", "2") or "2"),
        target=os.getcwd(),
    )
    raw_issues: List[str] = []
    i = 0
    while i < len(args):
        a = args[i]
        if a == "--concurrency":
            cfg.concurrency = int(_need_value(args, i, "--concurrency") or "2"); i += 2
        elif a == "--agent":
            cfg.agent = _need_value(args, i, "--agent"); i += 2
        elif a == "--target":
            cfg.target = _need_value(args, i, "--target"); i += 2
        elif a == "--command":
            cfg.command = _need_value(args, i, "--command"); i += 2
        elif a == "--base":
            cfg.base = _need_value(args, i, "--base"); i += 2
        elif a == "--":
            raw_issues.extend(args[i + 1:]); break
        elif a.startswith("-"):
            raise UsageError(f"run batch: unknown option {a}")
        else:
            raw_issues.append(a); i += 1
    cfg.issues = [int(x) for x in raw_issues if x.isdigit()]
    if not cfg.issues:
        raise UsageError("run batch requires at least one issue number")
    if cfg.concurrency < 1:
        raise UsageError("--concurrency must be a positive integer")
    return cfg


def _git_fetch(target: str, base: str) -> None:
    subprocess.run(["git", "-C", target, "fetch", "origin", base],
                   check=False, capture_output=True)


def _git_worktree_add(target: str, path: str, ref: str) -> None:
    subprocess.run(["git", "-C", target, "worktree", "add", "--detach", path, ref],
                   check=False, capture_output=True)


def _git_worktree_remove(target: str, path: str) -> None:
    subprocess.run(["git", "-C", target, "worktree", "remove", "--force", path],
                   check=False, capture_output=True)


def _seed_agentrail(target: str, worktree: str) -> None:
    src = Path(target) / ".agentrail"
    if src.is_dir():
        shutil.copytree(src, Path(worktree) / ".agentrail", dirs_exist_ok=True)


def run_batch(args: List[str]) -> int:
    cfg = parse_batch_args(args)
    cfg.target = str(Path(cfg.target).resolve())
    ensure_source_run_allowed(cfg.target, "run batch")
    command = resolve_agent_command(cfg.agent, cfg.command, cfg.target)
    ensure_command_available(command)

    import datetime as _dt
    stamp = _dt.datetime.now().strftime("%Y%m%d-%H%M%S")
    batch_dir = Path(cfg.target) / ".agentrail" / "batch" / stamp
    (batch_dir / "worktrees").mkdir(parents=True, exist_ok=True)
    print(f"batch: {len(cfg.issues)} issues, concurrency {cfg.concurrency}, agent {cfg.agent}")
    _git_fetch(cfg.target, cfg.base)

    worktrees: List[str] = []

    def _one(slot_issue):
        slot, issue = slot_issue
        wt = str(batch_dir / "worktrees" / f"slot-{slot}-issue-{issue}")
        _git_worktree_add(cfg.target, wt, f"origin/{cfg.base}")
        worktrees.append(wt)
        _seed_agentrail(cfg.target, wt)
        opts = RunOptions(agent=cfg.agent, target=wt, command=cfg.command)
        rc = exec_issue(issue, opts, allow_source=True)
        print(f"batch: issue #{issue} {'completed' if rc == 0 else 'failed'}")
        return rc

    try:
        with ThreadPoolExecutor(max_workers=cfg.concurrency) as pool:
            results = list(pool.map(_one, list(enumerate(cfg.issues, start=1))))
    finally:
        for wt in worktrees:
            _git_worktree_remove(cfg.target, wt)

    if any(rc != 0 for rc in results):
        print(f"batch: some issues failed; check {batch_dir}", file=sys.stderr)
        return 1
    print(f"batch: all {len(cfg.issues)} issues completed successfully")
    return 0
```

- [ ] **Step 4: Run test to verify it passes**

Run: `python -m pytest tests/cli/test_run_cli.py::ParseBatchTests tests/cli/test_run_cli.py::RunBatchExecTests -q`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add -A && git commit -m "feat(cli): native run batch worktree fan-out (kills double-shift bug)"
```

---

## Task 9: Wire `_dispatch` and route from `main.py`

**Files:**
- Modify: `agentrail/cli/commands/run.py` (`_dispatch`)
- Modify: `agentrail/cli/main.py`
- Test: `tests/cli/test_run_cli.py`

- [ ] **Step 1: Write the failing test**

```python
class DispatchTests(unittest.TestCase):
    def test_issue_subcommand_routes_to_exec(self) -> None:
        with patch("agentrail.cli.commands.run.exec_issue", return_value=0) as m, \
             patch("agentrail.cli.commands.run.ensure_source_run_allowed"), \
             patch("agentrail.cli.commands.run.ensure_no_conflicting_active_run"), \
             patch("agentrail.cli.commands.run.resolve_agent_command", return_value="claude -p"), \
             patch("agentrail.cli.commands.run.ensure_command_available"):
            rc = run_run(["issue", "42", "--agent", "claude", "--target", "/tmp/x"])
        self.assertEqual(rc, 0)
        self.assertEqual(m.call_args.args[0], 42)

    def test_issue_requires_number(self) -> None:
        rc = run_run(["issue", "--agent", "claude"])
        self.assertEqual(rc, 2)

    def test_batch_subcommand_routes(self) -> None:
        with patch("agentrail.cli.commands.run.run_batch", return_value=0) as m:
            rc = run_run(["batch", "1", "2"])
        self.assertEqual(rc, 0)
        self.assertEqual(m.call_args.args[0], ["1", "2"])

    def test_main_routes_run(self) -> None:
        from agentrail.cli import main as main_mod
        with patch.object(main_mod, "run_run", return_value=0) as m:
            rc = main_mod.main(["run", "issue", "5"])
        self.assertEqual(rc, 0)
        self.assertEqual(m.call_args.args[0], ["issue", "5"])
```

- [ ] **Step 2: Run test to verify it fails**

Run: `python -m pytest tests/cli/test_run_cli.py::DispatchTests -q`
Expected: FAIL (`_dispatch` raises "not implemented"; `main` has no `run_run`).

- [ ] **Step 3: Write minimal implementation**

Replace `_dispatch` in `run.py`:

```python
def _dispatch(args: List[str]) -> int:
    if args and args[0] == "issue":
        rest = args[1:]
        if not rest or rest[0].startswith("--"):
            raise UsageError("run issue requires a number")
        issue_arg = rest[0]
        if not issue_arg.isdigit():
            raise UsageError("run issue argument must be numeric")
        opts = parse_run_options(rest[1:])
        opts.target = str(Path(opts.target).resolve())
        opts.agent = resolve_agent_name(opts.target, opts.agent)
        ensure_source_run_allowed(opts.target, f"run issue #{issue_arg}")
        ensure_no_conflicting_active_run(opts.target, issue_arg)
        command = resolve_agent_command(opts.agent, opts.command, opts.target)
        ensure_command_available(command)
        opts.command = command
        return exec_issue(int(issue_arg), opts)

    if args and args[0] == "batch":
        return run_batch(args[1:])

    # bare `run`: select next queued issue
    opts = parse_run_options(args)
    opts.target = str(Path(opts.target).resolve())
    ensure_source_run_allowed(opts.target, "select queued issues")
    picked = next_pickable_issue(opts.target)
    if picked is None:
        print("No pickable GitHub issues found.")
        print("Required labels: afk, ready-for-agent")
        print("Excluded label: afk-in-progress")
        return 0
    number, title, url = picked
    print(f"selected issue #{number}: {title}")
    if url:
        print(url)
    opts.agent = resolve_agent_name(opts.target, opts.agent)
    command = resolve_agent_command(opts.agent, opts.command, opts.target)
    ensure_command_available(command)
    opts.command = command
    ensure_no_conflicting_active_run(opts.target, str(number))
    return exec_issue(number, opts)
```

In `agentrail/cli/main.py`, add the import and route (mirroring the `status` block):

```python
from agentrail.cli.commands.run import run_run
```
```python
    if args and args[0] == "run":
        return run_run(args[1:])
```

(Place the `run` check alongside the other native routes, before the legacy fallback.)

- [ ] **Step 4: Run test to verify it passes**

Run: `python -m pytest tests/cli/test_run_cli.py -q`
Expected: PASS (all classes).

- [ ] **Step 5: Commit**

```bash
git add -A && git commit -m "feat(cli): wire native run dispatch + route from main"
```

---

## Task 10: Full suite + manual smoke verification

**Files:** none (verification only)

- [ ] **Step 1: Run the whole Python test suite**

Run: `python -m pytest tests/ -q`
Expected: PASS, no regressions. (If the repo uses `unittest`: `python -m unittest discover -s tests -v`.)

- [ ] **Step 2: Smoke — help and dispatch reach native code (no agent needed)**

Run:
```bash
python -c "from agentrail.cli.main import main; main(['run','--help'])"
```
Expected: the native usage text from `_usage()`.

- [ ] **Step 3: Smoke — `run batch` arg parsing no longer drops the first issue**

Run (dry, expect the source-guard or missing-gh/agent to stop it *after* parsing both issues — the point is it does not print "requires at least one issue number" for two args, and does not silently drop #360):
```bash
AGENTRAIL_ALLOW_SOURCE_RUN=1 python -c "from agentrail.cli.commands.run import parse_batch_args; print(parse_batch_args(['360','361']).issues)"
```
Expected: `[360, 361]`.

- [ ] **Step 4: Commit any final touch-ups, open PR**

```bash
git add -A && git commit -m "test: verify native run suite green" --allow-empty
gh pr create --title "feat(cli): port run dispatch + batch to native Python (#364)" \
  --body "Slice 1 of the run port: native dispatch/parse/resolve/guards/selection/batch. Inner plan/execute pipeline still delegated to legacy. Closes the run-batch double-shift class of bugs. Refs #364."
```

---

## Self-review notes (already applied)

- **Spec coverage:** every legacy outer-layer helper (`parse_run_options`, `configured_agent_*`, `ensure_command_available`, `ensure_source_run_allowed`/`is_agentrail_source_checkout`, `active_run_*`, `next_pickable_issue`, `run_batch`, `run_agentrail_run` dispatch) has a corresponding task. The inner pipeline (`run_issue` phases, prompts, skills, context packs, ralph executor, state writers) is **explicitly out of scope** for this slice and delegated — see Future Slices.
- **Type consistency:** `RunOptions`/`BatchConfig` field names are reused verbatim across tasks; `exec_issue(issue, opts, allow_source=…)` signature matches its callers in Tasks 8 and 9; patch targets (`agentrail.cli.commands.run.*`) are consistent.
- **Circular import:** `_legacy_script` is wrapped in a lazy importer (Task 7) so `main.py` can import `run_run` without a cycle.

---

## Future Slices (separate plans — do not implement here)

**Slice 2 — port the per-issue pipeline.** `run_issue` + `run_issue_phase` (plan/execute), `prompt_issue`/`issue_run_phase_prompt`, `resolve_skills_json`, `issue_resolution_text`, `build_context_pack_file`/`context_pack_summary`/`context_pack_file_from_prompt`/`context_retrieval_metadata_json` (reuse `agentrail/context/packs.py` + `retrieval.py` natively), the ralph executor, and the run/phase state machine (`write_run_metadata`/`write_phase_*`/`update_run_state`/`update_run_metadata_attempts`). Once native, `exec_issue` calls Python directly instead of shelling to legacy, and the AFK runner's `_implement` can call the native function. This is the large one and needs its own plan with the same TDD granularity.

**Slice 3 — delete legacy `run`.** Remove `run_agentrail_run`/`run_issue`/`run_batch` and now-orphaned helpers from `scripts/agentrail-legacy`; drop the `run)` branch from its dispatcher. Verify nothing else in the script references the removed helpers. This is the step that actually shrinks the bash toward zero.

Then the broader migration continues with `internal review-pr` (the AFK reviewer that mutates the main checkout — port + review-in-worktree), `prompt`, `init`/`install`/`upgrade`/`doctor`, `memory`/`skills`/`resume`/`labels`/`cleanup`, and finally deleting `scripts/agentrail-legacy`.
