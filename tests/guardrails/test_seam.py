"""Tests for the agentrail.guardrails package seam (issue #918).

Covers:
* AC1 — `from agentrail.guardrails import list_guardrails` enumerates the
  migrated output-enforcer guardrail with name/description/blocking metadata.
* AC2 — output (diff-only) enforcement returns IDENTICAL Accept/Reject verdicts
  via BOTH the new `agentrail.guardrails` path AND the old
  `agentrail.run.output_enforcer` shim (reject case + accept case).
* AC3 — the migrated policy module imports no framework/I-O module.
"""
from __future__ import annotations

import importlib

import pytest

from agentrail.guardrails import (
    Guardrail,
    Verdict,
    VerdictStatus,
    get_guardrail,
    list_guardrails,
)


# ---------------------------------------------------------------------------
# AC1: list_guardrails() includes output_enforcer with its metadata
# ---------------------------------------------------------------------------

class TestListGuardrailsAC1:
    def test_returns_a_collection(self):
        guardrails = list_guardrails()
        assert isinstance(guardrails, list)
        assert len(guardrails) >= 1

    def test_includes_output_enforcer_entry(self):
        names = {g.name for g in list_guardrails()}
        assert "output_enforcer" in names

    def test_output_enforcer_exposes_required_metadata(self):
        g = get_guardrail("output_enforcer")
        # name, description, blocking-vs-advisory metadata
        assert g.name == "output_enforcer"
        assert isinstance(g.description, str) and g.description.strip()
        assert isinstance(g.blocking, bool)
        assert g.blocking is True  # full-file rewrites are a blocking failure

    def test_every_entry_satisfies_guardrail_protocol(self):
        for g in list_guardrails():
            assert isinstance(g, Guardrail)
            assert g.name
            assert g.description
            assert isinstance(g.blocking, bool)
            assert callable(g.evaluate)

    def test_list_is_sorted_and_deterministic(self):
        names = [g.name for g in list_guardrails()]
        assert names == sorted(names)
        assert names == [g.name for g in list_guardrails()]


# ---------------------------------------------------------------------------
# AC1/AC2: the guardrail evaluate() maps enforce() decisions to a Verdict
# ---------------------------------------------------------------------------

class TestGuardrailEvaluate:
    def test_full_rewrite_is_failing_verdict(self):
        g = get_guardrail("output_enforcer")
        v = g.evaluate(content="def f():\n    return 1\n", is_new_or_rename=False)
        assert isinstance(v, Verdict)
        assert v.status is VerdictStatus.FAIL
        assert v.failed and not v.passed
        assert v.reasons and "@@" in v.reasons[0]

    def test_diff_is_passing_verdict(self):
        g = get_guardrail("output_enforcer")
        v = g.evaluate(content="@@ -1,2 +1,2 @@\n-a\n+b\n", is_new_or_rename=False)
        assert v.status is VerdictStatus.PASS
        assert v.passed and not v.failed
        assert v.reasons == ()

    def test_new_file_is_passing_verdict(self):
        g = get_guardrail("output_enforcer")
        v = g.evaluate(content="any full content", is_new_or_rename=True)
        assert v.status is VerdictStatus.PASS


# ---------------------------------------------------------------------------
# AC2: identical Accept/Reject decisions via BOTH old and new import paths
# ---------------------------------------------------------------------------

class TestBackCompatShimIdenticalVerdictsAC2:
    """The shim must be transparent: old and new paths produce the same decision
    on the same inputs, for both a reject case and an accept case."""

    @pytest.mark.parametrize(
        "content,is_new_or_rename",
        [
            ("def foo():\n    return 42\n", False),          # reject: full rewrite
            ("", False),                                      # reject: empty existing file
            ("@@ -1,5 +1,6 @@\n-old\n+new\n", False),         # accept: unified diff
            ("@@ -1 +1 @@\n-a\n+b\n", False),                 # accept: no-comma hunk
            ("brand new file content", True),                 # accept: new/rename
            ("", True),                                        # accept: rename, empty
        ],
    )
    def test_old_and_new_enforce_agree(self, content, is_new_or_rename):
        from agentrail.run.output_enforcer import (
            Accepted as OldAccepted,
            Rejected as OldRejected,
            enforce as old_enforce,
        )
        from agentrail.guardrails.policies.output_enforcer import (
            Accepted as NewAccepted,
            Rejected as NewRejected,
            enforce as new_enforce,
        )

        # Shim re-exports the SAME objects, not copies.
        assert OldAccepted is NewAccepted
        assert OldRejected is NewRejected
        assert old_enforce is new_enforce

        old = old_enforce(content, is_new_or_rename=is_new_or_rename)
        new = new_enforce(content, is_new_or_rename=is_new_or_rename)

        assert type(old) is type(new)
        if isinstance(old, OldRejected):
            assert isinstance(new, NewRejected)
            assert old.reason == new.reason
        else:
            assert isinstance(old, OldAccepted)

    def test_guardrail_verdict_matches_old_enforce(self):
        """The Verdict from evaluate() maps 1:1 to the legacy Accept/Reject."""
        from agentrail.run.output_enforcer import Rejected, enforce as old_enforce

        g = get_guardrail("output_enforcer")
        cases = [
            ("def x(): pass\n", False),
            ("@@ -1,2 +1,2 @@\n-a\n+b\n", False),
            ("full new content", True),
        ]
        for content, inr in cases:
            old = old_enforce(content, is_new_or_rename=inr)
            v = g.evaluate(content=content, is_new_or_rename=inr)
            if isinstance(old, Rejected):
                assert v.status is VerdictStatus.FAIL
                assert v.reasons[0] == old.reason
            else:
                assert v.status is VerdictStatus.PASS


# ---------------------------------------------------------------------------
# AC3: the migrated policy is pure — imports no framework / I-O module
# ---------------------------------------------------------------------------

class TestPolicyIsPureAC3:
    def test_policy_module_imports_no_io_modules(self):
        import sys

        # Import the policy in isolation and confirm it does not pull in I/O libs.
        mod = importlib.import_module("agentrail.guardrails.policies.output_enforcer")
        src_globals = set(vars(mod))
        for forbidden in ("subprocess", "urllib", "socket", "requests"):
            assert forbidden not in src_globals, (
                f"pure policy must not import {forbidden!r}"
            )
        # push I/O must NOT have leaked into the pure policy.
        assert not hasattr(mod, "push_format_rejection_event")

    def test_policy_imports_no_io_modules_via_ast(self):
        """Parse the import statements (not prose) and assert none are I/O libs."""
        import ast
        import inspect

        from agentrail.guardrails.policies import output_enforcer as policy

        tree = ast.parse(inspect.getsource(policy))
        imported: set[str] = set()
        for node in ast.walk(tree):
            if isinstance(node, ast.Import):
                imported.update(alias.name.split(".")[0] for alias in node.names)
            elif isinstance(node, ast.ImportFrom) and node.module:
                imported.add(node.module.split(".")[0])

        forbidden = {"subprocess", "urllib", "socket", "requests", "pytest", "http"}
        assert not (imported & forbidden), (
            f"pure policy imports I/O modules: {sorted(imported & forbidden)}"
        )
        # It must also not import the run/ I/O layer (e.g. snapshot_push.load_link).
        from agentrail.guardrails.policies import output_enforcer as p2
        assert "agentrail.context.snapshot_push" not in {
            (node.module or "")
            for node in ast.walk(ast.parse(inspect.getsource(p2)))
            if isinstance(node, ast.ImportFrom)
        }
