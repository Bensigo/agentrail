"""Arc C §3: verify_gate emits a JUnit report so per-test evidence exists."""
from agentrail.run import verify_gate


def test_junit_constants_exported():
    assert verify_gate.DEFAULT_JUNIT_REPORT.endswith("pytest-report.xml")
    assert verify_gate.JUNIT_ENV == "AGENTRAIL_VERIFY_JUNIT_XML"


def test_resolve_junit_path_env_override(monkeypatch):
    monkeypatch.setenv(verify_gate.JUNIT_ENV, "/tmp/custom-report.xml")
    assert verify_gate.resolve_junit_path() == "/tmp/custom-report.xml"
    monkeypatch.delenv(verify_gate.JUNIT_ENV)
    assert verify_gate.resolve_junit_path() == verify_gate.DEFAULT_JUNIT_REPORT


def test_main_pytest_invocation_carries_junit_flag(monkeypatch, tmp_path):
    # Force the "run the tests" path with a fake decide() and capture the call.
    calls = {}
    monkeypatch.chdir(tmp_path)
    monkeypatch.setattr(verify_gate, "collect_changed_files", lambda _: ["x_test.py"])
    monkeypatch.setattr(verify_gate, "decide", lambda _: (0, ""))
    monkeypatch.setattr(
        verify_gate, "select_pytest_targets",
        lambda *a, **k: ["agentrail/tests/run/test_state.py"],
    )

    def fake_call(argv):
        calls["argv"] = argv
        return 0

    monkeypatch.setattr(verify_gate.subprocess, "call", fake_call)
    verify_gate.main([])
    assert any(str(a).startswith("--junit-xml=") for a in calls["argv"])
