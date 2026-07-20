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


def test_phase_generation_drops_non_numeric_breakdown_keys_from_cost_details(capture):
    """#1337 PR②: `agentrail.run.pricing.cost_breakdown()` now returns a
    non-numeric `"price_source"` key ("gateway" | "price_table" | None)
    alongside its numeric `*_usd` components. Langfuse's ingestion schema
    documents costDetails as "USD cost per usage type" — every value a
    number (https://langfuse.com/docs/observability/features/token-and-cost-tracking,
    confirmed 2026-07-20) — so forwarding a breakdown dict verbatim once it
    carries a string/None value would put a non-numeric entry inside a
    field Langfuse expects to be all-numeric. Numeric components must still
    pass through unchanged; only the non-numeric key is dropped.
    """
    breakdown = {
        "input_usd": 0.01,
        "output_usd": 0.02,
        "cache_read_usd": 0.001,
        "cache_write_usd": 0.0,
        "expansion_usd": 0.0,
        "rerank_usd": 0.0,
        "price_source": "gateway",  # the non-numeric field that must NOT reach costDetails
    }
    t = RunTracer.start("run-x")
    t.phase_generation("execute", {"input": 100, "output": 20}, 0.031, breakdown, 1720000000.0, "sonnet")
    gens = [e for batch in capture for e in batch if e["type"] == "generation-create"]
    cost_details = gens[0]["body"]["costDetails"]

    assert "price_source" not in cost_details
    assert cost_details["input_usd"] == 0.01
    assert cost_details["output_usd"] == 0.02
    assert cost_details["cache_read_usd"] == 0.001
    assert cost_details["total"] == 0.031
    assert all(isinstance(v, (int, float)) for v in cost_details.values())


def test_phase_generation_drops_none_valued_breakdown_keys_from_cost_details(capture):
    """The unknown-model path of `cost_breakdown()` sets `price_source: None`
    (there is no source to record) — `None` must be dropped the same way a
    string value is, not forwarded as a literal null inside costDetails."""
    breakdown = {"input_usd": 0.0, "output_usd": 0.0, "price_source": None}
    t = RunTracer.start("run-x")
    t.phase_generation("execute", {"input": 0, "output": 0}, 0.0, breakdown, 1720000000.0, "unknown-model")
    gens = [e for batch in capture for e in batch if e["type"] == "generation-create"]
    cost_details = gens[0]["body"]["costDetails"]

    assert "price_source" not in cost_details
    assert cost_details == {"input_usd": 0.0, "output_usd": 0.0, "total": 0.0}


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


# ---------------------------------------------------------------------------
# Trace-level readability: name / input / output (#trace-readability).
#
# TraceBody exposes `name`, `input`, `output` as first-class fields (verified
# against the installed @langfuse/core types) — populating Langfuse's trace
# list/detail I/O columns. New params are keyword-optional and pruned when
# absent so every existing caller and body stays byte-identical to before.
# ---------------------------------------------------------------------------

def _trace_bodies(capture):
    return [e["body"] for batch in capture for e in batch
            if e["type"] == "trace-create"]


def test_trace_input_and_name_set_when_provided(capture):
    RunTracer.start("run-x", name="issue #42", input_text="Fix the bug")
    body = _trace_bodies(capture)[0]
    assert body["name"] == "issue #42"
    assert body["input"] == "Fix the bug"


def test_trace_name_defaults_to_run_id_when_absent(capture):
    # Locks the backward-compat fallback: no name => the exact prior default.
    RunTracer.start("run-x")
    body = _trace_bodies(capture)[0]
    assert body["name"] == "agentrail-run:run-x"


def test_trace_input_omitted_when_none(capture):
    # Prune behavior: an omitted input is never sent as a literal null.
    RunTracer.start("run-x")
    body = _trace_bodies(capture)[0]
    assert "input" not in body


def test_finish_sets_output(capture):
    t = RunTracer.start("run-x")
    t.finish(0, output={"exitStatus": 0, "verdict": "green"})
    body = _trace_bodies(capture)[-1]
    # Output coexists with the metadata-merge invariant.
    assert body["output"]["verdict"] == "green"
    assert body["output"]["exitStatus"] == 0
    assert body["metadata"]["exit_status"] == 0


def test_finish_without_output_unchanged(capture):
    # No output => body byte-identical to before (no `output` key), metadata
    # still carries run_id/exit_status.
    t = RunTracer.start("run-x")
    t.finish(0)
    body = _trace_bodies(capture)[-1]
    assert "output" not in body
    assert body["metadata"]["exit_status"] == 0
    assert body["metadata"]["run_id"] == "run-x"


def test_input_and_output_are_clipped(capture):
    big_input = "x" * 20000
    big_output = {"blob": "y" * 20000, "reasons": ["z" * 20000] * 10}
    t = RunTracer.start("run-x", input_text=big_input)
    t.finish(1, output=big_output)
    bodies = _trace_bodies(capture)
    # Input clipped to the field bound.
    assert len(bodies[0]["input"]) <= 8000
    # Output serialized size bounded (string leaves clipped, whole thing capped).
    import json
    assert len(json.dumps(bodies[-1]["output"], default=str)) <= 16000 + 100


def test_malformed_output_flag_on_never_raises_and_sends_nothing_bad(capture):
    # Mirrors test_phase_generation_with_invalid_start_ts_does_not_raise_flag_on:
    # an output that can't be serialized cleanly is handled inside _safe_emit's
    # guarded lambda — the call must not raise. A non-JSON-able object falls
    # back to a clipped repr rather than propagating.
    class Unserializable:
        def __repr__(self):
            return "u" * 20000

    t = RunTracer.start("run-x")
    t.finish(1, output={"bad": Unserializable()})  # must not raise
    body = _trace_bodies(capture)[-1]
    # Emitted output stays bounded even for the awkward value.
    import json
    assert len(json.dumps(body["output"], default=str)) <= 16000 + 100


def test_long_input_flag_off_never_raises(monkeypatch):
    def explode(*a, **k):
        raise AssertionError("network attempted with flag off")
    monkeypatch.setattr(lc, "_request", explode)
    # Fully disabled: even a huge input / malformed output must be a no-op.
    t = RunTracer.start("run-x", input_text="x" * 50000)
    t.finish(0, output={"blob": "y" * 50000})
