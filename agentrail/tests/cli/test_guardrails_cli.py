"""Tests for ``agentrail guardrails list`` / ``docs`` (issue #922).

* AC1 — ``guardrails list`` prints every registered guardrail with name,
  description, blocking-vs-advisory, and a framework-neutral indicator; exit 0.
* AC4 — the command output is sourced from the single registry: parity between
  the printed names and ``list_guardrails()``.
* AC3 — registering a NEW guardrail surfaces it in the command output with no
  other code change (nothing is hardcoded).
"""
from __future__ import annotations

import dataclasses
import subprocess
from pathlib import Path

import pytest

from agentrail.cli.commands.guardrails import run_guardrails
from agentrail.guardrails import Verdict, list_guardrails
from agentrail.guardrails.registry import _REGISTRY, register


@dataclasses.dataclass(frozen=True)
class _DummyGuardrail:
    name: str = "zzz_dummy_test_guardrail"
    description: str = "A dummy guardrail registered only by the AC3 test."
    blocking: bool = False
    framework_neutral: bool = True

    def evaluate(self, **kwargs: object) -> Verdict:
        return Verdict.passing()


@pytest.fixture
def dummy_guardrail():
    """Register a dummy guardrail for the duration of one test, then remove it."""
    g = _DummyGuardrail()
    register(g)
    try:
        yield g
    finally:
        _REGISTRY.pop(g.name, None)


# ---------------------------------------------------------------------------
# AC1 + AC4: list prints every guardrail, exits 0, parity with the registry
# ---------------------------------------------------------------------------

def test_list_exits_zero_and_lists_every_registered_guardrail(capsys):
    rc = run_guardrails(["list"])
    assert rc == 0
    out = capsys.readouterr().out

    for g in list_guardrails():
        # name, description and the indicators all appear
        assert f"- {g.name}" in out
        assert g.description in out
    # parity: the count line reflects the registry size exactly
    assert f"AgentRail guardrails ({len(list_guardrails())}):" in out


def test_list_shows_posture_and_framework_neutral_indicators(capsys):
    rc = run_guardrails(["list"])
    assert rc == 0
    out = capsys.readouterr().out
    # blocking-vs-advisory indicator present for every guardrail
    assert "posture: blocking" in out or "posture: advisory" in out
    # framework-neutral indicator present
    assert "framework-neutral: yes" in out or "framework-neutral: no" in out
    # one posture + one neutral line per guardrail
    n = len(list_guardrails())
    assert out.count("posture: ") == n
    assert out.count("framework-neutral: ") == n


def test_list_output_names_match_registry_exactly(capsys):
    """AC4 parity: the names the command prints == list_guardrails() names."""
    run_guardrails(["list"])
    out = capsys.readouterr().out
    printed = {ln[2:] for ln in out.splitlines() if ln.startswith("- ")}
    registry = {g.name for g in list_guardrails()}
    assert printed == registry


# ---------------------------------------------------------------------------
# AC3: a newly-registered guardrail surfaces in the command (not hardcoded)
# ---------------------------------------------------------------------------

def test_dummy_guardrail_surfaces_in_list_output(dummy_guardrail, capsys):
    run_guardrails(["list"])
    out = capsys.readouterr().out
    assert f"- {dummy_guardrail.name}" in out
    assert dummy_guardrail.description in out
    # advisory + neutral indicators rendered honestly from the instance
    assert "posture: advisory" in out
    assert "framework-neutral: yes" in out


# ---------------------------------------------------------------------------
# Smoke: the public entrypoint wires `guardrails list` and exits 0
# ---------------------------------------------------------------------------

def test_public_entrypoint_guardrails_list_exits_zero():
    repo = Path(__file__).resolve().parents[3]
    result = subprocess.run(
        [str(repo / "agentrail" / "scripts" / "agentrail"), "guardrails", "list"],
        check=False,
        stdout=subprocess.PIPE,
        stderr=subprocess.PIPE,
        text=True,
    )
    assert result.returncode == 0, result.stderr
    assert "AgentRail guardrails" in result.stdout
    for g in list_guardrails():
        assert g.name in result.stdout
