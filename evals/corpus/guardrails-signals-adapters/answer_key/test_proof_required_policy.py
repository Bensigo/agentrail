"""Config-driven proof-required policy tests (issue #919, AC2 + AC3).

The HEADLINE test is parametrized over a Python config fixture AND a TypeScript
config fixture, running the SAME policy code with zero edits and asserting correct
classification for each — that is the framework-independence proof (AC3).
"""
from __future__ import annotations

import pytest

from agentrail.guardrails import get_guardrail, list_guardrails
from agentrail.guardrails.base import VerdictStatus
from agentrail.guardrails.policies.proof_required import (
    ProofConfig,
    is_test_free,
    requires_proof,
)
from agentrail.guardrails.signals import Signals

PYTHON_CONFIG = ProofConfig(source_globs=("*.py",), test_globs=("test_*.py", "*_test.py"))
TS_CONFIG = ProofConfig(source_globs=("**/*.ts",), test_globs=("**/*.test.ts",))


# ---------------------------------------------------------------------------
# AC3: same policy, two framework configs, correct classification for each.
# ---------------------------------------------------------------------------

@pytest.mark.parametrize(
    "config,source_file,test_file,docs_file",
    [
        (PYTHON_CONFIG, "agentrail/run/feature.py", "tests/test_feature.py", "docs/x.md"),
        (TS_CONFIG, "src/foo.ts", "src/foo.test.ts", "docs/x.md"),
    ],
    ids=["python", "typescript"],
)
def test_same_policy_classifies_each_framework(config, source_file, test_file, docs_file):
    # A source change requires a proof.
    assert requires_proof(Signals(changed_files=(source_file,)), config) is True
    assert is_test_free(Signals(changed_files=(source_file,)), config) is False

    # A docs-only change does not require a proof and is test-free.
    assert requires_proof(Signals(changed_files=(docs_file,)), config) is False
    assert is_test_free(Signals(changed_files=(docs_file,)), config) is True

    # A test-only change does not, by itself, require a NEW proof (test_globs wins).
    assert requires_proof(Signals(changed_files=(test_file,)), config) is False

    # A source file that matches test_globs is NOT counted as needing its own proof.
    assert requires_proof(Signals(changed_files=(test_file, docs_file)), config) is False


def test_empty_change_set_is_never_test_free():
    for config in (PYTHON_CONFIG, TS_CONFIG):
        assert is_test_free(Signals(changed_files=()), config) is False
        assert requires_proof(Signals(changed_files=()), config) is False


def test_ts_top_level_and_nested_paths_both_match():
    # `**/*.ts` must match both a nested and a top-level source file.
    assert requires_proof(Signals(changed_files=("a/b/deep.ts",)), TS_CONFIG)
    assert requires_proof(Signals(changed_files=("toplevel.ts",)), TS_CONFIG)
    # `**/*.test.ts` must classify a nested test as a test, not source.
    assert not requires_proof(Signals(changed_files=("a/b/deep.test.ts",)), TS_CONFIG)


# ---------------------------------------------------------------------------
# AC2: the decision is computed by a registered guardrail reading Signals+config.
# ---------------------------------------------------------------------------

class TestProofRequiredGuardrail:
    def test_registered_in_list(self):
        assert "proof_required" in {g.name for g in list_guardrails()}

    def test_metadata(self):
        g = get_guardrail("proof_required")
        assert g.name == "proof_required"
        assert isinstance(g.description, str) and g.description.strip()
        assert g.blocking is True

    @pytest.mark.parametrize(
        "config,source_file", [(PYTHON_CONFIG, "a.py"), (TS_CONFIG, "a.ts")],
        ids=["python", "typescript"],
    )
    def test_source_change_is_failing_verdict(self, config, source_file):
        g = get_guardrail("proof_required")
        v = g.evaluate(signals=Signals(changed_files=(source_file,)), config=config)
        assert v.status is VerdictStatus.FAIL
        assert v.reasons

    @pytest.mark.parametrize("config", [PYTHON_CONFIG, TS_CONFIG], ids=["python", "typescript"])
    def test_docs_change_is_passing_verdict(self, config):
        g = get_guardrail("proof_required")
        v = g.evaluate(signals=Signals(changed_files=("docs/x.md",)), config=config)
        assert v.status is VerdictStatus.PASS

    def test_evaluate_requires_signals_and_config(self):
        g = get_guardrail("proof_required")
        with pytest.raises(TypeError):
            g.evaluate(signals=Signals(changed_files=("a.py",)))
        with pytest.raises(TypeError):
            g.evaluate(config=PYTHON_CONFIG)
