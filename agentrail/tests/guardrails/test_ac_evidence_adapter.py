"""Arc C §2/§3 I/O: bindings, waivers, and JUnit capture are adapter-only."""
import json

from agentrail.guardrails.adapters import ac_evidence
from agentrail.guardrails.adapters.ac_evidence import (
    load_ac_bindings, load_ac_waivers, load_junit_results,
)
from agentrail.run.verify_gate import JUNIT_ENV

_JUNIT = """<?xml version="1.0" encoding="utf-8"?>
<testsuites>
  <testsuite name="pytest" tests="3">
    <testcase classname="agentrail.tests.run.test_x" name="test_pass" time="0.01"/>
    <testcase classname="agentrail.tests.run.test_x" name="test_fail" time="0.01">
      <failure message="boom">trace</failure>
    </testcase>
    <testcase classname="agentrail.tests.run.test_x" name="test_skip" time="0.0">
      <skipped message="later"/>
    </testcase>
  </testsuite>
</testsuites>
"""


def _write(tmp_path, rel, text):
    path = tmp_path / rel
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(text)
    return path


def test_bindings_lists_and_unverifiable_objects(tmp_path):
    _write(tmp_path, ".agentrail/ac_bindings.json", json.dumps({
        "AC1": ["agentrail/tests/run/test_x.py::test_pass", ""],
        "AC3": {"unverifiable": True, "why": "needs prod creds",
                "whatWouldProveIt": "a staging login"},
        "": ["ignored"],
        "AC4": "not-a-list-ignored",
    }))
    bindings, unverifiable = load_ac_bindings(tmp_path)
    assert bindings == {"AC1": ["agentrail/tests/run/test_x.py::test_pass"]}
    assert unverifiable == {"AC3": {"why": "needs prod creds",
                                    "whatWouldProveIt": "a staging login"}}


def test_bindings_missing_or_malformed_is_empty(tmp_path):
    assert load_ac_bindings(tmp_path) == ({}, {})
    _write(tmp_path, ".agentrail/ac_bindings.json", "{not json")
    assert load_ac_bindings(tmp_path) == ({}, {})


def test_waivers_load_and_default_empty(tmp_path):
    assert load_ac_waivers(tmp_path) == {}
    _write(tmp_path, ".agentrail/ac_waivers.json", json.dumps(
        {"AC2": {"reason": "manual-only", "by": "owner", "at": "2026-08-01"}}
    ))
    assert load_ac_waivers(tmp_path)["AC2"]["reason"] == "manual-only"


def test_junit_results_default_path_and_outcomes(tmp_path):
    _write(tmp_path, ".agentrail/run/pytest-report.xml", _JUNIT)
    results = load_junit_results(tmp_path)
    assert results["agentrail.tests.run.test_x.test_pass"] == "passed"
    assert results["agentrail.tests.run.test_x.test_fail"] == "failed"
    assert results["agentrail.tests.run.test_x.test_skip"] == "skipped"


def test_junit_results_verify_report_config_override(tmp_path):
    _write(tmp_path, "reports/custom.xml", _JUNIT)
    _write(tmp_path, ".agentrail/config.json", json.dumps({"verifyReport": "reports/custom.xml"}))
    assert load_junit_results(tmp_path)  # found via config, not default


def test_junit_missing_report_is_empty(tmp_path):
    assert load_junit_results(tmp_path) == {}


def test_junit_results_env_override_is_honored(tmp_path, monkeypatch):
    # verify_gate.resolve_junit_path() (the writer) honors AGENTRAIL_VERIFY_JUNIT_XML
    # over the default — the reader must follow it to the same place instead of
    # silently returning {} (final-review finding 1).
    _write(tmp_path, "relocated/report.xml", _JUNIT)
    monkeypatch.setenv(JUNIT_ENV, "relocated/report.xml")
    results = load_junit_results(tmp_path)
    assert results["agentrail.tests.run.test_x.test_pass"] == "passed"


def test_junit_results_config_verify_report_beats_env(tmp_path, monkeypatch):
    # A declared verifyReport names the repo's OWN runner output; that command
    # never sees our env var, so the explicit declaration must win over the env
    # override.
    _write(tmp_path, "declared/custom.xml", _JUNIT)
    monkeypatch.setenv(JUNIT_ENV, "somewhere/else.xml")
    _write(tmp_path, ".agentrail/config.json", json.dumps({"verifyReport": "declared/custom.xml"}))
    assert load_junit_results(tmp_path)  # found via declared config, not env


def test_junit_results_nonparse_exception_is_swallowed(tmp_path, monkeypatch):
    # A TOCTOU race or permission error between report.is_file() and ET.parse()
    # must not escape uncaught (module docstring's no-raise contract). Simulate
    # that OS-boundary failure by monkeypatching the adapter module's ET.parse
    # reference — mocking the OS boundary is legitimate for this error-path
    # test; no happy-path test mocks ET.parse.
    _write(tmp_path, ".agentrail/run/pytest-report.xml", _JUNIT)

    def _raise_permission_error(*_args, **_kwargs):
        raise PermissionError("denied")

    monkeypatch.setattr(ac_evidence.ET, "parse", _raise_permission_error)
    assert load_junit_results(tmp_path) == {}
