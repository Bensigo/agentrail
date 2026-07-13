import json
import pytest
from agentrail.observability import langfuse_client as lc


@pytest.fixture(autouse=True)
def clean_env(monkeypatch):
    for var in ("AGENTRAIL_LANGFUSE_ENABLED", "LANGFUSE_PUBLIC_KEY",
                "LANGFUSE_SECRET_KEY", "LANGFUSE_HOST", "LANGFUSE_BASE_URL"):
        monkeypatch.delenv(var, raising=False)


def test_enabled_off_by_default():
    assert lc.enabled() is False


def test_enabled_accepts_truthy(monkeypatch):
    monkeypatch.setenv("AGENTRAIL_LANGFUSE_ENABLED", "TRUE")
    assert lc.enabled() is True


def test_deterministic_trace_id_stable_and_hex():
    tid = lc.deterministic_trace_id("run-20260713-abc")
    assert tid == lc.deterministic_trace_id("run-20260713-abc")
    assert len(tid) == 32 and int(tid, 16) >= 0


def test_from_env_returns_none_without_keys():
    assert lc.LangfuseHTTP.from_env() is None


def test_from_env_accepts_base_url_fallback(monkeypatch):
    monkeypatch.setenv("LANGFUSE_BASE_URL", "http://localhost:3000")
    monkeypatch.setenv("LANGFUSE_PUBLIC_KEY", "pk")
    monkeypatch.setenv("LANGFUSE_SECRET_KEY", "sk")
    client = lc.LangfuseHTTP.from_env()
    assert client is not None and client.base_url == "http://localhost:3000"


def test_ingest_posts_batch_with_basic_auth(monkeypatch):
    calls = []

    def fake_request(method, url, headers, data, timeout):
        calls.append((method, url, headers, data))
        return 207, b'{"successes": [], "errors": []}'

    monkeypatch.setattr(lc, "_request", fake_request)
    client = lc.LangfuseHTTP("http://localhost:3000", "pk", "sk")
    client.ingest([{"id": "1", "type": "trace-create", "timestamp": "t", "body": {}}])
    method, url, headers, data = calls[0]
    assert method == "POST" and url.endswith("/api/public/ingestion")
    assert headers["Authorization"].startswith("Basic ")
    assert json.loads(data)["batch"][0]["type"] == "trace-create"
