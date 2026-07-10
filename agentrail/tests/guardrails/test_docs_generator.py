"""Tests for the guardrails doc generator (issue #922).

* AC2 — the generator renders ``docs/agents/guardrails.md`` enumerating the same
  guardrails as ``list_guardrails()`` (name + posture + neutral + description).
* AC2/up-to-date — the COMMITTED doc equals a fresh render (regenerate, diff).
* AC3 — registering a NEW guardrail surfaces it in the regenerated doc with no
  other code change (nothing is hardcoded).
"""
from __future__ import annotations

import dataclasses
from pathlib import Path

import pytest

from agentrail.guardrails import Verdict, list_guardrails
from agentrail.guardrails.docs import doc_path, render_doc, write_doc
from agentrail.guardrails.registry import _REGISTRY, register


def _repo_root() -> Path:
    return Path(__file__).resolve().parents[3]


@dataclasses.dataclass(frozen=True)
class _DummyGuardrail:
    name: str = "zzz_dummy_doc_guardrail"
    description: str = "A dummy guardrail registered only by the AC3 doc test."
    blocking: bool = False
    framework_neutral: bool = True

    def evaluate(self, **kwargs: object) -> Verdict:
        return Verdict.passing()


@pytest.fixture
def dummy_guardrail():
    g = _DummyGuardrail()
    register(g)
    try:
        yield g
    finally:
        _REGISTRY.pop(g.name, None)


# ---------------------------------------------------------------------------
# AC2: the rendered doc enumerates the same guardrails as the registry
# ---------------------------------------------------------------------------

def test_render_includes_every_registered_guardrail():
    doc = render_doc()
    for g in list_guardrails():
        assert f"`{g.name}`" in doc
        assert g.description.split("|")[0][:40] in doc  # description body present
        assert ("blocking" if g.blocking else "advisory") in doc
    # one table row per guardrail (rows start with "| `")
    rows = [ln for ln in doc.splitlines() if ln.startswith("| `")]
    assert len(rows) == len(list_guardrails())


def test_render_shows_framework_neutral_column():
    doc = render_doc()
    assert "Framework-neutral" in doc
    # every guardrail row carries a yes/no neutral cell
    rows = [ln for ln in doc.splitlines() if ln.startswith("| `")]
    for row in rows:
        assert " yes " in row or " no " in row


# ---------------------------------------------------------------------------
# AC2 (up-to-date): the committed doc equals a fresh render
# ---------------------------------------------------------------------------

def test_committed_doc_is_up_to_date():
    committed = doc_path(_repo_root()).read_text(encoding="utf-8")
    assert committed == render_doc(), (
        "docs/agents/guardrails.md is stale; regenerate with "
        "`agentrail guardrails docs --write`"
    )


def test_write_doc_roundtrips(tmp_path):
    written = write_doc(tmp_path)
    assert written == tmp_path / "docs" / "agents" / "guardrails.md"
    assert written.read_text(encoding="utf-8") == render_doc()


# ---------------------------------------------------------------------------
# AC3: a newly-registered guardrail surfaces in the regenerated doc
# ---------------------------------------------------------------------------

def test_dummy_guardrail_surfaces_in_regenerated_doc(dummy_guardrail, tmp_path):
    written = write_doc(tmp_path)
    doc = written.read_text(encoding="utf-8")
    assert f"`{dummy_guardrail.name}`" in doc
    assert dummy_guardrail.description in doc
    assert "advisory" in doc  # honest posture from the instance
