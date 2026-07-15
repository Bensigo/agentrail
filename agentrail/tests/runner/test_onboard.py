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
from pathlib import Path
from typing import Any, Dict, List, Optional

from agentrail.runner.client import WorkItem
from agentrail.runner.onboard import (
    MEMORY_TYPES,
    generate_onboard_items,
    push_onboard_items,
    run_onboard,
)


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
    {"content": "convention one", "type": "decision", "tags": ["onboard"]},
    {"content": "module map", "type": "decision", "tags": ["onboard"]},
    {"content": "run pytest", "type": "preference", "tags": ["onboard"]},
    {"content": "glossary: widget = thing", "type": "fact", "tags": ["onboard"]},
]


# ---------------------------------------------------------------------------
# run_onboard: dispatch + branches
# ---------------------------------------------------------------------------

def test_run_onboard_happy_path_is_green():
    clone_calls: List[tuple] = []

    def clone_fn(repo_url, ref, dest):
        clone_calls.append((repo_url, ref, dest))

    result = run_onboard(
        _work_item(),
        base_url="https://app.agentrail.dev",
        api_key="rt_secret",
        clone_fn=clone_fn,
        index_fn=lambda p: {"indexed": 12, "graphNodes": 34, "commitSha": "abc123"},
        brief_fn=lambda *a, **k: list(_FOUR_ITEMS),
        push_fn=lambda *a, **k: (True, "HTTP 202"),
        work_dir_factory=lambda: _mkdtemp(),
    )

    assert result.status == "green"
    assert "4" in result.gate_reason
    assert result.branch == "main"
    assert clone_calls, "clone_fn was invoked"


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
    def clone_fn(repo_url, ref, dest):
        raise RuntimeError("remote branch not found")

    result = run_onboard(
        _work_item(),
        base_url="https://app.agentrail.dev",
        api_key="rt_secret",
        clone_fn=clone_fn,
        index_fn=lambda p: {},
        brief_fn=lambda *a, **k: list(_FOUR_ITEMS),
        push_fn=lambda *a, **k: (True, "ok"),
        work_dir_factory=lambda: _mkdtemp(),
    )

    assert result.status == "error"
    assert "clone" in result.gate_reason


def test_run_onboard_push_failure_is_red():
    result = run_onboard(
        _work_item(),
        base_url="https://app.agentrail.dev",
        api_key="rt_secret",
        clone_fn=lambda *a, **k: None,
        index_fn=lambda p: {"indexed": 1, "graphNodes": 2, "commitSha": "z"},
        brief_fn=lambda *a, **k: list(_FOUR_ITEMS),
        push_fn=lambda *a, **k: (False, "boom"),
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
        work_dir_factory=work_dir_factory,
    )

    assert seen.get("ran"), "index_fn must have been invoked"
    assert seen.get("committed_exists") is False, "committed index must be cleared before build"
    assert result.status == "green"


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


def test_generate_onboard_items_clamps_bogus_type_and_drops_empty_content():
    def call_model(model, prompt):
        return json.dumps(
            [
                {"content": "valid", "type": "decision", "tags": ["onboard"]},
                {"content": "clamp me", "type": "bogus", "tags": ["onboard"]},
                {"content": "   ", "type": "preference", "tags": ["onboard"]},
                {"content": "", "type": "fact"},
            ]
        )

    items = generate_onboard_items("digest text", call_model=call_model)

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


# ---------------------------------------------------------------------------
# push_onboard_items: the wire contract
# ---------------------------------------------------------------------------

class _FakeResponse:
    """A minimal urlopen-style response carrying an HTTP status."""

    def __init__(self, status: int) -> None:
        self.status = status

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
