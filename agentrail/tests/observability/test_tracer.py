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


def test_phase_generation_body_carries_its_own_id(capture):
    # Confirmed against a live local Langfuse instance (v3.212.0): the real
    # ingestion endpoint 400s a generation-create body missing its own "id"
    # ("expected string, received undefined" at body.id) -- this is the
    # observation's own identity, distinct from the outer batch envelope's
    # event id (_event()'s "id"). Every prior test only asserted individual
    # body fields and never caught this; it silently failed against the real
    # server while the tracer's non-fatal design let the run continue normally.
    t = RunTracer.start("run-x")
    t.phase_generation("verify", {"input": 100, "output": 20}, 0.0123,
                       {"input": 0.01, "output": 0.0023}, 1720000000.0, "opus")
    gens = [e for batch in capture for e in batch if e["type"] == "generation-create"]
    body_id = gens[0]["body"]["id"]
    assert isinstance(body_id, str) and body_id
    assert body_id != gens[0]["id"]  # distinct from the outer envelope's event id


def test_phase_generation_start_ts_zero_records_epoch_not_now(capture):
    # start_ts=0.0 is a valid Unix epoch (1970-01-01Z), NOT "unset" — a bare
    # `if start_ts` truthiness check would silently substitute the current
    # time. Pin the emitted startTime so that regression can't return.
    t = RunTracer.start("run-x")
    t.phase_generation("execute", {"input": 1}, 0.0, None, 0.0, "m")
    gens = [e for batch in capture for e in batch if e["type"] == "generation-create"]
    assert gens[0]["body"]["startTime"].startswith("1970-01-01T00:00:00")


def test_phase_generation_start_ts_passthrough(capture):
    t = RunTracer.start("run-x")
    t.phase_generation("verify", {"input": 1}, 0.0, None, 1720000000.0, "m")
    gens = [e for batch in capture for e in batch if e["type"] == "generation-create"]
    # 1720000000.0 == 2024-07-03T09:46:40Z — the provided value, not _now_iso().
    assert gens[0]["body"]["startTime"].startswith("2024-07-03T09:46:40")


def test_transport_error_swallowed(capture, monkeypatch):
    def boom(*a, **k):
        raise OSError("connection refused")
    monkeypatch.setattr(lc, "_request", boom)
    t = RunTracer.start("run-x")
    t.phase_generation("execute", {"input": 1}, 0.0, None, 0.0, None)
    t.finish(1)  # nothing raises


def test_phase_generation_with_invalid_start_ts_does_not_raise_flag_off(monkeypatch):
    def explode(*a, **k):
        raise AssertionError("network attempted with flag off")
    monkeypatch.setattr(lc, "_request", explode)
    t = RunTracer.start("run-x")
    # NaN can't be converted to a timestamp; must not raise even though the
    # tracer is fully disabled (no client at all).
    t.phase_generation("execute", {"input": 1}, 0.0, None, float("nan"), None)


def test_phase_generation_with_invalid_start_ts_does_not_raise_flag_on(capture):
    t = RunTracer.start("run-x")
    # Malformed input while enabled: body construction raises internally,
    # must be swallowed just like a transport error, and never sent.
    t.phase_generation("execute", {"input": 1}, 0.0, None, float("nan"), None)
    gens = [e for batch in capture for e in batch if e["type"] == "generation-create"]
    assert gens == []


def test_finish_preserves_metadata_set_at_start(capture):
    t = RunTracer.start("run-x", metadata={"custom": "value", "goal": "ship"})
    t.finish(0)
    events = [e for batch in capture for e in batch]
    trace_creates = [e for e in events if e["type"] == "trace-create"]
    finish_body = trace_creates[-1]["body"]
    assert finish_body["metadata"]["custom"] == "value"
    assert finish_body["metadata"]["goal"] == "ship"
    assert finish_body["metadata"]["exit_status"] == 0
    assert finish_body["metadata"]["run_id"] == "run-x"
