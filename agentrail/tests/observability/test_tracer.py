import pytest
from agentrail.observability import langfuse_client as lc
from agentrail.observability.tracer import RunTracer


@pytest.fixture(autouse=True)
def clean_env(monkeypatch):
    for var in ("AGENTRAIL_LANGFUSE_ENABLED", "LANGFUSE_PUBLIC_KEY",
                "LANGFUSE_SECRET_KEY", "LANGFUSE_HOST", "LANGFUSE_BASE_URL"):
        monkeypatch.delenv(var, raising=False)


@pytest.fixture
def capture(monkeypatch):
    """Flag on, env configured, transport captured. Fails the test on real IO."""
    batches = []

    def fake_request(method, url, headers, data, timeout):
        import json
        batches.append(json.loads(data)["batch"])
        return 207, b"{}"

    monkeypatch.setenv("AGENTRAIL_LANGFUSE_ENABLED", "1")
    monkeypatch.setenv("LANGFUSE_HOST", "http://localhost:3000")
    monkeypatch.setenv("LANGFUSE_PUBLIC_KEY", "pk")
    monkeypatch.setenv("LANGFUSE_SECRET_KEY", "sk")
    monkeypatch.setattr(lc, "_request", fake_request)
    return batches


def test_flag_off_makes_no_network_calls(monkeypatch):
    def explode(*a, **k):
        raise AssertionError("network attempted with flag off")
    monkeypatch.setattr(lc, "_request", explode)
    t = RunTracer.start("run-x")
    t.phase_generation("execute", {"input": 10, "output": 5}, 0.01, None, 0.0, "m")
    t.finish(0)  # must not raise, must not call _request


def test_trace_created_with_deterministic_id_and_session(capture):
    t = RunTracer.start("run-x", session_id="afk-42")
    t.finish(0)
    events = [e for batch in capture for e in batch]
    trace_creates = [e for e in events if e["type"] == "trace-create"]
    assert trace_creates[0]["body"]["id"] == lc.deterministic_trace_id("run-x")
    assert trace_creates[0]["body"]["sessionId"] == "afk-42"


def test_phase_generation_carries_explicit_cost(capture):
    t = RunTracer.start("run-x")
    t.phase_generation("verify", {"input": 100, "output": 20}, 0.0123,
                       {"input": 0.01, "output": 0.0023}, 1720000000.0, "opus")
    gens = [e for batch in capture for e in batch if e["type"] == "generation-create"]
    body = gens[0]["body"]
    assert body["traceId"] == lc.deterministic_trace_id("run-x")
    assert body["name"] == "verify"
    assert body["costDetails"]["total"] == 0.0123
    assert body["usageDetails"] == {"input": 100, "output": 20}


def test_transport_error_swallowed(capture, monkeypatch):
    def boom(*a, **k):
        raise OSError("connection refused")
    monkeypatch.setattr(lc, "_request", boom)
    t = RunTracer.start("run-x")
    t.phase_generation("execute", {"input": 1}, 0.0, None, 0.0, None)
    t.finish(1)  # nothing raises
