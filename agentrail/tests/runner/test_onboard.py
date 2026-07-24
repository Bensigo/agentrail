"""Tests for the onboard work-kind handler (agentrail/runner/onboard.py).

The onboard handler clones a freshly connected repo, indexes it for a digest,
generates durable workspace-memory items via the headless Claude CLI (fail-open),
and pushes them to the backend. Every heavy step is an injectable seam, so these
tests are fully offline — no real clone, no real ``claude``, no network, no real
``build_index``. The suite pins the happy path, each failure branch, the
LLM-fallback + type-clamp contract of ``generate_onboard_items``, and the exact
wire contract of ``push_onboard_items``.
"""
from __future__ import annotations

import json
import os
import subprocess
import urllib.error
from contextlib import contextmanager
from datetime import datetime, timedelta, timezone
from pathlib import Path
from typing import Any, Dict, List, Optional

from agentrail.context.wiki import REPO_WIKI_ENV as _REPO_WIKI_ENV
from agentrail.runner.client import WorkItem
from agentrail.runner.onboard import (
    _AGENT_DOC_FILES,
    _DIGEST_AGENT_DOC_HEAD_LINES,
    _DIGEST_FILES,
    _DIGEST_HEAD_LINES,
    _ONBOARD_WIKI_ENV,
    MEMORY_TYPES,
    ONBOARD_CATEGORIES,
    _CATEGORY_TYPE,
    _clone,
    _default_items,
    _ensure_wiki_summary_config,
    _postprocess_items,
    _repo_digest,
    _repo_full_name,
    check_onboard_freshness,
    generate_onboard_items,
    onboard_wiki_enabled,
    push_onboard_items,
    run_onboard,
)


@contextmanager
def _env(key: str, value: Optional[str]):
    """Set (or unset, when ``value`` is None) an env var for the block,
    restoring whatever was there before on exit — mirrors
    agentrail/tests/context/test_wiki.py's identically-named helper."""
    prev = os.environ.get(key)
    if value is None:
        os.environ.pop(key, None)
    else:
        os.environ[key] = value
    try:
        yield
    finally:
        if prev is None:
            os.environ.pop(key, None)
        else:
            os.environ[key] = prev


# ---------------------------------------------------------------------------
# Fixtures / helpers
# ---------------------------------------------------------------------------

def _work_item(repository_id: str = "repo-1", **overrides: Any) -> WorkItem:
    base = dict(
        id="wi-1",
        workspace_id="ws1",
        source="github",
        external_id="owner/repo#1",
        repo_url="https://github.com/owner/repo",
        ref="main",
        title="t",
        body="b",
        repository_id=repository_id,
        kind="onboard",
    )
    base.update(overrides)
    return WorkItem(**base)


_FOUR_ITEMS = [
    {"content": "use black + ruff", "type": "preference", "tags": ["onboard", "onboard:conventions"]},
    {"content": "module map", "type": "decision", "tags": ["onboard", "onboard:architecture"]},
    {"content": "run pytest", "type": "preference", "tags": ["onboard", "onboard:commands"]},
    {"content": "glossary: widget = thing", "type": "fact", "tags": ["onboard", "onboard:glossary"]},
]

# Default freshness seam for run_onboard tests: "not onboarded" → proceed
# normally. Passed explicitly so tests never hit the real network freshness GET.
def _no_freshness(*_a: Any, **_k: Any) -> Optional[datetime]:
    return None


class _FakeProc:
    """A minimal subprocess.CompletedProcess-alike (returncode/stdout/stderr)."""

    def __init__(self, returncode: int = 0, stdout: str = "", stderr: str = "") -> None:
        self.returncode = returncode
        self.stdout = stdout
        self.stderr = stderr


class _FakeGitRunner:
    """The `runner` seam _clone (and native_runner) accept: a `.run(cmd, **kw)`
    that either returns a fake completed process or raises a pre-set
    exception. Captures every call's argv for structural assertions — never
    touches the network or a real git binary.
    """

    def __init__(self, *, result: _FakeProc | None = None, raises: Exception | None = None) -> None:
        self.calls: List[Dict[str, Any]] = []
        self._result = result if result is not None else _FakeProc()
        self._raises = raises

    def run(self, cmd: List[str], **kwargs: Any) -> _FakeProc:
        self.calls.append({"cmd": cmd, **kwargs})
        if self._raises is not None:
            raise self._raises
        return self._result


# ---------------------------------------------------------------------------
# _clone: private-repo auth + token redaction (#1268)
# ---------------------------------------------------------------------------

class TestClonePrivateAuth:
    def test_embeds_token_in_clone_url_when_present(self) -> None:
        fake = _FakeGitRunner()

        _clone("https://github.com/owner/repo", "main", "/tmp/dest", token="secret-tok", runner=fake)

        cmd = fake.calls[0]["cmd"]
        assert "https://x-access-token:secret-tok@github.com/owner/repo" in cmd

    def test_no_token_leaves_the_clone_url_unchanged_public_path_byte_identical(self) -> None:
        fake = _FakeGitRunner()

        _clone("https://github.com/owner/repo", "main", "/tmp/dest", runner=fake)

        cmd = fake.calls[0]["cmd"]
        assert "https://github.com/owner/repo" in cmd
        assert "x-access-token" not in " ".join(cmd)

    def test_redacts_token_from_stderr_on_a_nonzero_exit(self) -> None:
        """Simulates a git version that (unlike this host's) echoes the
        credentialed URL verbatim in a failure message — redact_token must
        still scrub it before it reaches the raised exception's text.
        """
        token = "super-secret-token"
        leaky_stderr = (
            f"fatal: could not read from 'https://x-access-token:{token}@github.com/owner/repo'"
        )
        fake = _FakeGitRunner(result=_FakeProc(returncode=128, stderr=leaky_stderr))

        try:
            _clone("https://github.com/owner/repo", "main", "/tmp/dest", token=token, runner=fake)
            raise AssertionError("expected RuntimeError")
        except RuntimeError as exc:
            assert token not in str(exc)
            assert "***" in str(exc)

    def test_redacts_token_from_a_subprocess_timeout_exception(self) -> None:
        """Ground-truth #1268 finding: subprocess.TimeoutExpired.__str__()
        unconditionally embeds the raw argv it was constructed with —
        including the credentialed clone URL — regardless of what git itself
        printed. Verified empirically: a real subprocess.run(..., check=True)
        failure's CalledProcessError.__str__() does exactly this. _clone must
        catch and redact it, not let it propagate to run_onboard's
        gate_reason unredacted.
        """
        token = "super-secret-token"
        clone_url = f"https://x-access-token:{token}@github.com/owner/repo"
        timeout_exc = subprocess.TimeoutExpired(cmd=["git", "clone", clone_url], timeout=300)
        fake = _FakeGitRunner(raises=timeout_exc)

        try:
            _clone("https://github.com/owner/repo", "main", "/tmp/dest", token=token, runner=fake)
            raise AssertionError("expected RuntimeError")
        except RuntimeError as exc:
            assert token not in str(exc)
            assert "***" in str(exc)

    def test_no_token_stderr_failure_message_is_unaffected_by_redaction(self) -> None:
        fake = _FakeGitRunner(result=_FakeProc(returncode=128, stderr="fatal: repository not found"))

        try:
            _clone("https://github.com/owner/repo", "main", "/tmp/dest", runner=fake)
            raise AssertionError("expected RuntimeError")
        except RuntimeError as exc:
            assert "repository not found" in str(exc)


# ---------------------------------------------------------------------------
# run_onboard: dispatch + branches
# ---------------------------------------------------------------------------

def test_run_onboard_happy_path_is_green():
    clone_calls: List[tuple] = []

    def clone_fn(repo_url, ref, dest, *, token=""):
        clone_calls.append((repo_url, ref, dest, token))

    result = run_onboard(
        _work_item(github_token="wi-secret-token"),
        base_url="https://app.agentrail.dev",
        api_key="rt_secret",
        clone_fn=clone_fn,
        index_fn=lambda p: {"indexed": 12, "graphNodes": 34, "commitSha": "abc123"},
        brief_fn=lambda *a, **k: list(_FOUR_ITEMS),
        push_fn=lambda *a, **k: (True, "HTTP 202"),
        freshness_fn=_no_freshness,
        work_dir_factory=lambda: _mkdtemp(),
    )

    assert result.status == "green"
    assert "4" in result.gate_reason
    assert result.branch == "main"
    assert clone_calls, "clone_fn was invoked"
    # #1268: the claim's github_token must reach clone_fn.
    assert clone_calls[0][3] == "wi-secret-token"


def test_run_onboard_missing_repository_id_is_red_and_skips_clone():
    clone_calls: List[tuple] = []

    result = run_onboard(
        _work_item(repository_id=""),
        base_url="https://app.agentrail.dev",
        api_key="rt_secret",
        clone_fn=lambda *a, **k: clone_calls.append(a),
        index_fn=lambda p: {},
        brief_fn=lambda *a, **k: list(_FOUR_ITEMS),
        push_fn=lambda *a, **k: (True, "ok"),
    )

    assert result.status == "red"
    assert "repository_id" in result.gate_reason
    assert clone_calls == [], "clone must not run without a repository_id"


def test_run_onboard_clone_failure_is_error():
    def clone_fn(repo_url, ref, dest, *, token=""):
        raise RuntimeError("remote branch not found")

    result = run_onboard(
        _work_item(),
        base_url="https://app.agentrail.dev",
        api_key="rt_secret",
        clone_fn=clone_fn,
        index_fn=lambda p: {},
        brief_fn=lambda *a, **k: list(_FOUR_ITEMS),
        push_fn=lambda *a, **k: (True, "ok"),
        freshness_fn=_no_freshness,
        work_dir_factory=lambda: _mkdtemp(),
    )

    assert result.status == "error"
    assert "clone" in result.gate_reason


def test_run_onboard_redacts_token_even_from_a_non_redacting_custom_clone_fn():
    """Defense in depth: clone_fn is an injectable seam. The DEFAULT _clone
    always redacts (TestClonePrivateAuth above), but a caller-supplied
    clone_fn might not — run_onboard's own outer handler must redact
    item.github_token from gate_reason regardless of what clone_fn raises.
    """
    token = "wi-secret-token"

    def leaky_clone_fn(repo_url, ref, dest, *, token=""):
        # Simulates a clone_fn that does NOT sanitize its own exception.
        raise RuntimeError(f"git clone failed for https://x-access-token:{token}@github.com/o/r")

    result = run_onboard(
        _work_item(github_token=token),
        base_url="https://app.agentrail.dev",
        api_key="rt_secret",
        clone_fn=leaky_clone_fn,
        index_fn=lambda p: {},
        brief_fn=lambda *a, **k: list(_FOUR_ITEMS),
        push_fn=lambda *a, **k: (True, "ok"),
        freshness_fn=_no_freshness,
        work_dir_factory=lambda: _mkdtemp(),
    )

    assert result.status == "error"
    assert token not in result.gate_reason
    assert "***" in result.gate_reason


def test_run_onboard_push_failure_is_red():
    result = run_onboard(
        _work_item(),
        base_url="https://app.agentrail.dev",
        api_key="rt_secret",
        clone_fn=lambda *a, **k: None,
        index_fn=lambda p: {"indexed": 1, "graphNodes": 2, "commitSha": "z"},
        brief_fn=lambda *a, **k: list(_FOUR_ITEMS),
        push_fn=lambda *a, **k: (False, "boom"),
        freshness_fn=_no_freshness,
        work_dir_factory=lambda: _mkdtemp(),
    )

    assert result.status == "red"
    assert "push" in result.gate_reason
    assert "boom" in result.gate_reason


def test_run_onboard_clears_committed_index_before_building():
    """A freshly cloned repo carrying a COMMITTED context index must have it
    wiped before the index build runs, so onboarding indexes the real code.
    """
    # index build failures are best-effort (swallowed inside run_onboard), so we
    # record the observed state here and assert on it at the top level instead of
    # relying on an assertion inside index_fn propagating.
    seen: Dict[str, Any] = {}

    def work_dir_factory() -> str:
        import tempfile

        work_dir = tempfile.mkdtemp(prefix="agentrail-onboard-test-")
        # Simulate a cloned repo shipping a committed/stale context index.
        index_dir = Path(work_dir) / "repo" / ".agentrail" / "context" / "index"
        index_dir.mkdir(parents=True, exist_ok=True)
        (index_dir / "index.json").write_text('{"stale": true}', encoding="utf-8")
        return work_dir

    def index_fn(repo_dir: Path) -> dict:
        committed = repo_dir / ".agentrail" / "context" / "index" / "index.json"
        # run_onboard must have removed the committed index before calling us.
        assert not committed.exists(), "committed index should be cleared first"
        seen["committed_exists"] = committed.exists()
        seen["ran"] = True
        return {"indexed": 1, "graphNodes": 0, "commitSha": "fresh"}

    result = run_onboard(
        _work_item(),
        base_url="https://app.agentrail.dev",
        api_key="rt_secret",
        clone_fn=lambda *a, **k: None,  # dir already exists; no-op clone
        index_fn=index_fn,
        brief_fn=lambda *a, **k: list(_FOUR_ITEMS),
        push_fn=lambda *a, **k: (True, "ok"),
        freshness_fn=_no_freshness,
        work_dir_factory=work_dir_factory,
    )

    assert seen.get("ran"), "index_fn must have been invoked"
    assert seen.get("committed_exists") is False, "committed index must be cleared before build"
    assert result.status == "green"


# ---------------------------------------------------------------------------
# run_onboard: freshness reuse gate
# ---------------------------------------------------------------------------

def test_run_onboard_reuses_fresh_onboarding_and_skips_clone():
    """A recent onboardedAt makes run_onboard reuse notes and skip the clone."""
    clone_calls: List[tuple] = []
    fresh = datetime.now(timezone.utc) - timedelta(days=2)

    result = run_onboard(
        _work_item(),
        base_url="https://app.agentrail.dev",
        api_key="rt_secret",
        clone_fn=lambda *a, **k: clone_calls.append(a),
        index_fn=lambda p: {},
        brief_fn=lambda *a, **k: list(_FOUR_ITEMS),
        push_fn=lambda *a, **k: (True, "ok"),
        freshness_fn=lambda *a, **k: fresh,
        work_dir_factory=lambda: _mkdtemp(),
    )

    assert result.status == "green"
    assert "reused" in result.gate_reason
    assert result.branch == "main"
    assert clone_calls == [], "a fresh onboarding must skip cloning"


def test_run_onboard_none_freshness_proceeds_to_clone():
    """No prior onboarding (None) → proceed with a normal onboarding run."""
    clone_calls: List[tuple] = []

    result = run_onboard(
        _work_item(),
        base_url="https://app.agentrail.dev",
        api_key="rt_secret",
        clone_fn=lambda repo_url, ref, dest, **_kw: clone_calls.append((repo_url, ref, dest)),
        index_fn=lambda p: {"indexed": 1, "graphNodes": 0, "commitSha": "x"},
        brief_fn=lambda *a, **k: list(_FOUR_ITEMS),
        push_fn=lambda *a, **k: (True, "ok"),
        freshness_fn=lambda *a, **k: None,
        work_dir_factory=lambda: _mkdtemp(),
    )

    assert result.status == "green"
    assert "reused" not in result.gate_reason
    assert clone_calls, "a missing onboarding must clone and re-onboard"


def test_run_onboard_stale_onboarding_proceeds_to_clone():
    """An onboardedAt older than the freshness window re-onboards (clones)."""
    clone_calls: List[tuple] = []
    stale = datetime.now(timezone.utc) - timedelta(days=40)

    result = run_onboard(
        _work_item(),
        base_url="https://app.agentrail.dev",
        api_key="rt_secret",
        clone_fn=lambda repo_url, ref, dest, **_kw: clone_calls.append((repo_url, ref, dest)),
        index_fn=lambda p: {"indexed": 1, "graphNodes": 0, "commitSha": "x"},
        brief_fn=lambda *a, **k: list(_FOUR_ITEMS),
        push_fn=lambda *a, **k: (True, "ok"),
        freshness_fn=lambda *a, **k: stale,
        work_dir_factory=lambda: _mkdtemp(),
    )

    assert result.status == "green"
    assert "reused" not in result.gate_reason
    assert clone_calls, "a stale onboarding must clone and re-onboard"


# ---------------------------------------------------------------------------
# Repo Wiki (spec §4.6 transition) — AGENTRAIL_ONBOARD_WIKI, default OFF.
# The wiki seams (fetch_wiki_fn/assemble_wiki_fn/push_wiki_fn) are recording
# fakes, never raising ones: run_onboard's own wrappers (_fetch_wiki/
# _push_wiki) swallow ANY exception a seam raises (best-effort by design),
# so a raise-based "must not be called" guard would pass even if the wiring
# were broken. Recording calls into a list and asserting emptiness is the
# only assertion that actually proves non-invocation.
# ---------------------------------------------------------------------------

def test_onboard_wiki_enabled_defaults_off():
    with _env(_ONBOARD_WIKI_ENV, None):
        assert onboard_wiki_enabled() is False
    with _env(_ONBOARD_WIKI_ENV, "0"):
        assert onboard_wiki_enabled() is False
    with _env(_ONBOARD_WIKI_ENV, "yes"):
        assert onboard_wiki_enabled() is False
    with _env(_ONBOARD_WIKI_ENV, "1"):
        assert onboard_wiki_enabled() is True


def test_run_onboard_wiki_flag_off_is_byte_identical_to_today():
    """Flag OFF (the default): no wiki env vars, no temp config override, no
    hydrate/assemble/push calls — the memory-item flow is byte-identical to
    test_run_onboard_happy_path_is_green."""
    clone_calls: List[tuple] = []
    index_calls: List[Path] = []
    fetch_calls: List[tuple] = []
    assemble_calls: List[tuple] = []
    push_calls: List[tuple] = []

    def index_fn(repo_dir: Path) -> dict:
        index_calls.append(repo_dir)
        assert os.environ.get(_REPO_WIKI_ENV) != "1"
        assert not (repo_dir / ".agentrail" / "config.json").exists(), "no temp config override when the flag is off"
        return {"indexed": 12, "graphNodes": 34, "commitSha": "abc123"}

    with _env(_ONBOARD_WIKI_ENV, None), _env(_REPO_WIKI_ENV, None):
        result = run_onboard(
            _work_item(github_token="wi-secret-token"),
            base_url="https://app.agentrail.dev",
            api_key="rt_secret",
            clone_fn=lambda repo_url, ref, dest, *, token="": clone_calls.append((repo_url, ref, dest, token)),
            index_fn=index_fn,
            brief_fn=lambda *a, **k: list(_FOUR_ITEMS),
            push_fn=lambda *a, **k: (True, "HTTP 202"),
            freshness_fn=_no_freshness,
            work_dir_factory=lambda: _mkdtemp(),
            fetch_wiki_fn=lambda *a, **k: fetch_calls.append((a, k)) or True,
            assemble_wiki_fn=lambda *a, **k: assemble_calls.append((a, k)) or ([], None),
            push_wiki_fn=lambda *a, **k: push_calls.append((a, k)) or True,
        )

    # Exactly test_run_onboard_happy_path_is_green's assertions.
    assert result.status == "green"
    assert "4" in result.gate_reason
    assert result.branch == "main"
    assert clone_calls, "clone_fn was invoked"
    assert clone_calls[0][3] == "wi-secret-token"
    assert index_calls, "index_fn was invoked"

    # No wiki seam was ever touched.
    assert fetch_calls == []
    assert assemble_calls == []
    assert push_calls == []


def test_run_onboard_wiki_flag_on_compiles_pushes_and_memory_items_still_happen():
    """Flag ON (all fakes): hydrate -> compile (env + temp config satisfy
    wiki.py's two gates) -> push, entirely independent of — and without
    perturbing — the memory-item flow (dual-write per spec §4.6)."""
    fetch_calls: List[tuple] = []
    assemble_calls: List[Path] = []
    push_calls: List[tuple] = []
    index_env_seen: Dict[str, Any] = {}

    fake_pages = [{"slug": "wiki/overview", "title": "acme/widgets — overview"}]
    fake_compile_event = {
        "commitSha": "abc123", "pagesWritten": 3, "pagesReused": 0,
        "costUsd": 0.01, "model": "claude-haiku-4-5", "durationMs": 900,
    }

    def index_fn(repo_dir: Path) -> dict:
        # The wiki env vars + temp config override must be in place BY THE
        # TIME the compile itself runs — captured here since repo_dir is
        # wiped in run_onboard's own `finally`, before the test can inspect it.
        index_env_seen["repo_wiki_flag"] = os.environ.get(_REPO_WIKI_ENV)
        index_env_seen["server_base_url"] = os.environ.get("AGENTRAIL_SERVER_BASE_URL")
        index_env_seen["server_api_key"] = os.environ.get("AGENTRAIL_SERVER_API_KEY")
        index_env_seen["server_repo_id"] = os.environ.get("AGENTRAIL_SERVER_REPOSITORY_ID")
        config_path = repo_dir / ".agentrail" / "config.json"
        index_env_seen["config"] = json.loads(config_path.read_text(encoding="utf-8")) if config_path.is_file() else None
        return {"indexed": 1, "graphNodes": 0, "commitSha": "abc123", "wikiReport": {"pagesWritten": 3, "pagesReused": 0}}

    orig_base_url = os.environ.get("AGENTRAIL_SERVER_BASE_URL")
    orig_api_key = os.environ.get("AGENTRAIL_SERVER_API_KEY")
    orig_repo_id = os.environ.get("AGENTRAIL_SERVER_REPOSITORY_ID")
    orig_wiki_flag = os.environ.get(_REPO_WIKI_ENV)

    with _env(_ONBOARD_WIKI_ENV, "1"):
        result = run_onboard(
            _work_item(repo_url="https://github.com/acme/widgets"),
            base_url="https://app.agentrail.dev",
            api_key="rt_secret",
            clone_fn=lambda *a, **k: None,
            index_fn=index_fn,
            brief_fn=lambda *a, **k: list(_FOUR_ITEMS),
            push_fn=lambda *a, **k: (True, "HTTP 202"),
            freshness_fn=_no_freshness,
            work_dir_factory=lambda: _mkdtemp(),
            fetch_wiki_fn=lambda repo_dir, repo_full_name: fetch_calls.append((repo_dir, repo_full_name)) or True,
            assemble_wiki_fn=lambda repo_dir: assemble_calls.append(repo_dir) or (fake_pages, fake_compile_event),
            push_wiki_fn=lambda repo_dir, repo_full_name, pages, compile_event: push_calls.append((repo_dir, repo_full_name, pages, compile_event)) or True,
        )

    # Memory-item flow is untouched (dual-write): still green, still "4".
    assert result.status == "green"
    assert "4" in result.gate_reason

    # Env vars + temp config were in place FOR the compile call.
    assert index_env_seen["repo_wiki_flag"] == "1"
    assert index_env_seen["server_base_url"] == "https://app.agentrail.dev"
    assert index_env_seen["server_api_key"] == "rt_secret"
    assert index_env_seen["server_repo_id"] == "repo-1"
    assert index_env_seen["config"]["context"]["summary"]["mode"] == "claude-cli"

    # Env vars never leak past this one call (agentrail's own known gotcha:
    # AGENTRAIL_SERVER_* must be restored, not just cleared).
    assert os.environ.get("AGENTRAIL_SERVER_BASE_URL") == orig_base_url
    assert os.environ.get("AGENTRAIL_SERVER_API_KEY") == orig_api_key
    assert os.environ.get("AGENTRAIL_SERVER_REPOSITORY_ID") == orig_repo_id
    assert os.environ.get(_REPO_WIKI_ENV) == orig_wiki_flag

    # Hydrate -> compile -> push, all wired with the right identity.
    assert len(fetch_calls) == 1
    assert fetch_calls[0][1] == "acme/widgets"
    assert len(assemble_calls) == 1
    assert len(push_calls) == 1
    push_repo_dir, push_repo_full_name, pushed_pages, pushed_event = push_calls[0]
    assert push_repo_full_name == "acme/widgets"
    assert pushed_pages == fake_pages
    assert pushed_event == fake_compile_event
    assert push_repo_dir == assemble_calls[0], "push must assemble/push the SAME clone the compile just ran in"


def test_run_onboard_wiki_flag_on_skips_push_when_compile_produced_no_wiki_report():
    """A compile that produced no wikiReport (summary ended up disabled, or
    the compile step itself failed) has nothing to push — assemble/push
    must not run."""
    assemble_calls: List[Any] = []
    push_calls: List[Any] = []

    def index_fn(repo_dir: Path) -> dict:
        return {"indexed": 1, "graphNodes": 0, "commitSha": "abc123"}  # no wikiReport

    with _env(_ONBOARD_WIKI_ENV, "1"):
        result = run_onboard(
            _work_item(),
            base_url="https://app.agentrail.dev",
            api_key="rt_secret",
            clone_fn=lambda *a, **k: None,
            index_fn=index_fn,
            brief_fn=lambda *a, **k: list(_FOUR_ITEMS),
            push_fn=lambda *a, **k: (True, "ok"),
            freshness_fn=_no_freshness,
            work_dir_factory=lambda: _mkdtemp(),
            fetch_wiki_fn=lambda *a, **k: True,
            assemble_wiki_fn=lambda *a, **k: assemble_calls.append(1) or ([], None),
            push_wiki_fn=lambda *a, **k: push_calls.append(1) or True,
        )

    assert result.status == "green"
    assert assemble_calls == []
    assert push_calls == []


def test_ensure_wiki_summary_config_preserves_an_already_configured_provider(tmp_path: Path):
    """A repo that already configures a working (non-disabled) summary
    provider itself must keep it untouched — 'least invasive' means filling
    the gap, never clobbering an explicit choice. Other config.json fields
    (e.g. codebaseUnits) must survive too."""
    (tmp_path / ".agentrail").mkdir()
    (tmp_path / ".agentrail" / "config.json").write_text(
        json.dumps({"context": {"summary": {"mode": "custom-command", "customCommand": "echo hi"}, "codebaseUnits": ["x"]}}),
        encoding="utf-8",
    )

    _ensure_wiki_summary_config(tmp_path)

    written = json.loads((tmp_path / ".agentrail" / "config.json").read_text(encoding="utf-8"))
    assert written["context"]["summary"] == {"mode": "custom-command", "customCommand": "echo hi"}
    assert written["context"]["codebaseUnits"] == ["x"]


def test_ensure_wiki_summary_config_fills_a_missing_or_disabled_mode(tmp_path: Path):
    # No config.json at all yet -- the common case for a customer repo that
    # never ran `agentrail init`.
    _ensure_wiki_summary_config(tmp_path)
    written = json.loads((tmp_path / ".agentrail" / "config.json").read_text(encoding="utf-8"))
    assert written["context"]["summary"]["mode"] == "claude-cli"

    # An explicit "disabled" (the default shape agentrail init writes) is
    # also filled, not treated as an intentional non-default choice.
    (tmp_path / ".agentrail" / "config.json").write_text(
        json.dumps({"context": {"summary": {"mode": "disabled"}}}), encoding="utf-8"
    )
    _ensure_wiki_summary_config(tmp_path)
    written = json.loads((tmp_path / ".agentrail" / "config.json").read_text(encoding="utf-8"))
    assert written["context"]["summary"]["mode"] == "claude-cli"


# ---------------------------------------------------------------------------
# _repo_digest / _DIGEST_FILES: agent-doc-tier context files (spec §4.6)
# ---------------------------------------------------------------------------

def test_digest_files_gains_agent_doc_tier_context_files_at_the_front():
    assert _DIGEST_FILES[:3] == (".agentrail/context.md", "CONTEXT.md", "TASTE.md")
    assert ".agentrail/context.md" in _AGENT_DOC_FILES
    assert "CONTEXT.md" in _AGENT_DOC_FILES
    assert "TASTE.md" not in _AGENT_DOC_FILES, "TASTE.md stays at the standard head-line budget"


def test_repo_digest_includes_the_new_files_when_present(tmp_path: Path):
    (tmp_path / ".agentrail").mkdir()
    (tmp_path / ".agentrail" / "context.md").write_text("compiled context doc content\n", encoding="utf-8")
    (tmp_path / "CONTEXT.md").write_text("house context doc content\n", encoding="utf-8")
    (tmp_path / "TASTE.md").write_text("taste doc content\n", encoding="utf-8")
    (tmp_path / "README.md").write_text("readme content\n", encoding="utf-8")

    digest = _repo_digest(tmp_path, None)

    assert "compiled context doc content" in digest
    assert "house context doc content" in digest
    assert "taste doc content" in digest
    assert "readme content" in digest
    # Front-of-digest ordering: the three new files precede README.md.
    assert digest.index("compiled context doc content") < digest.index("readme content")
    assert digest.index("house context doc content") < digest.index("readme content")
    assert digest.index("taste doc content") < digest.index("readme content")


def test_repo_digest_gives_context_docs_a_bigger_head_line_budget_than_taste(tmp_path: Path):
    """.agentrail/context.md and CONTEXT.md join the CLAUDE.md/AGENTS.md
    agent-doc tier (120 head lines); TASTE.md stays at the standard 40."""
    (tmp_path / ".agentrail").mkdir()
    total_lines = _DIGEST_AGENT_DOC_HEAD_LINES + 20
    agent_doc_lines = [f"agent-doc-line-{i}" for i in range(total_lines)]
    (tmp_path / ".agentrail" / "context.md").write_text("\n".join(agent_doc_lines), encoding="utf-8")
    taste_lines = [f"taste-line-{i}" for i in range(total_lines)]
    (tmp_path / "TASTE.md").write_text("\n".join(taste_lines), encoding="utf-8")

    digest = _repo_digest(tmp_path, None)

    assert f"agent-doc-line-{_DIGEST_AGENT_DOC_HEAD_LINES - 1}" in digest, "agent-doc tier keeps up to 120 head lines"
    assert f"taste-line-{_DIGEST_HEAD_LINES - 1}" in digest
    assert f"taste-line-{_DIGEST_HEAD_LINES}" not in digest, "TASTE.md is capped at the standard 40 head lines"


def test_repo_digest_unaffected_when_new_files_absent(tmp_path: Path):
    """When the new files simply aren't present (most repos today), the
    digest behaves exactly as before — no crash, no phantom sections."""
    (tmp_path / "README.md").write_text("only a readme\n", encoding="utf-8")
    digest = _repo_digest(tmp_path, None)
    assert "only a readme" in digest
    assert "context.md" not in digest


# ---------------------------------------------------------------------------
# _repo_full_name + check_onboard_freshness
# ---------------------------------------------------------------------------

def test_repo_full_name_from_onboard_external_id():
    item = _work_item(external_id="onboard:acme/widgets")
    assert _repo_full_name(item) == "acme/widgets"


def test_repo_full_name_falls_back_to_repo_url():
    # A normal (non-onboard) external_id is ignored; repo_url is parsed instead.
    item = _work_item(external_id="owner/repo#1", repo_url="https://github.com/owner/repo.git")
    assert _repo_full_name(item) == "owner/repo"


def test_check_onboard_freshness_parses_iso_z_suffix():
    body = json.dumps({"onboardedAt": "2026-07-01T00:00:00Z", "count": 3}).encode("utf-8")
    dt = check_onboard_freshness(
        "https://app.agentrail.dev",
        "rt_secret",
        "owner/repo",
        opener=lambda req, timeout=None: _FakeResponse(200, body),
    )
    assert dt is not None
    assert dt.tzinfo is not None, "returned datetime must be tz-aware"


def test_check_onboard_freshness_requests_encoded_repo_with_auth():
    captured: Dict[str, Any] = {}

    def opener(req, timeout=None):
        captured["url"] = req.full_url
        captured["method"] = req.get_method()
        captured["auth"] = req.get_header("Authorization")
        return _FakeResponse(200, json.dumps({"onboardedAt": None}).encode("utf-8"))

    check_onboard_freshness("https://app.agentrail.dev", "rt_secret", "acme/widgets", opener=opener)

    assert "onboard-status?repo=acme%2Fwidgets" in captured["url"]
    assert captured["method"] == "GET"
    assert captured["auth"] == "Bearer rt_secret"


def test_check_onboard_freshness_null_onboarded_at_is_none():
    body = json.dumps({"onboardedAt": None, "count": 0}).encode("utf-8")
    dt = check_onboard_freshness(
        "https://app.agentrail.dev",
        "rt_secret",
        "owner/repo",
        opener=lambda req, timeout=None: _FakeResponse(200, body),
    )
    assert dt is None


def test_check_onboard_freshness_fail_open_on_opener_error():
    def opener(req, timeout=None):
        raise urllib.error.URLError("boom")

    dt = check_onboard_freshness(
        "https://app.agentrail.dev", "rt_secret", "owner/repo", opener=opener
    )
    assert dt is None, "any error must fail open to None (never wrongly skip)"


def test_check_onboard_freshness_non_200_is_none():
    dt = check_onboard_freshness(
        "https://app.agentrail.dev",
        "rt_secret",
        "owner/repo",
        opener=lambda req, timeout=None: _FakeResponse(500, b"{}"),
    )
    assert dt is None


# ---------------------------------------------------------------------------
# generate_onboard_items: fail-open + type-clamp
# ---------------------------------------------------------------------------

def test_generate_onboard_items_falls_back_when_call_model_raises():
    def call_model(model, prompt):
        raise RuntimeError("headless call exploded")

    items = generate_onboard_items("digest text", call_model=call_model)

    assert items, "fallback returns at least the default items"
    assert all(it["type"] in MEMORY_TYPES for it in items)
    assert all(it["tags"] for it in items)


def _category_tag(item: dict) -> str:
    return next(t for t in item["tags"] if t.startswith("onboard:"))


def test_generate_onboard_items_emits_four_category_skeleton():
    """A JSON object over the four categories → one tagged, typed item each."""
    def call_model(model, prompt):
        return json.dumps(
            {
                "conventions": "Use black + ruff; type-annotate public functions.",
                "architecture": "runner/ dispatches work items to handlers.",
                "commands": "pytest -q; ruff check .",
                "glossary": "onboard = seed workspace memory for a repo.",
            }
        )

    items = generate_onboard_items("digest", call_model=call_model)

    assert len(items) == 4
    by_cat = {_category_tag(it): it for it in items}
    assert set(by_cat) == {f"onboard:{c}" for c in ONBOARD_CATEGORIES}
    for cat in ONBOARD_CATEGORIES:
        it = by_cat[f"onboard:{cat}"]
        assert it["type"] == _CATEGORY_TYPE[cat]
        assert it["type"] in MEMORY_TYPES
        assert "onboard" in it["tags"]
    # The exact mapping the handler pins.
    assert by_cat["onboard:architecture"]["type"] == "decision"
    assert by_cat["onboard:conventions"]["type"] == "preference"
    assert by_cat["onboard:commands"]["type"] == "preference"
    assert by_cat["onboard:glossary"]["type"] == "fact"


def test_generate_onboard_items_skips_missing_and_empty_categories():
    """Empty-string and absent categories are skipped, not emitted."""
    def call_model(model, prompt):
        return json.dumps(
            {
                "conventions": "Use black.",
                "architecture": "",  # empty → skipped
                "commands": "pytest",
                # glossary key absent → skipped
            }
        )

    items = generate_onboard_items("digest", call_model=call_model)

    cats = sorted(_category_tag(it) for it in items)
    assert cats == ["onboard:commands", "onboard:conventions"]


def test_generate_onboard_items_non_object_falls_back_to_defaults():
    """A JSON array (old shape) is the wrong shape → fail open to defaults."""
    def call_model(model, prompt):
        return json.dumps([{"content": "x", "type": "decision", "tags": ["onboard"]}])

    items = generate_onboard_items("--- Makefile ---\nbuild:", call_model=call_model)

    assert items, "wrong shape must fall back to deterministic defaults"
    assert all(it["type"] in MEMORY_TYPES for it in items)
    assert all(any(t.startswith("onboard:") for t in it["tags"]) for it in items)


def test_generate_onboard_items_fallback_emits_category_skeleton():
    """When the model call raises, the deterministic fallback still emits the
    category skeleton (architecture + commands at minimum, valid types/tags).
    """
    def call_model(model, prompt):
        raise RuntimeError("boom")

    digest = "Top-level entries: Makefile, package.json\n--- package.json ---\n{}"
    items = generate_onboard_items(digest, call_model=call_model)

    assert len(items) >= 2
    assert all(it["type"] in MEMORY_TYPES for it in items)
    cats = {_category_tag(it) for it in items}
    assert "onboard:architecture" in cats
    assert "onboard:commands" in cats


def test_default_items_emits_conventions_when_docs_present():
    """A digest that ships CLAUDE.md/AGENTS.md yields a conventions item too."""
    digest = "--- CLAUDE.md ---\nHouse rules\n--- Makefile ---\nbuild:"
    items = _default_items(digest, {"indexed": 3, "graphNodes": 1, "commitSha": "abc"})

    cats = {_category_tag(it) for it in items}
    assert "onboard:architecture" in cats
    assert "onboard:commands" in cats
    assert "onboard:conventions" in cats
    assert all(it["type"] in MEMORY_TYPES for it in items)


def test_postprocess_items_clamps_bogus_type_and_drops_empty_content():
    items = _postprocess_items(
        [
            {"content": "valid", "type": "decision", "tags": ["onboard"]},
            {"content": "clamp me", "type": "bogus", "tags": ["onboard"]},
            {"content": "   ", "type": "preference", "tags": ["onboard"]},
            {"content": "", "type": "fact"},
            "not a dict",
        ]
    )

    contents = [it["content"] for it in items]
    assert "valid" in contents
    assert "clamp me" in contents
    # Empty / whitespace-only content is dropped.
    assert "" not in contents
    assert "   " not in contents
    # The bogus type is clamped to "fact".
    clamped = next(it for it in items if it["content"] == "clamp me")
    assert clamped["type"] == "fact"
    assert all(it["type"] in MEMORY_TYPES for it in items)


def test_postprocess_items_preserves_category_tags():
    """The type-clamp pass must not strip the ``onboard:<category>`` tags."""
    items = _postprocess_items(
        [{"content": "c", "type": "decision", "tags": ["onboard", "onboard:architecture"]}]
    )
    assert items[0]["tags"] == ["onboard", "onboard:architecture"]


# ---------------------------------------------------------------------------
# push_onboard_items: the wire contract
# ---------------------------------------------------------------------------

class _FakeResponse:
    """A minimal urlopen-style response carrying an HTTP status + optional body."""

    def __init__(self, status: int, body: bytes = b"") -> None:
        self.status = status
        self._body = body

    def read(self) -> bytes:
        return self._body

    def close(self) -> None:  # pragma: no cover - trivial
        pass


def test_push_onboard_items_posts_pinned_contract():
    captured: Dict[str, Any] = {}

    def opener(req, timeout=None):
        captured["url"] = req.full_url
        captured["method"] = req.get_method()
        captured["auth"] = req.get_header("Authorization")
        captured["body"] = json.loads(req.data.decode("utf-8"))
        captured["timeout"] = timeout
        return _FakeResponse(202)

    items = [{"content": "c", "type": "decision", "tags": ["onboard"]}]
    ok, detail = push_onboard_items(
        "https://app.agentrail.dev",
        "rt_secret",
        "repo-1",
        "wi-1",
        items,
        opener=opener,
    )

    assert ok is True
    assert "202" in detail
    assert captured["url"].endswith("/api/v1/ingest/memory-items")
    assert captured["method"] == "POST"
    assert captured["auth"] == "Bearer rt_secret"

    body = captured["body"]
    assert body["written_by"] == "onboarder"
    assert body["source"] == "onboard"
    assert body["replace_by_writer"] is True
    assert body["run_id"] == "wi-1"
    assert body["repository_id"] == "repo-1"
    assert body["items"][0]["type"] == "decision"


def test_push_onboard_items_non_202_is_not_ok():
    ok, detail = push_onboard_items(
        "https://app.agentrail.dev",
        "rt_secret",
        "repo-1",
        "wi-1",
        [{"content": "c", "type": "fact", "tags": ["onboard"]}],
        opener=lambda req, timeout=None: _FakeResponse(500),
    )
    assert ok is False
    assert "500" in detail


# ---------------------------------------------------------------------------
# tiny local tempdir helper (avoids leaking real temp dirs into the suite)
# ---------------------------------------------------------------------------

def _mkdtemp() -> str:
    import tempfile

    return tempfile.mkdtemp(prefix="agentrail-onboard-test-")
