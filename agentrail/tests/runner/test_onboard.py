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
import urllib.error
from datetime import datetime, timedelta, timezone
from pathlib import Path
from typing import Any, Dict, List, Optional

from agentrail.runner.client import WorkItem
from agentrail.runner.onboard import (
    MEMORY_TYPES,
    ONBOARD_CATEGORIES,
    _CATEGORY_TYPE,
    _default_items,
    _postprocess_items,
    _repo_full_name,
    check_onboard_freshness,
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
    {"content": "use black + ruff", "type": "preference", "tags": ["onboard", "onboard:conventions"]},
    {"content": "module map", "type": "decision", "tags": ["onboard", "onboard:architecture"]},
    {"content": "run pytest", "type": "preference", "tags": ["onboard", "onboard:commands"]},
    {"content": "glossary: widget = thing", "type": "fact", "tags": ["onboard", "onboard:glossary"]},
]

# Default freshness seam for run_onboard tests: "not onboarded" → proceed
# normally. Passed explicitly so tests never hit the real network freshness GET.
def _no_freshness(*_a: Any, **_k: Any) -> Optional[datetime]:
    return None


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
        freshness_fn=_no_freshness,
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
        freshness_fn=_no_freshness,
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
        clone_fn=lambda repo_url, ref, dest: clone_calls.append((repo_url, ref, dest)),
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
        clone_fn=lambda repo_url, ref, dest: clone_calls.append((repo_url, ref, dest)),
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
