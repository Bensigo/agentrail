"""Tests for the framework-neutral Signals schema (issue #919, AC1).

Signals carries the six neutral fields the gate epic needs and is frozen/pure:
no methods do I/O, sequence fields normalise to immutable tuples, and the whole
thing is hashable.
"""
from __future__ import annotations

import dataclasses

import pytest

from agentrail.guardrails.signals import CiCheck, Signals, TestResult


class TestSignalsSchemaAC1:
    def test_has_the_six_fields(self):
        fields = {f.name for f in dataclasses.fields(Signals)}
        assert fields == {
            "changed_files",
            "diff",
            "test_results",
            "ci_checks",
            "added_lines",
            "deleted_files",
        }

    def test_defaults_are_empty(self):
        s = Signals()
        assert s.changed_files == ()
        assert s.diff == ""
        assert s.test_results == ()
        assert s.ci_checks == ()
        assert s.added_lines == ()
        assert s.deleted_files == ()

    def test_is_frozen(self):
        s = Signals(changed_files=("a.py",))
        with pytest.raises(dataclasses.FrozenInstanceError):
            s.changed_files = ("b.py",)  # type: ignore[misc]

    def test_sequence_fields_normalise_to_tuples(self):
        s = Signals(
            changed_files=["a.py", "b.py"],
            test_results=[TestResult("t", True)],
            ci_checks=[CiCheck("ci", "success")],
            added_lines=["+x"],
            deleted_files=["gone.py"],
        )
        assert isinstance(s.changed_files, tuple)
        assert isinstance(s.test_results, tuple)
        assert isinstance(s.ci_checks, tuple)
        assert isinstance(s.added_lines, tuple)
        assert isinstance(s.deleted_files, tuple)

    def test_is_hashable(self):
        # Frozen + tuple fields → hashable, so a Signals can be a dict key / set member.
        assert hash(Signals(changed_files=("a.py",))) == hash(Signals(changed_files=("a.py",)))


class TestNeutralElementTypes:
    def test_test_result(self):
        r = TestResult(name="pkg/test_x.py", passed=False, message="boom")
        assert (r.name, r.passed, r.message) == ("pkg/test_x.py", False, "boom")

    def test_ci_check_success_vocabularies(self):
        assert CiCheck("a", "success").succeeded
        assert CiCheck("a", "PASSED").succeeded
        assert not CiCheck("a", "failure").succeeded
        assert not CiCheck("a", "").succeeded
