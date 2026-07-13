import http.server
import json
import threading

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


class _FiveHundredHandler(http.server.BaseHTTPRequestHandler):
    def do_GET(self):
        body = b'{"error": "boom"}'
        self.send_response(500)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def log_message(self, *args, **kwargs):  # silence test-run noise
        pass


@pytest.fixture
def local_500_server():
    server = http.server.HTTPServer(("127.0.0.1", 0), _FiveHundredHandler)
    thread = threading.Thread(target=server.serve_forever, daemon=True)
    thread.start()
    try:
        yield f"http://127.0.0.1:{server.server_port}"
    finally:
        server.shutdown()
        thread.join()


def test_request_normalizes_httperror_to_status_tuple(local_500_server):
    # Exercises the real _request() (no monkeypatch of _request itself) against
    # a real local server returning HTTP 500, proving urllib.error.HTTPError is
    # caught and normalized into the documented (status, body) tuple contract.
    status, body = lc._request("GET", local_500_server, {}, None, 5)
    assert status == 500
    assert json.loads(body)["error"] == "boom"


def test_get_json_raises_runtime_error_on_real_500(local_500_server):
    # Proves a caller (get_json) raises the documented RuntimeError from a
    # normalized >=400 status produced by the real _request(), not an
    # uncaught urllib.error.HTTPError.
    client = lc.LangfuseHTTP(local_500_server, "pk", "sk")
    with pytest.raises(RuntimeError, match="HTTP 500"):
        client.get_json("/api/public/whatever", {})


def test_get_json_builds_url_with_encoded_query_params(monkeypatch):
    calls = []

    def fake_request(method, url, headers, data, timeout):
        calls.append((method, url, headers, data))
        return 200, b'{"ok": true}'

    monkeypatch.setattr(lc, "_request", fake_request)
    client = lc.LangfuseHTTP("http://localhost:3000", "pk", "sk")
    result = client.get_json("/api/public/traces", {"page": 1, "name": "run a"})
    method, url, headers, data = calls[0]
    assert method == "GET" and data is None
    assert url == "http://localhost:3000/api/public/traces?page=1&name=run+a"
    assert headers["Authorization"].startswith("Basic ")
    assert result == {"ok": True}


def test_get_json_raises_runtime_error_on_400_status(monkeypatch):
    def fake_request(method, url, headers, data, timeout):
        return 404, b'{"error": "not found"}'

    monkeypatch.setattr(lc, "_request", fake_request)
    client = lc.LangfuseHTTP("http://localhost:3000", "pk", "sk")
    with pytest.raises(RuntimeError, match="HTTP 404"):
        client.get_json("/api/public/traces", {})


def test_post_json_posts_body_and_returns_parsed_response(monkeypatch):
    calls = []

    def fake_request(method, url, headers, data, timeout):
        calls.append((method, url, headers, data))
        return 200, b'{"id": "abc123"}'

    monkeypatch.setattr(lc, "_request", fake_request)
    client = lc.LangfuseHTTP("http://localhost:3000", "pk", "sk")
    result = client.post_json("/api/public/score-configs", {"name": "quality"})
    method, url, headers, data = calls[0]
    assert method == "POST" and url == "http://localhost:3000/api/public/score-configs"
    assert headers["Authorization"].startswith("Basic ")
    assert json.loads(data) == {"name": "quality"}
    assert result == {"id": "abc123"}


def test_post_json_raises_runtime_error_on_500_status(monkeypatch):
    def fake_request(method, url, headers, data, timeout):
        return 500, b'{"error": "boom"}'

    monkeypatch.setattr(lc, "_request", fake_request)
    client = lc.LangfuseHTTP("http://localhost:3000", "pk", "sk")
    with pytest.raises(RuntimeError, match="HTTP 500"):
        client.post_json("/api/public/score-configs", {"name": "quality"})
